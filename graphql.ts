// graphql.ts — a small GraphQL layer over /api/graphql.
//
// The kit only ever sends a fixed family of documents (viewer, repository and issue
// reads, the five mutations, introspection probes, one batched pair), so this is a
// purpose-built parser and executor rather than a full spec implementation. It
// resolves fields from plain view objects; fields that need arguments (issues,
// pullRequests, files, issue(number:)) are functions on those objects. Unknown
// fields produce a 200 response carrying an `errors` entry naming the field, which
// is what the kit's invalid-field check expects.

import type { ForgeStore, Issue, Pull, Repo } from './store.ts';
import { VIEWER } from './store.ts';

// ---------------------------------------------------------------------------
// Global ids: opaque, stable, and never equal to a plain database id or number.
// ---------------------------------------------------------------------------

function gid(...parts: string[]): string {
  return Buffer.from(parts.join('\u001f'), 'utf8').toString('base64url');
}

function ungid(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    if (!text.includes('\u001f')) return null;
    return text.split('\u001f');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The introspection table: the types the kit probes, and their fields.
// ---------------------------------------------------------------------------

const SCHEMA: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; values?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'private', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'createdAt', 'author', 'labels', 'comments'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'mergedAt', 'mergeCommit', 'author'],
  },
  PullRequestFile: { kind: 'OBJECT', fields: ['path', 'status', 'additions', 'deletions', 'changes'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'CODE', 'DISCUSSION', 'MILESTONE', 'PULL_REQUEST', 'WIKI'] },
};

// ---------------------------------------------------------------------------
// Parser: documents -> operations and fragments.
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] };

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, ValueNode | undefined>;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}():!$=@[]|&'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let float = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      if (source[j] === '.') { float = true; j += 1; while (j < source.length && /[0-9]/.test(source[j])) j += 1; }
      if (source[j] === 'e' || source[j] === 'E') {
        float = true; j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push(float ? { kind: 'float', value: source.slice(i, j) } : { kind: 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
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
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.kind} ${'value' in token ? token.value : ''}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private atName(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'name' && token.value === value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Record<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments: Record<string, FragmentNode> = {};
    while (this.peek() !== undefined) {
      if (this.atName('fragment')) {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        fragments[name] = { name, typeCondition, selections };
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const variables: Record<string, ValueNode | undefined> = {};
    if (this.atName('query') || this.atName('mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      if (this.peek()?.kind === 'name') name = this.next().value as string;
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          this.expectPunct('$');
          const varName = this.expectName();
          this.expectPunct(':');
          this.parseType();
          if (this.atPunct('=')) {
            this.next();
            variables[varName] = this.parseValue();
          } else {
            variables[varName] = undefined;
          }
        }
        this.expectPunct(')');
      }
      this.skipDirectives();
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.atPunct('...')) {
        this.next();
        if (this.atName('on')) {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else if (this.peek()?.kind === 'name') {
          const name = this.next().value as string;
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() });
        }
      } else {
        selections.push(this.parseField());
      }
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.atPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selections = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'string': return { kind: 'string', value: token.value };
      case 'int': return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float': return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const items: ValueNode[] = [];
          while (!this.atPunct(']')) items.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!this.atPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected punctuation ${token.value} in a value`);
    }
  }
}

// ---------------------------------------------------------------------------
// Executor.
// ---------------------------------------------------------------------------

type AnyObject = Record<string, unknown> & { __typename?: string };

function evaluate(value: ValueNode, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string': return value.value;
    case 'int': return value.value;
    case 'float': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'variable': return variables[value.name] ?? null;
    case 'list': return value.items.map((item) => evaluate(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evaluate(field.value, variables);
      return out;
    }
  }
}

interface Executor {
  store: ForgeStore;
  fragments: Record<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function resolveFieldValue(exec: Executor, object: AnyObject, field: FieldNode, variables: Record<string, unknown>): unknown {
  if (field.name === '__typename') return object.__typename ?? null;
  const raw = object[field.name];
  if (raw === undefined) {
    exec.errors.push({ message: `Cannot query field "${field.name}" on type "${object.__typename ?? 'Unknown'}".` });
    return undefined;
  }
  if (typeof raw === 'function') {
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = evaluate(arg.value, variables);
    return (raw as (args: Record<string, unknown>) => unknown)(args);
  }
  return raw;
}

function executeSelections(
  exec: Executor,
  selections: SelectionNode[],
  object: AnyObject,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = exec.fragments[selection.name];
      if (fragment === undefined) {
        exec.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== object.__typename) continue;
      Object.assign(out, executeSelections(exec, fragment.selections, object, variables));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== object.__typename) continue;
      Object.assign(out, executeSelections(exec, selection.selections, object, variables));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveFieldValue(exec, object, selection, variables);
    if (value === undefined) {
      out[key] = null;
      continue;
    }
    if (selection.selections === null) {
      out[key] = value;
      continue;
    }
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item !== null && typeof item === 'object'
          ? executeSelections(exec, selection.selections as SelectionNode[], item as AnyObject, variables)
          : item,
      );
      continue;
    }
    if (typeof value === 'object') {
      out[key] = executeSelections(exec, selection.selections, value as AnyObject, variables);
      continue;
    }
    exec.errors.push({ message: `Field "${selection.name}" must not have a selection since type "${typeof value}" has no subfields.` });
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// View builders: plain objects the executor reads.
// ---------------------------------------------------------------------------

function cursorFor(kind: string, number: number): string {
  return Buffer.from(`cursor:${kind}:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:[a-z]+:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1], 10);
  } catch {
    return null;
  }
}

