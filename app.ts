// app.ts — the HTTP server: routing, auth, JSON envelope, request ids. The entry
// point is main.ts (the kit's lifecycle, kept as it ships); this file is the server
// that grows: git smart HTTP, REST v3, GraphQL v4 and MCP from one process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, type ApiResponse } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  handleInfoRefs,
  handleUploadPack,
  handleReceivePack,
  type GitResponse,
} from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': requestId(), ...extra });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  sendBuffer(res, status, JSON_TYPE, Buffer.from(text, 'utf8'), extra);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': requestId() });
  res.end();
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handle(forge, req, res);
      } catch (error) {
        try {
          process.stderr.write(`[forge] handler error: ${error instanceof Error ? error.message : String(error)}\n`);
        } catch {
          // ignore logging failures
        }
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad request' });
    return;
  }
  const path = url.pathname;
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    if (!(key in query)) query[key] = value;
  });
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
  const authenticated = bearerToken(req) !== '';

  // Health probe (the env's boot check calls it twice).
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (gitMatch) {
    const owner = decodeSegment(gitMatch[1]!);
    const repoName = decodeSegment(gitMatch[2]!);
    const rest = gitMatch[3]!;
    if (!authenticated) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method === 'GET' && rest === 'info/refs') {
      const service = query.service ?? '';
      const out: GitResponse = handleInfoRefs(forge, owner, repoName, service, req.headers['git-protocol']);
      sendBuffer(res, out.status, out.contentType, out.body);
      return;
    }
    if (method === 'POST' && rest === 'git-upload-pack') {
      const body = await readBody(req);
      const out: GitResponse = handleUploadPack(forge, owner, repoName, body);
      sendBuffer(res, out.status, out.contentType, out.body);
      return;
    }
    if (method === 'POST' && rest === 'git-receive-pack') {
      const body = await readBody(req);
      const out: GitResponse = handleReceivePack(forge, owner, repoName, body);
      sendBuffer(res, out.status, out.contentType, out.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const tail = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
    const segments = tail === '' ? [] : tail.split('/').map(decodeSegment);
    // GET carries no body; every other method may (DELETE /contents carries one).
    const bodyText = method === 'GET' ? '' : (await readBody(req)).toString('utf8');
    let body: unknown;
    if (bodyText.trim() !== '') {
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        body = undefined;
      }
    }
    const response: ApiResponse = handleRest(forge, {
      method,
      segments,
      query,
      headers: req.headers as Record<string, string | undefined>,
      body,
      rawBody: bodyText,
      origin,
      authenticated,
    });
    if (response.status === 204) {
      sendNoContent(res);
      return;
    }
    if (Buffer.isBuffer(response.body)) {
      sendBuffer(res, response.status, response.headers?.['content-type'] ?? JSON_TYPE, response.body);
      return;
    }
    sendJson(res, response.status, response.body ?? {}, response.headers ?? {});
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql' && method === 'POST') {
    if (!authenticated) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const rawBody = (await readBody(req)).toString('utf8');
    const result = handleGraphQL(forge, rawBody);
    sendJson(res, result.status, result.body);
    return;
  }
  if (path === '/api/graphql') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (method === 'DELETE') {
      // A legacy session goodbye: nothing is held, so it is a no-op.
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const rawBody = (await readBody(req)).toString('utf8');
    const result = handleMcp(forge, rawBody, authenticated);
    if (result.body === null) {
      res.writeHead(result.status, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
