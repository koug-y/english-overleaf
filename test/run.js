// End-to-end test. Everything runs in this one process:
// a strict test IMAP server (hoodiecrow), an SMTP sink, a fake "newsletter"
// website for unsubscribe links, and the MCP server itself, driven through
// the real OAuth flow and the official MCP client.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
const hoodiecrow = require('hoodiecrow-imap');
const { SMTPServer } = require('smtp-server');

const ME = 'me@example.test';
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
const PASSPHRASE = 'correct horse battery staple';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const ME2 = 'work@corp.example';
const PASS2 = 'pw-two-xyz-123';

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}\n      ${err.stack || err}`);
    process.exitCode = 1;
    throw err;
  }
}
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// ---- test IMAP server -----------------------------------------------------
const imap = hoodiecrow({
  plugins: ['ID', 'SASL-IR', 'AUTH-PLAIN', 'NAMESPACE', 'IDLE', 'ENABLE', 'UNSELECT', 'SPECIAL-USE', 'MOVE', 'UIDPLUS', 'LITERALPLUS'],
  users: { [ME]: { password: APP_PASSWORD } },
  storage: {
    INBOX: { messages: [] },
    '': {
      separator: '/',
      folders: {
        'Sent Messages': { 'special-use': '\\Sent' },
        Drafts: { 'special-use': '\\Drafts' },
        'Deleted Messages': { 'special-use': '\\Trash' },
        Junk: { 'special-use': '\\Junk' },
        Archive: { 'special-use': '\\Archive' },
        Receipts: {},
      },
    },
  },
});
const imapPort = await new Promise((resolve) => imap.listen(0, () => resolve(imap.address().port)));

// Second mailbox, laid out the way Gmail lays out its folders.
const imap2 = hoodiecrow({
  plugins: ['ID', 'SASL-IR', 'AUTH-PLAIN', 'NAMESPACE', 'IDLE', 'ENABLE', 'UNSELECT', 'SPECIAL-USE', 'MOVE', 'UIDPLUS', 'LITERALPLUS'],
  users: { [ME2]: { password: PASS2 } },
  storage: {
    INBOX: { messages: [] },
    '': {
      separator: '/',
      folders: {
        '[Gmail]': {
          flags: ['\\Noselect'],
          folders: {
            'All Mail': { 'special-use': '\\All' },
            Drafts: { 'special-use': '\\Drafts' },
            'Sent Mail': { 'special-use': '\\Sent' },
            Spam: { 'special-use': '\\Junk' },
            Trash: { 'special-use': '\\Trash' },
          },
        },
      },
    },
  },
});
const imap2Port = await new Promise((resolve) => imap2.listen(0, () => resolve(imap2.address().port)));

function rawImap(second = false) {
  const c = new ImapFlow({ host: '127.0.0.1', port: second ? imap2Port : imapPort, secure: false, auth: second ? { user: ME2, pass: PASS2 } : { user: ME, pass: APP_PASSWORD }, logger: false });
  c.on('error', () => {});
  return c;
}
async function folderMessages(path, second = false) {
  const c = rawImap(second);
  await c.connect();
  const lock = await c.getMailboxLock(path);
  const out = [];
  try {
    if (c.mailbox.exists) {
      for await (const m of c.fetch('1:*', { uid: true, envelope: true, flags: true, source: true })) {
        out.push({ uid: m.uid, subject: m.envelope.subject, flags: [...m.flags], source: m.source.toString('utf8') });
      }
    }
  } finally { lock.release(); await c.logout(); }
  return out;
}

// ---- SMTP sink --------------------------------------------------------------
const outbox = [];
const smtp = new SMTPServer({
  secure: false,
  disabledCommands: ['STARTTLS'],
  allowInsecureAuth: true,
  onAuth(auth, session, cb) {
    if (auth.username === ME && auth.password === APP_PASSWORD) return cb(null, { user: ME });
    if (auth.username === ME2 && auth.password === PASS2) return cb(null, { user: ME2 });
    cb(new Error('Invalid login'));
  },
  onData(stream, session, cb) {
    const chunks = [];
    stream.on('data', (ch) => chunks.push(ch));
    stream.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const to = session.envelope.rcptTo.map((r) => r.address);
      outbox.push({ from: session.envelope.mailFrom.address, to, raw: raw.toString('utf8') });
      try {
        if (to.includes(ME)) {
          const c = rawImap();
          await c.connect();
          await c.append('INBOX', raw, []);
          await c.logout();
        }
        if (to.includes(ME2) || session.user === ME2) {
          const c = rawImap(true);
          await c.connect();
          if (to.includes(ME2)) await c.append('INBOX', raw, []);
          // Like Gmail: whatever this mailbox sends is filed in its Sent folder by the provider.
          if (session.user === ME2) await c.append('[Gmail]/Sent Mail', raw, ['\\Seen']);
          await c.logout();
        }
        cb();
      } catch (err) { cb(err); }
    });
  },
});
const smtpPort = await listen(smtp.server);

// ---- fake newsletter website ----------------------------------------------
const hits = [];
const site = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const body = Buffer.concat(chunks).toString('utf8');
  hits.push({ method: req.method, url: req.url, body, type: req.headers['content-type'] });
  const html = (text) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<html><head><title>Shop</title></head><body>${text}</body></html>`); };
  if (req.url.startsWith('/oneclick') && req.method === 'POST') return html('ok');
  if (req.url.startsWith('/oneclick-broken')) { res.writeHead(500); return res.end('nope'); }
  if (req.url.startsWith('/done')) return html('<h1>You have been unsubscribed</h1>');
  if (req.url.startsWith('/confirm')) return html('<p>Please confirm.</p><form method="post"><button>Confirm unsubscribe</button></form>');
  if (req.url.startsWith('/body-unsub')) { res.writeHead(302, { Location: '/ru-done' }); return res.end(); }
  if (req.url.startsWith('/ru-done')) return html('<p>Вы отписаны от рассылки.</p>');
  res.writeHead(404); res.end('missing');
});
const sitePort = await listen(site);
const SITE = `http://127.0.0.1:${sitePort}`;

