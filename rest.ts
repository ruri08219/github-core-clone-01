// rest.ts — the GitHub REST v3 surface the suite drives (/api/v3). Pure handler: it
// takes the parsed request and returns a response object; app.ts does HTTP plumbing.

import {
  Forge,
  VIEWER,
  FIXED_ISO_TIME,
  FORGE_IDENTITY_NAME,
  FORGE_IDENTITY_EMAIL,
  isObjectId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface ApiResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown; // JSON value, Buffer (raw), or null for an empty body
}

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, each percent-decoded. */
  segments: string[];
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  /** Parsed JSON body (undefined when no body / not JSON). */
  body: unknown;
  /** Raw body text (for malformed-JSON detection). */
  rawBody: string;
  /** The request's origin, e.g. http://127.0.0.1:PORT (for Link headers). */
  origin: string;
  /** Whether a non-empty bearer token was presented. */
  authenticated: boolean;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body };
}

function err(status: number, message: string): ApiResponse {
  return json(status, { message });
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    topics: [],
    license: null,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    assignees: [],
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
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
      repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, id: VIEWER.id, type: 'User' },
      repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO_TIME,
    updated_at: FIXED_ISO_TIME,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function paginate<T>(items: T[], query: Record<string, string>): { page: T[]; total: number; pageNum: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, parseInt(query.per_page ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNum, perPage };
}

