// mcp.ts — the Model Context Protocol surface at /mcp.
//
// Both eras the kit's client negotiates: the modern 2026-07-28 era, where
// `server/discover` answers identity, capabilities and supported versions and no
// handshake is needed, and the legacy eras, where `initialize` +
// `notifications/initialized` opens the session. Tools are the six the kit
// requires, with synonym-tolerant argument names (the suite maps arguments by
// normalised synonyms, so `pullNumber`, `pull_number` and `number` all mean the
// same thing here). Every tools/list answer is byte-identical, and every tool
// result carries both a text block and structuredContent, because the client
// reads structuredContent first and falls back to the first JSON in the text.

import type { ForgeStore, Repo } from './store.ts';
import { VIEWER } from './store.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** Normalise an argument key: case and separators do not matter. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The first argument value whose key matches any of the given names. */
function argOf(args: Record<string, unknown>, ...names: string[]): unknown {
  const wanted = new Set(names.map(normaliseKey));
  for (const [key, value] of Object.entries(args)) {
    if (wanted.has(normaliseKey(key))) return value;
  }
  return undefined;
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string {
  const value = argOf(args, ...names);
  return typeof value === 'string' ? value : '';
}

function intArg(args: Record<string, unknown>, ...names: string[]): number | null {
  const value = argOf(args, ...names);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function toolOk(value: Record<string, unknown>): ToolResult {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolFail(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function repoForCall(store: ForgeStore, args: Record<string, unknown>): { repo: Repo } | { error: string } {
  const owner = stringArg(args, 'owner', 'owner_login', 'login');
  const name = stringArg(args, 'repo', 'repository', 'repo_name', 'repository_name', 'name');
  if (owner === '' || name === '') return { error: 'owner and repo are required' };
  if (owner !== VIEWER.login) return { error: 'not found' };
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return { error: 'not found' };
  return { repo };
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): ToolResult {
  const tool = normaliseKey(name);
  switch (tool) {
    case 'createrepo':
    case 'createrepository': {
      const repoName = stringArg(args, 'name', 'repo', 'repository');
      if (repoName === '') return toolFail('name is required');
      const description = stringArg(args, 'description');
      const isPrivate = argOf(args, 'private') === true;
      const result = store.createRepo(VIEWER.login, repoName, { description, isPrivate });
      if ('error' in result) return toolFail(result.error.message);
      const repo = result.repo;
      return toolOk({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        default_branch: repo.defaultBranch,
        private: repo.isPrivate,
        description: repo.description,
      });
    }
    case 'getrepo':
    case 'getrepository': {
      const found = repoForCall(store, args);
      if ('error' in found) return toolFail(found.error);
      const repo = found.repo;
      return toolOk({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        default_branch: repo.defaultBranch,
        private: repo.isPrivate,
        description: repo.description,
      });
    }
    case 'createissue':
    case 'issuecreate': {
      const title = stringArg(args, 'title');
      if (title === '') return toolFail('title is required');
      const found = repoForCall(store, args);
      if ('error' in found) return toolFail(found.error);
      const result = store.createIssue(found.repo, { title, body: stringArg(args, 'body'), labels: [] });
      if ('error' in result) return toolFail(result.error.message);
      const issue = result.issue;
      return toolOk({ id: issue.number, number: issue.number, title: issue.title, state: issue.state, body: issue.body });
    }
    case 'listissues':
    case 'issueslist': {
      const found = repoForCall(store, args);
      if ('error' in found) return toolFail(found.error);
      const state = stringArg(args, 'state');
      const issues = store.listIssues(found.repo, {
        state: state === '' ? undefined : state,
        perPage: 10000,
        page: 1,
      });
      const items = issues.map((issue) => ({ id: issue.number, number: issue.number, title: issue.title, state: issue.state }));
      const text = JSON.stringify(items);
      return { content: [{ type: 'text', text }], structuredContent: { issues: items } };
    }
    case 'createpullrequest':
    case 'createpr':
    case 'createpull': {
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head', 'head_ref', 'head_ref_name', 'head_branch');
      const base = stringArg(args, 'base', 'base_ref', 'base_ref_name', 'base_branch');
      if (title === '' || head === '' || base === '') return toolFail('title, head and base are required');
      const found = repoForCall(store, args);
      if ('error' in found) return toolFail(found.error);
      const result = store.createPull(found.repo, { title, body: stringArg(args, 'body'), head, base });
      if ('error' in result) return toolFail(result.error.message);
      const pull = result.pull;
      return toolOk({
        id: pull.number,
        number: pull.number,
        title: pull.title,
        state: pull.state,
        head: { ref: pull.head, sha: pull.headSha },
        base: { ref: pull.base, sha: pull.baseSha },
      });
    }
    case 'mergepullrequest':
    case 'mergepr':
    case 'mergepull': {
      const number = intArg(args, 'pull_number', 'pullNumber', 'number', 'pull_request_number', 'pr_number', 'id');
      if (number === null) return toolFail('pull_number is required');
      const found = repoForCall(store, args);
      if ('error' in found) return toolFail(found.error);
      const result = store.mergePull(found.repo, number);
      if ('error' in result) return toolFail(result.error.message);
      return toolOk({ id: number, number, merged: true, state: 'closed', sha: result.mergeSha });
    }
    default:
      return toolFail(`unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC framing.
// ---------------------------------------------------------------------------

interface RpcReply {
  status: number;
  body: string | null;
}

function rpcResult(id: unknown, result: unknown): RpcReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string): RpcReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

/**
 * Handle POST /mcp. `rawBody` is the request body as text; `hasAuth` says whether
 * an Authorization header was present. tools/call requires auth; the other
 * methods do not, so a client probing the era before authenticating is never
 * locked out.
 */
export function routeMcp(store: ForgeStore, rawBody: string, hasAuth: boolean): RpcReply {
  let request: unknown;
  try {
    request = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }) };
  }
  const rpc = request as Record<string, unknown>;
  const id = rpc.id;
  const method = typeof rpc.method === 'string' ? rpc.method : '';
  const params = (rpc.params ?? {}) as Record<string, unknown>;

  // A request with no id is a notification: no reply body.
  if (id === undefined) return { status: 202, body: null };

  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    });
  }

  if (method === 'initialize') {
    const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(wanted) ? wanted : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') return rpcResult(id, {});

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    if (!hasAuth) {
      return { status: 401, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } }) };
    }
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((tool) => normaliseKey(tool.name) === normaliseKey(name));
    if (!known) {
      const aliases = ['createrepository', 'getrepository', 'issuecreate', 'issueslist', 'createpr', 'mergepr'];
      if (!aliases.includes(normaliseKey(name))) return rpcError(id, -32602, `unknown tool ${name}`);
    }
    const result = callTool(store, name, args);
    return rpcResult(id, result);
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}
