// graphql.ts — a small GraphQL executor for the documents gh and github-mcp-server
// actually send (kit sdk/conformance/checks-graphql.ts GRAPHQL_DOCUMENTS). It parses
// operations, variables, aliases, inline input objects/enums, and inline fragments,
// and resolves them against the forge store. Unknown fields answer HTTP 200 with an
// errors array naming the field (GitHub's behaviour), never an HTTP 400.

import {
  Forge,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// Tokenizer + parser
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'spread'; value: '...' }
  | { kind: 'variable'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'variable', value: input.slice(i + 1, j) });
      i = j;
      continue;
    }
    if ('{}()[]:!=$'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j]!;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'int', value: parseInt(input.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selection?: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selection: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Record<string, { default?: ValueNode }>;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.kind} ${JSON.stringify((token as { value?: unknown }).value)}`);
  }
  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name: string | undefined;
    const maybeName = this.peek();
    if (maybeName?.kind === 'name') {
      name = this.next().value as string;
    }
    const variables: Record<string, { default?: ValueNode }> = {};
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const varToken = this.next();
        if (varToken.kind !== 'variable') throw new Error('expected a variable definition');
        this.expectPunct(':');
        this.parseType();
        let def: ValueNode | undefined;
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          def = this.parseValue();
        }
        variables[varToken.value] = { default: def };
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  private parseType(): void {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      this.parseType();
      this.expectPunct(']');
    } else if (token.kind !== 'name') {
      throw new Error('expected a type');
    }
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selection: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      const token = this.peek();
      if (token?.kind === 'spread') {
        this.next();
        let typeCondition: string | undefined;
        const on = this.peek();
        if (on?.kind === 'name' && on.value === 'on') {
          this.next();
          typeCondition = this.expectName();
        }
        selection.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      const first = this.expectName();
      let alias: string | undefined;
      let name = first;
      const colon = this.peek();
      if (colon?.kind === 'punct' && colon.value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args: Record<string, ValueNode> = {};
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.next();
        while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args[argName] = this.parseValue();
        }
        this.expectPunct(')');
      }
      let sub: SelectionNode[] | undefined;
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
        sub = this.parseSelectionSet();
      }
      selection.push({ kind: 'field', alias, name, args, selection: sub });
    }
    this.expectPunct('}');
    return selection;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'variable') return { kind: 'variable', name: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
    case 'int':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// Global ids (opaque, stable): base64url of "kind:parts".
// -------------------------------------------------------------------------------------------

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64url');
}

function decodeGlobalId(id: unknown): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function cursorFor(index: number): string {
  return Buffer.from(`c:${index}`).toString('base64url');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^c:(\d+)$/.exec(text);
    return match ? parseInt(match[1]!, 10) : -1;
  } catch {
    return -1;
  }
}

// -------------------------------------------------------------------------------------------
// Node wrappers
// -------------------------------------------------------------------------------------------

type NodeValue =
  | { __type: 'Query' }
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'Ref'; name: string }
  | { __type: 'IssueConnection'; items: Array<{ repo: Repo; issue: Issue }>; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'PullRequestConnection'; items: Array<{ repo: Repo; pull: Pull }> }
  | { __type: 'ChangedFileConnection'; items: Array<{ path: string }> }
  | { __type: 'ChangedFile'; path: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: '__Type'; name: string; fields: string[]; enumValues: string[] }
  | { __type: 'CreateIssuePayload'; issue: { repo: Repo; issue: Issue } }
  | { __type: 'CloseIssuePayload'; issue: { repo: Repo; issue: Issue } }
  | { __type: 'CreatePullRequestPayload'; pullRequest: { repo: Repo; pull: Pull } }
  | { __type: 'MergePullRequestPayload'; pullRequest: { repo: Repo; pull: Pull } }
  | { __type: 'AddCommentPayload'; comment: { id: string; body: string } };

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments', 'closedAt'];
const PULL_REQUEST_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'url'];
const REPOSITORY_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'TOPIC'];

class GraphQLError extends Error {}

// -------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string }>;
}

export function executeGraphQL(
  forge: Forge,
  query: string,
  variables: Record<string, unknown>,
): GraphQLResult {
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  // The suite sends one operation per body; execute the first (batching is handled by
  // the caller, which runs one execute per document).
  const operation = operations[0];
  if (!operation) return { data: null, errors: [{ message: 'empty GraphQL document' }] };
  const errors: Array<{ message: string }> = [];
  const ctx: ExecContext = { forge, variables, errors };
  const data = resolveSelection(ctx, { __type: 'Query' }, operation.selection);
  return { data, errors };
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function findRepoById(forge: Forge, id: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function issueNode(repo: Repo, issue: Issue): NodeValue {
  return { __type: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): NodeValue {
  return { __type: 'PullRequest', repo, pull };
}

function resolveIssueList(
  ctx: ExecContext,
  repo: Repo,
  args: Record<string, unknown>,
): NodeValue {
  const first = typeof args.first === 'number' ? args.first : undefined;
  const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const after = indexFromCursor(args.after);
  let issues = [...repo.issues.values()];
  if (states) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  if (orderBy.field === 'CREATED_AT') {
    issues.sort((a, b) => (orderBy.direction === 'DESC' ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
  } else if (orderBy.field === 'UPDATED_AT') {
    issues.sort((a, b) => (orderBy.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  } else {
    issues.sort((a, b) => a.seq - b.seq);
  }
  const start = after + 1;
  const sliced = first !== undefined ? issues.slice(start, start + first) : issues.slice(start);
  const endIndex = start + sliced.length - 1;
  const hasNextPage = endIndex + 1 < issues.length;
  return {
    __type: 'IssueConnection',
    items: sliced.map((issue) => ({ repo, issue })),
    hasNextPage,
    endCursor: sliced.length > 0 ? cursorFor(endIndex) : null,
  };
}

function fieldResolver(ctx: ExecContext, node: NodeValue, field: FieldNode): unknown {
  const { forge } = ctx;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) args[key] = resolveValue(value, ctx.variables);

  switch (node.__type) {
    case 'Query': {
      if (field.name === 'viewer') return { __type: 'User', login: VIEWER.login } as NodeValue;
      if (field.name === 'repository') {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (!repo || repo.owner !== VIEWER.login) return null;
        return { __type: 'Repository', repo } as NodeValue;
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(args.id);
        if (!decoded) return null;
        if (decoded.kind === 'R') {
          const repo = findRepoById(forge, parseInt(decoded.parts[0] ?? '', 10));
          return repo ? ({ __type: 'Repository', repo } as NodeValue) : null;
        }
        if (decoded.kind === 'I') {
          const repo = findRepoById(forge, parseInt(decoded.parts[0] ?? '', 10));
          const issue = repo?.issues.get(parseInt(decoded.parts[1] ?? '', 10));
          return repo && issue ? issueNode(repo, issue) : null;
        }
        if (decoded.kind === 'P') {
          const repo = findRepoById(forge, parseInt(decoded.parts[0] ?? '', 10));
          const pull = repo?.pulls.get(parseInt(decoded.parts[1] ?? '', 10));
          return repo && pull ? pullNode(repo, pull) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (name === 'Issue') return { __type: '__Type', name, fields: ISSUE_TYPE_FIELDS, enumValues: [] } as NodeValue;
        if (name === 'PullRequest') return { __type: '__Type', name, fields: PULL_REQUEST_TYPE_FIELDS, enumValues: [] } as NodeValue;
        if (name === 'Repository') return { __type: '__Type', name, fields: REPOSITORY_TYPE_FIELDS, enumValues: [] } as NodeValue;
        if (name === 'SearchType') return { __type: '__Type', name, fields: [], enumValues: SEARCH_TYPE_VALUES } as NodeValue;
        return null;
      }
      if (field.name === 'createIssue' || field.name === 'closeIssue' || field.name === 'createPullRequest' || field.name === 'mergePullRequest' || field.name === 'addComment') {
        return resolveMutation(ctx, field.name, args);
      }
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Query".`);
    }
    case 'User': {
      if (field.name === 'login') return node.login;
      throw new GraphQLError(`Cannot query field "${field.name}" on type "User".`);
    }
    case 'Repository': {
      const repo = node.repo;
      if (field.name === 'id') return globalId('R', repo.id);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return { __type: 'User', login: repo.owner } as NodeValue;
      if (field.name === 'defaultBranchRef') {
        const tip = forge.defaultTip(repo);
        return tip === undefined ? null : ({ __type: 'Ref', name: repo.defaultBranch } as NodeValue);
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueNode(repo, issue) : null;
      }
      if (field.name === 'issues') return resolveIssueList(ctx, repo, args);
      if (field.name === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : undefined;
        let pulls = [...repo.pulls.values()].filter((p) => p.state === 'open').sort((a, b) => a.seq - b.seq);
        if (first !== undefined) pulls = pulls.slice(0, first);
        return { __type: 'PullRequestConnection', items: pulls.map((pull) => ({ repo, pull })) } as NodeValue;
      }
      if (field.name === 'pullRequest') {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullNode(repo, pull) : null;
      }
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Repository".`);
    }
    case 'Issue': {
      const issue = node.issue;
      if (field.name === 'id') return globalId('I', node.repo.id, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return issue.body;
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Issue".`);
    }
    case 'PullRequest': {
      const pull = node.pull;
      if (field.name === 'id') return globalId('P', node.repo.id, pull.number);
      if (field.name === 'number') return pull.number;
      if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'mergeable') return forge.mergeable(node.repo, pull);
      if (field.name === 'files') {
        const first = typeof args.first === 'number' ? args.first : undefined;
        const headTip = forge.defaultTip(node.repo) === undefined ? undefined : node.repo.refs.get(`refs/heads/${pull.headRef}`);
        const baseTip = node.repo.refs.get(`refs/heads/${pull.baseRef}`);
        let paths: string[] = [];
        if (headTip !== undefined && baseTip !== undefined) {
          const base = forge.mergeBase(node.repo, headTip, baseTip) ?? pull.baseSha;
          const baseCommit = forge.commitOf(node.repo, base);
          const headCommit = forge.commitOf(node.repo, headTip);
          if (baseCommit && headCommit) {
            paths = forge.diffTrees(node.repo, baseCommit.tree, headCommit.tree).map((c) => c.filename);
          }
        }
        if (first !== undefined) paths = paths.slice(0, first);
        return { __type: 'ChangedFileConnection', items: paths.map((path) => ({ path })) } as NodeValue;
      }
      throw new GraphQLError(`Cannot query field "${field.name}" on type "PullRequest".`);
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return node.items.map((item) => issueNode(item.repo, item.issue));
      if (field.name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: node.hasNextPage, endCursor: node.endCursor } as NodeValue;
      if (field.name === 'totalCount') return node.items.length;
      throw new GraphQLError(`Cannot query field "${field.name}" on type "IssueConnection".`);
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return node.items.map((item) => pullNode(item.repo, item.pull));
      if (field.name === 'totalCount') return node.items.length;
      throw new GraphQLError(`Cannot query field "${field.name}" on type "PullRequestConnection".`);
    }
    case 'ChangedFileConnection': {
      if (field.name === 'nodes') return node.items.map((item) => ({ __type: 'ChangedFile', path: item.path }) as NodeValue);
      if (field.name === 'totalCount') return node.items.length;
      throw new GraphQLError(`Cannot query field "${field.name}" on type "PullRequestChangedFileConnection".`);
    }
    case 'ChangedFile': {
      if (field.name === 'path') return node.path;
      throw new GraphQLError(`Cannot query field "${field.name}" on type "PullRequestChangedFile".`);
    }
    case 'Ref': {
      if (field.name === 'name') return node.name;
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Ref".`);
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return node.hasNextPage;
      if (field.name === 'endCursor') return node.endCursor;
      throw new GraphQLError(`Cannot query field "${field.name}" on type "PageInfo".`);
    }
    case '__Type': {
      if (field.name === 'name') return node.name;
      if (field.name === 'kind') return node.enumValues.length > 0 ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') return node.fields.map((name) => ({ __type: '__Field', name }) as unknown as NodeValue);
      if (field.name === 'enumValues') return node.enumValues.map((name) => ({ __type: '__EnumValue', name }) as unknown as NodeValue);
      throw new GraphQLError(`Cannot query field "${field.name}" on type "__Type".`);
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') return issueNode(node.issue.repo, node.issue.issue);
      throw new GraphQLError(`Cannot query field "${field.name}" on type "CreateIssuePayload".`);
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return issueNode(node.issue.repo, node.issue.issue);
      throw new GraphQLError(`Cannot query field "${field.name}" on type "CloseIssuePayload".`);
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') return pullNode(node.pullRequest.repo, node.pullRequest.pull);
      throw new GraphQLError(`Cannot query field "${field.name}" on type "CreatePullRequestPayload".`);
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return pullNode(node.pullRequest.repo, node.pullRequest.pull);
      throw new GraphQLError(`Cannot query field "${field.name}" on type "MergePullRequestPayload".`);
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return { __type: 'CommentEdge', node: node.comment } as unknown as NodeValue;
      throw new GraphQLError(`Cannot query field "${field.name}" on type "AddCommentPayload".`);
    }
    default: {
      // __Field / __EnumValue / CommentEdge nodes reach here through the generic path.
      const anyNode = node as unknown as Record<string, unknown>;
      if (anyNode.__type === '__Field' || anyNode.__type === '__EnumValue') {
        if (field.name === 'name') return anyNode.name;
        throw new GraphQLError(`Cannot query field "${field.name}" on type "${String(anyNode.__type)}".`);
      }
      if (anyNode.__type === 'CommentEdge') {
        if (field.name === 'node') return { __type: 'Comment', id: (anyNode.node as { id: string }).id, body: (anyNode.node as { body: string }).body } as unknown as NodeValue;
        throw new GraphQLError(`Cannot query field "${field.name}" on type "CommentEdge".`);
      }
      if (anyNode.__type === 'Comment') {
        if (field.name === 'id') return anyNode.id;
        if (field.name === 'body') return anyNode.body;
        throw new GraphQLError(`Cannot query field "${field.name}" on type "Comment".`);
      }
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${String(anyNode.__type)}".`);
    }
  }
}

