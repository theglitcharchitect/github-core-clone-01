// app.ts: one HTTP server for the whole forge. Routing order: the unauthenticated /healthz
// probe, then the bearer-token gate (the trial token names the viewer; a missing or wrong
// token is a 401 JSON error on every surface), then the four surfaces over one shared store:
// REST v3 under /api/v3, GraphQL at /api/graphql, MCP at /mcp, and git smart HTTP at
// /<owner>/<repo>.git/*. Anything else is a JSON 404, never an HTML error page.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { authorized, errorBody, notFound, readBody, sendJson, unauthorized } from './http.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './smart.ts';
import { getRepo } from './store.ts';

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const method = req.method ?? 'GET';
  const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!authorized(req)) {
    unauthorized(res);
    return;
  }

  if (url.pathname === '/api/v3' || url.pathname.startsWith('/api/v3/')) {
    await handleRest(req, res, url, rawBody);
    return;
  }

  if (url.pathname === '/api/graphql') {
    if (method !== 'POST') {
      notFound(res);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    if (Array.isArray(parsed)) {
      sendJson(res, 200, parsed.map((entry) => executeGraphQL(entry as { query?: unknown; variables?: unknown })));
      return;
    }
    sendJson(res, 200, executeGraphQL(parsed as { query?: unknown; variables?: unknown }));
    return;
  }

  if (url.pathname === '/mcp') {
    if (method !== 'POST') {
      notFound(res);
      return;
    }
    handleMcp(res, rawBody);
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const name = decodeURIComponent(gitMatch[2] as string);
    const repo = getRepo(owner, name);
    if (repo === undefined) {
      notFound(res);
      return;
    }
    const endpoint = gitMatch[3] as string;
    if (endpoint === 'info/refs' && method === 'GET') {
      handleInfoRefs(req, res, repo, url);
      return;
    }
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      await handleUploadPack(req, res, repo, rawBody);
      return;
    }
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      await handleReceivePack(res, repo, rawBody);
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, errorBody('Internal Server Error'));
        else res.end();
      } catch {
        // The socket is already gone; nothing left to report on it.
      }
    });
  });
  return server;
}
