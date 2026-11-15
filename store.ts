// store.ts — the forge's state: git objects, repositories, issues and pull requests.
//
// Everything the HTTP, GraphQL and MCP layers need lives here, behind one ForgeStore.
// The object layer is real git: blobs, trees, commits and tags are content-addressed by
// SHA-1 over "<type> <size>\0" + bytes, so the REST surface and the smart-HTTP surface
// always agree on ids. Repositories hold refs; issues and pull requests live beside them.
//
// The viewer (the login the bearer token owns) is derived from the contest's one fixed
// seed with a small deterministic generator, so the server knows its owner without any
// configuration: the same seed always yields the same viewer.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// The viewer, derived from the contest's fixed seed
// ---------------------------------------------------------------------------

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_EPOCH_SEC = 1_735_689_600;

/** FNV-1a over a label, 64-bit. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: mixes a seeded value's bits into each other. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from. */
function streamSeed(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: a 64-bit state walked by three shifts and one multiply. */
class SeedStream {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const GIVEN_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const FAMILY_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ForgeUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function deriveUsers(count: number): ForgeUser[] {
  const rng = new SeedStream(streamSeed('users'));
  const used = new Set<string>();
  const users: ForgeUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(GIVEN_NAMES);
    const last = rng.pick(FAMILY_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

export const FORGE_USERS: readonly ForgeUser[] = deriveUsers(12);
/** The login the bearer token owns. */
export const VIEWER: ForgeUser = FORGE_USERS[0];
/** The identity REST-created commits carry. */
export const FORGE_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const OID_RE = /^[0-9a-f]{40}$/i;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** git's object id: SHA-1 over "<type> <size>\0" + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree's binary entries: "<mode> <name>\0<20-byte oid>" per entry. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** The sort key git uses for tree entries: directories sort as if named with a trailing '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree's bytes from entries, in git's sort order. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit's headers and message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

/** Build a commit's bytes. The message is normalised to end with one newline. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag's headers and message. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

// ---------------------------------------------------------------------------
// Repository model
// ---------------------------------------------------------------------------

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  /** Creation order inside the repository; drives list sorting. */
  seq: number;
  createdAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** ref name -> commit oid. */
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, { name: string; color: string }>;
  /** The next issue/pull-request number (one shared counter, GitHub-style). */
  nextNumber: number;
  nextCommentId: number;
  /** Creation order across repositories; drives GET /user/repos ordering. */
  seq: number;
  /** Bumped on every ref change; cache keys hang off it. */
  refVersion: number;
  /** Cached serialised JSON for single-issue reads (the read workload's hot path). */
  issueJson: Map<number, string>;
  /** Cached serialised repo JSON. */
  repoJson: string | null;
  /** Cached fetch packs: fetch key -> { pack, shallow, unshallow }. */
  fetchCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>;
  /** Cached ls-refs bodies: args key -> response Buffer. */
  lsRefsCache: Map<string, Buffer>;
}

export type StoreError = { status: number; message: string };

function err(status: number, message: string): StoreError {
  return { status, message };
}

function isoFromSeq(seq: number): string {
  return new Date((SCENARIO_EPOCH_SEC + seq) * 1000).toISOString();
}

/** The forge: every repository, every object, every issue. */
export class ForgeStore {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextGlobalId = 1;
  private nextSeq = 1;
  private commitClock = 0;

  /** A fresh deterministic timestamp for a commit this server creates. */
  nextCommitTime(): number {
    this.commitClock += 1;
    return SCENARIO_EPOCH_SEC + this.commitClock;
  }

  // -- objects ---------------------------------------------------------------

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Every object reachable from `roots` (commits, trees, blobs, tags). */
  reachable(roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const root of roots) if (isOid(root) && root !== ZERO_OID) stack.push(root);
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /**
   * Every object reachable from `roots`, without following the parents of a commit
   * in `boundary`. A shallow boundary is a commit the client holds but whose
   * parents it does not, so a deepen fetch's haves stop there instead of
   * swallowing the history the fetch is meant to deliver.
   */
  reachableBounded(roots: Iterable<string>, boundary: ReadonlySet<string>): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const root of roots) if (isOid(root) && root !== ZERO_OID) stack.push(root);
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        if (!boundary.has(oid)) {
          for (const parent of commit.parents) stack.push(parent);
        }
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /**
   * The objects a fetch of `wants` must deliver, excluding what `haves` already hold.
   * With `depth`, only commits shallower than `depth` from a want are included, plus
   * each included commit's whole tree; `shallow` names the new boundary and `unshallow`
   * the old boundaries this fetch now covers.
   */
  fetchObjects(options: {
    wants: readonly string[];
    haves?: readonly string[];
    depth?: number;
    shallow?: readonly string[];
  }): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
    const shallowSet = new Set(options.shallow ?? []);
    const haveSet = new Set<string>();
    for (const have of options.haves ?? []) {
      for (const oid of this.reachableBounded([have], shallowSet)) haveSet.add(oid);
    }
    const out = new Map<string, GitObject>();
    const shallow: string[] = [];
    const unshallow: string[] = [];
    const add = (oid: string): void => {
      if (haveSet.has(oid)) return;
      const object = this.objects.get(oid);
      if (object !== undefined && !out.has(oid)) out.set(oid, object);
    };
    const addTree = (treeOid: string): void => {
      const stack = [treeOid];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (haveSet.has(oid)) continue;
        const object = this.objects.get(oid);
        if (!object || object.type !== 'tree') {
          if (object !== undefined) add(oid);
          continue;
        }
        if (out.has(oid)) continue;
        out.set(oid, object);
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    };

    if (options.depth !== undefined) {
      const depth = Math.max(1, Math.trunc(options.depth));
      // Breadth-first over commits, tracking distance from the nearest want.
      const seenDepth = new Map<string, number>();
      const queue: Array<{ oid: string; d: number }> = [];
      for (const want of options.wants) {
        const peeled = this.peelToCommit(want);
        if (peeled !== null && !seenDepth.has(peeled)) {
          seenDepth.set(peeled, 0);
          queue.push({ oid: peeled, d: 0 });
        }
      }
      const boundary = new Set<string>();
      while (queue.length > 0) {
        const { oid, d } = queue.shift()!;
        const object = this.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        add(oid);
        const commit = parseCommit(object.data);
        addTree(commit.tree);
        if (d === depth - 1) {
          if (commit.parents.length > 0) boundary.add(oid);
          continue;
        }
        for (const parent of commit.parents) {
          if (!seenDepth.has(parent)) {
            seenDepth.set(parent, d + 1);
            queue.push({ oid: parent, d: d + 1 });
          }
        }
      }
      for (const oid of boundary) shallow.push(oid);
      for (const old of options.shallow ?? []) {
        if (seenDepth.has(old) && (seenDepth.get(old) ?? 0) < depth - 1) unshallow.push(old);
      }
      // A boundary the client already holds at the same depth stays shallow: report it.
      for (const old of options.shallow ?? []) {
        if (!unshallow.includes(old) && !shallow.includes(old) && seenDepth.has(old)) shallow.push(old);
      }
      return { objects: out, shallow, unshallow };
    }

    for (const want of options.wants) {
      for (const oid of this.reachable([want])) add(oid);
    }
    return { objects: out, shallow, unshallow };
  }

  /** Follow a tag to its commit, or return the oid itself when it already is one. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 8; hops += 1) {
      const object = this.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Peel a tag object to its target oid (any type), or the oid itself. */
  peelTag(oid: string): string | null {
    const object = this.objects.get(oid);
    if (!object) return null;
    if (object.type === 'tag') return parseTag(object.data).object;
    return oid;
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack = [tip];
    let steps = 0;
    while (stack.length > 0 && steps < 100_000) {
      const oid = stack.pop()!;
      steps += 1;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** The nearest common ancestor of two commits, or null. */
  mergeBase(a: string, b: string): string | null {
    const aSet = new Set<string>();
    const aStack = [a];
    while (aStack.length > 0) {
      const oid = aStack.pop()!;
      if (aSet.has(oid)) continue;
      aSet.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) aStack.push(parent);
    }
    const bQueue = [b];
    const bSeen = new Set<string>();
    while (bQueue.length > 0) {
      const oid = bQueue.shift()!;
      if (bSeen.has(oid)) continue;
      bSeen.add(oid);
      if (aSet.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) bQueue.push(parent);
    }
    return null;
  }

  // -- trees -----------------------------------------------------------------

  /** Flatten a tree into path -> {oid, mode}. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** The blob at `path` in the tree, or null when the path is absent or a directory. */
  blobAtPath(treeOid: string, path: string): { oid: string; data: Buffer } | null {
    const segments = path.split('/').filter((part) => part !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') return null;
        const blob = this.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** The direct children of `dirPath` in the tree ('' is the root). */
  listDir(treeOid: string, dirPath: string): TreeEntry[] | null {
    let current = treeOid;
    if (dirPath !== '') {
      for (const segment of dirPath.split('/').filter((part) => part !== '')) {
        const object = this.objects.get(current);
        if (!object || object.type !== 'tree') return null;
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
        if (!entry || entry.mode !== '40000') return null;
        current = entry.oid;
      }
    }
    const object = this.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  /**
   * A new root tree with `path` set to `blobOid` (or removed when null), rebuilding
   * every tree on the way down. Empty directories left behind are pruned.
   */
  setPath(treeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((part) => part !== '');
    const build = (oid: string | null, depth: number): string | null => {
      const entries = oid === null ? [] : parseTree(this.objects.get(oid)?.data ?? Buffer.alloc(0));
      const name = segments[depth];
      const rest = segments.slice(depth + 1);
      const out: TreeEntry[] = [];
      let replaced = false;
      for (const entry of entries) {
        if (entry.name !== name) {
          out.push(entry);
          continue;
        }
        replaced = true;
        if (rest.length === 0) {
          if (blobOid !== null) out.push({ mode: '100644', name, oid: blobOid });
        } else {
          const child = build(entry.mode === '40000' ? entry.oid : null, depth + 1);
          if (child !== null) out.push({ mode: '40000', name, oid: child });
        }
      }
      if (!replaced) {
        if (rest.length === 0) {
          if (blobOid !== null) out.push({ mode: '100644', name, oid: blobOid });
        } else {
          const child = build(null, depth + 1);
          if (child !== null) out.push({ mode: '40000', name, oid: child });
        }
      }
      if (out.length === 0) return null;
      return this.putObject('tree', buildTree(out));
    };
    return build(treeOid, 0) ?? this.putObject('tree', buildTree([]));
  }

  /** Build a root tree from a flat path -> blob map. */
  treeFromPaths(paths: Map<string, string>): string {
    let root: string | null = null;
    for (const [path, blobOid] of paths) root = this.setPath(root, path, blobOid);
    return root ?? this.putObject('tree', buildTree([]));
  }

  // -- repositories ----------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { description?: string; isPrivate?: boolean }): { repo: Repo } | { error: StoreError } {
    if (this.repos.has(this.repoKey(owner, name))) {
      return { error: err(422, 'Repository already exists') };
    }
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.nextSeq,
      refVersion: 0,
      issueJson: new Map(),
      repoJson: null,
      fetchCache: new Map(),
      lsRefsCache: new Map(),
    };
    this.nextRepoId += 1;
    this.nextSeq += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return { repo };
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** The tip commit of a branch (or any ref name), or null. */
  refTip(repo: Repo, refName: string): string | null {
    return repo.refs.get(refName) ?? null;
  }

  /** Resolve a branch name or commit oid to a tip commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    const direct = repo.refs.get(`refs/heads/${ref}`);
    if (direct !== undefined) return direct;
    const asRef = repo.refs.get(ref);
    if (asRef !== undefined) return asRef;
    if (isOid(ref) && this.objects.has(ref)) return ref;
    return null;
  }

  bumpRefs(repo: Repo): void {
    repo.refVersion += 1;
    repo.fetchCache.clear();
    repo.lsRefsCache.clear();
    repo.repoJson = null;
  }

  // -- commits ---------------------------------------------------------------

  /** Create a commit on `branch`, creating the branch from the default tip when needed. */
  commitOnBranch(repo: Repo, options: {
    branch: string;
    tree: string;
    message: string;
    parents?: readonly string[];
  }): { commitSha: string } {
    const parents = options.parents ?? (() => {
      const tip = repo.refs.get(`refs/heads/${options.branch}`);
      if (tip !== undefined) return [tip];
      const base = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return base !== undefined ? [base] : [];
    })();
    const commit = buildCommit({
      tree: options.tree,
      parents,
      message: options.message,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      timestamp: this.nextCommitTime(),
    });
    const commitSha = this.putObject('commit', commit);
    repo.refs.set(`refs/heads/${options.branch}`, commitSha);
    this.bumpRefs(repo);
    return { commitSha };
  }

  /** Walk a tip's history, newest first (all parents, visited once). */
  walkCommits(tip: string, limit = 10_000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return out;
  }

  // -- contents --------------------------------------------------------------

  commitFile(repo: Repo, options: {
    branch?: string;
    path: string;
    content: Buffer;
    message: string;
    sha?: string;
  }): { commitSha: string; blobSha: string; created: boolean } | { error: StoreError } {
    const branch = options.branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    let baseTree: string | null = null;
    if (tip !== undefined) {
      const commit = this.objects.get(tip);
      if (!commit || commit.type !== 'commit') return { error: err(422, 'the branch tip is not a commit') };
      baseTree = parseCommit(commit.data).tree;
    }
    const existing = baseTree === null ? null : this.blobAtPath(baseTree, options.path);
    if (existing !== null) {
      if (options.sha === undefined) return { error: err(409, 'a file already exists at this path; pass its sha to update it') };
      if (options.sha.toLowerCase() !== existing.oid.toLowerCase()) {
        return { error: err(409, 'the sha does not match the current file') };
      }
    }
    const blobSha = this.putObject('blob', options.content);
    const tree = this.setPath(baseTree, options.path, blobSha);
    const { commitSha } = this.commitOnBranch(repo, { branch, tree, message: options.message });
    return { commitSha, blobSha, created: existing === null };
  }

  deleteFile(repo: Repo, options: {
    branch?: string;
    path: string;
    message: string;
    sha?: string;
  }): { commitSha: string } | { error: StoreError } {
    const branch = options.branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return { error: err(404, 'the repository has no commits yet') };
    const commit = this.objects.get(tip);
    if (!commit || commit.type !== 'commit') return { error: err(404, 'the branch tip is not a commit') };
    const baseTree = parseCommit(commit.data).tree;
    const existing = this.blobAtPath(baseTree, options.path);
    if (existing === null) return { error: err(404, 'no file at this path') };
    if (options.sha !== undefined && options.sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { error: err(409, 'the sha does not match the current file') };
    }
    const tree = this.setPath(baseTree, options.path, null);
    const { commitSha } = this.commitOnBranch(repo, { branch, tree, message: options.message });
    return { commitSha };
  }

  // -- issues ----------------------------------------------------------------

  createIssue(repo: Repo, options: {
    title: string;
    body?: string;
    labels?: readonly string[];
  }): { issue: Issue } | { error: StoreError } {
    const labels = options.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: err(422, `unknown label "${name}"`) };
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      id: this.nextGlobalId,
      number,
      title: options.title,
      body: options.body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.nextSeq,
      createdAt: isoFromSeq(this.nextSeq),
    };
    this.nextGlobalId += 1;
    this.nextSeq += 1;
    repo.issues.set(number, issue);
    repo.issueJson.set(number, issueJsonText(repo, issue));
    return { issue };
  }

  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue | null {
    const issue = repo.issues.get(number);
    if (!issue) return null;
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    repo.issueJson.set(number, issueJsonText(repo, issue));
    return issue;
  }

  addComment(repo: Repo, number: number, body: string): IssueComment | null {
    const issue = repo.issues.get(number);
    if (!issue) return null;
    const comment: IssueComment = { id: repo.nextCommentId, body };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  listIssues(repo: Repo, options: {
    state?: string;
    sort?: string;
    direction?: string;
    perPage?: number;
    page?: number;
  }): Issue[] {
    const state = options.state ?? 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    const direction = options.direction === 'asc' ? 1 : -1;
    list.sort((a, b) => (a.seq - b.seq) * direction);
    const perPage = Math.max(1, Math.min(100, options.perPage ?? 30));
    const page = Math.max(1, options.page ?? 1);
    return list.slice((page - 1) * perPage, page * perPage);
  }

  // -- pull requests -----------------------------------------------------------

  createPull(repo: Repo, options: {
    title: string;
    body?: string;
    head: string;
    base: string;
  }): { pull: Pull } | { error: StoreError } {
    const headSha = repo.refs.get(`refs/heads/${options.head}`);
    if (headSha === undefined) return { error: err(422, `unknown head branch "${options.head}"`) };
    const baseSha = repo.refs.get(`refs/heads/${options.base}`);
    if (baseSha === undefined) return { error: err(422, `unknown base branch "${options.base}"`) };
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === options.head && pull.baseRef === options.base) {
        return { error: err(422, 'a pull request is already open for this head and base') };
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: Pull = {
      id: this.nextGlobalId,
      number,
      title: options.title,
      body: options.body ?? '',
      state: 'open',
      merged: false,
      headRef: options.head,
      baseRef: options.base,
      headSha,
      baseSha,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.nextSeq,
      createdAt: isoFromSeq(this.nextSeq),
    };
    this.nextGlobalId += 1;
    this.nextSeq += 1;
    repo.pulls.set(number, pull);
    return { pull };
  }

  listPulls(repo: Repo, options: { state?: string; perPage?: number; page?: number }): Pull[] {
    const state = options.state ?? 'open';
    let list = [...repo.pulls.values()];
    if (state !== 'all') list = list.filter((pull) => pull.state === state);
    list.sort((a, b) => b.seq - a.seq);
    const perPage = Math.max(1, Math.min(100, options.perPage ?? 30));
    const page = Math.max(1, options.page ?? 1);
    return list.slice((page - 1) * perPage, page * perPage);
  }

  /** MERGEABLE when a three-way merge of head into base has no path both sides changed. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const head = repo.refs.get(`refs/heads/${pull.headRef}`);
    const base = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (head === undefined || base === undefined) return 'UNKNOWN';
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.mergeConflict(head, base) ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** True when merging `headTip` into `baseTip` would conflict. */
  mergeConflict(headTip: string, baseTip: string): boolean {
    const base = this.mergeBase(headTip, baseTip);
    if (base === null) return false;
    const baseCommit = this.objects.get(base);
    const headCommit = this.objects.get(headTip);
    const tipCommit = this.objects.get(baseTip);
    if (!baseCommit || !headCommit || !tipCommit) return false;
    const ancestorTree = this.flattenTree(parseCommit(baseCommit.data).tree);
    const headTree = this.flattenTree(parseCommit(headCommit.data).tree);
    const baseTree = this.flattenTree(parseCommit(tipCommit.data).tree);
    const paths = new Set([...ancestorTree.keys(), ...headTree.keys(), ...baseTree.keys()]);
    for (const path of paths) {
      const a = ancestorTree.get(path)?.oid ?? null;
      const h = headTree.get(path)?.oid ?? null;
      const b = baseTree.get(path)?.oid ?? null;
      const headChanged = h !== a;
      const baseChanged = b !== a;
      if (headChanged && baseChanged && h !== b) return true;
    }
    return false;
  }

  /** The squash-merge result tree for head into base (null when conflicted). */
  mergeTree(headTip: string, baseTip: string): string | null {
    const base = this.mergeBase(headTip, baseTip);
    if (base === null) return null;
    const baseCommit = this.objects.get(base);
    const headCommit = this.objects.get(headTip);
    const tipCommit = this.objects.get(baseTip);
    if (!baseCommit || !headCommit || !tipCommit) return null;
    const ancestorTree = this.flattenTree(parseCommit(baseCommit.data).tree);
    const headTree = this.flattenTree(parseCommit(headCommit.data).tree);
    const baseTree = this.flattenTree(parseCommit(tipCommit.data).tree);
    const result = new Map<string, string>();
    const paths = new Set([...ancestorTree.keys(), ...headTree.keys(), ...baseTree.keys()]);
    for (const path of paths) {
      const a = ancestorTree.get(path)?.oid ?? null;
      const h = headTree.get(path)?.oid ?? null;
      const b = baseTree.get(path)?.oid ?? null;
      const headChanged = h !== a;
      const baseChanged = b !== a;
      if (headChanged && baseChanged && h !== b) return null;
      const picked = headChanged ? h : b;
      if (picked !== null) result.set(path, picked);
    }
    return this.treeFromPaths(result);
  }

  mergePull(repo: Repo, number: number): { mergeSha: string } | { error: StoreError } {
    const pull = repo.pulls.get(number);
    if (!pull) return { error: err(404, 'no such pull request') };
    if (pull.merged || pull.state !== 'open') return { error: err(405, 'this pull request is already closed') };
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return { error: err(405, 'the head or base branch is gone') };
    const tree = this.mergeTree(headTip, baseTip);
    if (tree === null) return { error: err(405, 'this pull request cannot be merged: conflicts') };
    const commit = buildCommit({
      tree,
      parents: [baseTip],
      message: `Merge pull request #${number} from ${repo.owner}/${pull.headRef}`,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      timestamp: this.nextCommitTime(),
    });
    const mergeSha = this.putObject('commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date((SCENARIO_EPOCH_SEC + this.nextSeq) * 1000).toISOString();
    pull.mergeCommitSha = mergeSha;
    pull.baseSha = mergeSha;
    this.nextSeq += 1;
    this.bumpRefs(repo);
    return { mergeSha };
  }

  /** The changed files of a pull request: merge-base tree vs head tree. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> | null {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return null;
    const mergeBaseOid = this.mergeBase(headTip, baseTip);
    const baseTreeOid = mergeBaseOid === null ? null : parseCommit(this.objects.get(mergeBaseOid)?.data ?? Buffer.alloc(0)).tree;
    const headTreeOid = parseCommit(this.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    const baseFiles = baseTreeOid === null ? new Map() : this.flattenTree(baseTreeOid);
    const headFiles = this.flattenTree(headTreeOid);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const lineCount = (oid: string | null): number => {
      if (oid === null) return 0;
      const object = this.objects.get(oid);
      if (!object) return 0;
      const text = object.data.toString('utf8');
      if (text === '') return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const before = baseFiles.get(path)?.oid ?? null;
      const after = headFiles.get(path)?.oid ?? null;
      if (before === after) continue;
      const status = before === null ? 'added' : after === null ? 'removed' : 'modified';
      const additions = status === 'removed' ? 0 : lineCount(after);
      const deletions = status === 'added' ? 0 : lineCount(before);
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// JSON views (one canonical shape per object, shared by REST, GraphQL and MCP)
// ---------------------------------------------------------------------------

export function repoJsonText(repo: Repo): string {
  if (repo.repoJson !== null) return repo.repoJson;
  const text = JSON.stringify({
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/repos/${repo.owner}/${repo.name}`,
  });
  repo.repoJson = text;
  return text;
}

export function issueJsonText(repo: Repo, issue: Issue): string {
  return JSON.stringify({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: repo.owner },
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
  });
}

export function pullJsonText(repo: Repo, pull: Pull, mergeable?: string): string {
  return JSON.stringify({
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: mergeable ?? null,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
  });
}

/** A repo's branches as REST [{name, commit:{sha}}], default branch first. */
export function branchesJson(repo: Repo): Array<{ name: string; commit: { sha: string } }> {
  const out: Array<{ name: string; commit: { sha: string } }> = [];
  const names = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .sort();
  const ordered = [repo.defaultBranch, ...names.filter((name) => name !== repo.defaultBranch)];
  for (const name of ordered) {
    const sha = repo.refs.get(`refs/heads/${name}`);
    if (sha !== undefined) out.push({ name, commit: { sha } });
  }
  return out;
}
