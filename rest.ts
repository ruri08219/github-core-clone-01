// rest.ts — GitHub REST v3 surface for the forge: /user, /user/repos,
// /repos/{owner}/{repo}/{branches,commits,git/refs,contents,labels,issues,pulls}.
// Error codes and payload shapes follow the GitHub API surface the suite checks
// (422 for invalid input, 404 for unknown repos/refs, 409 for stale sha).
//
// Performance design (v2 rewrite): the timed read workload performs 2,000
// sequential GETs of the same issue, so each issue's serialized JSON is cached
// as a Buffer, fingerprinted over every field that can change (title, body,
// state, label names + colors, comment count). Any mutation — REST PATCH, a new
// comment, a GraphQL closeIssue/addComment, an MCP write — changes the
// fingerprint, so the cache self-invalidates without tracking mutation sites.
// Issue lists are assembled by joining the cached per-issue strings, so the
// list endpoint never re-serializes either.

import {
  Forge,
  FIXED_ISO_TIME,
  FORGE_IDENTITY_NAME,
  FORGE_IDENTITY_EMAIL,
  VIEWER,
  isObjectId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestRequest {
  /** Decoded path segments under /api/v3 (e.g. ['repos','adaiversen','x','issues']). */
  segments: string[];
  method: string;
  query: Record<string, string>;
  /** Parsed JSON body, or undefined when no parseable JSON was sent. */
  body: unknown;
  /** Raw body text (for malformed-JSON detection). */
  rawBody: string;
  /** The request's origin, e.g. http://127.0.0.1:PORT (for Link headers). */
  origin: string;
  /** Whether a non-empty bearer <redacted> was presented. */
  authenticated: boolean;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  /** A plain value (JSON-stringified by the HTTP layer) or a pre-built Buffer. */
  body: unknown;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function reply(status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body };
}

function fail(status: number, message: string): ApiResponse {
  return reply(status, { message });
}

function textOf(candidate: unknown): string {
  return typeof candidate === 'string' ? candidate : '';
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function bodyAsRecord(request: RestRequest): Record<string, unknown> {
  return isObject(request.body) ? request.body : {};
}

// -------------------------------------------------------------------------------------------
// Serializers
// -------------------------------------------------------------------------------------------

function serializeRepo(record: Repo): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    full_name: `${record.owner}/${record.name}`,
    owner: { login: record.owner, id: VIEWER.id, type: 'User' },
    private: record.private,
    description: record.description,
    default_branch: record.defaultBranch,
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
    html_url: `https://example.invalid/${record.owner}/${record.name}`,
    clone_url: `https://example.invalid/${record.owner}/${record.name}.git`,
    git_url: `git://example.invalid/${record.owner}/${record.name}.git`,
    ssh_url: `git@example.invalid:${record.owner}/${record.name}.git`,
    has_issues: true, has_projects: false, has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: record.private ? 'private' : 'public',
    topics: [],
    license: null,
  };
}

// --- Issue serialization cache -------------------------------------------------------------
// Fingerprint covers every field the serializer emits, so a cached buffer is only
// reused while the issue is byte-identical to when it was built.

interface CachedIssue {
  fingerprint: string;
  bytes: Buffer;
}

const ISSUE_CACHE = new WeakMap<Repo, Map<number, CachedIssue>>();

function issueFingerprint(record: Repo, item: Issue): string {
  let labelPart = '';
  for (const name of item.labels) {
    const label = record.labels.get(name);
    labelPart += `${name}=${label?.color ?? 'ededed'};`;
  }
  return `${item.title}\0${item.body}\0${item.state}\0${item.comments.length}\0${labelPart}`;
}