// ---- the server under test --------------------------------------------------
Object.assign(process.env, {
  ICLOUD_EMAIL: ME,
  ICLOUD_APP_PASSWORD: APP_PASSWORD,
  OWNER_PASSPHRASE: PASSPHRASE,
  FROM_NAME: 'Test Owner',
  IMAP_HOST: '127.0.0.1', IMAP_PORT: String(imapPort), IMAP_SECURE: '0',
  SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_SECURE: '0', SMTP_REQUIRE_TLS: '0',
  ALLOW_PRIVATE_HTTP: '1',
  MAIL2_EMAIL: ME2, MAIL2_PASSWORD: PASS2,
  MAIL2_IMAP_HOST: '127.0.0.1', MAIL2_IMAP_PORT: String(imap2Port), MAIL2_IMAP_SECURE: '0',
  MAIL2_SMTP_HOST: '127.0.0.1', MAIL2_SMTP_PORT: String(smtpPort), MAIL2_SMTP_SECURE: '0', MAIL2_SMTP_REQUIRE_TLS: '0',
  MAIL3_EMAIL: 'someone@gmail.com',
  MAIL4_EMAIL: 'someone@outlook.com', MAIL4_PASSWORD: 'x',
  MAIL5_EMAIL: 'student@uni.example', MAIL5_PASSWORD: 'x',
});
const { handle } = await import('../src/app.js');
const { safeRequest } = await import('../src/unsubscribe.js');
const { sign } = await import('../src/auth.js');
const { accounts } = await import('../src/config.js');

const plain = http.createServer(handle);
const plainPort = await listen(plain);

// Same app behind an emulation of Vercel: path rewritten to /api/index?__path=..., body already parsed.
const vercelLike = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  u.searchParams.set('__path', u.pathname);
  req.url = `/api/index?${u.searchParams.toString()}`;
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '');
  let body;
  if (raw) body = type.includes('json') ? JSON.parse(raw) : type.includes('urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : raw;
  Object.defineProperty(req, 'body', { get: () => body });
  handle(req, res);
});
const vercelPort = await listen(vercelLike);

