import { cfg } from './config.js';

export function baseUrl(req) {
  const c = cfg();
  if (c.publicUrl) return c.publicUrl;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const proto = String(req.headers['x-forwarded-proto'] || (local ? 'http' : 'https')).split(',')[0].trim();
  return `${proto}://${host}`;
}

// Works both on Vercel (where req.body may already be parsed) and on a bare Node server.
export async function readBody(req) {
  let pre;
  try { pre = req.body; } catch { pre = undefined; }
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (pre !== undefined && pre !== null) {
    if (Buffer.isBuffer(pre)) return parseByType(pre.toString('utf8'), type);
    if (typeof pre === 'string') return parseByType(pre, type);
    return pre;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return parseByType(Buffer.concat(chunks).toString('utf8'), type);
}

function parseByType(text, type) {
  if (!text) return {};
  if (type.includes('application/json')) {
    try { return JSON.parse(text); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text); } catch { return Object.fromEntries(new URLSearchParams(text)); }
}

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};
