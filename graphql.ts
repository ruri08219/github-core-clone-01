// graphql.ts — a compact GraphQL engine for the exact documents gh and
// github-mcp-server send (see kit sdk/conformance/checks-graphql.ts
// GRAPHQL_DOCUMENTS). It lexes and parses operations, variables, aliases, inline
// input objects/enums and inline fragments, then resolves them against the forge
// store. An unknown field answers HTTP 200 with an errors array naming the field
// (GitHub's behaviour), never an HTTP 400.

import { Forge, VIEWER, type Issue, type Pull, type Repo } from './store.ts';

// -------------------------------------------------------------------------------------------
// Tokenizer + parser
// -------------------------------------------------------------------------------------------

type LexToken =
  | { kind: 'punct'; value: string } // one of {}()[]:!= $ and similar
  | { kind: 'name'; value: string } // identifiers and bare keywords
  | { kind: 'int'; value: number } // integer literals
  | { kind: 'string'; value: string } // double-quoted literals, escapes resolved
  | { kind: 'spread'; value: '...' } // fragment spread marker
  | { kind: 'variable'; value: string }; // $name, without the dollar

function lexDocument(input: string): LexToken[] {
  const lexed: LexToken[] = [];
  let pos = 0;
  const startsName = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNamePart = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (pos < input.length) {
    const ch = input[pos]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      pos += 1;
      continue;
    }
    if (ch === '#') {
      while (pos < input.length && input[pos] !== '\n') pos += 1;
      continue;
    }
    if (ch === '.' && input.slice(pos, pos + 3) === '...') {
      lexed.push({ kind: 'spread', value: '...' });
      pos += 3;
      continue;
    }
    if (ch === '$') {
      let end = pos + 1;
      while (end < input.length && isNamePart(input[end]!)) end += 1;
      lexed.push({ kind: 'variable', value: input.slice(pos + 1, end) });
      pos = end;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      lexed.push({ kind: 'punct', value: ch });
      pos += 1;
      continue;
    }
    if (ch === '"') {
      let end = pos + 1;
      let text = '';
      while (end < input.length && input[end] !== '"') {
        if (input[end] === '\\' && end + 1 < input.length) {
          const escape = input[end + 1]!;
          if (escape === 'n') text += '\n';
          else if (escape === 't') text += '\t';
          else if (escape === 'r') text += '\r';
          else text += escape;
          end += 2;
        } else {
          text += input[end]!;
          end += 1;
        }
      }
      lexed.push({ kind: 'string', value: text });
      pos = end + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[pos + 1] ?? ''))) {
      let end = pos;
      if (input[end] === '-') end += 1;
      while (end < input.length && /[0-9]/.test(input[end]!)) end += 1;
      lexed.push({ kind: 'int', value: parseInt(input.slice(pos, end), 10) });
      pos = end;
      continue;
    }
    if (startsName(ch)) {
      let end = pos;
      while (end < input.length && isNamePart(input[end]!)) end += 1;
      lexed.push({ kind: 'name', value: input.slice(pos, end) });
      pos = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return lexed;
}

// A literal value in a document: a $variable, a scalar, a list, or an input object.
export type ValueNode =
  | { kind: 'variable'; name: string } // $name — resolved from the variables map
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string } // bare name, e.g. OPEN or SQUASH
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

// One field in a selection set, with its alias (if any), arguments, and sub-selection.
export interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selection?: SelectionNode[];
}

// An inline fragment (`... on Type { ... }`); typeCondition is undefined for `... { }`.
export interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selection: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

// One top-level operation in a document (query or mutation), with its variable
// definitions (defaults kept for completeness) and its selection set.
export interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Record<string, { default?: ValueNode }>;
  selection: SelectionNode[];
}

class DocParser {
  private cursor = 0;
  private readonly tokens: LexToken[];
  constructor(tokens: LexToken[]) {
    this.tokens = tokens;
  }