// ---- seed mail --------------------------------------------------------------
const seedTransport = nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true, auth: { user: ME, pass: APP_PASSWORD } });
const seed = (m) => seedTransport.sendMail({ to: ME, ...m });
await seed({ from: 'Shop News <news@shop.example>', subject: 'Big sale week 1', html: '<p>Sale!</p>', headers: { 'List-Unsubscribe': `<${SITE}/oneclick?id=A>, <mailto:unsub@lists.example.test?subject=unsubscribe-A>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
await seed({ from: 'Shop News <news@shop.example>', subject: 'Big sale week 2', html: '<p>More sale!</p>', headers: { 'List-Unsubscribe': `<${SITE}/oneclick?id=A2>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
await seed({ from: 'Digest <digest@lists.example.test>', subject: 'Weekly digest', text: 'digest body', headers: { 'List-Unsubscribe': '<mailto:unsub@lists.example.test?subject=Unsub%20B&body=please%20remove>' } });
await seed({ from: 'Blog <blog@blog.example>', subject: 'New post', text: 'post', headers: { 'List-Unsubscribe': `<${SITE}/done?u=1>` } });
await seed({ from: 'Forum <forum@forum.example>', subject: 'Forum updates', text: 'updates', headers: { 'List-Unsubscribe': `<${SITE}/confirm?u=1>` } });
await seed({ from: 'Promo <promo@promo.example>', subject: 'Скидки недели', html: `<p>Только сегодня</p><p><a href="${SITE}/home">Сайт</a> <a href="${SITE}/body-unsub?t=9&amp;x=1">Отписаться от рассылки</a></p>` });
await seed({ from: 'Dana Lee <dana@example.org>', replyTo: 'dana.reply@example.org', cc: 'Sam <sam@example.org>', subject: 'Lunch tomorrow?', text: 'Hi! Are you free for lunch tomorrow at 13:00?', messageId: '<lunch-1@example.org>', attachments: [{ filename: 'menu.txt', content: 'soup, salad' }] });
await seed({ from: 'Бухгалтерия <buh@firma.example>', subject: 'Счёт за ноябрь', text: 'Привет, высылаю счёт за ноябрь. Сумма 15000.' });
await seed({ from: 'Bank <bank@bank.example>', subject: 'Statement', html: `<html><body><table><tr><td><h1>Your statement</h1><p>Balance is fine.</p>${'<p>Line of long html content.</p>'.repeat(40)}<a href="https://bank.example/view">View online</a></td></tr></table></body></html>`, text: 'View in browser' });
await seed({ from: 'Plain <plain@nowhere.example>', subject: 'No unsubscribe here', text: 'Just a note.' });
const SEEDED = 10;
await seedTransport.sendMail({ to: ME2, from: 'Boss <boss@corp.example>', subject: 'Work report', text: 'Please send the report by Friday.', messageId: '<report-1@corp.example>' });
await seedTransport.sendMail({ to: ME2, from: 'Team Digest <team@lists.corp.example>', subject: 'Team digest', text: 'digest', headers: { 'List-Unsubscribe': '<mailto:leave@lists.corp.example?subject=leave>' } });

// ---- OAuth ------------------------------------------------------------------
async function oauthSuite(base) {
  const j = async (path, init) => {
    const r = await fetch(base + path, init);
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { r, text, json };
  };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString(), redirect: 'manual' });
  let clientId; let code; let tokens;

  await step('unauthenticated /mcp gets 401 with a resource_metadata pointer', async () => {
    const { r } = await j('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource"`));
    const get = await j('/mcp');
    assert.equal(get.r.status, 401);
  });
  await step('discovery documents match what Claude requires', async () => {
    const prm = await j('/.well-known/oauth-protected-resource');
    assert.equal(prm.json.resource, `${base}/mcp`);
    assert.deepEqual(prm.json.authorization_servers, [base]);
    assert.equal((await j('/.well-known/oauth-protected-resource/mcp')).json.resource, `${base}/mcp`);
    const as = await j('/.well-known/oauth-authorization-server');
    assert.equal(as.json.issuer, base);
    assert.deepEqual(as.json.code_challenge_methods_supported, ['S256']);
    assert.ok(as.json.token_endpoint_auth_methods_supported.includes('none'));
    assert.equal(as.json.registration_endpoint, `${base}/register`);
    assert.equal(as.json.client_id_metadata_document_supported, true);
  });
  await step('registration refuses foreign redirect URIs and accepts Claude ones', async () => {
    const bad = await j('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
    assert.equal(bad.r.status, 400);
    assert.equal(bad.json.error, 'invalid_redirect_uri');
    const mixed = await j('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK, 'https://claude.ai.evil.example/api/mcp/auth_callback'] }) });
    assert.equal(mixed.r.status, 400);
    const ok = await j('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK] }) });
    assert.equal(ok.r.status, 201);
    clientId = ok.json.client_id;
    const code2 = await j('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost:3118/callback', 'http://127.0.0.1:50001/callback'] }) });
    assert.equal(code2.r.status, 201);
  });
  const params = () => ({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', scope: 'mail', resource: `${base}/mcp` });
  await step('authorize page: form shown, foreign redirect refused, PKCE required', async () => {
    const page = await j(`/authorize?${new URLSearchParams(params())}`);
    assert.equal(page.r.status, 200);
    assert.match(page.text, /name="passphrase"/);
    assert.match(page.text, /claude\.ai/);
    assert.ok(!page.text.includes(ME), 'the page must not reveal the mailbox address');
    const evil = await j(`/authorize?${new URLSearchParams({ ...params(), redirect_uri: 'https://evil.example/cb' })}`, { redirect: 'manual' });
    assert.equal(evil.r.status, 400);
    assert.equal(evil.r.headers.get('location'), null);
    const xss = await j(`/authorize?${new URLSearchParams({ ...params(), state: '"><script>alert(1)</script>' })}`);
    assert.ok(!xss.text.includes('<script>alert(1)</script>'));
    const noPkce = await j(`/authorize?${new URLSearchParams({ ...params(), code_challenge: '' })}`, { redirect: 'manual' });
    assert.equal(noPkce.r.status, 302);
    assert.match(noPkce.r.headers.get('location'), /error=invalid_request/);
  });
  await step('wrong passphrase is refused, right one redirects to Claude with a code', async () => {
    const t0 = Date.now();
    const wrong = await j('/authorize', form({ ...params(), passphrase: 'not the passphrase' }));
    assert.equal(wrong.r.status, 401);
    assert.equal(wrong.r.headers.get('location'), null);
    assert.ok(Date.now() - t0 >= 1400, 'a failed attempt must be delayed');
    const empty = await j('/authorize', form({ ...params(), passphrase: '' }));
    assert.equal(empty.r.status, 401);
    const right = await j('/authorize', form({ ...params(), passphrase: PASSPHRASE }));
    assert.equal(right.r.status, 302);
    const loc = new URL(right.r.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, CALLBACK);
    assert.equal(loc.searchParams.get('state'), 'st-123');
    code = loc.searchParams.get('code');
    assert.ok(code);
  });
  await step('token endpoint: PKCE enforced, tokens issued, refresh works, junk refused', async () => {
    const badVerifier = await j('/token', form({ grant_type: 'authorization_code', code, code_verifier: 'wrong', client_id: clientId, redirect_uri: CALLBACK }));
    assert.equal(badVerifier.r.status, 400);
    assert.equal(badVerifier.json.error, 'invalid_grant');
    const otherClient = await j('/token', form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: 'someone-else', redirect_uri: CALLBACK }));
    assert.equal(otherClient.json.error, 'invalid_grant');
    const ok = await j('/token', form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CALLBACK }));
    assert.equal(ok.r.status, 200);
    assert.equal(ok.json.token_type, 'Bearer');
    assert.ok(ok.json.access_token && ok.json.refresh_token && ok.json.expires_in > 0);
    tokens = ok.json;
    const refreshed = await j('/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
    assert.equal(refreshed.r.status, 200);
    assert.notEqual(refreshed.json.refresh_token, tokens.refresh_token);
    const junk = await j('/token', form({ grant_type: 'refresh_token', refresh_token: 'v1.abc.def' }));
    assert.equal(junk.json.error, 'invalid_grant');
    const accessAsRefresh = await j('/token', form({ grant_type: 'refresh_token', refresh_token: tokens.access_token }));
    assert.equal(accessAsRefresh.json.error, 'invalid_grant');
    const codeAsAccess = await j('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${code}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(codeAsAccess.r.status, 401);
  });
  await step('tampered, expired and foreign-key tokens are refused', async () => {
    const call = (t) => j('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal((await call(tokens.access_token)).r.status, 200);
    const parts = tokens.access_token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ typ: 'at', exp: 9999999999, cid: 'x' })).toString('base64url');
    assert.equal((await call(`${parts[0]}.${forgedBody}.${parts[2]}`)).r.status, 401);
    assert.equal((await call(sign({ typ: 'at', exp: Math.floor(Date.now() / 1000) - 5, cid: 'x' }))).r.status, 401);
    process.env.OWNER_PASSPHRASE = 'a different passphrase entirely';
    assert.equal((await call(tokens.access_token)).r.status, 401, 'changing the passphrase must revoke tokens');
    process.env.OWNER_PASSPHRASE = PASSPHRASE;
    assert.equal((await call(tokens.access_token)).r.status, 200);
    process.env.OWNER_PASSPHRASE = 'short';
    assert.equal((await call(tokens.access_token)).r.status, 401, 'a too-short passphrase must lock the server');
    const locked = await j(`/authorize?${new URLSearchParams(params())}`);
    assert.equal(locked.r.status, 503);
    process.env.OWNER_PASSPHRASE = PASSPHRASE;
  });
  return tokens;
}

