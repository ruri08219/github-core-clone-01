// app.ts — the HTTP server: one Node process, four surfaces.
//
// Routing, in order:
//   GET  /healthz                                  the env's boot probe, no auth
//   GET  /api/v3[/]                                the API root, no auth
//   GET  /api/v3/meta                             the meta probe, no auth
//   *    /api/v3/...                              REST v3, Bearer token required
//   POST /api/graphql                             GraphQL, Bearer token required
//   POST /mcp                                     MCP (auth is enforced inside, on tools/call)
//   *    /{owner}/{repo}.git/info/refs            smart-HTTP advertisements, Bearer required
//   POST /{owner}/{repo}.git/git-upload-pack      fetch / ls-refs, Bearer required
//   POST /{owner}/{repo}.git/git-receive-pack     push, Bearer required
//
// Auth is the entry's only credential: any non-empty `Authorization: Bearer <token>`
// names the viewer; a missing header is a 401. The server never learns the token
// value, because the entry lifecycle (main.ts) never passes it one. Every reply
// carries a non-empty X-GitHub-Request-Id, and every REST reply is JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ForgeStore, VIEWER } from './store.ts';
import { routeRest, type RestReply } from './rest.ts';
import { routeGraphQL } from './graphql.ts';
import { routeMcp } from './mcp.ts';
import { handleReceivePack, handleUploadPack, v0Advertisement, v2Advertisement } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body the server accepts: packs are the big ones. */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer | null,
  contentType: string,
  extra: Record<string, string> = {},
): void {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    ...extra,
  };
  if (body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  headers['content-length'] = String(bytes.length);
  res.writeHead(status, headers);
  res.end(bytes);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(body), JSON_TYPE, extra);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

/** The bearer token, or null when the request carries none. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match === null ? null : match[1];
}

/** Read the whole request body, or reject when it passes the cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!failed) {
        failed = true;
        reject(error);
      }
    });
  });
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Split a pathname into decoded segments; null when any segment is undecodable. */
function pathSegments(pathname: string): string[] | null {
  const raw = pathname.split('/').filter((part) => part !== '');
  const out: string[] = [];
  for (const part of raw) {
    const decoded = decodeSegment(part);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}

/** Parse a request body as JSON; `undefined` for an empty body, `null` for malformed JSON. */
function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

/** The git smart-HTTP routes: /{owner}/{repo}.git/<endpoint>. */
async function handleGit(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  endpoint: string,
  query: URLSearchParams,
): Promise<void> {
  if (owner !== VIEWER.login) {
    notFound(res);
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    notFound(res);
    return;
  }

  if (endpoint === 'info/refs') {
    const service = query.get('service');
    const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-receive-pack') {
      send(res, 200, v0Advertisement(store, repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    if (v2 && service !== 'git-receive-pack') {
      send(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-upload-pack' || service === null) {
      send(res, 200, v0Advertisement(store, repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      return;
    }
    notFound(res);
    return;
  }

  if (req.method !== 'POST') {
    notFound(res);
    return;
  }
  const body = await readBody(req);
  if (endpoint === 'git-upload-pack') {
    const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const result = handleUploadPack(store, repo, body, v2);
    send(res, result.status, result.body, result.contentType);
    return;
  }
  if (endpoint === 'git-receive-pack') {
    const result = handleReceivePack(store, repo, body);
    send(res, result.status, result.body, result.contentType);
    return;
  }
  notFound(res);
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new ForgeStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        let url: URL;
        try {
          url = new URL(req.url ?? '/', 'http://entry');
        } catch {
          notFound(res);
          return;
        }
        const pathname = url.pathname;
        const query = url.searchParams;

        // The boot probe.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // The git smart-HTTP routes.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch !== null) {
          if (bearerToken(req) === null) {
            unauthorized(res);
            return;
          }
          const owner = decodeSegment(gitMatch[1]);
          const repoName = decodeSegment(gitMatch[2]);
          if (owner === null || repoName === null) {
            notFound(res);
            return;
          }
          await handleGit(store, req, res, owner, repoName, gitMatch[3], query);
          return;
        }

        // The MCP endpoint: it reads its own raw body and enforces auth on tools/call.
        if (pathname === '/mcp') {
          if (method !== 'POST') {
            notFound(res);
            return;
          }
          const raw = await readBody(req);
          const reply = routeMcp(store, raw.toString('utf8'), bearerToken(req) !== null);
          send(res, reply.status, reply.body, JSON_TYPE);
          return;
        }

        // GraphQL.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            notFound(res);
            return;
          }
          if (bearerToken(req) === null) {
            unauthorized(res);
            return;
          }
          const raw = await readBody(req);
          const body = parseJsonBody(raw);
          if (body === null) {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          const result = routeGraphQL(store, body);
          send(res, result.status, result.text, JSON_TYPE);
          return;
        }

        // The REST surface.
        if (pathname === '/api/v3' || pathname === '/api/v3/') {
          if (method !== 'GET') {
            notFound(res);
            return;
          }
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }
        if (pathname === '/api/v3/meta') {
          if (method !== 'GET') {
            notFound(res);
            return;
          }
          sendJson(res, 200, { installed_version: '1.0.0' });
          return;
        }
        if (pathname.startsWith('/api/v3/')) {
          if (bearerToken(req) === null) {
            unauthorized(res);
            return;
          }
          const segments = pathSegments(pathname.slice('/api/v3/'.length));
          if (segments === null) {
            notFound(res);
            return;
          }
          const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
          let body: unknown;
          if (needsBody) {
            const raw = await readBody(req);
            body = parseJsonBody(raw);
            if (body === null) {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
          }
          const reply: RestReply = routeRest({
            store,
            method,
            segments,
            query,
            body,
            host: req.headers.host ?? 'localhost',
          });
          send(res, reply.status, reply.body, JSON_TYPE, reply.headers ?? {});
          return;
        }

        notFound(res);
      } catch (error) {
        // A request handler must never take the server down with it.
        if (!res.headersSent) {
          sendJson(res, 500, { message: error instanceof Error ? error.message : 'internal error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
