import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './mcp.js';
import { configProblems } from './config.js';
import { readBody, sendJson, sendHtml, CORS } from './http-util.js';
import * as auth from './auth.js';

function route(req) {
  const url = new URL(req.url || '/', 'http://internal');
  let path = url.pathname;
  // On Vercel every path is rewritten to /api/index?__path=<original path>.
  const rewritten = url.searchParams.get('__path');
  if (rewritten && (path === '/api/index' || path === '/api')) path = rewritten;
  url.searchParams.delete('__path');
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return { path, query: Object.fromEntries(url.searchParams) };
}

async function mcp(req, res) {
  if (!auth.bearerPayload(req)) return auth.challenge(req, res);
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST', ...CORS });
    return res.end();
  }
  let body;
  try { body = await readBody(req); } catch (e) {
    return sendJson(res, e.status || 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, CORS);
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export async function handle(req, res) {
  const { path, query } = route(req);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (path === '/mcp') return await mcp(req, res);
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      return auth.protectedResourceMetadata(req, res);
    }
    if (['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration'].includes(path)) {
      return auth.authServerMetadata(req, res);
    }
    if (path === '/register' && req.method === 'POST') return await auth.register(req, res);
    if (path === '/authorize' && (req.method === 'GET' || req.method === 'POST')) return await auth.authorize(req, res, query);
    if (path === '/token' && req.method === 'POST') return await auth.token(req, res);
    if (path === '/' && req.method === 'GET') {
      const problems = configProblems();
      return sendHtml(res, 200, `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Mail MCP</title>
<body style="font:16px system-ui;background:#111;color:#eee;padding:24px">
<p>Private mail MCP server.</p><p>Connector URL: this address + <code>/mcp</code></p>
<p>${problems.length ? `Not ready: ${problems.join('; ')}` : 'Settings: ok'}</p></body>`);
    }
    sendJson(res, 404, { error: 'not_found' }, CORS);
  } catch (err) {
    console.error('request failed', path, err);
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' }, CORS);
    else res.end();
  }
}
