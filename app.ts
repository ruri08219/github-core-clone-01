// app.ts — the HTTP server: routing, auth, the JSON envelope, and request ids.
// main.ts (the kit's lifecycle) is the entry point; this file is the server itself,
// serving git smart HTTP, REST v3, GraphQL v4 and MCP from a single process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, type ApiResponse } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack, type GitResponse } from './gitproto.ts';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_SIZE = 64 * 1024 * 1024;

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

function decodePart(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let received = 0;
    request.on('data', (piece: Buffer) => {
      received += piece.length;
      if (received > MAX_BODY_SIZE) {
        reject(new Error('request body too large'));
        return;
      }
      parts.push(piece);
    });
    request.on('end', () => resolve(Buffer.concat(parts)));
    request.on('error', reject);
  });
}

function writeBuffer(response: ServerResponse, code: number, mime: string, payload: Buffer, more: Record<string, string> = {}): void {
  response.writeHead(code, { 'content-type': mime, 'content-length': payload.length, 'x-github-request-id': nextRequestId(), ...more });
  response.end(payload);
}

function writeJson(response: ServerResponse, code: number, payload: unknown, more: Record<string, string> = {}): void {
  const encoded = `${JSON.stringify(payload)}\n`;
  writeBuffer(response, code, JSON_CONTENT_TYPE, Buffer.from(encoded, 'utf8'), more);
}

function writeEmpty(response: ServerResponse): void {
  response.writeHead(204, { 'x-github-request-id': nextRequestId() });
  response.end();
}

function readBearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (!value || !value.startsWith('Bearer ')) return '';
  return value.slice('Bearer '.length).trim();
}

/** Build the server. It listens on nothing until the caller binds it. */
export function createApp(): Server {
  const store = new Forge();
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      try {
        await routeRequest(store, request, response);
      } catch (error) {
        try {
          process.stderr.write(`[app] handler error: ${error instanceof Error ? error.message : String(error)}\n`);
        } catch {
          // ignore logging failures
        }
        if (!response.headersSent) writeJson(response, 500, { message: 'Internal Server Error' });
        else response.end();
      }
    })();
  });
}

async function routeRequest(store: Forge, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const verb = request.method ?? 'GET';
  let parsed: URL;
  try {
    parsed = new URL(request.url ?? '/', 'http://entry');
  } catch {
    writeJson(response, 400, { message: 'Bad request' });
    return;
  }
  const route = parsed.pathname;
  const params: Record<string, string> = {};
  parsed.searchParams.forEach((v, k) => {
    if (!(k in params)) params[k] = v;
  });
  const base = `http://${request.headers.host ?? '127.0.0.1'}`;
  const authed = readBearer(request) !== '';

  // Liveness probe (the env's boot check calls it twice).
  if (verb === 'GET' && route === '/healthz') {
    writeJson(response, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/<verb> — info/refs, upload-pack, receive-pack.
  const gitRoute = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(route);
  if (gitRoute) {
    const login = decodePart(gitRoute[1]!);
    const slug = decodePart(gitRoute[2]!);
    const tail = gitRoute[3]!;
    if (!authed) {
      writeJson(response, 401, { message: 'Requires authentication' });
      return;
    }
    if (verb === 'GET' && tail === 'info/refs') {
      const name = params.service ?? '';
      const answer: GitResponse = handleInfoRefs(store, login, slug, name, request.headers['git-protocol']);
      writeBuffer(response, answer.status, answer.contentType, answer.body);
      return;
    }
    if (verb === 'POST' && tail === 'git-upload-pack') {
      const raw = await readRequestBody(request);
      const answer: GitResponse = handleUploadPack(store, login, slug, raw);
      writeBuffer(response, answer.status, answer.contentType, answer.body);
      return;
    }
    if (verb === 'POST' && tail === 'git-receive-pack') {
      const raw = await readRequestBody(request);
      const answer: GitResponse = handleReceivePack(store, login, slug, raw);
      writeBuffer(response, answer.status, answer.contentType, answer.body);
      return;
    }
    writeJson(response, 404, { message: 'Not Found' });
    return;
  }

  // REST v3 surface.
  if (route === '/api/v3' || route.startsWith('/api/v3/')) {
    const suffix = route === '/api/v3' ? '' : route.slice('/api/v3/'.length);
    const parts = suffix === '' ? [] : suffix.split('/').map(decodePart);
    // GET carries no body; every other method may (DELETE /contents carries one).
    const text = verb === 'GET' ? '' : (await readRequestBody(request)).toString('utf8');
    let body: unknown;
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = undefined;
      }
    }
    const answer: ApiResponse = handleRest(store, {
      method: verb,
      segments: parts,
      query: params,
      headers: request.headers as Record<string, string | undefined>,
      body,
      rawBody: text,
      origin: base,
      authenticated: authed,
    });
    if (answer.status === 204) {
      writeEmpty(response);
      return;
    }
    if (Buffer.isBuffer(answer.body)) {
      writeBuffer(response, answer.status, answer.headers?.['content-type'] ?? JSON_CONTENT_TYPE, answer.body);
      return;
    }
    writeJson(response, answer.status, answer.body ?? {}, answer.headers ?? {});
    return;
  }

  // GraphQL v4 surface.
  if (route === '/api/graphql' && verb === 'POST') {
    if (!authed) {
      writeJson(response, 401, { message: 'Requires authentication' });
      return;
    }
    const text = (await readRequestBody(request)).toString('utf8');
    const answer = handleGraphQL(store, text);
    writeJson(response, answer.status, answer.body);
    return;
  }
  if (route === '/api/graphql') {
    writeJson(response, 404, { message: 'Not Found' });
    return;
  }

  // MCP surface.
  if (route === '/mcp') {
    if (verb === 'GET') {
      writeJson(response, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (verb === 'DELETE') {
      // A legacy session goodbye: nothing is held, so it is a no-op.
      response.writeHead(204, { 'x-github-request-id': nextRequestId() });
      response.end();
      return;
    }
    if (verb !== 'POST') {
      writeJson(response, 405, { message: 'Method Not Allowed' });
      return;
    }
    const text = (await readRequestBody(request)).toString('utf8');
    const answer = handleMcp(store, text, authed);
    if (answer.body === null) {
      response.writeHead(answer.status, { 'x-github-request-id': nextRequestId() });
      response.end();
      return;
    }
    writeJson(response, answer.status, answer.body);
    return;
  }

  writeJson(response, 404, { message: 'Not Found' });
}
