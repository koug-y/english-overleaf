// Mailbox operations over IMAP (reading, organizing) and SMTP (sending).
// A fresh IMAP connection is opened per tool call and closed afterwards,
// which is what a serverless function needs.
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
import { cfg, accounts, resolveAccount } from './config.js';
import { parseListUnsubscribe, methodsOf, parseMailto, findBodyLinks, safeRequest, judgePage } from './unsubscribe.js';

// ---- connections --------------------------------------------------------

function imapClient(acct, user) {
  const c = cfg();
  const client = new ImapFlow({
    host: acct.imap.host,
    port: acct.imap.port,
    secure: acct.imap.secure,
    auth: { user, pass: acct.password },
    logger: false,
    tls: c.tlsInsecure ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 45_000,
  });
  client.on('error', () => {});
  return client;
}

async function withImap(acct, fn) {
  let client = imapClient(acct, acct.user);
  try {
    await client.connect();
  } catch (err) {
    // Apple documents the short name (the part before @) as the IMAP username; some accounts need it.
    if (err?.authenticationFailed && acct.provider === 'icloud' && acct.user.includes('@')) {
      client = imapClient(acct, acct.user.split('@')[0]);
      await client.connect();
    } else {
      throw err;
    }
  }
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { /* connection already gone */ }
  }
}

function smtpTransport(acct) {
  const c = cfg();
  return nodemailer.createTransport({
    host: acct.smtp.host,
    port: acct.smtp.port,
    secure: acct.smtp.secure,
    requireTLS: acct.smtp.secure ? undefined : acct.smtp.requireTLS,
    auth: { user: acct.user, pass: acct.password },
    tls: c.tlsInsecure ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 45_000,
  });
}

// ---- folders ------------------------------------------------------------

const FALLBACK = {
  sent: ['Sent Messages', 'Sent', 'Sent Items'],
  drafts: ['Drafts'],
  trash: ['Deleted Messages', 'Trash', 'Bin'],
  junk: ['Junk', 'Spam'],
  archive: ['Archive', 'Archives'],
};
const SPECIAL = { sent: '\\Sent', drafts: '\\Drafts', trash: '\\Trash', junk: '\\Junk', archive: '\\Archive' };

async function folderMap(client) {
  const list = await client.list();
  const paths = list.map((f) => f.path);
  const map = { inbox: 'INBOX' };
  for (const key of Object.keys(SPECIAL)) {
    map[key] = list.find((f) => f.specialUse === SPECIAL[key])?.path || FALLBACK[key].find((name) => paths.includes(name));
  }
  // Gmail has no archive folder: archiving there means leaving only the All Mail copy.
  if (!map.archive) map.archive = list.find((f) => f.specialUse === '\\All')?.path;
  return { list, map };
}

async function resolveFolder(client, name, cache) {
  const wanted = String(name || 'INBOX').trim();
  const key = wanted.toLowerCase();
  if (key === 'inbox') return 'INBOX';
  const fm = cache.fm || (cache.fm = await folderMap(client));
  if (fm.map[key]) return fm.map[key];
  const exact = fm.list.find((f) => f.path === wanted) || fm.list.find((f) => f.path.toLowerCase() === key);
  if (exact) return exact.path;
  if (key in SPECIAL) throw new Error(`This mailbox has no ${key} folder`);
  throw new Error(`Folder not found: ${wanted}. Call list_folders to see the real names.`);
}

export async function listFolders(args = {}) {
  const acct = resolveAccount(args.account);
  return withImap(acct, async (client) => {
    const { list, map } = await folderMap(client);
    const roles = Object.fromEntries(Object.entries(map).map(([role, path]) => [path, role]));
    const folders = [];
    for (const f of list) {
      if (f.flags?.has?.('\\Noselect')) continue;
      let status = {};
      try { status = await client.status(f.path, { messages: true, unseen: true }); } catch { /* skip counts */ }
      folders.push({ path: f.path, role: roles[f.path] || null, messages: status.messages ?? null, unread: status.unseen ?? null });
    }
    return { account: acct.email, folders };
  });
}