async function connect(base, accessToken) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    if (r.isError) throw new Error(text);
    return JSON.parse(text);
  };
  const callRaw = (name, args = {}) => client.callTool({ name, arguments: args });
  return { client, call, callRaw };
}

// ---- run --------------------------------------------------------------------
try {
  console.log('OAuth, plain Node server');
  const base = `http://127.0.0.1:${plainPort}`;
  const tokens = await oauthSuite(base);

  console.log('OAuth, Vercel-style routing and body parsing');
  const vbase = `http://127.0.0.1:${vercelPort}`;
  const vtokens = await oauthSuite(vbase);

  console.log('Mail tools');
  const { client, call, callRaw } = await connect(base, tokens.access_token);
  const uidOf = async (subject, folder) => {
    const r = await call('search_emails', { subject, folder });
    assert.ok(r.emails.length >= 1, `no email with subject ${subject}`);
    return r.emails[0].uid;
  };

  await step('initialize carries the untrusted-content instruction; 9 tools listed', async () => {
    assert.match(client.getInstructions(), /untrusted/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['create_draft', 'list_accounts', 'list_folders', 'list_subscriptions', 'read_email', 'search_emails', 'send_email', 'unsubscribe', 'update_emails']);
    assert.equal(tools.find((t) => t.name === 'search_emails').annotations.readOnlyHint, true);
  });
  await step('list_folders maps iCloud-style names to roles', async () => {
    const { folders } = await call('list_folders');
    const role = Object.fromEntries(folders.map((f) => [f.role, f.path]));
    assert.equal(role.sent, 'Sent Messages');
    assert.equal(role.trash, 'Deleted Messages');
    assert.equal(role.drafts, 'Drafts');
    assert.equal(folders.find((f) => f.path === 'INBOX').messages, SEEDED);
    assert.equal(folders.find((f) => f.path === 'INBOX').unread, SEEDED);
  });
  await step('search_emails: latest first, paging, filters, free text, Cyrillic', async () => {
    const all = await call('search_emails', {});
    assert.equal(all.total_matches, SEEDED);
    assert.equal(all.emails[0].subject, 'No unsubscribe here');
    assert.ok(all.emails[0].uid > all.emails[1].uid);
    const page = await call('search_emails', { limit: 3, offset: 3 });
    assert.equal(page.returned, 3);
    assert.equal(page.emails[0].uid, all.emails[3].uid);
    const from = await call('search_emails', { from: 'shop.example' });
    assert.equal(from.total_matches, 2);
    assert.ok(from.emails.every((e) => e.can_unsubscribe));
    const q = await call('search_emails', { query: 'lunch' });
    assert.equal(q.total_matches, 1);
    assert.equal(q.emails[0].has_attachments, true);
    assert.equal(q.emails[0].can_unsubscribe, false);
    const body = await call('search_emails', { query: 'at 13:00' });
    assert.equal(body.emails[0].subject, 'Lunch tomorrow?');
    // The test IMAP server compares raw header bytes and does not decode non-ASCII headers,
    // so this only proves that a UTF-8 search is sent in a form a strict server accepts.
    const ru = await call('search_emails', { query: 'счёт' });
    assert.ok(Array.isArray(ru.emails));
    const invoice = await call('search_emails', { from: 'firma.example' });
    assert.equal(invoice.emails[0].subject, 'Счёт за ноябрь');
    assert.equal(invoice.emails[0].from, 'Бухгалтерия <buh@firma.example>');
    assert.match((await call('read_email', { uid: invoice.emails[0].uid })).body, /высылаю счёт за ноябрь/);
    const none = await call('search_emails', { since: '2099-01-01' });
    assert.equal(none.total_matches, 0);
    const today = await call('search_emails', { since: new Date(Date.now() - 86400000).toISOString().slice(0, 10) });
    assert.equal(today.total_matches, SEEDED);
    const bad = await callRaw('search_emails', { since: 'not-a-date' });
    assert.equal(bad.isError, true);
    const missing = await callRaw('search_emails', { folder: 'Nope' });
    assert.match(missing.content[0].text, /Folder not found/);
  });
  await step('read_email: text, attachments, html to text, truncation, read flag untouched', async () => {
    const lunch = await call('read_email', { uid: await uidOf('Lunch tomorrow') });
    assert.match(lunch.body, /free for lunch/);
    assert.equal(lunch.from, 'Dana Lee <dana@example.org>');
    assert.equal(lunch.reply_to, 'dana.reply@example.org');
    assert.match(lunch.cc, /sam@example\.org/);
    assert.deepEqual(lunch.attachments.map((a) => a.filename), ['menu.txt']);
    assert.equal(lunch.unread, true);
    assert.equal((await call('search_emails', { subject: 'Lunch tomorrow' })).emails[0].unread, true, 'reading must not mark as read');
    const bank = await call('read_email', { uid: await uidOf('Statement'), max_chars: 600 });
    assert.match(bank.body, /YOUR STATEMENT|Your statement/);
    assert.equal(bank.body_truncated, true);
    assert.ok(bank.body_total_chars > 600 && bank.body.length === 600);
    const shop = await call('read_email', { uid: await uidOf('Big sale week 1'), mark_read: true });
    assert.deepEqual(shop.unsubscribe_methods, ['one_click', 'mailto', 'link']);
    assert.equal((await call('search_emails', { subject: 'Big sale week 1' })).emails[0].unread, false);
    const gone = await callRaw('read_email', { uid: 99999 });
    assert.equal(gone.isError, true);
  });
  await step('send_email: delivered, Bcc hidden from recipients, copy saved to Sent with Bcc', async () => {
    outbox.length = 0;
    const r = await call('send_email', { to: ['friend@example.org'], cc: ['cc@example.org'], bcc: ['secret@example.org'], subject: 'Привет из теста', body: 'Тело письма.' });
    assert.equal(r.status, 'sent');
    assert.equal(r.saved_to, 'Sent Messages');
    assert.equal(outbox.length, 1);
    assert.deepEqual(outbox[0].to.sort(), ['cc@example.org', 'friend@example.org', 'secret@example.org']);
    assert.equal(outbox[0].from, ME);
    assert.ok(!/secret@example\.org/.test(outbox[0].raw), 'Bcc must not be in the message other recipients get');
    assert.match(outbox[0].raw, /From: Test Owner <me@example\.test>/);
    const sent = await folderMessages('Sent Messages');
    assert.equal(sent.length, 1);
    assert.match(sent[0].source, /Bcc: secret@example\.org/);
    assert.ok(sent[0].flags.includes('\\Seen'));
    const noRcpt = await callRaw('send_email', { body: 'x', subject: 'y' });
    assert.match(noRcpt.content[0].text, /No recipients/);
  });
  await step('reply: goes to Reply-To, threads, quotes, marks the original answered; reply_all adds Cc', async () => {
    outbox.length = 0;
    const uid = await uidOf('Lunch tomorrow');
    const r = await call('send_email', { reply_to_uid: uid, body: 'Yes, 13:00 works.' });
    assert.equal(r.subject, 'Re: Lunch tomorrow?');
    assert.deepEqual(outbox[0].to, ['dana.reply@example.org']);
    assert.match(outbox[0].raw, /In-Reply-To: <lunch-1@example\.org>/);
    assert.match(outbox[0].raw, /References: <lunch-1@example\.org>/);
    assert.match(outbox[0].raw, /> Hi! Are you free for lunch/);
    const c = rawImap(); await c.connect();
    const lock = await c.getMailboxLock('INBOX');
    const orig = await c.fetchOne(String(uid), { flags: true }, { uid: true });
    lock.release(); await c.logout();
    assert.ok(orig.flags.has('\\Answered'));
    outbox.length = 0;
    await call('send_email', { reply_to_uid: uid, reply_all: true, quote_original: false, body: 'See you all.' });
    assert.deepEqual(outbox[0].to.sort(), ['dana.reply@example.org', 'sam@example.org']);
    assert.ok(!/> Hi!/.test(outbox[0].raw));
  });
  await step('create_draft: saved to Drafts with the Draft flag, nothing sent', async () => {
    outbox.length = 0;
    const r = await call('create_draft', { to: ['boss@example.org'], subject: 'Draft subject', body: 'Draft body' });
    assert.equal(r.status, 'draft_saved');
    assert.equal(r.folder, 'Drafts');
    assert.equal(outbox.length, 0);
    const drafts = await folderMessages('Drafts');
    assert.equal(drafts.length, 1);
    assert.ok(drafts[0].flags.includes('\\Draft'));
    assert.equal((await call('search_emails', { folder: 'drafts' })).emails[0].subject, 'Draft subject');
  });
  await step('update_emails: flags, archive, move, trash', async () => {
    const a = await uidOf('Statement');
    const b = await uidOf('No unsubscribe here');
    await call('update_emails', { uids: [a, b], action: 'mark_read' });
    await call('update_emails', { uids: [a], action: 'flag' });
    let s = (await call('search_emails', { subject: 'Statement' })).emails[0];
    assert.equal(s.unread, false); assert.equal(s.flagged, true);
    await call('update_emails', { uids: [a], action: 'mark_unread' });
    await call('update_emails', { uids: [a], action: 'unflag' });
    s = (await call('search_emails', { subject: 'Statement' })).emails[0];
    assert.equal(s.unread, true); assert.equal(s.flagged, false);
    assert.equal((await call('search_emails', { unread_only: true })).emails.some((e) => e.uid === b), false);
    const arch = await call('update_emails', { uids: [a], action: 'archive' });
    assert.equal(arch.moved_to, 'Archive');
    assert.equal((await call('search_emails', { subject: 'Statement' })).total_matches, 0);
    const inArchive = await uidOf('Statement', 'archive');
    await call('update_emails', { uids: [inArchive], folder: 'archive', action: 'move', destination: 'Receipts' });
    assert.equal((await call('search_emails', { folder: 'Receipts' })).total_matches, 1);
    const tr = await call('update_emails', { uids: [b], action: 'trash' });
    assert.equal(tr.moved_to, 'Deleted Messages');
    assert.equal((await folderMessages('Deleted Messages')).length, 1);
    const needDest = await callRaw('update_emails', { uids: [1], action: 'move' });
    assert.match(needDest.content[0].text, /destination is required/);
  });
  await step('list_subscriptions groups senders that can be unsubscribed from', async () => {
    const r = await call('list_subscriptions', {});
    const by = Object.fromEntries(r.senders.map((s) => [s.sender, s]));
    assert.equal(r.senders[0].sender, 'Shop News <news@shop.example>');
    assert.equal(by['Shop News <news@shop.example>'].emails, 2);
    assert.equal(by['Shop News <news@shop.example>'].latest_subject, 'Big sale week 2');
    assert.deepEqual(by['Digest <digest@lists.example.test>'].methods, ['mailto']);
    assert.deepEqual(by['Blog <blog@blog.example>'].methods, ['link']);
    assert.ok(!r.senders.some((s) => /dana|promo/.test(s.sender)));
    assert.equal(r.senders.length, 4);
  });
  await step('unsubscribe one_click: RFC 8058 POST reaches the sender; email trashed on request', async () => {
    hits.length = 0;
    const uid = await uidOf('Big sale week 2');
    const info = await call('unsubscribe', { uid, method: 'inspect' });
    assert.equal(info.status, 'inspected');
    assert.equal(hits.length, 0, 'inspect must not call anything');
    const r = await call('unsubscribe', { uid, after: 'trash' });
    assert.equal(r.status, 'unsubscribed');
    assert.equal(r.attempt.method, 'one_click');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].method, 'POST');
    assert.equal(hits[0].url, '/oneclick?id=A2');
    assert.equal(hits[0].body, 'List-Unsubscribe=One-Click');
    assert.match(hits[0].type, /x-www-form-urlencoded/);
    assert.equal(r.email_moved_to, 'Deleted Messages');
    assert.equal((await call('search_emails', { subject: 'Big sale week 2' })).total_matches, 0);
  });
  await step('unsubscribe mailto: sends the email the sender asked for', async () => {
    outbox.length = 0;
    const r = await call('unsubscribe', { uid: await uidOf('Weekly digest') });
    assert.equal(r.status, 'request_sent');
    assert.deepEqual(outbox[0].to, ['unsub@lists.example.test']);
    assert.match(outbox[0].raw, /Subject: Unsub B/);
    assert.match(outbox[0].raw, /please remove/);
    outbox.length = 0;
    const forced = await call('unsubscribe', { uid: await uidOf('Big sale week 1'), method: 'mailto' });
    assert.equal(forced.status, 'request_sent');
    assert.match(outbox[0].raw, /Subject: unsubscribe-A/);
  });
  await step('unsubscribe link: confirmed page, confirmation-needed page, body link with redirect', async () => {
    hits.length = 0;
    const done = await call('unsubscribe', { uid: await uidOf('New post') });
    assert.equal(done.status, 'unsubscribed');
    assert.equal(hits[0].method, 'GET');
    const confirm = await call('unsubscribe', { uid: await uidOf('Forum updates') });
    assert.equal(confirm.status, 'needs_confirmation');
    assert.equal(confirm.attempt.final_url, `${SITE}/confirm?u=1`);
    hits.length = 0;
    const promo = await call('unsubscribe', { uid: (await call('search_emails', { from: 'promo.example' })).emails[0].uid });
    assert.deepEqual(promo.available_methods, ['body_link']);
    assert.equal(promo.status, 'unsubscribed');
    assert.equal(promo.attempt.final_url, `${SITE}/ru-done`);
    assert.equal(hits[0].url, '/body-unsub?t=9&x=1');
    const none = await call('unsubscribe', { uid: await uidOf('Lunch tomorrow') });
    assert.equal(none.status, 'no_unsubscribe_info');
    const wrong = await callRaw('unsubscribe', { uid: await uidOf('Weekly digest'), method: 'one_click' });
    assert.match(wrong.content[0].text, /not available/);
  });
  await step('outbound requests refuse private and local addresses outside tests', async () => {
    process.env.ALLOW_PRIVATE_HTTP = '';
    await assert.rejects(() => safeRequest(`${SITE}/done`), /private or local/);
    await assert.rejects(() => safeRequest('http://169.254.169.254/latest/meta-data/'), /private or local/);
    await assert.rejects(() => safeRequest('http://[::1]:80/'), /private or local/);
    await assert.rejects(() => safeRequest('http://localhost:1/'), /private or local/);
    await assert.rejects(() => safeRequest('file:///etc/passwd'), /non-http/);
    process.env.ALLOW_PRIVATE_HTTP = '1';
  });
  await step('several mailboxes: listing, presets, problems that do not lock the server', async () => {
    const { accounts: list } = await call('list_accounts', {});
    const by = Object.fromEntries(list.map((a) => [a.account, a]));
    assert.equal(list.length, 5);
    assert.equal(by[ME].main, true);
    assert.equal(by[ME].ready, true);
    assert.equal(by[ME2].ready, true);
    assert.match(by['someone@gmail.com'].problem, /MAIL3_PASSWORD is not set/);
    assert.match(by['someone@outlook.com'].problem, /Microsoft mailboxes/);
    assert.match(by['student@uni.example'].problem, /MAIL5_PROVIDER/);
    const checked = await call('list_accounts', { check_login: true });
    assert.equal(checked.accounts.find((a) => a.account === ME).login, 'ok');
    assert.equal(checked.accounts.find((a) => a.account === ME2).login, 'ok');
    // Preset resolution, without touching the network.
    const saved = { ...process.env };
    Object.assign(process.env, { MAIL3_PASSWORD: 'abcd efgh ijkl mnop', MAIL5_PROVIDER: 'gmail', MAIL6_EMAIL: 'me@yandex.kz', MAIL6_PASSWORD: 'x', MAIL7_EMAIL: 'second@me.com', MAIL7_PASSWORD: 'x' });
    const resolved = Object.fromEntries(accounts().map((a) => [a.email, a]));
    assert.equal(resolved['someone@gmail.com'].imap.host, 'imap.gmail.com');
    assert.equal(resolved['someone@gmail.com'].smtp.host, 'smtp.gmail.com');
    assert.equal(resolved['someone@gmail.com'].saveSent, 'never');
    assert.equal(resolved['someone@gmail.com'].problem, null);
    assert.equal(resolved['student@uni.example'].imap.host, 'imap.gmail.com');
    assert.equal(resolved['me@yandex.kz'].imap.host, 'imap.yandex.com');
    assert.deepEqual(resolved['second@me.com'].smtp, { host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    const unknown = await callRaw('search_emails', { account: 'nobody@example.org' });
    assert.match(unknown.content[0].text, /Connected mailboxes: me@example\.test, work@corp\.example/);
    const broken = await callRaw('search_emails', { account: 'someone@outlook.com' });
    assert.match(broken.content[0].text, /not usable: Microsoft/);
  });
  await step('second mailbox: search, read, unified search, Gmail-style folders', async () => {
    const mine = await call('search_emails', {});
    assert.equal(mine.account, ME);
    assert.ok(!mine.emails.some((e) => e.subject === 'Work report'), 'the main mailbox must not show the other one');
    const work = await call('search_emails', { account: ME2 });
    assert.equal(work.account, ME2);
    assert.equal(work.total_matches, 2);
    assert.equal((await call('search_emails', { account: 'work' })).total_matches, 2, 'the part before @ is enough');
    const report = work.emails.find((e) => e.subject === 'Work report');
    const read = await call('read_email', { account: ME2, uid: report.uid });
    assert.match(read.body, /report by Friday/);
    assert.equal(read.account, ME2);
    const all = await call('search_emails', { account: 'all', limit: 50 });
    assert.deepEqual(all.searched, [ME, ME2]);
    assert.equal(all.total_matches, mine.total_matches + 2);
    assert.ok(all.emails.some((e) => e.account === ME2 && e.subject === 'Work report'));
    assert.ok(all.emails.some((e) => e.account === ME));
    assert.ok(all.emails.every((e, i, arr) => i === 0 || String(arr[i - 1].date) >= String(e.date)), 'merged results are newest first');
    const allQ = await call('search_emails', { account: 'all', query: 'report' });
    assert.equal(allQ.total_matches, 1);
    const folders = await call('list_folders', { account: ME2 });
    const role = Object.fromEntries(folders.folders.map((f) => [f.role, f.path]));
    assert.equal(role.sent, '[Gmail]/Sent Mail');
    assert.equal(role.archive, '[Gmail]/All Mail');
    assert.ok(!folders.folders.some((f) => f.path === '[Gmail]'));
  });
  await step('second mailbox: sends as itself, no duplicate in Sent, archive, unsubscribe', async () => {
    outbox.length = 0;
    const report = (await call('search_emails', { account: ME2, subject: 'Work report' })).emails[0];
    const r = await call('send_email', { account: ME2, reply_to_uid: report.uid, body: 'Will do.' });
    assert.equal(r.account, ME2);
    assert.equal(outbox[0].from, ME2);
    assert.deepEqual(outbox[0].to, ['boss@corp.example']);
    assert.match(outbox[0].raw, /In-Reply-To: <report-1@corp\.example>/);
    assert.equal((await folderMessages('[Gmail]/Sent Mail', true)).length, 1, 'the provider already filed the copy, a second one would be a duplicate');
    assert.equal((await folderMessages('Sent Messages')).filter((m) => /Will do/.test(m.source)).length, 0, 'nothing leaks into the main mailbox');
    const arch = await call('update_emails', { account: ME2, uids: [report.uid], action: 'archive' });
    assert.equal(arch.moved_to, '[Gmail]/All Mail');
    outbox.length = 0;
    const digest = (await call('search_emails', { account: ME2, subject: 'Team digest' })).emails[0];
    const un = await call('unsubscribe', { account: ME2, uid: digest.uid, after: 'trash' });
    assert.equal(un.status, 'request_sent');
    assert.equal(outbox[0].from, ME2);
    assert.deepEqual(outbox[0].to, ['leave@lists.corp.example']);
    assert.equal(un.email_moved_to, '[Gmail]/Trash');
    assert.equal((await call('search_emails', { account: ME2 })).total_matches, 0);
    const draft = await call('create_draft', { account: ME2, to: ['x@corp.example'], subject: 'd2', body: 'b' });
    assert.equal(draft.folder, '[Gmail]/Drafts');
  });
  await step('wrong app password gives a readable error, not a crash', async () => {
    process.env.ICLOUD_APP_PASSWORD = 'wrong-wrong-wrong-wrong';
    const fresh = (await oauthQuick(base)).access_token;
    const second = await connect(base, fresh);
    const r = await second.callRaw('search_emails', {});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /rejected the login/);
    await second.client.close();
    process.env.ICLOUD_APP_PASSWORD = APP_PASSWORD;
  });
  await client.close();

  console.log('Mail tools through the Vercel-style entry');
  const v = await connect(vbase, vtokens.access_token);
  await step('tools work when the body arrives pre-parsed and the path is rewritten', async () => {
    assert.equal((await v.client.listTools()).tools.length, 9);
    const r = await v.call('search_emails', { limit: 2 });
    assert.equal(r.returned, 2);
    outbox.length = 0;
    assert.equal((await v.call('send_email', { to: ['v@example.org'], subject: 'via vercel', body: 'hi' })).status, 'sent');
    assert.deepEqual(outbox[0].to, ['v@example.org']);
  });
  await v.client.close();

  console.log(`\n${passed} checks passed`);
} catch {
  console.log(`\nstopped after ${passed} passed checks`);
} finally {
  plain.close(); vercelLike.close(); site.close(); smtp.close(); imap.close(); imap2.close();
  setTimeout(() => process.exit(process.exitCode || 0), 300).unref();
}

// Shortest path to a token, used where the suite above is not the subject of the test.
async function oauthQuick(base) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const post = (path, o) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString(), redirect: 'manual' });
  const a = await post('/authorize', { response_type: 'code', client_id: 'quick', redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 's', passphrase: PASSPHRASE });
  const code = new URL(a.headers.get('location')).searchParams.get('code');
  return (await post('/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: 'quick' })).json();
}