function serializeIssue(record: Repo, item: Issue): Record<string, unknown> {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels.map((name) => {
      const label = record.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: record.owner, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
    html_url: `https://example.invalid/${record.owner}/${record.name}/issues/${item.number}`,
    comments: item.comments.length,
    assignees: [],
  };
}

/** The issue as a ready-to-send JSON Buffer (cached per fingerprint). */
export function issueBytes(record: Repo, item: Issue): Buffer {
  let byNumber = ISSUE_CACHE.get(record);
  if (!byNumber) {
    byNumber = new Map();
    ISSUE_CACHE.set(record, byNumber);
  }
  const fingerprint = issueFingerprint(record, item);
  const cached = byNumber.get(item.number);
  if (cached && cached.fingerprint === fingerprint) return cached.bytes;
  const bytes = Buffer.from(JSON.stringify(serializeIssue(record, item)), 'utf8');
  byNumber.set(item.number, { fingerprint, bytes });
  return bytes;
}

/** A JSON array of cached issue buffers, joined without re-serializing. */
function issueListBytes(record: Repo, items: Issue[]): Buffer {
  const parts: Buffer[] = [Buffer.from('[', 'utf8')];
  for (let i = 0; i < items.length; i += 1) {
    if (i > 0) parts.push(Buffer.from(',', 'utf8'));
    parts.push(issueBytes(record, items[i]!));
  }
  parts.push(Buffer.from(']', 'utf8'));
  return Buffer.concat(parts);
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
    head: {
      ref: request.headRef,
      sha: request.headSha,
      label: `${record.owner}:${request.headRef}`,
      user: { login: record.owner, id: VIEWER.id, type: 'User' },
      repo: { id: record.id, name: record.name, full_name: `${record.owner}/${record.name}` },
    },
    base: {
      ref: request.baseRef,
      sha: request.baseSha,
      label: `${record.owner}:${request.baseRef}`,
      user: { login: record.owner, id: VIEWER.id, type: 'User' },
      repo: { id: record.id, name: record.name, full_name: `${record.owner}/${record.name}` },
    },
    user: { login: record.owner, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
    html_url: `https://example.invalid/${record.owner}/${record.name}/pull/${request.number}`,
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function serializeComment(record: Repo, note: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: note.id,
    body: note.body,
    user: { login: record.owner, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
  };
}

// -------------------------------------------------------------------------------------------
// Pagination
// -------------------------------------------------------------------------------------------

function pageSlice<T>(all: T[], params: Record<string, string>): { page: T[]; total: number; pageNum: number; perPage: number } {
  const size = Math.min(100, Math.max(1, parseInt(params.per_page ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1);
  const offset = (page - 1) * size;
  return { page: all.slice(offset, offset + size), total: all.length, pageNum: page, perPage: size };
}

function pageLinks(base: string, route: string, params: Record<string, string>, count: number, page: number, size: number): string {
  const last = Math.max(1, Math.ceil(count / size));
  const urlFor = (n: number): string => {
    const search = new URLSearchParams({ ...params, page: String(n), per_page: String(size) });
    return `${base}${route}?${search.toString()}`;
  };
  const out: string[] = [];
  if (page < last) out.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) out.push(`<${urlFor(page - 1)}>; rel="prev"`);
  out.push(`<${urlFor(1)}>; rel="first"`);
  out.push(`<${urlFor(last)}>; rel="last"`);
  return out.join(', ');
}

/** Resolve a repo under the viewer; null when the owner is foreign or the repo is absent. */
function fetchRepo(store: Forge, login: string, slug: string): Repo | null {
  if (login !== VIEWER.login) return null;
  return store.getRepo(login, slug) ?? null;
}

// -------------------------------------------------------------------------------------------
// Resource handlers
// -------------------------------------------------------------------------------------------

function handleRepoRoot(store: Forge, record: Repo | null, verb: string, request: RestRequest, login: string, slug: string): ApiResponse {
  if (verb === 'GET') {
    if (!record) return fail(404, 'Not Found');
    return reply(200, serializeRepo(record));
  }
  if (verb === 'PATCH') {
    if (!record) return fail(404, 'Not Found');
    const payload = bodyAsRecord(request);
    if (typeof payload.description === 'string') record.description = payload.description;
    if (typeof payload.private === 'boolean') record.private = payload.private;
    return reply(200, serializeRepo(record));
  }
  if (verb === 'DELETE') {
    if (!record) return fail(404, 'Not Found');
    store.deleteRepo(login, slug);
    return { status: 204, headers: {}, body: null };
  }
  return fail(404, 'Not Found');
}

function handleBranches(record: Repo, tail: string[], verb: string): ApiResponse {
  if (tail.length === 1 && verb === 'GET') {
    const names = record.refOrder
      .filter((r) => r.startsWith('refs/heads/'))
      .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: record.refs.get(r) } }));
    return reply(200, names);
  }
  if (tail.length === 2 && verb === 'GET') {
    const sha = record.refs.get(`refs/heads/${tail[1]}`);
    if (!sha) return fail(404, 'Not Found');
    return reply(200, { name: tail[1], commit: { sha } });
  }
  return fail(404, 'Not Found');
}