  private peekTok(): LexToken | undefined {
    return this.tokens[this.cursor];
  }
  private takeTok(): LexToken {
    const token = this.tokens[this.cursor];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.cursor += 1;
    return token;
  }
  private wantPunct(value: string): void {
    const tok = this.takeTok();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value}, got ${tok.kind} ${JSON.stringify((tok as { value?: unknown }).value)}`);
  }
  private wantName(expected?: string): string {
    const tok = this.takeTok();
    if (tok.kind !== 'name') throw new Error(`expected a name, got ${tok.kind}`);
    if (expected !== undefined && tok.value !== expected) throw new Error(`expected ${expected}, got ${tok.value}`);
    return tok.value;
  }

  parseAll(): Operation[] {
    const docs: Operation[] = [];
    while (this.cursor < this.tokens.length) {
      docs.push(this.parseOp());
    }
    return docs;
  }

  private parseOp(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const token = this.peekTok();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.takeTok().value as 'query' | 'mutation';
    }
    let name: string | undefined;
    const maybeName = this.peekTok();
    if (maybeName?.kind === 'name') {
      name = this.takeTok().value as string;
    }
    const variables: Record<string, { default?: ValueNode }> = {};
    if (this.peekTok()?.kind === 'punct' && (this.peekTok() as { value: string }).value === '(') {
      this.takeTok();
      while (!(this.peekTok()?.kind === 'punct' && (this.peekTok() as { value: string }).value === ')')) {
        const varToken = this.takeTok();
        if (varToken.kind !== 'variable') throw new Error('expected a variable definition');
        this.wantPunct(':');
        this.parseTypeName();
        let def: ValueNode | undefined;
        if (this.peekTok()?.kind === 'punct' && (this.peekTok() as { value: string }).value === '=') {
          this.takeTok();
          def = this.parseArg();
        }
        variables[varToken.value] = { default: def };
      }
      this.wantPunct(')');
    }
    const selection = this.parseFields();
    return { kind, name, variables, selection };
  }

  private parseTypeName(): void {
    const token = this.takeTok();
    if (token.kind === 'punct' && token.value === '[') {
      this.parseTypeName();
      this.wantPunct(']');
    } else if (token.kind !== 'name') {
      throw new Error('expected a type');
    }
    if (this.peekTok()?.kind === 'punct' && (this.peekTok() as { value: string }).value === '!') this.takeTok();
  }

  private parseFields(): SelectionNode[] {
    this.wantPunct('{');
    const fields: SelectionNode[] = [];
    while (!(this.peekTok()?.kind === 'punct' && (this.peekTok() as { value: string }).value === '}')) {
      const token = this.peekTok();
      if (token?.kind === 'spread') {
        this.takeTok();
        let typeCondition: string | undefined;
        const on = this.peekTok();
        if (on?.kind === 'name' && on.value === 'on') {
          this.takeTok();
          typeCondition = this.wantName();
        }
        fields.push({ kind: 'fragment', typeCondition, selection: this.parseFields() });
        continue;
      }
      const first = this.wantName();
      let alias: string | undefined;
      let name = first;
      const colon = this.peekTok();
      if (colon?.kind === 'punct' && colon.value === ':') {
        this.takeTok();
        alias = first;
        name = this.wantName();
      }
      const args: Record<string, ValueNode> = {};
      if (this.peekTok()?.kind === 'punct' && (this.peekTok() as { value: string }).value === '(') {
        this.takeTok();
        while (!(this.peekTok()?.kind === 'punct' && (this.peekTok() as { value: string }).value === ')')) {
          const argName = this.wantName();
          this.wantPunct(':');
          args[argName] = this.parseArg();
        }
        this.wantPunct(')');
      }
      let sub: SelectionNode[] | undefined;
      if (this.peekTok()?.kind === 'punct' && (this.peekTok() as { value: string }).value === '{') {
        sub = this.parseFields();
      }
      fields.push({ kind: 'field', alias, name, args, selection: sub });
    }
    this.wantPunct('}');
    return fields;
  }

  private parseArg(): ValueNode {
    const tok = this.takeTok();
    if (tok.kind === 'variable') return { kind: 'variable', name: tok.value };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: tok.value };
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peekTok()?.kind === 'punct' && (this.peekTok() as { value: string }).value === ']')) {
        values.push(this.parseArg());
      }
      this.wantPunct(']');
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peekTok()?.kind === 'punct' && (this.peekTok() as { value: string }).value === '}')) {
        const name = this.wantName();
        this.wantPunct(':');
        fields[name] = this.parseArg();
      }
      this.wantPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected value token ${tok.kind}`);
  }
}

