// mcp.ts — the Model Context Protocol endpoint at POST /mcp (streamable HTTP, plain
// JSON responses). It speaks both the modern 2026-07-28 era (server/discover, no
// session) and the legacy handshake era (initialize + notifications/initialized),
// exposes the eight tools github-mcp-server expects, answers JSON-RPC errors, and
// returns 401 when no bearer token is present. tools/list comes from a frozen
// constant, so two calls are byte-identical.

import { Forge, VIEWER, type Issue, type Pull, type Repo } from './store.ts';

export interface McpHttpResult {
  status: number;
  // JSON value, or null for an empty body (a 202 notification answer).
  body: unknown;
}

const MCP_SERVER_NAME = 'github-core-clone';
const MCP_SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** Build one frozen tool definition from a compact property table. */
function defineTool(
  name: string,
  description: string,
  props: Record<string, { type: string; description: string }>,
  required: string[],
): McpToolDef {
  const properties: Record<string, { type: string; description: string }> = {};
  for (const [key, spec] of Object.entries(props)) properties[key] = Object.freeze({ ...spec });
  return Object.freeze({
    name,
    description,
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze(properties),
      required: Object.freeze(required),
    }),
  });
}

const TOOL_DEFS: readonly McpToolDef[] = Object.freeze([
  defineTool('create_repo', 'Create a repository owned by the authenticated user.', {
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  defineTool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
  }, ['owner', 'repo']),
  defineTool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
  }, ['owner', 'repo', 'title']),
  defineTool('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', description: 'Issue state: open, closed or all.' },
  }, ['owner', 'repo']),
  defineTool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The pull request title.' },
    body: { type: 'string', description: 'The pull request body.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  defineTool('merge_pull_request', 'Merge a pull request by number.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    pull_number: { type: 'integer', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
  defineTool('get_issue', 'Get one issue by number.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    issue_number: { type: 'integer', description: 'The issue number.' },
  }, ['owner', 'repo', 'issue_number']),
  defineTool('list_pull_requests', 'List pull requests in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', description: 'Pull request state: open, closed or all.' },
  }, ['owner', 'repo']),
]);

function serializeRepo(record: Repo): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    full_name: `${record.owner}/${record.name}`,
    owner: { login: record.owner },
    private: record.private,
    description: record.description,
    default_branch: record.defaultBranch,
  };
}

function serializeIssue(record: Repo, item: Issue): Record<string, unknown> {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels.map((name) => ({ name })),
    user: { login: record.owner },
  };
}

function serializePull(record: Repo, request: Pull): Record<string, unknown> {
  return {
    id: request.id,
    number: request.number,
    title: request.title,
    body: request.body,
    state: request.state,
    merged: request.merged,
    merged_at: request.mergedAt,
    merge_commit_sha: request.mergeCommitSha,
    head: { ref: request.headRef, sha: request.headSha },
    base: { ref: request.baseRef, sha: request.baseSha },
  };
}

function okResult(payload: unknown): Record<string, unknown> {
  const encoded = JSON.stringify(payload);
  return { content: [{ type: 'text', text: encoded }], structuredContent: payload, isError: false };
}

function errResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function textArg(params: Record<string, unknown>, key: string): string {
  const raw = params[key];
  return typeof raw === 'string' ? raw : '';
}

function intArg(params: Record<string, unknown>, key: string): number | null {
  const raw = params[key];
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
  return null;
}