function pageInfoFor(start: number, page: Array<{ number: number }>, total: number, kind: string): AnyObject {
  const last = page[page.length - 1];
  return {
    __typename: 'PageInfo',
    hasNextPage: start + page.length < total,
    hasPreviousPage: start > 0,
    startCursor: page.length > 0 ? cursorFor(kind, page[0].number) : null,
    endCursor: last !== undefined ? cursorFor(kind, last.number) : null,
  };
}

function issueView(store: ForgeStore, repo: Repo, issue: Issue): AnyObject {
  return {
    __typename: 'Issue',
    id: gid('issue', repo.owner, repo.name, String(issue.number)),
    databaseId: issue.number,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.createdAt,
    author: { __typename: 'User', login: VIEWER.login, id: gid('user', VIEWER.login), name: VIEWER.name, email: VIEWER.email },
    labels: issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    comments: (args: Record<string, unknown>) => {
      const nodes = issue.comments.map((comment) => ({
        __typename: 'IssueComment',
        id: gid('comment', repo.owner, repo.name, String(issue.number), String(comment.id)),
        databaseId: comment.id,
        body: comment.body,
      }));
      const first = typeof args.first === 'number' ? args.first : nodes.length;
      const page = nodes.slice(0, first);
      return {
        __typename: 'IssueCommentConnection',
        nodes: page,
        edges: page.map((node) => ({ __typename: 'IssueCommentEdge', node, cursor: cursorFor('comment', node.databaseId as number) })),
        pageInfo: pageInfoFor(0, page.map((node) => ({ number: node.databaseId as number })), nodes.length, 'comment'),
        totalCount: nodes.length,
      };
    },
  };
}

function pullView(store: ForgeStore, repo: Repo, pull: Pull): AnyObject {
  return {
    __typename: 'PullRequest',
    id: gid('pull', repo.owner, repo.name, String(pull.number)),
    databaseId: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: store.pullMergeable(repo, pull),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRef: { __typename: 'Ref', name: pull.headRef, oid: pull.headSha },
    baseRef: { __typename: 'Ref', name: pull.baseRef, oid: pull.baseSha },
    mergedAt: pull.mergedAt,
    mergeCommit: pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha },
    author: { __typename: 'User', login: VIEWER.login, id: gid('user', VIEWER.login), name: VIEWER.name, email: VIEWER.email },
    files: (args: Record<string, unknown>) => {
      const all = store.pullFiles(repo, pull) ?? [];
      const nodes = all.map((file) => ({
        __typename: 'PullRequestFile',
        path: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }));
      const first = typeof args.first === 'number' ? args.first : nodes.length;
      const page = nodes.slice(0, first);
      return {
        __typename: 'PullRequestFileConnection',
        nodes: page,
        edges: page.map((node, index) => ({ __typename: 'PullRequestFileEdge', node, cursor: cursorFor('file', index + 1) })),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: page.length < nodes.length,
          hasPreviousPage: false,
          startCursor: page.length > 0 ? cursorFor('file', 1) : null,
          endCursor: page.length > 0 ? cursorFor('file', page.length) : null,
        },
        totalCount: nodes.length,
      };
    },
  };
}