function materialize(value: ValueNode, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': {
      const resolved = vars[value.name];
      return resolved === undefined ? null : resolved;
    }
    case 'string':
    case 'int':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((v) => materialize(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value.fields)) out[key] = materialize(v, vars);
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

function decodeNodeId(encoded: unknown): { kind: string; parts: string[] } | null {
  if (typeof encoded !== 'string' || encoded === '') return null;
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const [type, ...segments] = decoded.split(':');
    if (!type || segments.length === 0) return null;
    return { kind: type, parts: segments };
  } catch {
    return null;
  }
}

function cursorAt(index: number): string {
  return Buffer.from(`c:${index}`).toString('base64url');
}

function cursorIndex(encoded: unknown): number {
  if (typeof encoded !== 'string' || encoded === '') return -1;
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const found = /^c:(\d+)$/.exec(decoded);
    return found ? parseInt(found[1]!, 10) : -1;
  } catch {
    return -1;
  }
}

// -------------------------------------------------------------------------------------------
// Node wrappers
// -------------------------------------------------------------------------------------------

// A resolved node the field resolver walks: the __type tag drives the switch in
// resolveField, and the payload fields carry the store objects behind it.
type GqlNode =
  | { __type: 'Query' } // root — no payload
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'Ref'; name: string } // a branch ref (defaultBranchRef)
  | {
      __type: 'IssueConnection';
      items: Array<{ repo: Repo; issue: Issue }>;
      hasNextPage: boolean;
      endCursor: string | null;
    }
  | { __type: 'PullRequestConnection'; items: Array<{ repo: Repo; pull: Pull }> }
  | { __type: 'ChangedFileConnection'; items: Array<{ path: string }> }
  | { __type: 'ChangedFile'; path: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: '__Type'; name: string; fields: string[]; enumValues: string[] } // introspection
  | { __type: 'CreateIssuePayload'; issue: { repo: Repo; issue: Issue } }
  | { __type: 'CloseIssuePayload'; issue: { repo: Repo; issue: Issue } }
  | { __type: 'CreatePullRequestPayload'; pullRequest: { repo: Repo; pull: Pull } }
  | { __type: 'MergePullRequestPayload'; pullRequest: { repo: Repo; pull: Pull } }
  | { __type: 'AddCommentPayload'; comment: { id: string; body: string } };

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments', 'closedAt'];
const PULL_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'url'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'];
const SEARCH_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'TOPIC'];

class GqlError extends Error {}

// -------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string }>;
}

