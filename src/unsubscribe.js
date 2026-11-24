// Unsubscribe helpers: List-Unsubscribe parsing, link discovery in the body,
// and outbound HTTP that refuses private addresses (the URLs come from email,
// which is untrusted input).
import dns from 'node:dns/promises';
import net from 'node:net';
import { convert } from 'html-to-text';
import { cfg } from './config.js';

export function parseListUnsubscribe(listUnsubscribe, listUnsubscribePost) {
  const uris = [...String(listUnsubscribe || '').matchAll(/<([^>]+)>/g)].map((m) => m[1].replace(/\s+/g, ''));
  const https = uris.filter((u) => /^https?:\/\//i.test(u));
  const mailto = uris.filter((u) => /^mailto:/i.test(u));
  const oneClickUrl = /List-Unsubscribe=One-Click/i.test(String(listUnsubscribePost || ''))
    ? https.find((u) => /^https:\/\//i.test(u)) || https[0]
    : undefined;
  return { https, mailto, oneClickUrl };
}

export function methodsOf(info) {
  const out = [];
  if (info.oneClickUrl) out.push('one_click');
  if (info.mailto.length) out.push('mailto');
  if (info.https.length) out.push('link');
  return out;
}

export function parseMailto(uri) {
  const m = /^mailto:([^?]*)(?:\?(.*))?$/i.exec(uri);
  if (!m) return null;
  const to = decodeURIComponent(m[1]).split(',').map((s) => s.trim()).filter(Boolean);
  const params = new URLSearchParams((m[2] || '').replace(/\+/g, '%2B'));
  const get = (name) => {
    for (const [k, v] of params) if (k.toLowerCase() === name) return v;
    return '';
  };
  return { to, subject: get('subject'), body: get('body') };
}

const WORDS = /(unsubscri|opt[\s_-]?out|отпис|отказаться от рассыл|remove me|email[\s_-]?preferences|manage[\s_-]?(your[\s_-]?)?(subscription|preferences|notifications)|notification settings|настройк\S* (уведомлен|рассыл))/i;
const STRONG = /(unsubscri|отпис|opt[\s_-]?out)/i;

export function findBodyLinks(html) {
  const found = [];
  const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = (m[1] ?? m[2] ?? '').replace(/&amp;/g, '&').trim();
    if (!/^https?:\/\//i.test(href)) continue;
    const text = m[3].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (!WORDS.test(text) && !WORDS.test(href)) continue;
    const score = (STRONG.test(text) ? 2 : 0) + (STRONG.test(href) ? 1 : 0);
    if (!found.some((f) => f.url === href)) found.push({ url: href, text: text.slice(0, 80), score });
  }
  return found.sort((a, b) => b.score - a.score).slice(0, 3);
}

const blocked = new net.BlockList();
for (const [addr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) {
  blocked.addSubnet(addr, bits, 'ipv4');
}
for (const [addr, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(addr, bits, 'ipv6');

async function assertPublic(urlString) {
  const u = new URL(urlString);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`Refusing non-http URL: ${u.protocol}`);
  if (cfg().allowPrivateHttp) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  for (const a of addrs) {
    let address = a.address;
    let family = a.family === 6 ? 'ipv6' : 'ipv4';
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) { address = mapped[1]; family = 'ipv4'; }
    if (blocked.check(address, family)) throw new Error('Refusing to call a private or local address');
  }
  return u;
}

async function readLimited(response, limit = 300_000) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  try { await reader.cancel(); } catch { /* already closed */ }
  return Buffer.concat(chunks).toString('utf8');
}

// Follows redirects by hand so that every hop is checked.
export async function safeRequest(url, { method = 'GET', headers = {}, body } = {}) {
  let current = url;
  let m = method;
  let b = body;
  for (let hop = 0; hop < 6; hop++) {
    await assertPublic(current);
    const response = await fetch(current, {
      method: m,
      body: m === 'GET' ? undefined : b,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        ...(m === 'GET' ? {} : headers),
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
      current = new URL(response.headers.get('location'), current).toString();
      if (![307, 308].includes(response.status)) { m = 'GET'; b = undefined; }
      try { await response.body?.cancel(); } catch { /* ignore */ }
      continue;
    }
    const raw = await readLimited(response);
    const isHtml = /html/i.test(response.headers.get('content-type') || '') || /<html|<body|<form/i.test(raw);
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 150);
    let text = raw;
    if (isHtml) {
      try {
        text = convert(raw, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }, { selector: 'a', options: { ignoreHref: true } }] });
      } catch { text = raw.replace(/<[^>]+>/g, ' '); }
    }
    text = text.replace(/\s+/g, ' ').trim().slice(0, 700);
    return { status: response.status, ok: response.ok, final_url: current, title, text, has_form: /<form\b/i.test(raw) };
  }
  throw new Error('Too many redirects');
}

const DONE = /(unsubscribed|been removed|successfully|you'?re (now )?unsubscribed|no longer receive|opted out|preferences (have been )?(saved|updated)|отписа(ны|лись|н\b)|больше не будете получать|подписка отменена|рассылка отключена)/i;
const ASK = /(confirm|are you sure|click|press|select|choose|подтверд|нажмите|выберите|уверены)/i;

export function judgePage(result) {
  if (!result.ok) return 'failed';
  const hay = `${result.title} ${result.text}`;
  if (DONE.test(hay) && !(/are you sure|уверены/i.test(hay))) return 'unsubscribed';
  if (result.has_form || ASK.test(hay)) return 'needs_confirmation';
  return 'page_opened';
}