function resolveMutation(ctx: ExecContext, name: string, args: Record<string, unknown>): NodeValue {
  const { forge } = ctx;
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const decoded = decodeGlobalId(input.repositoryId);
    const repo = decoded?.kind === 'R' ? findRepoById(forge, parseInt(decoded.parts[0] ?? '', 10)) : undefined;
    if (!repo) throw new GraphQLError('createIssue: unknown repositoryId');
    const issue = forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    return { __type: 'CreateIssuePayload', issue: { repo, issue } };
  }
  if (name === 'closeIssue') {
    const decoded = decodeGlobalId(input.issueId);
    const repo = decoded?.kind === 'I' ? findRepoById(forge, parseInt(decoded.parts[0] ?? '', 10)) : undefined;
    const issue = repo?.issues.get(parseInt(decoded?.parts[1] ?? '', 10));
    if (!repo || !issue) throw new GraphQLError('closeIssue: unknown issueId');
    issue.state = 'closed';
    return { __type: 'CloseIssuePayload', issue: { repo, issue } };
  }
  if (name === 'createPullRequest') {
    const decoded = decodeGlobalId(input.repositoryId);
    const repo = decoded?.kind === 'R' ? findRepoById(forge, parseInt(decoded.parts[0] ?? '', 10)) : undefined;
    if (!repo) throw new GraphQLError('createPullRequest: unknown repositoryId');
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) throw new GraphQLError('createPullRequest: unknown head or base branch');
    const pull = forge.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, baseRef, headSha, baseSha);
    return { __type: 'CreatePullRequestPayload', pullRequest: { repo, pull } };
  }
  if (name === 'mergePullRequest') {
    const decoded = decodeGlobalId(input.pullRequestId);
    const repo = decoded?.kind === 'P' ? findRepoById(forge, parseInt(decoded.parts[0] ?? '', 10)) : undefined;
    const pull = repo?.pulls.get(parseInt(decoded?.parts[1] ?? '', 10));
    if (!repo || !pull) throw new GraphQLError('mergePullRequest: unknown pullRequestId');
    const method = String(input.mergeMethod ?? 'SQUASH');
    const result = forge.mergePullRequest(repo, pull, method === 'MERGE' ? 'merge' : 'squash');
    if ('conflict' in result) throw new GraphQLError('mergePullRequest: merge conflict');
    return { __type: 'MergePullRequestPayload', pullRequest: { repo, pull } };
  }
  if (name === 'addComment') {
    const decoded = decodeGlobalId(input.subjectId);
    const repo = decoded?.kind === 'I' ? findRepoById(forge, parseInt(decoded.parts[0] ?? '', 10)) : undefined;
    const issue = repo?.issues.get(parseInt(decoded?.parts[1] ?? '', 10));
    if (!repo || !issue) throw new GraphQLError('addComment: unknown subjectId');
    const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), user: repo.owner };
    issue.comments.push(comment);
    return {
      __type: 'AddCommentPayload',
      comment: { id: globalId('C', repo.id, issue.number, comment.id), body: comment.body },
    };
  }
  throw new GraphQLError(`unknown mutation ${name}`);
}

