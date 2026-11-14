// mcp.ts — the Model Context Protocol endpoint at POST /mcp (streamable HTTP, plain
// JSON responses). Supports the modern 2026-07-28 era (server/discover, no session)
// and the legacy handshake era (initialize + notifications/initialized), the six
// required tools (github-mcp-server's names), JSON-RPC errors, and 401 without a
// bearer token. tools/list is a frozen constant, so two calls are byte-identical.

import { Forge, VIEWER, type Issue, type Pull, type Repo } from './store.ts';

export interface McpHttpResult {
  status: number;
  body: unknown; // JSON value, or null for an empty (202 notification) body
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Issue state: open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
  Object.freeze({
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        issue_number: Object.freeze({ type: 'integer', description: 'The issue number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'issue_number']),
    }),
  }),
  Object.freeze({
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Pull request state: open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
]);

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: repo.owner },
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function numArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return toolError(`Unknown tool: ${name}`);
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  const owner = strArg(args, 'owner');
  const repoName = strArg(args, 'repo');
  switch (name) {
    case 'create_repo': {
      const repoNameArg = strArg(args, 'name');
      if (repoNameArg === '') return toolError('Missing required argument: name');
      const repo = forge.createRepo(VIEWER.login, repoNameArg, args.private === true, strArg(args, 'description'));
      if (!repo) return toolError(`Repository ${VIEWER.login}/${repoNameArg} already exists`);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      if (owner !== VIEWER.login) return toolError(`Repository ${owner}/${repoName} not found`);
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      if (owner !== VIEWER.login) return toolError(`Repository ${owner}/${repoName} not found`);
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const issue = forge.createIssue(repo, strArg(args, 'title'), strArg(args, 'body'), []);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      if (owner !== VIEWER.login) return toolError(`Repository ${owner}/${repoName} not found`);
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = strArg(args, 'state') || 'open';
      let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      return toolResult(issues.map((i) => issueJson(repo, i)));
    }
    case 'get_issue': {
      if (owner !== VIEWER.login) return toolError(`Repository ${owner}/${repoName} not found`);
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const number = numArg(args, 'issue_number');
      const issue = number === null ? undefined : repo.issues.get(number);
      if (!issue) return toolError(`Issue not found`);
      return toolResult(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      if (owner !== VIEWER.login) return toolError(`Repository ${owner}/${repoName} not found`);
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const headRef = strArg(args, 'head');
      const baseRef = strArg(args, 'base');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined) return toolError(`head branch ${headRef} does not exist`);
      if (baseSha === undefined) return toolError(`base branch ${baseRef} does not exist`);
      const pull = forge.createPull(repo, strArg(args, 'title'), strArg(args, 'body'), headRef, baseRef, headSha, baseSha);
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      if (owner !== VIEWER.login) return toolError(`Repository ${owner}/${repoName} not found`);
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const number = numArg(args, 'pull_number');
      const pull = number === null ? undefined : repo.pulls.get(number);
      if (!pull) return toolError(`Pull request not found`);
      if (pull.state !== 'open') return toolError('Pull Request is already merged or closed');
      const result = forge.mergePullRequest(repo, pull, 'squash');
      if ('conflict' in result) return toolError('Merge conflict');
      return toolResult(pullJson(repo, pull));
    }
    case 'list_pull_requests': {
      if (owner !== VIEWER.login) return toolError(`Repository ${owner}/${repoName} not found`);
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = strArg(args, 'state') || 'open';
      let pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
      return toolResult(pulls.map((p) => pullJson(repo, p)));
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function extractId(raw: string): unknown {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(raw);
  if (!match) return null;
  const token = match[1]!;
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as unknown;
    } catch {
      return null;
    }
  }
  return parseInt(token, 10);
}

export function handleMcp(forge: Forge, rawBody: string, authenticated: boolean): McpHttpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    return { status: 400, body: rpcError(extractId(rawBody), -32700, 'Parse error') };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const id = parsed.id ?? null;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};

  // Authentication is decided before any method exists: no token is a 401.
  if (!authenticated) {
    return { status: 401, body: rpcError(id, -32001, 'Unauthorized') };
  }

  // Notifications (no id) are answered 202 with no body.
  if (parsed.id === undefined) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: REVISIONS[0],
        supportedVersions: [...REVISIONS],
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      }),
    };
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = REVISIONS.includes(offered) ? offered : REVISIONS[0]!;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const known = TOOLS.some((t) => t.name === name);
    if (!known) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    return { status: 200, body: rpcResult(id, callTool(forge, name, args)) };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
