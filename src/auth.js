// OAuth 2.1 for a single owner, with no database.
//
// Who can get in: only someone who types OWNER_PASSPHRASE on the approval page,
// and the approval can only be delivered to Claude's own callback URL (or to a
// loopback address, which is how Claude Code on the owner's machine connects).
// Every token is an HMAC-signed blob. Changing OWNER_PASSPHRASE or the app
// password changes the signing key, which revokes every token at once.
import { createHmac, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { cfg, configProblems } from './config.js';
import { baseUrl, readBody, sendJson, sendHtml, esc, CORS } from './http-util.js';

const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 90 * 24 * 60 * 60; // 90 days, renewed on every refresh
const CODE_TTL = 120; // 2 minutes
const SCOPE = 'mail';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function signingKey() {
  const c = cfg();
  if (c.tokenSecret) return createHmac('sha256', 'icloud-mcp/v1/secret').update(c.tokenSecret).digest();
  return createHmac('sha256', 'icloud-mcp/v1').update(`${c.passphrase}\n${c.appPassword}`).digest();
}

export function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(createHmac('sha256', signingKey()).update(body).digest());
  return `v1.${body}.${mac}`;
}

export function verify(token, typ) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expected = createHmac('sha256', signingKey()).update(parts[1]).digest();
  let given;
  try { given = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (payload.typ !== typ) return null;
  if (typeof payload.exp !== 'number' || payload.exp < now()) return null;
  return payload;
}

export function redirectAllowed(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol === 'https:' && (u.host === 'claude.ai' || u.host === 'claude.com') && u.pathname === '/api/mcp/auth_callback') return true;
  // Claude Code: RFC 8252 loopback redirect on any port.
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return true;
  return false;
}

function isLoopback(uri) {
  try { return new URL(uri).protocol === 'http:'; } catch { return false; }
}

function passphraseOk(input) {
  const c = cfg();
  const a = createHash('sha256').update(String(input ?? '')).digest();
  const b = createHash('sha256').update(c.passphrase).digest();
  return timingSafeEqual(a, b) && configProblems().length === 0;
}

export function bearerPayload(req) {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  if (configProblems().length) return null;
  return verify(m[1].trim(), 'at');
}

export function challenge(req, res) {
  const base = baseUrl(req);
  sendJson(res, 401, { error: 'unauthorized', error_description: 'Sign in required' }, {
    ...CORS,
    'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="${SCOPE}"`,
  });
}

// ---- discovery ----------------------------------------------------------

export function protectedResourceMetadata(req, res) {
  const base = baseUrl(req);
  sendJson(res, 200, {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'iCloud Mail (private)',
  }, { ...CORS, 'Cache-Control': 'public, max-age=300' });
}

export function authServerMetadata(req, res) {
  const base = baseUrl(req);
  sendJson(res, 200, {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE, 'offline_access'],
    client_id_metadata_document_supported: true,
  }, { ...CORS, 'Cache-Control': 'public, max-age=300' });
}

// ---- dynamic client registration (stateless) ----------------------------

export async function register(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, e.status || 400, { error: 'invalid_client_metadata' }, CORS); }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!uris.length || !uris.every(redirectAllowed)) {
    return sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'This server only accepts Claude callback URLs' }, CORS);
  }
  sendJson(res, 201, {
    client_id: `dcr_${randomUUID()}`,
    client_id_issued_at: now(),
    client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : 'Claude',
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, CORS);
}

// ---- authorization page -------------------------------------------------

const FIELDS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];