function isNodeValue(value: unknown): value is NodeValue {
  return typeof value === 'object' && value !== null && typeof (value as { __type?: unknown }).__type === 'string';
}

function resolveSelection(ctx: ExecContext, node: NodeValue, selection: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== undefined && sel.typeCondition !== node.__type) continue;
      const sub = resolveSelection(ctx, node, sel.selection);
      Object.assign(out, sub);
      continue;
    }
    const key = sel.alias ?? sel.name;
    let value: unknown;
    try {
      value = fieldResolver(ctx, node, sel);
    } catch (error) {
      if (error instanceof GraphQLError) {
        ctx.errors.push({ message: error.message });
        out[key] = null;
        continue;
      }
      throw error;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (isNodeValue(item) && sel.selection) return resolveSelection(ctx, item, sel.selection);
        return item;
      });
      continue;
    }
    if (isNodeValue(value)) {
      if (sel.selection) out[key] = resolveSelection(ctx, value, sel.selection);
      else out[key] = null;
      continue;
    }
    out[key] = value;
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// HTTP entry: one document, or a JSON array of documents (GitHub batching).
// -------------------------------------------------------------------------------------------

export interface GraphQLHttpResult {
  status: number;
  body: unknown;
}

export function handleGraphQL(forge: Forge, rawBody: string): GraphQLHttpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'invalid operation' }] };
      const query = String((entry as Record<string, unknown>).query ?? '');
      const variables = ((entry as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
      return executeGraphQL(forge, query, variables);
    });
    return { status: 200, body: results };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { errors: [{ message: 'invalid GraphQL request' }] } };
  }
  const query = String((parsed as Record<string, unknown>).query ?? '');
  const variables = ((parsed as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
  return { status: 200, body: executeGraphQL(forge, query, variables) };
}
