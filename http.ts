// http.ts: the shared HTTP plumbing for every surface: body reading with a size cap, JSON
// replies that always carry an X-GitHub-Request-Id, and the bearer-token check. The request
// id is a per-process counter, so identical request sequences produce identical headers.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** The next request id (deterministic: a counter, never a clock or a random value). */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': 0, 'x-github-request-id': nextRequestId() });
  res.end();
}

/** Read a whole request body (capped); resolves null when the cap is exceeded. */
export function readBody(req: IncomingMessage, cap = 64 * 1024 * 1024): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > cap) {
        settled = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (!settled) resolve(Buffer.alloc(0));
    });
  });
}

/** True when the request carries the trial's bearer token (and only then). */
export function authorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return false;
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

/** GitHub's error body: a JSON object with a non-empty string message. */
export function errorBody(message: string): { message: string } {
  return { message };
}

export function notFound(res: ServerResponse): void {
  sendJson(res, 404, errorBody('Not Found'));
}

export function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, errorBody('Bad credentials'));
}

/** Parse a JSON request body; `{}` for an empty body, null for malformed JSON. */
export function parseJsonBody(raw: Buffer): Record<string, unknown> | null {
  if (raw.length === 0) return {};
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
