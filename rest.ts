// rest.ts — the GitHub REST v3 surface under /api/v3.
//
// One dispatcher, `routeRest`, answers every REST route from the store. Responses are
// pre-serialised JSON strings wherever the object is cacheable (single-issue reads,
// repository reads, list pages), because the read workload re-reads one issue two
// thousand times and should pay for a Map lookup, not a serialiser.

import type { ForgeStore, Repo } from './store.ts';
import {
  VIEWER,
  branchesJson,
  issueJsonText,
  parseCommit,
  pullJsonText,
  repoJsonText,
} from './store.ts';

export interface RestContext {
  store: ForgeStore;
  method: string;
  /** Path segments after /api/v3, each percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when there is none. */
  body: unknown;
  /** The request's Host header, for absolute pagination links. */
  host: string;
}

export interface RestReply {
  status: number;
  body: string | null;
  headers?: Record<string, string>;
}

const json = (status: number, value: unknown): RestReply => ({
  status,
  body: JSON.stringify(value),
});

const jsonText = (status: number, text: string, headers?: Record<string, string>): RestReply => ({
  status,
  body: text,
  headers,
});

const failure = (status: number, message: string): RestReply =>
  json(status, { message });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyOf(ctx: RestContext): Record<string, unknown> {
  return isRecord(ctx.body) ? ctx.body : {};
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function boolField(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

function intQuery(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The repository a route names, or null when the owner is foreign or the repo is absent. */
function routeRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function pageLinks(ctx: RestContext, base: string, perPage: number, page: number, total: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const url = (p: number): string => `http://${ctx.host}${base}?per_page=${perPage}&page=${p}`;
  const links: string[] = [];
  if (page < lastPage) links.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`);
  links.push(`<${url(1)}>; rel="first"`);
  links.push(`<${url(lastPage)}>; rel="last"`);
  return links.join(', ');
}

/** GET /api/v3/user/repos — the viewer's repositories, paginated. */
function listUserRepos(ctx: RestContext): RestReply {
  const perPage = Math.max(1, Math.min(100, intQuery(ctx.query, 'per_page', 30)));
  const page = Math.max(1, intQuery(ctx.query, 'page', 1));
  const all = ctx.store.listRepos(VIEWER.login);
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const text = `[${slice.map((repo) => repoJsonText(repo)).join(',')}]`;
  return jsonText(200, text, { link: pageLinks(ctx, '/api/v3/user/repos', perPage, page, all.length) });
}

/** GET /api/v3/repos/{owner}/{repo}/commits — newest first. */
function listCommits(ctx: RestContext, repo: Repo): RestReply {
  const ref = ctx.query.get('sha');
  const tip = ref === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : ctx.store.resolveRef(repo, ref);
  if (tip === undefined || tip === null) return failure(404, 'no such ref');
  const commits = ctx.store.walkCommits(tip, 1000);
  const items: string[] = [];
  for (const sha of commits) {
    const object = ctx.store.getObject(sha);
    if (!object || object.type !== 'commit') continue;
    const view = parseCommit(object.data);
    items.push(JSON.stringify({
      sha,
      commit: { message: view.message.replace(/\n+$/, ''), author: { name: view.author }, committer: { name: view.committer } },
    }));
  }
  return jsonText(200, `[${items.join(',')}]`);
}

/** GET /api/v3/repos/{owner}/{repo}/contents/{path} — a file, or a directory listing. */
function getContents(ctx: RestContext, repo: Repo, path: string): RestReply {
  const ref = ctx.query.get('ref');
  const tip = ref === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : ctx.store.resolveRef(repo, ref);
  if (tip === undefined || tip === null) return failure(404, 'no such ref');
  const commit = ctx.store.getObject(tip);
  if (!commit || commit.type !== 'commit') return failure(404, 'no such ref');
  const tree = parseCommit(commit.data).tree;
  if (path === '') {
    const entries = ctx.store.listDir(tree, '');
    if (entries === null) return failure(404, 'no such path');
    return json(200, entries.map((entry) => dirEntry(repo, tree, '', entry)));
  }
  const blob = ctx.store.blobAtPath(tree, path);
  if (blob !== null) {
    const name = path.split('/').pop() ?? path;
    return json(200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: blob.oid,
      size: blob.data.length,
      name,
      path,
    });
  }
  const entries = ctx.store.listDir(tree, path);
  if (entries === null) return failure(404, 'no such path');
  return json(200, entries.map((entry) => dirEntry(repo, tree, path, entry)));
}

function dirEntry(repo: Repo, _tree: string, dir: string, entry: { mode: string; name: string; oid: string }): Record<string, unknown> {
  return {
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: dir === '' ? entry.name : `${dir}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : undefined,
  };
}

/** PUT /api/v3/repos/{owner}/{repo}/contents/{path} — create or update a file. */
function putContents(ctx: RestContext, repo: Repo, path: string): RestReply {
  const body = bodyOf(ctx);
  const message = stringField(body, 'message');
  const contentB64 = stringField(body, 'content');
  if (message === '' || contentB64 === '') return failure(422, 'a contents write needs a message and base64 content');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return failure(422, 'the content is not valid base64');
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : undefined;
  const sha = typeof body.sha === 'string' && body.sha !== '' ? body.sha : undefined;
  const result = ctx.store.commitFile(repo, { branch, path, content, message, sha });
  if ('error' in result) return failure(result.error.status, result.error.message);
  return json(result.created ? 201 : 200, {
    content: { name: path.split('/').pop() ?? path, path, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64' },
    commit: { sha: result.commitSha },
  });
}

/** DELETE /api/v3/repos/{owner}/{repo}/contents/{path} — remove a file. */
function deleteContents(ctx: RestContext, repo: Repo, path: string): RestReply {
  const body = bodyOf(ctx);
  const message = stringField(body, 'message');
  const sha = typeof body.sha === 'string' && body.sha !== '' ? body.sha : undefined;
  const result = ctx.store.deleteFile(repo, { path, message: message === '' ? 'delete file' : message, sha });
  if ('error' in result) return failure(result.error.status, result.error.message);
  return json(200, { commit: { sha: result.commitSha } });
}

/** POST /api/v3/repos/{owner}/{repo}/issues — create an issue. */
function createIssue(ctx: RestContext, repo: Repo): RestReply {
  const body = bodyOf(ctx);
  const title = stringField(body, 'title');
  if (title === '') return failure(422, 'an issue needs a title');
  const labels = Array.isArray(body.labels)
    ? body.labels.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const result = ctx.store.createIssue(repo, { title, body: stringField(body, 'body'), labels });
  if ('error' in result) return failure(result.error.status, result.error.message);
  const text = repo.issueJson.get(result.issue.number) ?? issueJsonText(repo, result.issue);
  return jsonText(201, text);
}

/** GET /api/v3/repos/{owner}/{repo}/issues — list, filtered and sorted. */
function listIssues(ctx: RestContext, repo: Repo): RestReply {
  const issues = ctx.store.listIssues(repo, {
    state: ctx.query.get('state') ?? undefined,
    sort: ctx.query.get('sort') ?? undefined,
    direction: ctx.query.get('direction') ?? undefined,
    perPage: intQuery(ctx.query, 'per_page', 30),
    page: intQuery(ctx.query, 'page', 1),
  });
  const text = `[${issues.map((issue) => repo.issueJson.get(issue.number) ?? issueJsonText(repo, issue)).join(',')}]`;
  return jsonText(200, text);
}

/** POST /api/v3/repos/{owner}/{repo}/pulls — open a pull request. */
function createPull(ctx: RestContext, repo: Repo): RestReply {
  const body = bodyOf(ctx);
  const title = stringField(body, 'title');
  const head = stringField(body, 'head');
  const base = stringField(body, 'base');
  if (title === '' || head === '' || base === '') return failure(422, 'a pull request needs a title, head and base');
  const result = ctx.store.createPull(repo, { title, body: stringField(body, 'body'), head, base });
  if ('error' in result) return failure(result.error.status, result.error.message);
  return jsonText(201, pullJsonText(repo, result.pull, ctx.store.pullMergeable(repo, result.pull)));
}

/** GET /api/v3/repos/{owner}/{repo}/pulls — list, filtered by state. */
function listPulls(ctx: RestContext, repo: Repo): RestReply {
  const pulls = ctx.store.listPulls(repo, {
    state: ctx.query.get('state') ?? undefined,
    perPage: intQuery(ctx.query, 'per_page', 30),
    page: intQuery(ctx.query, 'page', 1),
  });
  const text = `[${pulls.map((pull) => pullJsonText(repo, pull, ctx.store.pullMergeable(repo, pull))).join(',')}]`;
  return jsonText(200, text);
}

/** The dispatcher. `segments` are the path parts after /api/v3. */
export function routeRest(ctx: RestContext): RestReply {
  const { method, segments } = ctx;
  const store = ctx.store;

  // The API root and its meta probe.
  if (segments.length === 0) {
    if (method !== 'GET') return failure(404, 'not found');
    return jsonText(200, '{"current_user_url":"/api/v3/user","rate_limit_url":"/api/v3/rate_limit"}', { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return failure(404, 'not found');
    return json(200, { installed_version: '1.0.0' });
  }

  // GET /user — the token owner.
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return failure(404, 'not found');
    return json(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }

  // POST /user/repos, GET /user/repos.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const body = bodyOf(ctx);
      const name = stringField(body, 'name');
      if (name === '') return failure(422, 'a repository needs a name');
      const result = store.createRepo(VIEWER.login, name, {
        description: stringField(body, 'description'),
        isPrivate: boolField(body, 'private', false),
      });
      if ('error' in result) return failure(result.error.status, result.error.message);
      return jsonText(201, repoJsonText(result.repo));
    }
    if (method === 'GET') return listUserRepos(ctx);
    return failure(404, 'not found');
  }

  // Everything below is /repos/{owner}/{repo}[...].
  if (segments.length >= 3 && segments[0] === 'repos') {
    const [, owner, name] = segments;
    const repo = routeRepo(ctx, owner, name);
    if (repo === null) return failure(404, 'not found');
    const tail = segments.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') return jsonText(200, repoJsonText(repo));
      if (method === 'PATCH') {
        const body = bodyOf(ctx);
        if (typeof body.description === 'string') {
          repo.description = body.description;
          repo.repoJson = null;
        }
        return jsonText(200, repoJsonText(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return failure(404, 'not found');
    }

    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') return json(200, branchesJson(repo));
      if (tail.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${tail[1]}`);
        if (sha === undefined) return failure(404, 'no such branch');
        return json(200, { name: tail[1], commit: { sha } });
      }
      return failure(404, 'not found');
    }

    if (tail[0] === 'commits') {
      if (tail.length === 1 && method === 'GET') return listCommits(ctx, repo);
      return failure(404, 'not found');
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') {
        const body = bodyOf(ctx);
        const ref = stringField(body, 'ref');
        const sha = stringField(body, 'sha');
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
          return failure(422, 'only refs/heads/ and refs/tags/ can be created here');
        }
        if (repo.refs.has(ref)) return failure(422, 'reference already exists');
        if (store.getObject(sha) === undefined) return failure(422, 'no such object');
        repo.refs.set(ref, sha);
        store.bumpRefs(repo);
        return json(201, { ref, object: { sha } });
      }
      if (tail.length === 4 && tail[2] === 'heads' && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${tail[3]}`);
        if (sha === undefined) return failure(404, 'no such ref');
        return json(200, { ref: `refs/heads/${tail[3]}`, object: { sha } });
      }
      return failure(404, 'not found');
    }

    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      if (method === 'PUT') return putContents(ctx, repo, path);
      if (method === 'GET') return getContents(ctx, repo, path);
      if (method === 'DELETE') return deleteContents(ctx, repo, path);
      return failure(404, 'not found');
    }

    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'POST') {
        const body = bodyOf(ctx);
        const labelName = stringField(body, 'name');
        if (labelName === '') return failure(422, 'a label needs a name');
        const color = typeof body.color === 'string' && body.color !== '' ? body.color : 'ededed';
        repo.labels.set(labelName, { name: labelName, color });
        return json(201, { name: labelName, color });
      }
      return failure(404, 'not found');
    }

    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') return createIssue(ctx, repo);
        if (method === 'GET') return listIssues(ctx, repo);
        return failure(404, 'not found');
      }
      const number = Number.parseInt(tail[1], 10);
      if (!Number.isInteger(number) || number < 1) return failure(404, 'not found');
      if (tail.length === 2) {
        if (method === 'GET') {
          const text = repo.issueJson.get(number);
          if (text === undefined) return failure(404, 'no such issue');
          return jsonText(200, text);
        }
        if (method === 'PATCH') {
          const body = bodyOf(ctx);
          const issue = store.patchIssue(repo, number, {
            state: typeof body.state === 'string' ? body.state : undefined,
            title: typeof body.title === 'string' ? body.title : undefined,
            body: typeof body.body === 'string' ? body.body : undefined,
          });
          if (issue === null) return failure(404, 'no such issue');
          return jsonText(200, repo.issueJson.get(number) ?? issueJsonText(repo, issue));
        }
        return failure(404, 'not found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'POST') {
          const body = bodyOf(ctx);
          const commentBody = stringField(body, 'body');
          if (commentBody === '') return failure(422, 'a comment needs a body');
          const comment = store.addComment(repo, number, commentBody);
          if (comment === null) return failure(404, 'no such issue');
          return json(201, { id: comment.id, body: comment.body });
        }
        if (method === 'GET') {
          const issue = repo.issues.get(number);
          if (issue === undefined) return failure(404, 'no such issue');
          return json(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
        }
        return failure(404, 'not found');
      }
      return failure(404, 'not found');
    }

    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') return createPull(ctx, repo);
        if (method === 'GET') return listPulls(ctx, repo);
        return failure(404, 'not found');
      }
      const number = Number.parseInt(tail[1], 10);
      if (!Number.isInteger(number) || number < 1) return failure(404, 'not found');
      if (tail.length === 2 && method === 'GET') {
        const pull = repo.pulls.get(number);
        if (pull === undefined) return failure(404, 'no such pull request');
        return jsonText(200, pullJsonText(repo, pull, store.pullMergeable(repo, pull)));
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const pull = repo.pulls.get(number);
        if (pull === undefined) return failure(404, 'no such pull request');
        const files = store.pullFiles(repo, pull);
        if (files === null) return failure(404, 'no such pull request');
        return json(200, files);
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const result = store.mergePull(repo, number);
        if ('error' in result) return failure(result.error.status, result.error.message);
        return json(200, { sha: result.mergeSha, merged: true, message: `Pull request #${number} merged` });
      }
      return failure(404, 'not found');
    }
  }

  return failure(404, 'not found');
}