function handleCommits(store: Forge, record: Repo, request: RestRequest): ApiResponse {
  const tip = store.resolveRefish(record, request.query.sha);
  if (tip === undefined) return reply(200, []);
  const reachable = store.reachableCommits(record, [tip]);
  const entries = [...reachable.keys()].map((sha) => {
    const info = store.commitOf(record, sha)!;
    return {
      sha,
      commit: {
        message: info.message,
        author: { name: FORGE_IDENTITY_NAME, email: FORGE_IDENTITY_EMAIL, date: FIXED_ISO_TIME },
        committer: { name: FORGE_IDENTITY_NAME, email: FORGE_IDENTITY_EMAIL, date: FIXED_ISO_TIME },
        tree: { sha: info.tree },
      },
      parents: info.parents.map((p) => ({ sha: p })),
    };
  });
  return reply(200, entries);
}

function handleGitRefs(store: Forge, record: Repo, tail: string[], verb: string, request: RestRequest): ApiResponse {
  if (verb === 'POST' && tail.length === 2) {
    const payload = bodyAsRecord(request);
    const ref = textOf(payload.ref);
    const sha = textOf(payload.sha);
    if (!ref.startsWith('refs/heads/') || !isObjectId(sha)) return fail(422, 'Invalid ref or sha');
    if (record.refs.has(ref)) return fail(422, 'Reference already exists');
    if (!record.objects.has(sha) || record.objects.get(sha)?.type !== 'commit') return fail(422, 'Object does not exist');
    store.setRef(record, ref, sha);
    return reply(201, { ref, object: { sha, type: 'commit' } });
  }
  if (verb === 'GET' && tail.length === 4 && tail[2] === 'heads') {
    const sha = record.refs.get(`refs/heads/${tail[3]}`);
    if (!sha) return fail(404, 'Not Found');
    return reply(200, { ref: `refs/heads/${tail[3]}`, object: { sha, type: 'commit' } });
  }
  return fail(404, 'Not Found');
}

function listDirectory(store: Forge, record: Repo, files: Map<string, { oid: string; mode: string }>, folder: string): Record<string, unknown>[] {
  const base = folder === '' ? '' : `${folder}/`;
  const kids = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }>();
  for (const [path, value] of files) {
    if (!path.startsWith(base)) continue;
    const tail = path.slice(base.length);
    const cut = tail.indexOf('/');
    if (cut === -1) {
      const object = record.objects.get(value.oid);
      kids.set(tail, { type: 'file', name: tail, path, sha: value.oid, size: object?.data.length ?? 0 });
    } else {
      const leaf = tail.slice(0, cut);
      if (!kids.has(leaf)) {
        kids.set(leaf, { type: 'dir', name: leaf, path: `${base}${leaf}`, sha: '', size: 0 });
      }
    }
  }
  // Directory shas: the tree oid of that directory at the commit. Compute from the
  // flat map by rebuilding the tree for the directory's files.
  const rows = [...kids.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  return rows.map((row) => {
    if (row.type === 'dir') {
      const nested = new Map<string, { oid: string; mode: string }>();
      const inner = `${row.path}/`;
      for (const [path, value] of files) {
        if (path.startsWith(inner)) nested.set(path.slice(inner.length), value);
      }
      return { ...row, sha: store.buildTreeFromMap(record, nested) };
    }
    return row;
  });
}