function invokeTool(store: Forge, toolName: string, params: Record<string, unknown>): Record<string, unknown> {
  const spec = TOOL_DEFS.find((t) => t.name === toolName);
  if (!spec) return errResult(`Unknown tool: ${toolName}`);
  for (const key of spec.inputSchema.required) {
    if (params[key] === undefined || params[key] === null || params[key] === '') {
      return errResult(`Missing required argument: ${key}`);
    }
  }
  const login = textArg(params, 'owner');
  const slug = textArg(params, 'repo');
  switch (toolName) {
    case 'create_repo': {
      const nameArg = textArg(params, 'name');
      if (nameArg === '') return errResult('Missing required argument: name');
      const record = store.createRepo(VIEWER.login, nameArg, params.private === true, textArg(params, 'description'));
      if (!record) return errResult(`Repository ${VIEWER.login}/${nameArg} already exists`);
      return okResult(serializeRepo(record));
    }
    case 'get_repo': {
      if (login !== VIEWER.login) return errResult(`Repository ${login}/${slug} not found`);
      const record = store.getRepo(login, slug);
      if (!record) return errResult(`Repository ${login}/${slug} not found`);
      return okResult(serializeRepo(record));
    }
    case 'create_issue': {
      if (login !== VIEWER.login) return errResult(`Repository ${login}/${slug} not found`);
      const record = store.getRepo(login, slug);
      if (!record) return errResult(`Repository ${login}/${slug} not found`);
      const item = store.createIssue(record, textArg(params, 'title'), textArg(params, 'body'), []);
      return okResult(serializeIssue(record, item));
    }
    case 'list_issues': {
      if (login !== VIEWER.login) return errResult(`Repository ${login}/${slug} not found`);
      const record = store.getRepo(login, slug);
      if (!record) return errResult(`Repository ${login}/${slug} not found`);
      const filter = textArg(params, 'state') || 'open';
      let items = [...record.issues.values()].sort((a, b) => a.number - b.number);
      if (filter === 'open') items = items.filter((i) => i.state === 'open');
      else if (filter === 'closed') items = items.filter((i) => i.state === 'closed');
      return okResult(items.map((i) => serializeIssue(record, i)));
    }
    case 'get_issue': {
      if (login !== VIEWER.login) return errResult(`Repository ${login}/${slug} not found`);
      const record = store.getRepo(login, slug);
      if (!record) return errResult(`Repository ${login}/${slug} not found`);
      const num = intArg(params, 'issue_number');
      const item = num === null ? undefined : record.issues.get(num);
      if (!item) return errResult(`Issue not found`);
      return okResult(serializeIssue(record, item));
    }
    case 'create_pull_request': {
      if (login !== VIEWER.login) return errResult(`Repository ${login}/${slug} not found`);
      const record = store.getRepo(login, slug);
      if (!record) return errResult(`Repository ${login}/${slug} not found`);
      const head = textArg(params, 'head');
      const base = textArg(params, 'base');
      const headId = record.refs.get(`refs/heads/${head}`);
      const baseId = record.refs.get(`refs/heads/${base}`);
      if (headId === undefined) return errResult(`head branch ${head} does not exist`);
      if (baseId === undefined) return errResult(`base branch ${base} does not exist`);
      const request = store.createPull(record, textArg(params, 'title'), textArg(params, 'body'), head, base, headId, baseId);
      return okResult(serializePull(record, request));
    }
    case 'merge_pull_request': {
      if (login !== VIEWER.login) return errResult(`Repository ${login}/${slug} not found`);
      const record = store.getRepo(login, slug);
      if (!record) return errResult(`Repository ${login}/${slug} not found`);
      const num = intArg(params, 'pull_number');
      const request = num === null ? undefined : record.pulls.get(num);
      if (!request) return errResult(`Pull request not found`);
      if (request.state !== 'open') return errResult('Pull Request is already merged or closed');
      const outcome = store.mergePullRequest(record, request, 'squash');
      if ('conflict' in outcome) return errResult('Merge conflict');
      return okResult(serializePull(record, request));
    }
    case 'list_pull_requests': {
      if (login !== VIEWER.login) return errResult(`Repository ${login}/${slug} not found`);
      const record = store.getRepo(login, slug);
      if (!record) return errResult(`Repository ${login}/${slug} not found`);
      const filter = textArg(params, 'state') || 'open';
      let open = [...record.pulls.values()].sort((a, b) => a.number - b.number);
      if (filter === 'open') open = open.filter((p) => p.state === 'open');
      else if (filter === 'closed') open = open.filter((p) => p.state === 'closed');
      return okResult(open.map((p) => serializePull(record, p)));
    }
    default:
      return errResult(`Unknown tool: ${toolName}`);
  }
}

function rpcOk(requestId: unknown, payload: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: requestId ?? null, result: payload };
}

function rpcFail(requestId: unknown, errorCode: number, text: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: requestId ?? null, error: { code: errorCode, message: text } };
}

function findRequestId(text: string): unknown {
  const found = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(text);
  if (!found) return null;
  const piece = found[1]!;
  if (piece.startsWith('"')) {
    try {
      return JSON.parse(piece) as unknown;
    } catch {
      return null;
    }
  }
  return parseInt(piece, 10);
}

export function handleMcp(store: Forge, text: string, authed: boolean): McpHttpResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    return { status: 400, body: rpcFail(findRequestId(text), -32700, 'Parse error') };
  }
  if (!isObject(doc)) {
    return { status: 400, body: rpcFail(null, -32600, 'Invalid Request') };
  }
  const requestId = doc.id ?? null;
  const verb = typeof doc.method === 'string' ? doc.method : '';
  const body = isObject(doc.params) ? doc.params : {};

  // Authentication is decided before any method exists: no token is a 401.
  if (!authed) {
    return { status: 401, body: rpcFail(requestId, -32001, 'Unauthorized') };
  }

  // Notifications (no id) are answered 202 with no body.
  if (doc.id === undefined) {
    return { status: 202, body: null };
  }

  if (verb === 'server/discover') {
    return {
      status: 200,
      body: rpcOk(requestId, {
        protocolVersion: PROTOCOL_VERSIONS[0],
        supportedVersions: [...PROTOCOL_VERSIONS],
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        capabilities: { tools: {} },
      }),
    };
  }
  if (verb === 'initialize') {
    const clientVersion = typeof body.protocolVersion === 'string' ? body.protocolVersion : '';
    const chosen = PROTOCOL_VERSIONS.includes(clientVersion) ? clientVersion : PROTOCOL_VERSIONS[0]!;
    return {
      status: 200,
      body: rpcOk(requestId, {
        protocolVersion: chosen,
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        capabilities: { tools: {} },
      }),
    };
  }
  if (verb === 'ping') {
    return { status: 200, body: rpcOk(requestId, {}) };
  }
  if (verb === 'tools/list') {
    return { status: 200, body: rpcOk(requestId, { tools: TOOL_DEFS }) };
  }
  if (verb === 'tools/call') {
    const toolName = typeof body.name === 'string' ? body.name : '';
    const toolArgs = isObject(body.arguments) ? body.arguments : {};
    const exists = TOOL_DEFS.some((t) => t.name === toolName);
    if (!exists) {
      return { status: 200, body: rpcFail(requestId, -32602, `Unknown tool: ${toolName}`) };
    }
    return { status: 200, body: rpcOk(requestId, invokeTool(store, toolName, toolArgs)) };
  }
  return { status: 200, body: rpcFail(requestId, -32601, `Method not found: ${verb}`) };
}