export function executeGraphQL(
  store: Forge,
  query: string,
  variables: Record<string, unknown>,
): GraphQLResult {
  let docs: Operation[];
  try {
    docs = new DocParser(lexDocument(query)).parseAll();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  // The suite sends one operation per body; execute the first (batching is handled by
  // the caller, which runs one execute per document).
  const op = docs[0];
  if (!op) return { data: null, errors: [{ message: 'empty GraphQL document' }] };
  const problems: Array<{ message: string }> = [];
  const context: Ctx = { store, vars: variables, problems };
  const payload = resolveFields(context, { __type: 'Query' }, op.selection);
  return { data: payload, errors: problems };
}

interface Ctx {
  store: Forge;
  vars: Record<string, unknown>;
  problems: Array<{ message: string }>;
}

function repoById(store: Forge, num: number): Repo | undefined {
  for (const record of store.repos.values()) if (record.id === num) return record;
  return undefined;
}

function wrapIssue(record: Repo, item: Issue): GqlNode {
  return { __type: 'Issue', repo: record, issue: item };
}

function wrapPull(record: Repo, request: Pull): GqlNode {
  return { __type: 'PullRequest', repo: record, pull: request };
}

function listIssues(
  context: Ctx,
  record: Repo,
  params: Record<string, unknown>,
): GqlNode {
  const limit = typeof params.first === 'number' ? params.first : undefined;
  const wantedStates = Array.isArray(params.states) ? (params.states as string[]) : undefined;
  const order = (params.orderBy ?? {}) as { field?: string; direction?: string };
  const cursor = cursorIndex(params.after);
  let items = [...record.issues.values()];
  if (wantedStates) {
    const keep = new Set(wantedStates.map((s) => s.toLowerCase()));
    items = items.filter((i) => keep.has(i.state));
  }
  if (order.field === 'CREATED_AT') {
    items.sort((a, b) => (order.direction === 'DESC' ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
  } else if (order.field === 'UPDATED_AT') {
    items.sort((a, b) => (order.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  } else {
    items.sort((a, b) => a.seq - b.seq);
  }
  const offset = cursor + 1;
  const page = limit !== undefined ? items.slice(offset, offset + limit) : items.slice(offset);
  const lastIndex = offset + page.length - 1;
  const more = lastIndex + 1 < items.length;
  return {
    __type: 'IssueConnection',
    items: page.map((item) => ({ repo: record, issue: item })),
    hasNextPage: more,
    endCursor: page.length > 0 ? cursorAt(lastIndex) : null,
  };
}

function resolveField(context: Ctx, value: GqlNode, sel: FieldNode): unknown {
  const { store } = context;
  const params: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(sel.args)) params[key] = materialize(v, context.vars);

  switch (value.__type) {
    case 'Query': {
      if (sel.name === 'viewer') return { __type: 'User', login: VIEWER.login } as GqlNode;
      if (sel.name === 'repository') {
        const record = store.getRepo(String(params.owner ?? ''), String(params.name ?? ''));
        if (!record || record.owner !== VIEWER.login) return null;
        return { __type: 'Repository', repo: record } as GqlNode;
      }
      if (sel.name === 'node') {
        const parsed = decodeNodeId(params.id);
        if (!parsed) return null;
        if (parsed.kind === 'R') {
          const record = repoById(store, parseInt(parsed.parts[0] ?? '', 10));
          return record ? ({ __type: 'Repository', repo: record } as GqlNode) : null;
        }
        if (parsed.kind === 'I') {
          const record = repoById(store, parseInt(parsed.parts[0] ?? '', 10));
          const item = record?.issues.get(parseInt(parsed.parts[1] ?? '', 10));
          return record && item ? wrapIssue(record, item) : null;
        }
        if (parsed.kind === 'P') {
          const record = repoById(store, parseInt(parsed.parts[0] ?? '', 10));
          const request = record?.pulls.get(parseInt(parsed.parts[1] ?? '', 10));
          return record && request ? wrapPull(record, request) : null;
        }
        return null;
      }
      if (sel.name === '__type') {
        const typeName = String(params.name ?? '');
        if (typeName === 'Issue') return { __type: '__Type', name: typeName, fields: ISSUE_FIELDS, enumValues: [] } as GqlNode;
        if (typeName === 'PullRequest') return { __type: '__Type', name: typeName, fields: PULL_FIELDS, enumValues: [] } as GqlNode;
        if (typeName === 'Repository') return { __type: '__Type', name: typeName, fields: REPO_FIELDS, enumValues: [] } as GqlNode;
        if (typeName === 'SearchType') return { __type: '__Type', name: typeName, fields: [], enumValues: SEARCH_VALUES } as GqlNode;
        return null;
      }
      if (sel.name === 'createIssue' || sel.name === 'closeIssue' || sel.name === 'createPullRequest' || sel.name === 'mergePullRequest' || sel.name === 'addComment') {
        return runMutation(context, sel.name, params);
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "Query".`);
    }
    case 'User': {
      if (sel.name === 'login') return value.login;
      throw new GqlError(`Cannot query field "${sel.name}" on type "User".`);
    }
    case 'Repository': {
      const record = value.repo;
      if (sel.name === 'id') return globalId('R', record.id);
      if (sel.name === 'databaseId') return record.id;
      if (sel.name === 'name') return record.name;
      if (sel.name === 'nameWithOwner') return `${record.owner}/${record.name}`;
      if (sel.name === 'owner') return { __type: 'User', login: record.owner } as GqlNode;
      if (sel.name === 'defaultBranchRef') {
        const head = store.defaultTip(record);
        return head === undefined ? null : ({ __type: 'Ref', name: record.defaultBranch } as GqlNode);
      }
      if (sel.name === 'viewerPermission') return 'ADMIN';
      if (sel.name === 'hasIssuesEnabled') return true;
      if (sel.name === 'issue') {
        const item = record.issues.get(Number(params.number));
        return item ? wrapIssue(record, item) : null;
      }
      if (sel.name === 'issues') return listIssues(context, record, params);
      if (sel.name === 'pullRequests') {
        const limit = typeof params.first === 'number' ? params.first : undefined;
        let open = [...record.pulls.values()].filter((p) => p.state === 'open').sort((a, b) => a.seq - b.seq);
        if (limit !== undefined) open = open.slice(0, limit);
        return { __type: 'PullRequestConnection', items: open.map((request) => ({ repo: record, pull: request })) } as GqlNode;
      }
      if (sel.name === 'pullRequest') {
        const request = record.pulls.get(Number(params.number));
        return request ? wrapPull(record, request) : null;
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "Repository".`);
    }
    case 'Issue': {
      const item = value.issue;
      if (sel.name === 'id') return globalId('I', value.repo.id, item.number);
      if (sel.name === 'number') return item.number;
      if (sel.name === 'title') return item.title;
      if (sel.name === 'state') return item.state === 'open' ? 'OPEN' : 'CLOSED';
      if (sel.name === 'body') return item.body;
      throw new GqlError(`Cannot query field "${sel.name}" on type "Issue".`);
    }
    case 'PullRequest': {
      const request = value.pull;
      if (sel.name === 'id') return globalId('P', value.repo.id, request.number);
      if (sel.name === 'number') return request.number;
      if (sel.name === 'state') return request.merged ? 'MERGED' : request.state === 'open' ? 'OPEN' : 'CLOSED';
      if (sel.name === 'merged') return request.merged;
      if (sel.name === 'headRefName') return request.headRef;
      if (sel.name === 'baseRefName') return request.baseRef;
      if (sel.name === 'mergeable') return store.mergeable(value.repo, request);
      if (sel.name === 'files') {
        const limit = typeof params.first === 'number' ? params.first : undefined;
        const headSha = store.defaultTip(value.repo) === undefined ? undefined : value.repo.refs.get(`refs/heads/${request.headRef}`);
        const baseSha = value.repo.refs.get(`refs/heads/${request.baseRef}`);
        let names: string[] = [];
        if (headSha !== undefined && baseSha !== undefined) {
          const ancestor = store.mergeBase(value.repo, headSha, baseSha) ?? request.baseSha;
          const baseInfo = store.commitOf(value.repo, ancestor);
          const headInfo = store.commitOf(value.repo, headSha);
          if (baseInfo && headInfo) {
            names = store.diffTrees(value.repo, baseInfo.tree, headInfo.tree).map((c) => c.filename);
          }
        }
        if (limit !== undefined) names = names.slice(0, limit);
        return { __type: 'ChangedFileConnection', items: names.map((path) => ({ path })) } as GqlNode;
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "PullRequest".`);
    }
    case 'IssueConnection': {
      if (sel.name === 'nodes') return value.items.map((item) => wrapIssue(item.repo, item.issue));
      if (sel.name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: value.hasNextPage, endCursor: value.endCursor } as GqlNode;
      if (sel.name === 'totalCount') return value.items.length;
      throw new GqlError(`Cannot query field "${sel.name}" on type "IssueConnection".`);
    }
    case 'PullRequestConnection': {
      if (sel.name === 'nodes') return value.items.map((item) => wrapPull(item.repo, item.pull));
      if (sel.name === 'totalCount') return value.items.length;
      throw new GqlError(`Cannot query field "${sel.name}" on type "PullRequestConnection".`);
    }
    case 'ChangedFileConnection': {
      if (sel.name === 'nodes') return value.items.map((item) => ({ __type: 'ChangedFile', path: item.path }) as GqlNode);
      if (sel.name === 'totalCount') return value.items.length;
      throw new GqlError(`Cannot query field "${sel.name}" on type "PullRequestChangedFileConnection".`);
    }
    case 'ChangedFile': {
      if (sel.name === 'path') return value.path;
      throw new GqlError(`Cannot query field "${sel.name}" on type "PullRequestChangedFile".`);
    }
    case 'Ref': {
      if (sel.name === 'name') return value.name;
      throw new GqlError(`Cannot query field "${sel.name}" on type "Ref".`);
    }
    case 'PageInfo': {
      if (sel.name === 'hasNextPage') return value.hasNextPage;
      if (sel.name === 'endCursor') return value.endCursor;
      throw new GqlError(`Cannot query field "${sel.name}" on type "PageInfo".`);
    }
    case '__Type': {
      if (sel.name === 'name') return value.name;
      if (sel.name === 'kind') return value.enumValues.length > 0 ? 'ENUM' : 'OBJECT';
      if (sel.name === 'fields') return value.fields.map((name) => ({ __type: '__Field', name }) as unknown as GqlNode);
      if (sel.name === 'enumValues') return value.enumValues.map((name) => ({ __type: '__EnumValue', name }) as unknown as GqlNode);
      throw new GqlError(`Cannot query field "${sel.name}" on type "__Type".`);
    }
    case 'CreateIssuePayload': {
      if (sel.name === 'issue') return wrapIssue(value.issue.repo, value.issue.issue);
      throw new GqlError(`Cannot query field "${sel.name}" on type "CreateIssuePayload".`);
    }
    case 'CloseIssuePayload': {
      if (sel.name === 'issue') return wrapIssue(value.issue.repo, value.issue.issue);
      throw new GqlError(`Cannot query field "${sel.name}" on type "CloseIssuePayload".`);
    }
    case 'CreatePullRequestPayload': {
      if (sel.name === 'pullRequest') return wrapPull(value.pullRequest.repo, value.pullRequest.pull);
      throw new GqlError(`Cannot query field "${sel.name}" on type "CreatePullRequestPayload".`);
    }
    case 'MergePullRequestPayload': {
      if (sel.name === 'pullRequest') return wrapPull(value.pullRequest.repo, value.pullRequest.pull);
      throw new GqlError(`Cannot query field "${sel.name}" on type "MergePullRequestPayload".`);
    }
    case 'AddCommentPayload': {
      if (sel.name === 'commentEdge') return { __type: 'CommentEdge', node: value.comment } as unknown as GqlNode;
      throw new GqlError(`Cannot query field "${sel.name}" on type "AddCommentPayload".`);
    }
    default: {
      // __Field / __EnumValue / CommentEdge nodes reach here through the generic path.
      const anyNode = value as unknown as Record<string, unknown>;
      if (anyNode.__type === '__Field' || anyNode.__type === '__EnumValue') {
        if (sel.name === 'name') return anyNode.name;
        throw new GqlError(`Cannot query field "${sel.name}" on type "${String(anyNode.__type)}".`);
      }
      if (anyNode.__type === 'CommentEdge') {
        if (sel.name === 'node') return { __type: 'Comment', id: (anyNode.node as { id: string }).id, body: (anyNode.node as { body: string }).body } as unknown as GqlNode;
        throw new GqlError(`Cannot query field "${sel.name}" on type "CommentEdge".`);
      }
      if (anyNode.__type === 'Comment') {
        if (sel.name === 'id') return anyNode.id;
        if (sel.name === 'body') return anyNode.body;
        throw new GqlError(`Cannot query field "${sel.name}" on type "Comment".`);
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "${String(anyNode.__type)}".`);
    }
  }
}

function runMutation(context: Ctx, verb: string, params: Record<string, unknown>): GqlNode {
  const { store } = context;
  const body = (params.input ?? {}) as Record<string, unknown>;
  if (verb === 'createIssue') {
    const parsed = decodeNodeId(body.repositoryId);
    const record = parsed?.kind === 'R' ? repoById(store, parseInt(parsed.parts[0] ?? '', 10)) : undefined;
    if (!record) throw new GqlError('createIssue: unknown repositoryId');
    const item = store.createIssue(record, String(body.title ?? ''), String(body.body ?? ''), []);
    return { __type: 'CreateIssuePayload', issue: { repo: record, issue: item } };
  }
  if (verb === 'closeIssue') {
    const parsed = decodeNodeId(body.issueId);
    const record = parsed?.kind === 'I' ? repoById(store, parseInt(parsed.parts[0] ?? '', 10)) : undefined;
    const item = record?.issues.get(parseInt(parsed?.parts[1] ?? '', 10));
    if (!record || !item) throw new GqlError('closeIssue: unknown issueId');
    item.state = 'closed';
    return { __type: 'CloseIssuePayload', issue: { repo: record, issue: item } };
  }
  if (verb === 'createPullRequest') {
    const parsed = decodeNodeId(body.repositoryId);
    const record = parsed?.kind === 'R' ? repoById(store, parseInt(parsed.parts[0] ?? '', 10)) : undefined;
    if (!record) throw new GqlError('createPullRequest: unknown repositoryId');
    const head = String(body.headRefName ?? '');
    const base = String(body.baseRefName ?? '');
    const headId = record.refs.get(`refs/heads/${head}`);
    const baseId = record.refs.get(`refs/heads/${base}`);
    if (headId === undefined || baseId === undefined) throw new GqlError('createPullRequest: unknown head or base branch');
    const request = store.createPull(record, String(body.title ?? ''), String(body.body ?? ''), head, base, headId, baseId);
    return { __type: 'CreatePullRequestPayload', pullRequest: { repo: record, pull: request } };
  }
  if (verb === 'mergePullRequest') {
    const parsed = decodeNodeId(body.pullRequestId);
    const record = parsed?.kind === 'P' ? repoById(store, parseInt(parsed.parts[0] ?? '', 10)) : undefined;
    const request = record?.pulls.get(parseInt(parsed?.parts[1] ?? '', 10));
    if (!record || !request) throw new GqlError('mergePullRequest: unknown pullRequestId');
    const style = String(body.mergeMethod ?? 'SQUASH');
    const outcome = store.mergePullRequest(record, request, style === 'MERGE' ? 'merge' : 'squash');
    if ('conflict' in outcome) throw new GqlError('mergePullRequest: merge conflict');
    return { __type: 'MergePullRequestPayload', pullRequest: { repo: record, pull: request } };
  }
  if (verb === 'addComment') {
    const parsed = decodeNodeId(body.subjectId);
    const record = parsed?.kind === 'I' ? repoById(store, parseInt(parsed.parts[0] ?? '', 10)) : undefined;
    const item = record?.issues.get(parseInt(parsed?.parts[1] ?? '', 10));
    if (!record || !item) throw new GqlError('addComment: unknown subjectId');
    const note = { id: record.nextCommentId++, body: String(body.body ?? ''), user: record.owner };
    item.comments.push(note);
    return {
      __type: 'AddCommentPayload',
      comment: { id: globalId('C', record.id, item.number, note.id), body: note.body },
    };
  }
  throw new GqlError(`unknown mutation ${verb}`);
}

function isGqlNode(candidate: unknown): candidate is GqlNode {
  return typeof candidate === 'object' && candidate !== null && typeof (candidate as { __type?: unknown }).__type === 'string';
}

function resolveFields(context: Ctx, value: GqlNode, fields: SelectionNode[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const part of fields) {
    if (part.kind === 'fragment') {
      if (part.typeCondition !== undefined && part.typeCondition !== value.__type) continue;
      const merged = resolveFields(context, value, part.selection);
      Object.assign(result, merged);
      continue;
    }
    const responseKey = part.alias ?? part.name;
    let resolved: unknown;
    try {
      resolved = resolveField(context, value, part);
    } catch (error) {
      if (error instanceof GqlError) {
        context.problems.push({ message: error.message });
        result[responseKey] = null;
        continue;
      }
      throw error;
    }
    if (resolved === null || resolved === undefined) {
      result[responseKey] = null;
      continue;
    }
    if (Array.isArray(resolved)) {
      result[responseKey] = resolved.map((element) => {
        if (isGqlNode(element) && part.selection) return resolveFields(context, element, part.selection);
        return element;
      });
      continue;
    }
    if (isGqlNode(resolved)) {
      if (part.selection) result[responseKey] = resolveFields(context, resolved, part.selection);
      else result[responseKey] = null;
      continue;
    }
    result[responseKey] = resolved;
  }
  return result;
}

// -------------------------------------------------------------------------------------------
// HTTP entry: one document, or a JSON array of documents (GitHub batching).
// -------------------------------------------------------------------------------------------

export interface GraphQLHttpResult {
  status: number;
  body: unknown;
}

export function handleGraphQL(store: Forge, text: string): GraphQLHttpResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(doc)) {
    const answers = doc.map((item) => {
      if (typeof item !== 'object' || item === null) return { data: null, errors: [{ message: 'invalid operation' }] };
      const source = String((item as Record<string, unknown>).query ?? '');
      const vars = ((item as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
      return executeGraphQL(store, source, vars);
    });
    return { status: 200, body: answers };
  }
  if (typeof doc !== 'object' || doc === null) {
    return { status: 400, body: { errors: [{ message: 'invalid GraphQL request' }] } };
  }
  const source = String((doc as Record<string, unknown>).query ?? '');
  const vars = ((doc as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
  return { status: 200, body: executeGraphQL(store, source, vars) };
}