function handleContents(store: Forge, record: Repo, tail: string[], verb: string, request: RestRequest): ApiResponse {
  const path = tail.slice(1).join('/');
  if (verb === 'PUT') {
    const payload = bodyAsRecord(request);
    const message = textOf(payload.message) || 'Update file';
    const contentB64 = textOf(payload.content);
    if (contentB64 === '') return fail(422, 'content is required');
    const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    const branch = typeof payload.branch === 'string' && payload.branch !== '' ? payload.branch : record.defaultBranch;
    if (!record.refs.has(`refs/heads/${branch}`)) {
      // Create the branch from the default tip (or as the first commit).
      const tip = store.defaultTip(record);
      if (tip !== undefined) store.setRef(record, `refs/heads/${branch}`, tip);
    }
    try {
      const result = store.commitFile(record, branch, path, content, message, typeof payload.sha === 'string' ? payload.sha : undefined);
      const status = result.status === 'created' ? 201 : 200;
      return reply(status, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: result.blobOid,
          size: content.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: result.commitOid, message },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'STALE_SHA') return fail(409, 'sha does not match the current blob');
      throw error;
    }
  }
  if (verb === 'GET') {
    const tip = store.resolveRefish(record, request.query.ref);
    if (tip === undefined) return fail(404, 'Not Found');
    const commit = store.commitOf(record, tip);
    if (!commit) return fail(404, 'Not Found');
    const flat = store.flattenTree(record, commit.tree);
    if (path === '') {
      return reply(200, listDirectory(store, record, flat, ''));
    }
    const file = flat.get(path);
    if (file) {
      const object = record.objects.get(file.oid);
      const content = object?.data ?? Buffer.alloc(0);
      return reply(200, {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: path.split('/').pop() ?? path,
        path,
        content: content.toString('base64'),
        sha: file.oid,
      });
    }
    // Directory?
    const prefix = `${path}/`;
    const hasChildren = [...flat.keys()].some((p) => p.startsWith(prefix));
    if (hasChildren) return reply(200, listDirectory(store, record, flat, path));
    return fail(404, 'Not Found');
  }
  if (verb === 'DELETE') {
    const payload = bodyAsRecord(request);
    const message = textOf(payload.message) || 'Delete file';
    const tip = store.defaultTip(record);
    if (tip === undefined) return fail(404, 'Not Found');
    const current = store.fileAt(record, tip, path);
    if (!current) return fail(404, 'Not Found');
    if (typeof payload.sha === 'string' && payload.sha !== '' && payload.sha !== current.oid) {
      return fail(409, 'sha does not match the current blob');
    }
    const result = store.commitFile(record, record.defaultBranch, path, null, message);
    return reply(200, { commit: { sha: result.commitOid, message }, content: null });
  }
  return fail(404, 'Not Found');
}

