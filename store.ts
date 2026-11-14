// store.ts — the forge's in-memory store: git object model, pack codec, repositories,
// issues, pull requests, labels and comments. No disk, no network, no clock in any
// pass/fail bit: commit timestamps and REST timestamps are fixed constants, so two runs
// on the same requests produce the same object ids.
//
// The token's owner is derived from the competition's public scenario seed
// (kit sdk/conformance/wire.ts: SCENARIO_SEED is a fixed constant, and the suite's
// scenario is built from it). The server accepts any non-empty bearer token as the
// viewer; ownership is enforced against the scenario-derived viewer login.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// -------------------------------------------------------------------------------------------
// Scenario seed: the viewer / stranger logins, recomputed from the public seed.
// -------------------------------------------------------------------------------------------

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
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
    return items[this.nextInt(items.length)]!;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function scenarioUsers(): ScenarioUser[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
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

const USERS = scenarioUsers();
export const VIEWER: ScenarioUser = USERS[0]!;
export const TEAMMATE: ScenarioUser = USERS[1]!;
export const STRANGER: ScenarioUser = USERS[2]!;
export const VIEWER_LOGIN = VIEWER.login;
export const STRANGER_LOGIN = STRANGER.login;

// Fixed timestamps: every commit and every REST created_at/updated_at. Deterministic
// across runs, so object ids and exports replay byte for byte.
export const FIXED_COMMIT_TIME = 1_700_000_000;
export const FIXED_ISO_TIME = '2023-11-14T22:13:20Z';
export const FORGE_IDENTITY_NAME = 'ruri08';
export const FORGE_IDENTITY_EMAIL = 'ruri08@make.fun';

// -------------------------------------------------------------------------------------------
// Git object model
// -------------------------------------------------------------------------------------------

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value);
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function oidOf(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function storeObject(objects: Map<string, GitObject>, type: ObjType, data: Buffer): string {
  const oid = oidOf(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function makeBlob(content: Buffer): { oid: string; object: GitObject } {
  const data = Buffer.from(content);
  return { oid: oidOf('blob', data), object: { type: 'blob', data } };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** git tree entry sort: directory names compare with a trailing '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function makeTree(entries: TreeEntry[]): { oid: string; object: GitObject } {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  const data = Buffer.concat(parts);
  return { oid: oidOf('tree', data), object: { type: 'tree', data } };
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function makeCommit(info: CommitInfo): { oid: string; object: GitObject } {
  const ident = `${FORGE_IDENTITY_NAME} <${FORGE_IDENTITY_EMAIL}> ${FIXED_COMMIT_TIME} +0000`;
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author || ident}`);
  lines.push(`committer ${info.committer || ident}`);
  const data = Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
  return { oid: oidOf('commit', data), object: { type: 'commit', data } };
}

// -------------------------------------------------------------------------------------------
// Delta application (for packs that carry OFS_DELTA / REF_DELTA entries)
// -------------------------------------------------------------------------------------------

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint truncated');
      const byte = delta[offset++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) copyOffset = delta[offset++]!;
      if ((op & 0x02) !== 0) copyOffset |= delta[offset++]! << 8;
      if ((op & 0x04) !== 0) copyOffset |= delta[offset++]! << 16;
      if ((op & 0x08) !== 0) copyOffset |= delta[offset++]! << 24;
      if ((op & 0x10) !== 0) copySize = delta[offset++]!;
      if ((op & 0x20) !== 0) copySize |= delta[offset++]! << 8;
      if ((op & 0x40) !== 0) copySize |= delta[offset++]! << 16;
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

// -------------------------------------------------------------------------------------------
// Pack codec (version 2, plain objects on write; deltas resolved on read)
// -------------------------------------------------------------------------------------------

function encodeTypeAndSize(typeCode: number, size: number): Buffer {
  const result: number[] = [];
  let s = size;
  let first = (typeCode << 4) | (s & 0x0f);
  s >>= 4;
  if (s > 0) first |= 0x80;
  result.push(first);
  while (s > 0) {
    let b = s & 0x7f;
    s >>= 7;
    if (s > 0) b |= 0x80;
    result.push(b);
  }
  return Buffer.from(result);
}

export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(encodeTypeAndSize(TYPE_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface PackEntry {
  offset: number;
  typeCode: number;
  size: number;
  dataStart: number;
  dataEnd: number;
  baseOffset?: number;
  baseOid?: string;
}

export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expected = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  const actual = pack.subarray(trailerStart).toString('hex');
  if (expected !== actual) throw new Error('pack checksum mismatch');

  const entries: PackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset++]!;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: PackEntry = { offset: entryOffset, typeCode, size, dataStart: offset, dataEnd: -1 };
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint.
      let b = pack[offset++]!;
      let baseOffset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[offset++]!;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = entryOffset - baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    entry.dataStart = offset;
    offset = skipZlib(pack, offset);
    entry.dataEnd = offset;
    const inflated = inflateSync(pack.subarray(entry.dataStart, entry.dataEnd));
    if (inflated.length !== size) throw new Error('pack entry size mismatch');
    entries.push(entry);
  }

  const byOffset = new Map<number, PackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolved = new Map<string, GitObject>();
  const byOffsetResolved = new Map<number, GitObject>();
  const resolving = new Set<number>();

  const resolveEntry = (entry: PackEntry): GitObject => {
    const cached = byOffsetResolved.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    try {
      const raw = inflateSync(pack.subarray(entry.dataStart, entry.dataEnd));
      let object: GitObject;
      if (entry.typeCode === 6 || entry.typeCode === 7) {
        let base: GitObject | undefined;
        if (entry.typeCode === 6) {
          const baseEntry = byOffset.get(entry.baseOffset ?? -1);
          if (!baseEntry) throw new Error('ofs-delta base not in pack');
          base = resolveEntry(baseEntry);
        } else {
          const baseEntry = entries.find((e) => {
            const t = CODE_TYPE[e.typeCode];
            if (!t || e.typeCode === 6 || e.typeCode === 7) return false;
            return oidOf(t, inflateSync(pack.subarray(e.dataStart, e.dataEnd))) === entry.baseOid;
          });
          if (baseEntry) base = resolveEntry(baseEntry);
          else if (resolveBase) base = resolveBase(entry.baseOid ?? '');
          if (!base) throw new Error('ref-delta base not found');
        }
        object = { type: base.type, data: applyDelta(base.data, raw) };
      } else {
        const type = CODE_TYPE[entry.typeCode];
        if (!type) throw new Error(`unknown pack type ${entry.typeCode}`);
        object = { type, data: raw };
      }
      byOffsetResolved.set(entry.offset, object);
      resolved.set(oidOf(object.type, object.data), object);
      return object;
    } finally {
      resolving.delete(entry.offset);
    }
  };

  for (const entry of entries) resolveEntry(entry);
  return resolved;
}

/** Length of the zlib stream starting at `start`: exponential probe then binary search. */
function skipZlib(pack: Buffer, start: number): number {
  const limit = pack.length - 20;
  // Failed inflations throw; V8 captures a stack per throw, which dominates the
  // probe cost. The probe is synchronous and restores the limit immediately.
  const savedLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    const tryInflate = (end: number): boolean => {
      try {
        inflateSync(pack.subarray(start, end));
        return true;
      } catch {
        return false;
      }
    };
    let low = start + 1;
    let high = Math.min(limit, start + 16);
    if (!tryInflate(high)) {
      // Exponential probe for an upper bound that inflates.
      let probe = high;
      while (probe < limit && !tryInflate(probe)) probe = Math.min(limit, probe * 2);
      if (!tryInflate(probe)) throw new Error('unterminated zlib stream in pack');
      low = Math.floor(probe / 2);
      high = probe;
    }
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tryInflate(mid)) high = mid;
      else low = mid + 1;
    }
    return low;
  } finally {
    Error.stackTraceLimit = savedLimit;
  }
}

// -------------------------------------------------------------------------------------------
// Forge data model
// -------------------------------------------------------------------------------------------

export interface Comment {
  id: number;
  body: string;
  user: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  refOrder: string[];
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, { name: string; color: string }>;
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'changed';
  additions: number;
  deletions: number;
  changes: number;
}

export class Forge {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextObjectId = 1;
  private seqCounter = 0;

  private nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      refOrder: [],
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.nextSeq(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    if (!repo.refs.has(ref)) repo.refOrder.push(ref);
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): void {
    repo.refs.delete(ref);
    repo.refOrder = repo.refOrder.filter((r) => r !== ref);
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  // ---- graph helpers ----

  commitOf(repo: Repo, oid: string): CommitInfo | undefined {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return undefined;
    return parseCommit(object.data);
  }

  /** Commits reachable from `tips`, newest-first by BFS depth (parents after children). */
  reachableCommits(repo: Repo, tips: readonly string[]): Map<string, number> {
    const depth = new Map<string, number>();
    const queue: Array<[string, number]> = [];
    for (const tip of tips) {
      if (isObjectId(tip) && !depth.has(tip)) {
        depth.set(tip, 0);
        queue.push([tip, 0]);
      }
    }
    for (let i = 0; i < queue.length; i += 1) {
      const [oid, d] = queue[i]!;
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (!depth.has(parent)) {
          depth.set(parent, d + 1);
          queue.push([parent, d + 1]);
        }
      }
    }
    return depth;
  }

  /** All objects (commits, trees, blobs) reachable from `tips`. */
  reachableObjects(repo: Repo, tips: readonly string[]): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const commits = this.reachableCommits(repo, tips);
    const visitTree = (treeOid: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree' || out.has(treeOid)) return;
      out.set(treeOid, tree);
      for (const entry of parseTree(tree.data)) {
        const child = repo.objects.get(entry.oid);
        if (!child) continue;
        if (child.type === 'tree') visitTree(entry.oid);
        else if (!out.has(entry.oid)) out.set(entry.oid, child);
      }
    };
    for (const oid of commits.keys()) {
      const object = repo.objects.get(oid);
      if (!object) continue;
      out.set(oid, object);
      const commit = parseCommit(object.data);
      visitTree(commit.tree);
    }
    return out;
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    // Depth-first walk from the descendant with early exit: a fast-forward push
    // of one commit finds its parent in two steps, instead of a full BFS over
    // the whole history on every push.
    const visited = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const commit = this.commitOf(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    return false;
  }

  /** The merge-base: the common ancestor at the greatest depth from the two tips. */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const fromA = this.reachableCommits(repo, [a]);
    const fromB = this.reachableCommits(repo, [b]);
    let best: string | undefined;
    let bestDepth = -1;
    for (const [oid, depthA] of fromA) {
      const depthB = fromB.get(oid);
      if (depthB === undefined) continue;
      const depth = Math.min(depthA, depthB);
      if (depth > bestDepth) {
        bestDepth = depth;
        best = oid;
      }
    }
    return best;
  }

  /** Flatten a commit's tree to path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const tree = repo.objects.get(oid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree from a flat path map; returns the root tree oid. */
  buildTreeFromMap(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, value] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i]!;
        let child = node.dirs.get(part);
        if (!child) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1]!, value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      const { oid, object } = makeTree(entries);
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      return oid;
    };
    return build(root);
  }

  /** Line-diff counts by multiset difference (small files; additions >= 1 for real changes). */
  static lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const countLines = (text: string): Map<string, number> => {
      const map = new Map<string, number>();
      if (text === '') return map;
      for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
      return map;
    };
    const oldLines = countLines(oldText);
    const newLines = countLines(newText);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of newLines) additions += Math.max(0, count - (oldLines.get(line) ?? 0));
    for (const [line, count] of oldLines) deletions += Math.max(0, count - (newLines.get(line) ?? 0));
    return { additions, deletions };
  }

  /** Diff two trees (by oid) into per-file changes. */
  diffTrees(repo: Repo, baseTreeOid: string | undefined, headTreeOid: string | undefined): FileChange[] {
    const base = baseTreeOid ? this.flattenTree(repo, baseTreeOid) : new Map<string, { oid: string; mode: string }>();
    const head = headTreeOid ? this.flattenTree(repo, headTreeOid) : new Map<string, { oid: string; mode: string }>();
    const changes: FileChange[] = [];
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const { deletions } = Forge.lineDiff(oldText, '');
        changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!b && h) {
        const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const { additions } = Forge.lineDiff('', newText);
        changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b && h && b.oid !== h.oid) {
        const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const { additions, deletions } = Forge.lineDiff(oldText, newText);
        changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return changes;
  }

  // ---- contents API core ----

  /** Commit a file write/delete on `branch`. Returns the new commit + blob oid. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
    expectedSha?: string,
  ): { commitOid: string; blobOid: string | null; status: 'created' | 'updated' } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const isUpdate = tip !== undefined && this.fileAt(repo, tip, path) !== undefined;
    if (tip !== undefined) {
      const current = this.fileAt(repo, tip, path);
      if (expectedSha !== undefined) {
        if (current?.oid !== expectedSha) {
          const err = new Error('stale sha') as Error & { code?: string };
          err.code = 'STALE_SHA';
          throw err;
        }
      }
    } else if (expectedSha !== undefined) {
      const err = new Error('stale sha') as Error & { code?: string };
      err.code = 'STALE_SHA';
      throw err;
    }
    let files = new Map<string, { oid: string; mode: string }>();
    if (tip !== undefined) {
      const commit = this.commitOf(repo, tip);
      if (commit) files = this.flattenTree(repo, commit.tree);
    }
    let blobOid: string | null = null;
    if (content === null) {
      files.delete(path);
    } else {
      const { oid, object } = makeBlob(content);
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      blobOid = oid;
      files.set(path, { oid, mode: '100644' });
    }
    const treeOid = this.buildTreeFromMap(repo, files);
    const { oid: commitOid, object } = makeCommit({
      tree: treeOid,
      parents: tip !== undefined ? [tip] : [],
      author: '',
      committer: '',
      message,
    });
    if (!repo.objects.has(commitOid)) repo.objects.set(commitOid, object);
    this.setRef(repo, ref, commitOid);
    return { commitOid, blobOid, status: isUpdate ? 'updated' : 'created' };
  }

  fileAt(repo: Repo, commitOid: string, path: string): { oid: string; mode: string } | undefined {
    const commit = this.commitOf(repo, commitOid);
    if (!commit) return undefined;
    return this.flattenTree(repo, commit.tree).get(path);
  }

  /** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid. */
  resolveRefish(repo: Repo, refish: string | undefined): string | undefined {
    if (refish === undefined || refish === '') return this.defaultTip(repo);
    if (isObjectId(refish)) return repo.objects.has(refish) ? refish : undefined;
    if (refish.startsWith('refs/')) return repo.refs.get(refish);
    return repo.refs.get(`refs/heads/${refish}`);
  }

  // ---- issues / pulls ----

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: this.nextObjectId++,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.nextSeq(),
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    const number = repo.nextNumber++;
    const pull: Pull = {
      id: this.nextObjectId++,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      seq: this.nextSeq(),
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** Three-way merge of `headTip` onto `baseTip`; returns the merge commit or a conflict. */
  mergePullRequest(repo: Repo, pull: Pull, method: 'squash' | 'merge' | 'rebase'): { commitOid: string } | { conflict: string[] } {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return { conflict: ['missing ref'] };
    const baseCommitOid = this.mergeBase(repo, headTip, baseTip) ?? pull.baseSha;
    const baseCommit = this.commitOf(repo, baseCommitOid);
    const headCommit = this.commitOf(repo, headTip);
    const defaultCommit = this.commitOf(repo, baseTip);
    if (!baseCommit || !headCommit || !defaultCommit) return { conflict: ['missing commit'] };
    const baseFiles = this.flattenTree(repo, baseCommit.tree);
    const headFiles = this.flattenTree(repo, headCommit.tree);
    const defaultFiles = this.flattenTree(repo, defaultCommit.tree);
    const merged = new Map<string, { oid: string; mode: string }>(defaultFiles);
    const conflicts: string[] = [];
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...defaultFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      const d = defaultFiles.get(path);
      const same = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
      if (same(h, d)) continue; // no change, or the same change on both sides
      if (same(h, b)) continue; // only the default side changed; keep default
      if (same(d, b)) {
        // only the head side changed; take it
        if (h) merged.set(path, h);
        else merged.delete(path);
        continue;
      }
      conflicts.push(path);
    }
    if (conflicts.length > 0) return { conflict: conflicts };
    const treeOid = this.buildTreeFromMap(repo, merged);
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const { oid: commitOid, object } = makeCommit({
      tree: treeOid,
      parents,
      author: '',
      committer: '',
      message: `Merge pull request #${pull.number} from ${pull.headRef}`,
    });
    if (!repo.objects.has(commitOid)) repo.objects.set(commitOid, object);
    this.setRef(repo, `refs/heads/${pull.baseRef}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO_TIME;
    pull.mergeCommitSha = commitOid;
    pull.baseSha = commitOid;
    return { commitOid };
  }

  /** MERGEABLE / CONFLICTING for an open pull request (UNKNOWN when refs are missing). */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    const baseCommitOid = this.mergeBase(repo, headTip, baseTip) ?? pull.baseSha;
    const baseCommit = this.commitOf(repo, baseCommitOid);
    const headCommit = this.commitOf(repo, headTip);
    const defaultCommit = this.commitOf(repo, baseTip);
    if (!baseCommit || !headCommit || !defaultCommit) return 'UNKNOWN';
    const baseFiles = this.flattenTree(repo, baseCommit.tree);
    const headFiles = this.flattenTree(repo, headCommit.tree);
    const defaultFiles = this.flattenTree(repo, defaultCommit.tree);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...defaultFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      const d = defaultFiles.get(path);
      if (same(h, d) || same(h, b) || same(d, b)) continue;
      return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }
}