function linkHeader(origin: string, path: string, query: Record<string, string>, total: number, pageNum: number, perPage: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const build = (page: number): string => {
    const q = new URLSearchParams({ ...query, page: String(page), per_page: String(perPage) });
    return `${origin}${path}?${q.toString()}`;
  };
  const links: string[] = [];
  if (pageNum < lastPage) links.push(`<${build(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) links.push(`<${build(pageNum - 1)}>; rel="prev"`);
  links.push(`<${build(1)}>; rel="first"`);
  links.push(`<${build(lastPage)}>; rel="last"`);
  return links.join(', ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyRecord(req: RestRequest): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Resolve a repo under the viewer; 404 when the owner is foreign or the repo is absent. */
function loadRepo(forge: Forge, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return forge.getRepo(owner, name) ?? null;
}

export function handleRest(forge: Forge, req: RestRequest): ApiResponse {
  const seg = req.segments;
  const method = req.method;

  // Public roots (no auth needed, like the real API root).
  if (seg.length === 0 && method === 'GET') {
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (seg.length === 1 && seg[0] === 'meta' && method === 'GET') {
    return json(200, { installed_version: '1.0.0' });
  }

  // Everything else needs a bearer token.
  if (!req.authenticated) return err(401, 'Requires authentication');

  // Malformed JSON bodies are 400 (only when a body was actually sent).
  if (req.rawBody.trim() !== '' && req.body === undefined) {
    return err(400, 'Problems parsing JSON');
  }

  // GET /user — the token's login.
  if (seg.length === 1 && seg[0] === 'user' && method === 'GET') {
    return json(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }

  // POST /user/repos — create a repository.
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos' && method === 'POST') {
    const body = bodyRecord(req);
    const name = str(body.name);
    if (name === '') return err(422, 'name is required');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
    const repo = forge.createRepo(VIEWER.login, name, body.private === true, str(body.description));
    if (!repo) return err(422, `Repository ${VIEWER.login}/${name} already exists`);
    return json(201, repoJson(repo));
  }

  // GET /user/repos — the viewer's repositories, paginated.
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos' && method === 'GET') {
    const repos = forge.listRepos(VIEWER.login);
    const { page, total, pageNum, perPage } = paginate(repos, req.query);
    const link = linkHeader(req.origin, '/api/v3/user/repos', req.query, total, pageNum, perPage);
    return json(200, page.map(repoJson), { link });
  }

  // /repos/{owner}/{name}...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1]!;
    const name = seg[2]!;
    const repo = loadRepo(forge, owner, name);
    const rest = seg.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) return err(404, 'Not Found');
        return json(200, repoJson(repo));
      }
      if (method === 'PATCH') {
        if (!repo) return err(404, 'Not Found');
        const body = bodyRecord(req);
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        if (!repo) return err(404, 'Not Found');
        forge.deleteRepo(owner, name);
        return { status: 204, headers: {}, body: null };
      }
      return err(404, 'Not Found');
    }

    if (!repo) return err(404, 'Not Found');

    // Branches.
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = repo.refOrder
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) } }));
        return json(200, branches);
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) return err(404, 'Not Found');
        return json(200, { name: rest[1], commit: { sha } });
      }
      return err(404, 'Not Found');
    }

    // Commits.
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const tip = forge.resolveRefish(repo, req.query.sha);
      if (tip === undefined) return json(200, []);
      const commits = forge.reachableCommits(repo, [tip]);
      const list = [...commits.keys()].map((sha) => {
        const info = forge.commitOf(repo, sha)!;
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
      return json(200, list);
    }

    // Git data: refs.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = bodyRecord(req);
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/heads/') || !isObjectId(sha)) return err(422, 'Invalid ref or sha');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (!repo.objects.has(sha) || repo.objects.get(sha)?.type !== 'commit') return err(422, 'Object does not exist');
        forge.setRef(repo, ref, sha);
        return json(201, { ref, object: { sha, type: 'commit' } });
      }
      if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
        const sha = repo.refs.get(`refs/heads/${rest[3]}`);
        if (!sha) return err(404, 'Not Found');
        return json(200, { ref: `refs/heads/${rest[3]}`, object: { sha, type: 'commit' } });
      }
      return err(404, 'Not Found');
    }

    // Contents.
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'PUT') {
        const body = bodyRecord(req);
        const message = str(body.message) || 'Update file';
        const contentB64 = str(body.content);
        if (contentB64 === '') return err(422, 'content is required');
        const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        if (!repo.refs.has(`refs/heads/${branch}`)) {
          // Create the branch from the default tip (or as the first commit).
          const tip = forge.defaultTip(repo);
          if (tip !== undefined) forge.setRef(repo, `refs/heads/${branch}`, tip);
        }
        try {
          const result = forge.commitFile(repo, branch, path, content, message, typeof body.sha === 'string' ? body.sha : undefined);
          const status = result.status === 'created' ? 201 : 200;
          return json(status, {
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
          if ((error as { code?: string }).code === 'STALE_SHA') return err(409, 'sha does not match the current blob');
          throw error;
        }
      }
      if (method === 'GET') {
        const tip = forge.resolveRefish(repo, req.query.ref);
        if (tip === undefined) return err(404, 'Not Found');
        const commit = forge.commitOf(repo, tip);
        if (!commit) return err(404, 'Not Found');
        const flat = forge.flattenTree(repo, commit.tree);
        if (path === '') {
          return json(200, dirListing(forge, repo, flat, ''));
        }
        const file = flat.get(path);
        if (file) {
          const object = repo.objects.get(file.oid);
          const content = object?.data ?? Buffer.alloc(0);
          return json(200, {
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
        if (hasChildren) return json(200, dirListing(forge, repo, flat, path));
        return err(404, 'Not Found');
      }
      if (method === 'DELETE') {
        const body = bodyRecord(req);
        const message = str(body.message) || 'Delete file';
        const tip = forge.defaultTip(repo);
        if (tip === undefined) return err(404, 'Not Found');
        const current = forge.fileAt(repo, tip, path);
        if (!current) return err(404, 'Not Found');
        if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== current.oid) {
          return err(409, 'sha does not match the current blob');
        }
        const result = forge.commitFile(repo, repo.defaultBranch, path, null, message);
        return json(200, { commit: { sha: result.commitOid, message }, content: null });
      }
      return err(404, 'Not Found');
    }

    // Labels.
    if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
      const body = bodyRecord(req);
      const name = str(body.name);
      if (name === '') return err(422, 'name is required');
      const color = typeof body.color === 'string' && body.color !== '' ? body.color : 'ededed';
      repo.labels.set(name, { name, color });
      return json(201, { name, color, description: '' });
    }

    // Issues.
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = bodyRecord(req);
          const title = str(body.title);
          if (title === '') return err(422, 'title is required');
          const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) return err(422, `Label '${label}' does not exist`);
          }
          const issue = forge.createIssue(repo, title, str(body.body), labels);
          return json(201, issueJson(repo, issue));
        }
        if (method === 'GET') {
          const state = req.query.state ?? 'open';
          let issues = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
          if (state === 'open') issues = issues.filter((i) => i.state === 'open');
          else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
          const sort = req.query.sort ?? 'created';
          const direction = req.query.direction ?? 'desc';
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const { page, total, pageNum, perPage } = paginate(issues, req.query);
          const link = linkHeader(req.origin, `/api/v3/repos/${owner}/${name}/issues`, req.query, total, pageNum, perPage);
          return json(200, page.map((i) => issueJson(repo, i)), { link });
        }
        return err(404, 'Not Found');
      }
      const number = parseInt(rest[1] ?? '', 10);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      if (rest.length === 2) {
        const issue = repo.issues.get(number);
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') return json(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          const body = bodyRecord(req);
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          return json(200, issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const issue = repo.issues.get(number);
        if (!issue) return err(404, 'Not Found');
        if (method === 'POST') {
          const body = bodyRecord(req);
          const commentBody = str(body.body);
          if (commentBody === '') return err(422, 'body is required');
          const comment = { id: repo.nextCommentId++, body: commentBody, user: repo.owner };
          issue.comments.push(comment);
          return json(201, { id: comment.id, body: comment.body, user: { login: repo.owner, id: VIEWER.id, type: 'User' }, created_at: FIXED_ISO_TIME, updated_at: FIXED_ISO_TIME });
        }
        if (method === 'GET') {
          return json(200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: repo.owner, id: VIEWER.id, type: 'User' }, created_at: FIXED_ISO_TIME, updated_at: FIXED_ISO_TIME })));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // Pull requests.
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = bodyRecord(req);
          const title = str(body.title);
          const headRef = str(body.head);
          const baseRef = str(body.base);
          if (title === '' || headRef === '' || baseRef === '') return err(422, 'title, head and base are required');
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (headSha === undefined) return err(422, `head branch ${headRef} does not exist`);
          if (baseSha === undefined) return err(422, `base branch ${baseRef} does not exist`);
          for (const pull of repo.pulls.values()) {
            if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) {
              return err(422, 'A pull request already exists for this head and base');
            }
          }
          const pull = forge.createPull(repo, title, str(body.body), headRef, baseRef, headSha, baseSha);
          return json(201, pullJson(repo, pull));
        }
        if (method === 'GET') {
          const state = req.query.state ?? 'open';
          let pulls = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
          if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
          else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
          const { page, total, pageNum, perPage } = paginate(pulls, req.query);
          const link = linkHeader(req.origin, `/api/v3/repos/${owner}/${name}/pulls`, req.query, total, pageNum, perPage);
          return json(200, page.map((p) => pullJson(repo, p)), { link });
        }
        return err(404, 'Not Found');
      }
      const number = parseInt(rest[1] ?? '', 10);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      if (rest.length === 2 && method === 'GET') {
        const pull = repo.pulls.get(number);
        if (!pull) return err(404, 'Not Found');
        return json(200, pullJson(repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const pull = repo.pulls.get(number);
        if (!pull) return err(404, 'Not Found');
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        if (headTip === undefined || baseTip === undefined) return json(200, []);
        const base = forge.mergeBase(repo, headTip, baseTip) ?? pull.baseSha;
        const baseCommit = forge.commitOf(repo, base);
        const headCommit = forge.commitOf(repo, headTip);
        if (!baseCommit || !headCommit) return json(200, []);
        const changes = forge.diffTrees(repo, baseCommit.tree, headCommit.tree);
        return json(200, changes.map((c) => ({ filename: c.filename, status: c.status, additions: c.additions, deletions: c.deletions, changes: c.changes })));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const pull = repo.pulls.get(number);
        if (!pull) return err(404, 'Not Found');
        if (pull.state !== 'open') return err(405, 'Pull Request is already merged or closed');
        const body = bodyRecord(req);
        const methodName = str(body.merge_method) || 'squash';
        const mergeMethod = methodName === 'merge' ? 'merge' : 'squash';
        const result = forge.mergePullRequest(repo, pull, mergeMethod);
        if ('conflict' in result) return err(405, 'Merge conflict');
        return json(200, { sha: result.commitOid, merged: true, message: 'Pull Request successfully merged' });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function dirListing(forge: Forge, repo: Repo, flat: Map<string, { oid: string; mode: string }>, dir: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }>();
  for (const [path, value] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const object = repo.objects.get(value.oid);
      children.set(rest, { type: 'file', name: rest, path, sha: value.oid, size: object?.data.length ?? 0 });
    } else {
      const name = rest.slice(0, slash);
      if (!children.has(name)) {
        children.set(name, { type: 'dir', name, path: `${prefix}${name}`, sha: '', size: 0 });
      }
    }
  }
  // Directory shas: the tree oid of that directory at the commit. Compute from the
  // flat map by rebuilding the tree for the directory's files.
  const out = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  return out.map((entry) => {
    if (entry.type === 'dir') {
      const sub = new Map<string, { oid: string; mode: string }>();
      const subPrefix = `${entry.path}/`;
      for (const [path, value] of flat) {
        if (path.startsWith(subPrefix)) sub.set(path.slice(subPrefix.length), value);
      }
      return { ...entry, sha: forge.buildTreeFromMap(repo, sub) };
    }
    return entry;
  });
}