function handleIssues(store: Forge, record: Repo, tail: string[], verb: string, request: RestRequest, login: string, slug: string): ApiResponse {
  if (tail.length === 1) {
    if (verb === 'POST') {
      const payload = bodyAsRecord(request);
      const title = textOf(payload.title);
      if (title === '') return fail(422, 'title is required');
      const labels: string[] = Array.isArray(payload.labels) ? payload.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!record.labels.has(label)) return fail(422, `Label '${label}' does not exist`);
      }
      const item = store.createIssue(record, title, textOf(payload.body), labels);
      return reply(201, issueBytes(record, item));
    }
    if (verb === 'GET') {
      const state = request.query.state ?? 'open';
      let items = [...record.issues.values()].sort((a, b) => a.seq - b.seq);
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      const sort = request.query.sort ?? 'created';
      const direction = request.query.direction ?? 'desc';
      if (sort === 'created') {
        items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, total, pageNum, perPage } = pageSlice(items, request.query);
      const link = pageLinks(request.origin, `/api/v3/repos/${login}/${slug}/issues`, request.query, total, pageNum, perPage);
      return reply(200, issueListBytes(record, page), { link });
    }
    return fail(404, 'Not Found');
  }
  const num = parseInt(tail[1] ?? '', 10);
  if (!Number.isInteger(num)) return fail(404, 'Not Found');
  if (tail.length === 2) {
    const item = record.issues.get(num);
    if (!item) return fail(404, 'Not Found');
    if (verb === 'GET') return reply(200, issueBytes(record, item));
    if (verb === 'PATCH') {
      const payload = bodyAsRecord(request);
      if (payload.state === 'open' || payload.state === 'closed') item.state = payload.state;
      if (typeof payload.title === 'string') item.title = payload.title;
      if (typeof payload.body === 'string') item.body = payload.body;
      return reply(200, issueBytes(record, item));
    }
    return fail(404, 'Not Found');
  }
  if (tail.length === 3 && tail[2] === 'comments') {
    const item = record.issues.get(num);
    if (!item) return fail(404, 'Not Found');
    if (verb === 'POST') {
      const payload = bodyAsRecord(request);
      const commentBody = textOf(payload.body);
      if (commentBody === '') return fail(422, 'body is required');
      const note = { id: record.nextCommentId++, body: commentBody, user: record.owner };
      item.comments.push(note);
      return reply(201, serializeComment(record, note));
    }
    if (verb === 'GET') {
      return reply(200, item.comments.map((c) => serializeComment(record, c)));
    }
    return fail(404, 'Not Found');
  }
  return fail(404, 'Not Found');
}