function repositoryView(store: ForgeStore, repo: Repo): AnyObject {
  return {
    __typename: 'Repository',
    id: gid('repo', repo.owner, repo.name),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: gid('user', repo.owner), name: VIEWER.name, email: VIEWER.email },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.isPrivate,
    issue: (args: Record<string, unknown>) => {
      const issue = repo.issues.get(args.number as number);
      return issue === undefined ? null : issueView(store, repo, issue);
    },
    issues: (args: Record<string, unknown>) => {
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'ASC').toUpperCase() === 'DESC' ? 'desc' : 'asc';
      const all = store.listIssues(repo, { state: 'all', sort: 'created', direction, perPage: 10000, page: 1 });
      const wanted = Array.isArray(args.states)
        ? (args.states as unknown[]).map((state) => String(state).toLowerCase())
        : null;
      const filtered = wanted === null ? all : all.filter((issue) => wanted.includes(issue.state));
      const after = cursorNumber(args.after);
      const start = after === null ? 0 : filtered.findIndex((issue) => issue.number === after) + 1;
      const first = typeof args.first === 'number' ? args.first : filtered.length;
      const page = filtered.slice(start, start + first);
      return {
        __typename: 'IssueConnection',
        nodes: page.map((issue) => issueView(store, repo, issue)),
        edges: page.map((issue) => ({ __typename: 'IssueEdge', node: issueView(store, repo, issue), cursor: cursorFor('issue', issue.number) })),
        pageInfo: pageInfoFor(start, page, filtered.length, 'issue'),
        totalCount: filtered.length,
      };
    },
    pullRequests: (args: Record<string, unknown>) => {
      const all = store.listPulls(repo, { perPage: 10000, page: 1 });
      const after = cursorNumber(args.after);
      const start = after === null ? 0 : all.findIndex((pull) => pull.number === after) + 1;
      const first = typeof args.first === 'number' ? args.first : all.length;
      const page = all.slice(start, start + first);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((pull) => pullView(store, repo, pull)),
        edges: page.map((pull) => ({ __typename: 'PullRequestEdge', node: pullView(store, repo, pull), cursor: cursorFor('pull', pull.number) })),
        pageInfo: pageInfoFor(start, page, all.length, 'pull'),
        totalCount: all.length,
      };
    },
    pullRequest: (args: Record<string, unknown>) => {
      const pull = repo.pulls.get(args.number as number);
      return pull === undefined ? null : pullView(store, repo, pull);
    },
  };
}

function typeView(name: string): AnyObject | null {
  const entry = SCHEMA[name];
  if (entry === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: entry.kind,
    fields: () => (entry.fields ?? []).map((field) => ({ __typename: '__Field', name: field })),
    enumValues: () => (entry.values ?? []).map((value) => ({ __typename: '__EnumValue', name: value })),
    description: null,
  };
}

function rootView(store: ForgeStore): AnyObject {
  return {
    __typename: 'Query',
    viewer: {
      __typename: 'User',
      login: VIEWER.login,
      id: gid('user', VIEWER.login),
      name: VIEWER.name,
      email: VIEWER.email,
    },
    repository: (args: Record<string, unknown>) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER.login) return null;
      const repo = store.getRepo(owner, name);
      return repo === undefined ? null : repositoryView(store, repo);
    },
    node: (args: Record<string, unknown>) => {
      const parts = ungid(String(args.id ?? ''));
      if (parts === null) return null;
      const [kind, owner, name, number] = parts;
      if (kind === 'repo') {
        const repo = store.getRepo(owner, name);
        return repo === undefined ? null : repositoryView(store, repo);
      }
      if (kind === 'issue') {
        const repo = store.getRepo(owner, name);
        const issue = repo?.issues.get(Number.parseInt(number, 10));
        return repo === undefined || issue === undefined ? null : issueView(store, repo, issue);
      }
      if (kind === 'pull') {
        const repo = store.getRepo(owner, name);
        const pull = repo?.pulls.get(Number.parseInt(number, 10));
        return repo === undefined || pull === undefined ? null : pullView(store, repo, pull);
      }
      return null;
    },
    __type: (args: Record<string, unknown>) => typeView(String(args.name ?? '')),
    __schema: {
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query' },
      mutationType: { __typename: '__Type', name: 'Mutation' },
      types: () => Object.keys(SCHEMA).map((name) => typeView(name)).filter((view): view is AnyObject => view !== null),
    },
  };
}