// ---- helpers ------------------------------------------------------------

const addr = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');
const addrs = (list) => (list || []).map(addr).filter(Boolean);
// mailparser gives one address object, or an array of them when a header repeats.
const vals = (field) => [].concat(field || []).flatMap((f) => f.value || []);

function headerBlock(buf) {
  const out = {};
  if (!buf) return out;
  const text = buf.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}

function hasAttachment(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes || []).some(hasAttachment);
}

function toDate(value, label) {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${label} is not a valid date: ${value}`);
  return d;
}

function summarize(msg, folder) {
  const env = msg.envelope || {};
  const h = headerBlock(msg.headers);
  const unsub = parseListUnsubscribe(h['list-unsubscribe'], h['list-unsubscribe-post']);
  return {
    uid: msg.uid,
    folder,
    date: (env.date || msg.internalDate || null) && new Date(env.date || msg.internalDate).toISOString(),
    from: addrs(env.from).join(', '),
    to: addrs(env.to).join(', '),
    subject: env.subject || '(no subject)',
    unread: !msg.flags?.has('\\Seen'),
    flagged: !!msg.flags?.has('\\Flagged'),
    has_attachments: hasAttachment(msg.bodyStructure),
    can_unsubscribe: methodsOf(unsub).length > 0,
  };
}

const LIST_FETCH = {
  uid: true,
  envelope: true,
  flags: true,
  internalDate: true,
  bodyStructure: true,
  headers: ['list-unsubscribe', 'list-unsubscribe-post'],
};

function bodyText(parsed, maxChars) {
  let text = (parsed.text || '').trim();
  const html = parsed.html || '';
  if (html && (text.length < 200 || text.length * 20 < html.length)) {
    try {
      const fromHtml = convert(html, {
        wordwrap: false,
        selectors: [
          { selector: 'img', format: 'skip' },
          { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
        ],
      }).trim();
      if (fromHtml.length > text.length) text = fromHtml;
    } catch { /* keep the plain part */ }
  }
  text = text.replace(/\n{3,}/g, '\n\n');
  const truncated = text.length > maxChars;
  return { text: truncated ? text.slice(0, maxChars) : text, truncated, total_chars: text.length };
}

async function fetchParsed(client, uid) {
  const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
  if (!msg || !msg.source) throw new Error(`No message with uid ${uid} in this folder`);
  const parsed = await simpleParser(msg.source);
  return { msg, parsed };
}

// ---- search and read ----------------------------------------------------

export async function searchEmails(args) {
  if (String(args.account ?? '').trim().toLowerCase() === 'all') return searchAllAccounts(args);
  const acct = resolveAccount(args.account);
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
  const offset = Math.max(args.offset ?? 0, 0);
  return withImap(acct, async (client) => {
    const folder = await resolveFolder(client, args.folder, {});
    const lock = await client.getMailboxLock(folder);
    try {
      const q = {};
      if (args.from) q.from = args.from;
      if (args.to) q.to = args.to;
      if (args.subject) q.subject = args.subject;
      const since = toDate(args.since, 'since');
      const before = toDate(args.before, 'before');
      if (since) q.since = since;
      if (before) q.before = before;
      if (args.unread_only) q.seen = false;
      if (args.flagged_only) q.flagged = true;
      const base = Object.keys(q).length ? q : { all: true };

      let uids;
      if (args.query) {
        try {
          uids = await client.search({ ...base, or: [{ subject: args.query }, { from: args.query }, { body: args.query }] }, { uid: true });
        } catch {
          // Some servers reject body search; fall back to subject and sender.
          uids = await client.search({ ...base, or: [{ subject: args.query }, { from: args.query }] }, { uid: true });
        }
      } else {
        uids = await client.search(base, { uid: true });
      }
      uids = (uids || []).slice().sort((a, b) => a - b);
      const total = uids.length;
      const end = Math.max(total - offset, 0);
      const page = uids.slice(Math.max(end - limit, 0), end);
      const emails = [];
      if (page.length) {
        for await (const msg of client.fetch(page.join(','), LIST_FETCH, { uid: true })) emails.push(summarize(msg, folder));
      }
      emails.sort((a, b) => b.uid - a.uid);
      return { account: acct.email, folder, total_matches: total, returned: emails.length, offset, emails };
    } finally {
      lock.release();
    }
  });
}

// One search over every connected mailbox, merged by date. Each result names its mailbox.
async function searchAllAccounts(args) {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
  const usable = accounts().filter((a) => !a.problem);
  const settled = await Promise.allSettled(usable.map((a) => searchEmails({ ...args, account: a.email, offset: 0, limit })));
  const emails = [];
  const errors = [];
  let total = 0;
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      total += r.value.total_matches;
      for (const e of r.value.emails) emails.push({ account: usable[i].email, ...e });
    } else {
      errors.push({ account: usable[i].email, error: r.reason?.authenticationFailed ? 'login rejected' : r.reason?.message || String(r.reason) });
    }
  });
  emails.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return { account: 'all', searched: usable.map((a) => a.email), total_matches: total, returned: Math.min(emails.length, limit), emails: emails.slice(0, limit), ...(errors.length ? { errors } : {}) };
}

export async function readEmail(args) {
  const acct = resolveAccount(args.account);
  const maxChars = Math.min(Math.max(args.max_chars ?? 15_000, 500), 100_000);
  return withImap(acct, async (client) => {
    const folder = await resolveFolder(client, args.folder, {});
    const lock = await client.getMailboxLock(folder);
    try {
      const { msg, parsed } = await fetchParsed(client, args.uid);
      const unsub = parseListUnsubscribe(rawHeader(parsed, 'list-unsubscribe'), rawHeader(parsed, 'list-unsubscribe-post'));
      const body = bodyText(parsed, maxChars);
      if (args.mark_read) await client.messageFlagsAdd(String(args.uid), ['\\Seen'], { uid: true });
      return {
        account: acct.email,
        uid: Number(args.uid),
        folder,
        message_id: parsed.messageId || null,
        date: parsed.date ? parsed.date.toISOString() : null,
        from: vals(parsed.from).map(addr).join(', '),
        to: vals(parsed.to).map(addr).join(', '),
        cc: vals(parsed.cc).map(addr).join(', '),
        reply_to: vals(parsed.replyTo).map(addr).join(', '),
        subject: parsed.subject || '(no subject)',
        unread: !msg.flags?.has('\\Seen') && !args.mark_read,
        flagged: !!msg.flags?.has('\\Flagged'),
        attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename || '(unnamed)', content_type: a.contentType, size: a.size })),
        unsubscribe_methods: methodsOf(unsub),
        body: body.text,
        body_truncated: body.truncated,
        body_total_chars: body.total_chars,
      };
    } finally {
      lock.release();
    }
  });
}

// mailparser turns some list headers into objects; the raw header line is what we need.
function rawHeader(parsed, name) {
  const line = (parsed.headerLines || []).find((h) => h.key === name);
  if (!line) return '';
  return line.line.slice(line.line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim();
}

// ---- compose, send, drafts ----------------------------------------------

function buildRaw(mail, keepBcc) {
  const node = new MailComposer(mail).compile();
  node.keepBcc = keepBcc;
  return new Promise((resolve, reject) => node.build((err, buf) => (err ? reject(err) : resolve(buf))));
}

const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(',') : []).map((s) => String(s).trim()).filter(Boolean);
const bare = (s) => (/<([^>]+)>/.exec(s)?.[1] || s).trim().toLowerCase();

async function replyContext(client, args) {
  const folder = await resolveFolder(client, args.reply_to_folder, {});
  const lock = await client.getMailboxLock(folder);
  try {
    const { parsed } = await fetchParsed(client, args.reply_to_uid);
    return { folder, parsed };
  } finally {
    lock.release();
  }
}

export async function compose(args, { draftOnly }) {
  const acct = resolveAccount(args.account);
  const fromAddress = (args.from || acct.email).trim();
  let to = list(args.to);
  let cc = list(args.cc);
  const bcc = list(args.bcc);
  let subject = args.subject;
  let text = args.body || '';
  const extra = {};
  let original = null;

  if (args.reply_to_uid) {
    original = await withImap(acct, (client) => replyContext(client, args));
    const p = original.parsed;
    const me = new Set([acct.email.toLowerCase(), fromAddress.toLowerCase()]);
    const replyTarget = (vals(p.replyTo).length ? vals(p.replyTo) : vals(p.from)).map(addr);
    if (!to.length) to = replyTarget;
    if (args.reply_all) {
      const others = [...vals(p.to), ...vals(p.cc)].map(addr);
      const taken = new Set(to.map(bare));
      cc = [...cc, ...others.filter((a) => !me.has(bare(a)) && !taken.has(bare(a)))];
    }
    if (!subject) subject = /^\s*re:/i.test(p.subject || '') ? p.subject : `Re: ${p.subject || ''}`.trim();
    if (p.messageId) {
      extra.inReplyTo = p.messageId;
      const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
      extra.references = [...refs, p.messageId];
    }
    if (args.quote_original !== false) {
      const quoted = bodyText(p, 20_000).text.split('\n').map((l) => `> ${l}`).join('\n');
      const when = p.date ? p.date.toUTCString() : '';
      text = `${text}\n\n${when ? `${when}, ` : ''}${vals(p.from).map(addr).join(', ')}:\n${quoted}`;
    }
  }

  if (!draftOnly && !to.length && !cc.length && !bcc.length) throw new Error('No recipients given');
  if (!subject && !draftOnly) subject = '(no subject)';

  const domain = fromAddress.split('@')[1] || 'icloud.com';
  const mail = {
    from: acct.fromName ? { name: acct.fromName, address: fromAddress } : fromAddress,
    to,
    cc,
    bcc,
    subject: subject || '',
    text,
    html: args.html || undefined,
    messageId: `<${randomUUID()}@${domain}>`,
    date: new Date(),
    ...extra,
  };
  const withBcc = await buildRaw(mail, true);

  if (draftOnly) {
    return withImap(acct, async (client) => {
      const drafts = await resolveFolder(client, 'drafts', {});
      const res = await client.append(drafts, withBcc, ['\\Draft', '\\Seen']);
      return { status: 'draft_saved', account: acct.email, folder: drafts, uid: res?.uid ?? null, to, cc, subject: mail.subject };
    });
  }

  const raw = bcc.length ? await buildRaw(mail, false) : withBcc;
  const recipients = [...to, ...cc, ...bcc].map(bare);
  const info = await smtpTransport(acct).sendMail({ envelope: { from: fromAddress, to: recipients }, raw });

  const result = {
    status: 'sent',
    account: acct.email,
    message_id: mail.messageId,
    accepted: info.accepted || recipients,
    rejected: info.rejected || [],
    subject: mail.subject,
  };
  try {
    await withImap(acct, async (client) => {
      if (acct.saveSent !== 'never') {
        const sent = await resolveFolder(client, 'sent', {});
        let already = false;
        if (acct.saveSent === 'check') {
          // Some providers file the sent message themselves; a second copy would be a duplicate.
          const lock = await client.getMailboxLock(sent);
          try {
            const hit = await client.search({ header: { 'message-id': mail.messageId } }, { uid: true });
            already = (hit || []).length > 0;
          } catch { /* cannot tell: append */ } finally { lock.release(); }
        }
        if (!already) await client.append(sent, withBcc, ['\\Seen']);
        result.saved_to = sent;
      }
      if (original) {
        const lock = await client.getMailboxLock(original.folder);
        try { await client.messageFlagsAdd(String(args.reply_to_uid), ['\\Answered'], { uid: true }); } finally { lock.release(); }
      }
    });
  } catch (err) {
    result.warning = `Sent, but the copy was not saved to the Sent folder: ${err.message}`;
  }
  return result;
}

// ---- organize -----------------------------------------------------------

export async function updateEmails(args) {
  const uids = (args.uids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!uids.length) throw new Error('uids is empty');
  const range = uids.join(',');
  const acct = resolveAccount(args.account);
  return withImap(acct, async (client) => {
    const cache = {};
    const folder = await resolveFolder(client, args.folder, cache);
    let destination;
    if (args.action === 'archive') destination = await resolveFolder(client, 'archive', cache);
    if (args.action === 'trash') destination = await resolveFolder(client, 'trash', cache);
    if (args.action === 'junk') destination = await resolveFolder(client, 'junk', cache);
    if (args.action === 'move') {
      if (!args.destination) throw new Error('destination is required for move');
      destination = await resolveFolder(client, args.destination, cache);
    }
    const lock = await client.getMailboxLock(folder);
    try {
      switch (args.action) {
        case 'mark_read': await client.messageFlagsAdd(range, ['\\Seen'], { uid: true }); break;
        case 'mark_unread': await client.messageFlagsRemove(range, ['\\Seen'], { uid: true }); break;
        case 'flag': await client.messageFlagsAdd(range, ['\\Flagged'], { uid: true }); break;
        case 'unflag': await client.messageFlagsRemove(range, ['\\Flagged'], { uid: true }); break;
        case 'archive': case 'trash': case 'junk': case 'move':
          if (destination === folder) throw new Error('Messages are already in that folder');
          await client.messageMove(range, destination, { uid: true });
          break;
        default: throw new Error(`Unknown action: ${args.action}`);
      }
      return { status: 'ok', account: acct.email, action: args.action, folder, count: uids.length, ...(destination ? { moved_to: destination } : {}) };
    } finally {
      lock.release();
    }
  });
}

// ---- subscriptions ------------------------------------------------------

export async function listSubscriptions(args) {
  const scan = Math.min(Math.max(args.scan ?? 300, 10), 1000);
  const acct = resolveAccount(args.account);
  return withImap(acct, async (client) => {
    const folder = await resolveFolder(client, args.folder, {});
    const lock = await client.getMailboxLock(folder);
    try {
      const exists = client.mailbox?.exists || 0;
      if (!exists) return { account: acct.email, folder, scanned: 0, senders: [] };
      const start = Math.max(exists - scan + 1, 1);
      const bySender = new Map();
      let scanned = 0;
      const fetchSpec = { uid: true, envelope: true, internalDate: true, headers: ['list-unsubscribe', 'list-unsubscribe-post', 'list-id'] };
      for await (const msg of client.fetch(`${start}:*`, fetchSpec)) {
        scanned++;
        const h = headerBlock(msg.headers);
        const info = parseListUnsubscribe(h['list-unsubscribe'], h['list-unsubscribe-post']);
        const methods = methodsOf(info);
        if (!methods.length) continue;
        const sender = msg.envelope?.from?.[0];
        const key = (sender?.address || h['list-id'] || 'unknown').toLowerCase();
        const date = msg.envelope?.date || msg.internalDate;
        const cur = bySender.get(key);
        if (!cur) {
          bySender.set(key, { sender: addr(sender) || key, emails: 1, latest_uid: msg.uid, latest_subject: msg.envelope?.subject || '', latest_date: date ? new Date(date).toISOString() : null, methods });
        } else {
          cur.emails++;
          if (msg.uid > cur.latest_uid) {
            Object.assign(cur, { latest_uid: msg.uid, latest_subject: msg.envelope?.subject || '', latest_date: date ? new Date(date).toISOString() : null, methods });
          }
        }
      }
      const senders = [...bySender.values()].sort((a, b) => b.emails - a.emails);
      return { account: acct.email, folder, scanned, senders };
    } finally {
      lock.release();
    }
  });
}

export async function unsubscribe(args) {
  const acct = resolveAccount(args.account);
  const method = args.method || 'auto';

  const ctx = await withImap(acct, async (client) => {
    const folder = await resolveFolder(client, args.folder, {});
    const lock = await client.getMailboxLock(folder);
    try {
      const { parsed } = await fetchParsed(client, args.uid);
      const info = parseListUnsubscribe(rawHeader(parsed, 'list-unsubscribe'), rawHeader(parsed, 'list-unsubscribe-post'));
      return { folder, info, from: vals(parsed.from).map(addr).join(', '), subject: parsed.subject || '', bodyLinks: findBodyLinks(parsed.html || parsed.textAsHtml || '') };
    } finally {
      lock.release();
    }
  });

  const { info, bodyLinks } = ctx;
  const available = [...methodsOf(info), ...(bodyLinks.length ? ['body_link'] : [])];
  const out = { account: acct.email, sender: ctx.from, subject: ctx.subject, available_methods: available };

  if (method === 'inspect') {
    return { ...out, status: 'inspected', one_click_url: info.oneClickUrl || null, mailto: info.mailto, links: info.https, body_links: bodyLinks };
  }
  if (!available.length) {
    return { ...out, status: 'no_unsubscribe_info', note: 'The email has no List-Unsubscribe header and no unsubscribe link in the body.' };
  }

  const chosen = method === 'auto' ? available[0] : method;
  if (!available.includes(chosen)) throw new Error(`Method ${chosen} is not available for this email. Available: ${available.join(', ')}`);

  if (chosen === 'one_click') {
    const r = await safeRequest(info.oneClickUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    out.attempt = { method: 'one_click', http_status: r.status, final_url: r.final_url, page_title: r.title, page_text: r.text };
    out.status = r.ok ? 'unsubscribed' : 'failed';
    out.note = r.ok
      ? 'The sender accepted the one-click unsubscribe request (RFC 8058).'
      : 'The sender rejected the one-click request. Try another method.';
  } else if (chosen === 'mailto') {
    const target = parseMailto(info.mailto[0]);
    if (!target?.to.length) throw new Error('The mailto unsubscribe address could not be parsed');
    const sent = await smtpTransport(acct).sendMail({
      from: acct.fromName ? { name: acct.fromName, address: acct.email } : acct.email,
      to: target.to,
      subject: target.subject || 'unsubscribe',
      text: target.body || 'unsubscribe',
    });
    out.attempt = { method: 'mailto', to: target.to, subject: target.subject || 'unsubscribe', rejected: sent.rejected || [] };
    out.status = 'request_sent';
    out.note = 'An unsubscribe email was sent to the address the sender published. Senders usually process it within a few days.';
  } else {
    const url = chosen === 'link' ? info.https[0] : bodyLinks[0].url;
    const r = await safeRequest(url);
    out.attempt = { method: chosen, http_status: r.status, final_url: r.final_url, page_title: r.title, page_text: r.text };
    out.status = judgePage(r);
    if (out.status === 'needs_confirmation') {
      out.note = 'The page asks for a confirmation click or a choice. Open final_url in a browser to finish.';
    } else if (out.status === 'page_opened') {
      out.note = 'The unsubscribe page opened without errors, but its text does not clearly confirm. Read page_text to judge.';
    }
  }

  if (args.after === 'trash' && ['unsubscribed', 'request_sent'].includes(out.status)) {
    try {
      const moved = await updateEmails({ account: acct.email, folder: ctx.folder, uids: [args.uid], action: 'trash' });
      out.email_moved_to = moved.moved_to;
    } catch (err) {
      out.warning = `Unsubscribed, but the email was not moved to trash: ${err.message}`;
    }
  }
  return out;
}

// ---- accounts -----------------------------------------------------------

export async function listAccounts(args = {}) {
  const list = accounts();
  const out = list.map((a, i) => ({
    account: a.email || `(mailbox #${a.id})`,
    provider: a.provider,
    main: i === 0,
    ready: !a.problem,
    ...(a.problem ? { problem: a.problem } : {}),
  }));
  if (args.check_login) {
    await Promise.all(list.map(async (a, i) => {
      if (a.problem) return;
      try {
        await withImap(a, async () => {});
        await smtpTransport(a).verify();
        out[i].login = 'ok';
      } catch (err) {
        out[i].login = 'failed';
        out[i].problem = err?.authenticationFailed || err?.code === 'EAUTH' ? 'The mail server rejected the address or password' : err?.message || String(err);
      }
    }));
  }
  return { accounts: out };
}