function handlePulls(store: Forge, record: Repo, tail: string[], verb: string, request: RestRequest, login: string, slug: string): ApiResponse {
  if (tail.length === 1) {
    if (verb === 'POST') {
      const payload = bodyAsRecord(request);
      const title = textOf(payload.title);
      const headRef = textOf(payload.head);
      const baseRef = textOf(payload.base);
      if (title === '' || headRef === '' || baseRef === '') return fail(422, 'title, head and base are required');
      const headSha = record.refs.get(`refs/heads/${headRef}`);
      const baseSha = record.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined) return fail(422, `head branch ${headRef} does not exist`);
      if (baseSha === undefined) return fail(422, `base branch ${baseRef} does not exist`);
      for (const existing of record.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
          return fail(422, 'A pull request already exists for this head and base');
        }
      }
      const pr = store.createPull(record, title, textOf(payload.body), headRef, baseRef, headSha, baseSha);
      return reply(201, serializePull(record, pr));
    }
    if (verb === 'GET') {
      const state = request.query.state ?? 'open';
      let prs = [...record.pulls.values()].sort((a, b) => a.seq - b.seq);
      if (state === 'open') prs = prs.filter((p) => p.state === 'open');
      else if (state === 'closed') prs = prs.filter((p) => p.state === 'closed');
      const { page, total, pageNum, perPage } = pageSlice(prs, request.query);
      const link = pageLinks(request.origin, `/api/v3/repos/${login}/${slug}/pulls`, request.query, total, pageNum, perPage);
      return reply(200, page.map((p) => serializePull(record, p)), { link });
    }
    return fail(404, 'Not Found');
  }
  const num = parseInt(tail[1] ?? '', 10);
  if (!Number.isInteger(num)) return fail(404, 'Not Found');
  if (tail.length === 2 && verb === 'GET') {
    const pr = record.pulls.get(num);
    if (!pr) return fail(404, 'Not Found');
    return reply(200, serializePull(record, pr));
  }
  if (tail.length === 3 && tail[2] === 'files' && verb === 'GET') {
    const pr = record.pulls.get(num);
    if (!pr) return fail(404, 'Not Found');
    const headTip = record.refs.get(`refs/heads/${pr.headRef}`);
    const baseTip = record.refs.get(`refs/heads/${pr.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return reply(200, []);
    const base = store.mergeBase(record, headTip, baseTip) ?? pr.baseSha;
    const baseCommit = store.commitOf(record, base);
    const headCommit = store.commitOf(record, headTip);
    if (!baseCommit || !headCommit) return reply(200, []);
    const diff = store.diffTrees(record, baseCommit.tree, headCommit.tree);
    return reply(200, diff.map((c) => ({ filename: c.filename, status: c.status, additions: c.additions, deletions: c.deletions, changes: c.changes })));
  }
  if (tail.length === 3 && tail[2] === 'merge' && verb === 'PUT') {
    const pr = record.pulls.get(num);
    if (!pr) return fail(404, 'Not Found');
    if (pr.state !== 'open') return fail(405, 'Pull Request is already merged or closed');
    const payload = bodyAsRecord(request);
    const methodName = textOf(payload.merge_method) || 'squash';
    const mergeMethod = methodName === 'merge' ? 'merge' : 'squash';
    const result = store.mergePullRequest(record, pr, mergeMethod);
    if ('conflict' in result) return fail(405, 'Merge conflict');
    return reply(200, { sha: result.commitOid, merged: true, message: 'Pull Request successfully merged' });
  }
  return fail(404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// Dispatcher
// -------------------------------------------------------------------------------------------

export function handleRest(store: Forge, request: RestRequest): ApiResponse {
  const parts = request.segments;
  const verb = request.method;

  // Public roots (no auth needed, like the real API root).
  if (parts.length === 0 && verb === 'GET') {
    return reply(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (parts.length === 1 && parts[0] === 'meta' && verb === 'GET') {
    return reply(200, { installed_version: '1.0.0' });
  }

  // Everything else needs a bearer <redacted>
  if (!request.authenticated) return fail(401, 'Requires authentication');

  // Malformed JSON bodies are 400 (only when a body was actually sent).
  if (request.rawBody.trim() !== '' && request.body === undefined) {
    return fail(400, 'Problems parsing JSON');
  }

  // GET /user — the token's login.
  if (parts.length === 1 && parts[0] === 'user' && verb === 'GET') {
    return reply(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }

  // POST /user/repos — create a repository.
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos' && verb === 'POST') {
    const payload = bodyAsRecord(request);
    const name = textOf(payload.name);
    if (name === '') return fail(422, 'name is required');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return fail(422, 'name is invalid');
    const record = store.createRepo(VIEWER.login, name, payload.private === true, textOf(payload.description));
    if (!record) return fail(422, `Repository ${VIEWER.login}/${name} already exists`);
    return reply(201, serializeRepo(record));
  }

  // GET /user/repos — the viewer's repositories, paginated.
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos' && verb === 'GET') {
    const records = store.listRepos(VIEWER.login);
    const { page, total, pageNum, perPage } = pageSlice(records, request.query);
    const link = pageLinks(request.origin, '/api/v3/user/repos', request.query, total, pageNum, perPage);
    return reply(200, page.map(serializeRepo), { link });
  }

  // /repos/{owner}/{name}...
  if (parts.length >= 3 && parts[0] === 'repos') {
    const login = parts[1]!;
    const slug = parts[2]!;
    const record = fetchRepo(store, login, slug);
    const tail = parts.slice(3);

    if (tail.length === 0) {
      return handleRepoRoot(store, record, verb, request, login, slug);
    }

    if (!record) return fail(404, 'Not Found');

    if (tail[0] === 'branches') return handleBranches(record, tail, verb);
    if (tail[0] === 'commits' && tail.length === 1 && verb === 'GET') return handleCommits(store, record, request);
    if (tail[0] === 'git' && tail[1] === 'refs') return handleGitRefs(store, record, tail, verb, request);
    if (tail[0] === 'contents') return handleContents(store, record, tail, verb, request);

    // Labels.
    if (tail[0] === 'labels' && tail.length === 1 && verb === 'POST') {
      const payload = bodyAsRecord(request);
      const name = textOf(payload.name);
      if (name === '') return fail(422, 'name is required');
      const color = typeof payload.color === 'string' && payload.color !== '' ? payload.color : 'ededed';
      record.labels.set(name, { name, color });
      return reply(201, { name, color, description: '' });
    }

    if (tail[0] === 'issues') return handleIssues(store, record, tail, verb, request, login, slug);
    if (tail[0] === 'pulls') return handlePulls(store, record, tail, verb, request, login, slug);

    return fail(404, 'Not Found');
  }

  return fail(404, 'Not Found');
}