function mutationView(store: ForgeStore): AnyObject {
  return {
    __typename: 'Mutation',
    createIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parts = ungid(String(input.repositoryId ?? ''));
      if (parts === null || parts[0] !== 'repo') return { issue: null };
      const repo = store.getRepo(parts[1], parts[2]);
      if (repo === undefined) return { issue: null };
      const result = store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? ''), labels: [] });
      if ('error' in result) return { issue: null };
      return { issue: issueView(store, repo, result.issue) };
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parts = ungid(String(input.issueId ?? ''));
      if (parts === null || parts[0] !== 'issue') return { issue: null };
      const repo = store.getRepo(parts[1], parts[2]);
      if (repo === undefined) return { issue: null };
      const issue = store.patchIssue(repo, Number.parseInt(parts[3], 10), { state: 'closed' });
      if (issue === null) return { issue: null };
      return { issue: issueView(store, repo, issue) };
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parts = ungid(String(input.repositoryId ?? ''));
      if (parts === null || parts[0] !== 'repo') return { pullRequest: null };
      const repo = store.getRepo(parts[1], parts[2]);
      if (repo === undefined) return { pullRequest: null };
      const result = store.createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if ('error' in result) return { pullRequest: null };
      return { pullRequest: pullView(store, repo, result.pull) };
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parts = ungid(String(input.pullRequestId ?? ''));
      if (parts === null || parts[0] !== 'pull') return { pullRequest: null };
      const repo = store.getRepo(parts[1], parts[2]);
      if (repo === undefined) return { pullRequest: null };
      const result = store.mergePull(repo, Number.parseInt(parts[3], 10));
      if ('error' in result) return { pullRequest: null };
      const pull = repo.pulls.get(Number.parseInt(parts[3], 10));
      if (pull === undefined) return { pullRequest: null };
      return { pullRequest: pullView(store, repo, pull) };
    },
    addComment: (args: Record<string, unknown>) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parts = ungid(String(input.subjectId ?? ''));
      if (parts === null || parts[0] !== 'issue') return { commentEdge: null };
      const repo = store.getRepo(parts[1], parts[2]);
      if (repo === undefined) return { commentEdge: null };
      const comment = store.addComment(repo, Number.parseInt(parts[3], 10), String(input.body ?? ''));
      if (comment === null) return { commentEdge: null };
      return {
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: {
            __typename: 'IssueComment',
            id: gid('comment', parts[1], parts[2], parts[3], String(comment.id)),
            databaseId: comment.id,
            body: comment.body,
          },
          cursor: cursorFor('comment', comment.id),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The endpoint: one document, or an array of documents (batched operations).
// ---------------------------------------------------------------------------

function executeDocument(store: ForgeStore, body: unknown): Record<string, unknown> {
  const query = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).query : undefined;
  const variables = typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).variables === 'object'
    ? (body as Record<string, unknown>).variables as Record<string, unknown>
    : {};
  const operationName = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).operationName : undefined;
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'a GraphQL query string is required' }] };
  }
  let parsed: { operations: OperationNode[]; fragments: Record<string, FragmentNode> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'query parse error' }] };
  }
  if (parsed.operations.length === 0) {
    return { errors: [{ message: 'no operation in the document' }] };
  }
  let operation = parsed.operations[0];
  if (typeof operationName === 'string') {
    operation = parsed.operations.find((candidate) => candidate.name === operationName) ?? operation;
  }
  const exec: Executor = { store, fragments: parsed.fragments, errors: [] };
  const root = operation.kind === 'mutation' ? mutationView(store) : rootView(store);
  const data = executeSelections(exec, operation.selections, root, variables);
  const result: Record<string, unknown> = { data };
  if (exec.errors.length > 0) result.errors = exec.errors;
  return result;
}

/** Handle POST /api/graphql. `body` is the already-parsed JSON request body. */
export function routeGraphQL(store: ForgeStore, body: unknown): { status: number; text: string } {
  const result = Array.isArray(body)
    ? body.map((item) => executeDocument(store, item))
    : executeDocument(store, body);
  return { status: 200, text: JSON.stringify(result) };
}