function page(title, inner) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
body{font:16px/1.45 -apple-system,system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:24px;display:flex;justify-content:center}
main{max-width:420px;width:100%;margin-top:8vh}
h1{font-size:22px;margin:0 0 12px}
p{margin:0 0 14px;color:#bbb}
code{background:#222;padding:2px 6px;border-radius:6px;color:#eee;word-break:break-all}
input{width:100%;box-sizing:border-box;font-size:16px;padding:12px;border-radius:10px;border:1px solid #444;background:#1b1b1b;color:#eee;margin:6px 0 14px}
button{width:100%;font-size:16px;padding:12px;border-radius:10px;border:0;background:#d97757;color:#111;font-weight:600}
.err{color:#ff8080}.warn{color:#e8c268}
</style></head><body><main>${inner}</main></body></html>`;
}

function validateAuthParams(p) {
  if (!p.redirect_uri || !redirectAllowed(p.redirect_uri)) return { fatal: 'Адрес возврата не принадлежит Claude. Запрос отклонён.' };
  if (p.response_type !== 'code') return { error: 'unsupported_response_type' };
  if (!p.client_id) return { error: 'invalid_request', description: 'client_id is required' };
  if (!p.code_challenge || (p.code_challenge_method || 'plain') !== 'S256') return { error: 'invalid_request', description: 'PKCE with S256 is required' };
  return null;
}

function redirectWith(res, redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store' });
  res.end();
}

function renderForm(res, p, errorText) {
  const host = new URL(p.redirect_uri).host;
  const hidden = FIELDS.map((f) => `<input type="hidden" name="${f}" value="${esc(p[f] ?? '')}">`).join('');
  sendHtml(res, errorText ? 401 : 200, page('Доступ к почте', `
<h1>Доступ к почте</h1>
<p>Запрос на подключение к почтовому ящику этого сервера.</p>
<p>После входа доступ уйдёт на <code>${esc(host)}</code>.</p>
${isLoopback(p.redirect_uri) ? '<p class="warn">Это локальный адрес на компьютере. Подтверждай, только если сам сейчас подключаешь Claude Code.</p>' : ''}
<p>Вводи пароль, только если сам только что нажал «Подключить» в Claude.</p>
${errorText ? `<p class="err">${esc(errorText)}</p>` : ''}
<form method="post" action="/authorize" autocomplete="off">
${hidden}
<input type="password" name="passphrase" placeholder="Пароль владельца" autofocus required>
<button type="submit">Разрешить</button>
</form>`));
}

export async function authorize(req, res, query) {
  const problems = configProblems();
  if (problems.length) {
    return sendHtml(res, 503, page('Сервер не настроен', `<h1>Сервер не настроен</h1><p>${problems.map(esc).join('<br>')}</p>`));
  }
  let p = query;
  let passphrase;
  if (req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { body = {}; }
    p = Object.fromEntries(FIELDS.map((f) => [f, typeof body[f] === 'string' ? body[f] : '']));
    passphrase = body.passphrase;
  } else {
    p = Object.fromEntries(FIELDS.map((f) => [f, typeof p[f] === 'string' ? p[f] : '']));
  }

  const bad = validateAuthParams(p);
  if (bad?.fatal) return sendHtml(res, 400, page('Отклонено', `<h1>Отклонено</h1><p>${esc(bad.fatal)}</p>`));
  if (bad) return redirectWith(res, p.redirect_uri, { error: bad.error, error_description: bad.description, state: p.state });

  if (req.method !== 'POST') return renderForm(res, p);

  if (!passphraseOk(passphrase)) {
    await new Promise((r) => setTimeout(r, 1500)); // slows guessing
    return renderForm(res, p, 'Неверный пароль.');
  }

  const code = sign({
    typ: 'code',
    exp: now() + CODE_TTL,
    cid: p.client_id,
    ru: p.redirect_uri,
    cc: p.code_challenge,
    jti: randomUUID(),
  });
  redirectWith(res, p.redirect_uri, { code, state: p.state });
}

// ---- token endpoint -----------------------------------------------------

function issueTokens(res, clientId) {
  const iat = now();
  const access = sign({ typ: 'at', exp: iat + ACCESS_TTL, iat, cid: clientId, scope: SCOPE, jti: randomUUID() });
  const refresh = sign({ typ: 'rt', exp: iat + REFRESH_TTL, iat, cid: clientId, jti: randomUUID() });
  sendJson(res, 200, {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: refresh,
    scope: SCOPE,
  }, { ...CORS, Pragma: 'no-cache' });
}

export async function token(req, res) {
  if (configProblems().length) return sendJson(res, 503, { error: 'temporarily_unavailable' }, CORS);
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid_request' }, CORS); }
  const grant = body.grant_type;

  if (grant === 'authorization_code') {
    const c = verify(body.code, 'code');
    if (!c) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'Code is invalid or expired' }, CORS);
    if (body.client_id && body.client_id !== c.cid) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'client_id mismatch' }, CORS);
    if (body.redirect_uri && body.redirect_uri !== c.ru) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, CORS);
    const verifier = String(body.code_verifier || '');
    const digest = createHash('sha256').update(verifier).digest('base64url');
    if (!verifier || digest !== c.cc) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' }, CORS);
    return issueTokens(res, c.cid);
  }

  if (grant === 'refresh_token') {
    const r = verify(body.refresh_token, 'rt');
    if (!r) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'Refresh token is invalid or expired' }, CORS);
    if (body.client_id && body.client_id !== r.cid) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'client_id mismatch' }, CORS);
    return issueTokens(res, r.cid);
  }

  sendJson(res, 400, { error: 'unsupported_grant_type' }, CORS);
}
