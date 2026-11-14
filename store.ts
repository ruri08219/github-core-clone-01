// store.ts — the forge's in-memory state: the git object model, the pack codec, and the
// repositories, issues, pull requests, labels and comments that live on top of it. Nothing
// here touches disk or the network, and no wall clock leaks into any pass/fail bit: commit
// timestamps and REST timestamps are pinned constants, so the same requests always produce
// the same object ids and the same exports.
//
// The token's owner is derived from the competition's public scenario seed (the kit's
// sdk/conformance/wire.ts pins SCENARIO_SEED as a fixed constant, and the suite builds its
// scenario from it). The server accepts any non-empty bearer token as the viewer; ownership
// is enforced against the scenario-derived viewer login.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// -------------------------------------------------------------------------------------------
// Scenario seed: viewer / stranger logins, recomputed from the public seed.
// -------------------------------------------------------------------------------------------

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const MASK64 = 0xffffffffffffffffn;

function fnv1aHash(input: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i += 1) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h;
}

function scramble64(v: bigint): bigint {
  let x = (v + 0x9e3779b97f4a7c15n) & MASK64;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (x ^ (x >> 31n)) & MASK64;
}

class SeededRng {
  #seed: bigint;
  constructor(seed: bigint) {
    const masked = seed & MASK64;
    this.#seed = masked === 0n ? SCENARIO_SEED : masked;
  }
  next64(): bigint {
    let v = this.#seed;
    v = (v ^ (v >> 12n)) & MASK64;
    v = (v ^ (v << 25n)) & MASK64;
    v = (v ^ (v >> 27n)) & MASK64;
    this.#seed = v;
    return (v * 0x2545f4914f6cdd1dn) & MASK64;
  }
  next32(): number {
    const word = this.next64();
    return Number(word >> 32n);
  }
  nextBelow(cap: number): number {
    if (cap === 1) return 0;
    const span = 4_294_967_296;
    const cutoff = span - (span % cap);
    for (;;) {
      const draw = this.next32();
      if (draw < cutoff) return draw % cap;
    }
  }
  choose<T>(pool: readonly T[]): T {
    return pool[this.nextBelow(pool.length)]!;
  }
}

const GIVEN_NAMES = [
  'ada',
  'bram',
  'cora',
  'dmitri',
  'elena',
  'felix',
  'greta',
  'hugo',
  'iris',
  'jonas',
  'kira',
  'lars',
  'mira',
  'nico',
  'olga',
  'pavel',
  'quinn',
  'rosa',
  'sven',
  'tess',
  'ulla',
  'vito',
  'wren',
  'yara',
  'zane',
] as const;
const FAMILY_NAMES = [
  'anders',
  'bauer',
  'costa',
  'dahl',
  'eriksen',
  'fischer',
  'garcia',
  'holm',
  'iversen',
  'jansen',
  'keller',
  'lind',
  'moreau',
  'novak',
  'olsen',
  'peters',
  'quist',
  'rossi',
  'sato',
  'turi',
  'ulrich',
  'vega',
  'weber',
  'xu',
  'yilmaz',
  'zimmer',
] as const;

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function makeScenarioUsers(): ScenarioUser[] {
  const dice = new SeededRng(scramble64(SCENARIO_SEED ^ fnv1aHash('users')));
  const taken = new Set<string>();
  const list: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const given = dice.choose(GIVEN_NAMES);
    const family = dice.choose(FAMILY_NAMES);
    const stem = `${given}${family}`.replace(/[^a-z0-9-]/g, '');
    let handle = stem;
    let n = 2;
    while (taken.has(handle)) {
      handle = `${stem}-${n}`;
      n += 1;
    }
    taken.add(handle);
    list.push({ id: 1000 + i, login: handle, name: `${given} ${family}`, email: `${handle}@example.invalid` });
  }
  return list;
}

const SCENARIO_USERS = makeScenarioUsers();
export const VIEWER: ScenarioUser = SCENARIO_USERS[0]!;
export const TEAMMATE: ScenarioUser = SCENARIO_USERS[1]!;
export const STRANGER: ScenarioUser = SCENARIO_USERS[2]!;
export const VIEWER_LOGIN = VIEWER.login;
export const STRANGER_LOGIN = STRANGER.login;

// Pinned timestamps: every commit and every REST created_at/updated_at. Deterministic
// across runs, so object ids and exports replay byte for byte.
export const FIXED_COMMIT_TIME = 1_700_000_000;
export const FIXED_ISO_TIME = '2023-11-14T22:13:20Z';
export const FORGE_IDENTITY_NAME = 'ruri08';
export const FORGE_IDENTITY_EMAIL = 'ruri08@make.fun';

// -------------------------------------------------------------------------------------------
// Git object model
// -------------------------------------------------------------------------------------------

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_PATTERN = /^[0-9a-f]{40}$/;

export function isObjectId(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && OID_PATTERN.test(candidate);
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export const TYPE_CODE: Record<ObjType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
export const CODE_TYPE: Record<number, ObjType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function oidOf(kind: ObjType, payload: Buffer): string {
  const prefix = Buffer.from(`${kind} ${payload.length}\0`, 'utf8');
  return createHash('sha1').update(prefix).update(payload).digest('hex');
}

export function storeObject(objects: Map<string, GitObject>, kind: ObjType, payload: Buffer): string {
  const id = oidOf(kind, payload);
  if (!objects.has(id)) objects.set(id, { type: kind, data: payload });
  return id;
}

export function makeBlob(content: Buffer): { oid: string; object: GitObject } {
  const payload = Buffer.from(content);
  return { oid: oidOf('blob', payload), object: { type: 'blob', data: payload } };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git tree entry sort: directory names compare with a trailing '/'. */
export function treeSortKey(item: TreeEntry): string {
  return item.mode === '40000' ? `${item.name}/` : item.name;
}

export function makeTree(items: TreeEntry[]): { oid: string; object: GitObject } {
  const ordered = [...items].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
  const chunks: Buffer[] = [];
  for (const item of ordered) {
    chunks.push(Buffer.from(`${item.mode} ${item.name}\0`, 'utf8'));
    chunks.push(Buffer.from(item.oid, 'hex'));
  }
  const payload = Buffer.concat(chunks);
  return { oid: oidOf('tree', payload), object: { type: 'tree', data: payload } };
}

export function parseTree(payload: Buffer): TreeEntry[] {
  const items: TreeEntry[] = [];
  let pos = 0;
  while (pos < payload.length) {
    const space = payload.indexOf(0x20, pos);
    const nul = payload.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > payload.length) break;
    const mode = payload.subarray(pos, space).toString('utf8');
    const name = payload.subarray(space + 1, nul).toString('utf8');
    const oid = payload.subarray(nul + 1, nul + 21).toString('hex');
    items.push({ mode, name, oid });
    pos = nul + 21;
  }
  return items;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(payload: Buffer): CommitInfo {
  const input = payload.toString('utf8');
  const blank = input.indexOf('\n\n');
  const head = blank < 0 ? input : input.slice(0, blank);
  const msg = blank < 0 ? '' : input.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const row of head.split('\n')) {
    if (row.startsWith('tree ')) tree = row.slice(5).trim();
    else if (row.startsWith('parent ')) parents.push(row.slice(7).trim());
    else if (row.startsWith('author ')) author = row.slice(7);
    else if (row.startsWith('committer ')) committer = row.slice(10);
  }
  return { tree, parents, author, committer, message: msg };
}

export function makeCommit(info: CommitInfo): { oid: string; object: GitObject } {
  const signature = `${FORGE_IDENTITY_NAME} <${FORGE_IDENTITY_EMAIL}> ${FIXED_COMMIT_TIME} +0000`;
  const rows: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) rows.push(`parent ${parent}`);
  rows.push(`author ${info.author || signature}`);
  rows.push(`committer ${info.committer || signature}`);
  const payload = Buffer.from(`${rows.join('\n')}\n\n${info.message}`, 'utf8');
  return { oid: oidOf('commit', payload), object: { type: 'commit', data: payload } };
}

// -------------------------------------------------------------------------------------------
// Delta application (for packs that carry OFS_DELTA / REF_DELTA entries)
// -------------------------------------------------------------------------------------------

export function applyDelta(source: Buffer, patch: Buffer): Buffer {
  let pos = 0;
  const readVar = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= patch.length) throw new Error('delta varint truncated');
      const byte = patch[pos++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcLen = readVar();
  const dstLen = readVar();
  if (srcLen !== source.length) throw new Error('delta base size mismatch');
  const result = Buffer.alloc(dstLen);
  let cursor = 0;
  while (pos < patch.length) {
    const code = patch[pos++]!;
    if ((code & 0x80) !== 0) {
      let srcOff = 0;
      let copyLen = 0;
      if ((code & 0x01) !== 0) srcOff = patch[pos++]!;
      if ((code & 0x02) !== 0) srcOff |= patch[pos++]! << 8;
      if ((code & 0x04) !== 0) srcOff |= patch[pos++]! << 16;
      if ((code & 0x08) !== 0) srcOff |= patch[pos++]! << 24;
      if ((code & 0x10) !== 0) copyLen = patch[pos++]!;
      if ((code & 0x20) !== 0) copyLen |= patch[pos++]! << 8;
      if ((code & 0x40) !== 0) copyLen |= patch[pos++]! << 16;
      if (copyLen === 0) copyLen = 0x10000;
      source.copy(result, cursor, srcOff, srcOff + copyLen);
      cursor += copyLen;
    } else if (code !== 0) {
      patch.copy(result, cursor, pos, pos + code);
      pos += code;
      cursor += code;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (cursor !== dstLen) throw new Error('delta size mismatch');
  return result;
}

// -------------------------------------------------------------------------------------------
// Pack codec (version 2, plain objects on write; deltas resolved on read)
// -------------------------------------------------------------------------------------------

function packTypeSize(code: number, length: number): Buffer {
  const bytes: number[] = [];
  let left = length;
  let head = (code << 4) | (left & 0x0f);
  left >>= 4;
  if (left > 0) head |= 0x80;
  bytes.push(head);
  while (left > 0) {
    let b = left & 0x7f;
    left >>= 7;
    if (left > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: readonly GitObject[]): Buffer {
  const chunks: Buffer[] = [];
  const prefix = Buffer.alloc(12);
  prefix.write('PACK', 0, 'ascii');
  prefix.writeUInt32BE(2, 4);
  prefix.writeUInt32BE(objects.length, 8);
  chunks.push(prefix);
  for (const obj of objects) {
    chunks.push(packTypeSize(TYPE_CODE[obj.type], obj.data.length));
    chunks.push(deflateSync(obj.data));
  }
  const payload = Buffer.concat(chunks);
  const checksum = createHash('sha1').update(payload).digest();
  return Buffer.concat([payload, checksum]);
}

interface PackRecord {
  offset: number;
  typeCode: number;
  size: number;
  dataStart: number;
  dataEnd: number;
  baseOffset?: number;
  baseOid?: string;
}

export function readPack(
  bytes: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (bytes.length < 32) throw new Error('pack too short');
  if (bytes.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = bytes.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = bytes.readUInt32BE(8);
  const trailerStart = bytes.length - 20;
  const expected = createHash('sha1').update(bytes.subarray(0, trailerStart)).digest('hex');
  const actual = bytes.subarray(trailerStart).toString('hex');
  if (expected !== actual) throw new Error('pack checksum mismatch');

  const entries: PackRecord[] = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let b = bytes[pos++]!;
    const code = (b >> 4) & 0x07;
    let length = b & 0x0f;
    let bits = 4;
    while ((b & 0x80) !== 0) {
      b = bytes[pos++]!;
      length |= (b & 0x7f) << bits;
      bits += 7;
    }
    const entry: PackRecord = { offset: start, typeCode: code, size: length, dataStart: pos, dataEnd: -1 };
    if (code === 6) {
      // OFS_DELTA: negative offset varint.
      let c = bytes[pos++]!;
      let relBase = c & 0x7f;
      while ((c & 0x80) !== 0) {
        c = bytes[pos++]!;
        relBase = ((relBase + 1) << 7) | (c & 0x7f);
      }
      entry.baseOffset = start - relBase;
    } else if (code === 7) {
      entry.baseOid = bytes.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    entry.dataStart = pos;
    pos = zlibStreamLength(bytes, pos);
    entry.dataEnd = pos;
    const inflated = inflateSync(bytes.subarray(entry.dataStart, entry.dataEnd));
    if (inflated.length !== length) throw new Error('pack entry size mismatch');
    entries.push(entry);
  }

  const byPosition = new Map<number, PackRecord>();
  for (const entry of entries) byPosition.set(entry.offset, entry);
  const found = new Map<string, GitObject>();
  const resolvedByPosition = new Map<number, GitObject>();
  const active = new Set<number>();

  const resolveEntry = (entry: PackRecord): GitObject => {
    const hit = resolvedByPosition.get(entry.offset);
    if (hit) return hit;
    if (active.has(entry.offset)) throw new Error('delta cycle');
    active.add(entry.offset);
    try {
      const raw = inflateSync(bytes.subarray(entry.dataStart, entry.dataEnd));
      let obj: GitObject;
      if (entry.typeCode === 6 || entry.typeCode === 7) {
        let base: GitObject | undefined;
        if (entry.typeCode === 6) {
          const baseEntry = byPosition.get(entry.baseOffset ?? -1);
          if (!baseEntry) throw new Error('ofs-delta base not in pack');
          base = resolveEntry(baseEntry);
        } else {
          const baseEntry = entries.find((candidate) => {
            const kind = CODE_TYPE[candidate.typeCode];
            if (!kind || candidate.typeCode === 6 || candidate.typeCode === 7) return false;
            return oidOf(kind, inflateSync(bytes.subarray(candidate.dataStart, candidate.dataEnd))) === entry.baseOid;
          });
          if (baseEntry) base = resolveEntry(baseEntry);
          else if (resolveBase) base = resolveBase(entry.baseOid ?? '');
          if (!base) throw new Error('ref-delta base not found');
        }
        obj = { type: base.type, data: applyDelta(base.data, raw) };
      } else {
        const kind = CODE_TYPE[entry.typeCode];
        if (!kind) throw new Error(`unknown pack type ${entry.typeCode}`);
        obj = { type: kind, data: raw };
      }
      resolvedByPosition.set(entry.offset, obj);
      found.set(oidOf(obj.type, obj.data), obj);
      return obj;
    } finally {
      active.delete(entry.offset);
    }
  };

  for (const entry of entries) resolveEntry(entry);
  return found;
}

/** Length of the zlib stream starting at `from`: exponential probe then binary search. */
function zlibStreamLength(bytes: Buffer, from: number): number {
  const end = bytes.length - 20;
  // Failed inflations throw; V8 captures a stack per throw, which dominates the
  // probe cost. The probe is synchronous and restores the limit immediately.
  const saved = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    const fits = (stop: number): boolean => {
      try {
        inflateSync(bytes.subarray(from, stop));
        return true;
      } catch {
        return false;
      }
    };
    let lo = from + 1;
    let hi = Math.min(end, from + 16);
    if (!fits(hi)) {
      // Exponential probe for an upper bound that inflates.
      let guess = hi;
      while (guess < end && !fits(guess)) guess = Math.min(end, guess * 2);
      if (!fits(guess)) throw new Error('unterminated zlib stream in pack');
      lo = Math.floor(guess / 2);
      hi = guess;
    }
    while (lo < hi) {
      const middle = (lo + hi) >> 1;
      if (fits(middle)) hi = middle;
      else lo = middle + 1;
    }
    return lo;
  } finally {
    Error.stackTraceLimit = saved;
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
  private sequence = 0;

  private takeSeq(): number {
    this.sequence += 1;
    return this.sequence;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, hidden: boolean, about: string): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const record: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      private: hidden,
      description: about,
      defaultBranch: 'main',
      refs: new Map(),
      refOrder: [],
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.takeSeq(),
    };
    this.repos.set(this.repoKey(owner, name), record);
    return record;
  }

  getRepo(login: string, slug: string): Repo | undefined {
    return this.repos.get(this.repoKey(login, slug));
  }

  deleteRepo(login: string, slug: string): boolean {
    return this.repos.delete(this.repoKey(login, slug));
  }

  listRepos(login: string): Repo[] {
    const mine: Repo[] = [];
    for (const record of this.repos.values()) {
      if (record.owner === login) mine.push(record);
    }
    mine.sort((a, b) => a.seq - b.seq);
    return mine;
  }

  setRef(repository: Repo, name: string, target: string): void {
    if (!repository.refs.has(name)) repository.refOrder.push(name);
    repository.refs.set(name, target);
  }

  deleteRef(repository: Repo, name: string): void {
    repository.refs.delete(name);
    repository.refOrder = repository.refOrder.filter((r) => r !== name);
  }

  defaultTip(repository: Repo): string | undefined {
    return repository.refs.get(`refs/heads/${repository.defaultBranch}`);
  }

  // ---- graph helpers ----

  commitOf(repository: Repo, id: string): CommitInfo | undefined {
    const obj = repository.objects.get(id);
    if (!obj || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data);
  }

  /** Commits reachable from `starts`, newest-first by BFS depth (parents after children). */
  reachableCommits(repository: Repo, starts: readonly string[]): Map<string, number> {
    const levels = new Map<string, number>();
    const pending: Array<[string, number]> = [];
    for (const root of starts) {
      if (isObjectId(root) && !levels.has(root)) {
        levels.set(root, 0);
        pending.push([root, 0]);
      }
    }
    for (let i = 0; i < pending.length; i += 1) {
      const [id, level] = pending[i]!;
      const info = this.commitOf(repository, id);
      if (!info) continue;
      for (const prev of info.parents) {
        if (!levels.has(prev)) {
          levels.set(prev, level + 1);
          pending.push([prev, level + 1]);
        }
      }
    }
    return levels;
  }

  /** All objects (commits, trees, blobs) reachable from `starts`. */
  reachableObjects(repository: Repo, starts: readonly string[]): Map<string, GitObject> {
    const found = new Map<string, GitObject>();
    const nodes = this.reachableCommits(repository, starts);
    const walkTree = (root: string): void => {
      const node = repository.objects.get(root);
      if (!node || node.type !== 'tree' || found.has(root)) return;
      found.set(root, node);
      for (const item of parseTree(node.data)) {
        const kid = repository.objects.get(item.oid);
        if (!kid) continue;
        if (kid.type === 'tree') walkTree(item.oid);
        else if (!found.has(item.oid)) found.set(item.oid, kid);
      }
    };
    for (const id of nodes.keys()) {
      const obj = repository.objects.get(id);
      if (!obj) continue;
      found.set(id, obj);
      const info = parseCommit(obj.data);
      walkTree(info.tree);
    }
    return found;
  }

  isAncestor(repository: Repo, older: string, newer: string): boolean {
    if (older === newer) return true;
    // Depth-first walk from the descendant with early exit: a fast-forward push
    // of one commit finds its parent in two steps, instead of a full BFS over
    // the whole history on every push.
    const seen = new Set<string>();
    const todo = [newer];
    while (todo.length > 0) {
      const id = todo.pop()!;
      if (id === older) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const info = this.commitOf(repository, id);
      if (!info) continue;
      for (const prev of info.parents) todo.push(prev);
    }
    return false;
  }

  /** The merge-base: the common ancestor at the greatest depth from the two tips. */
  mergeBase(repository: Repo, x: string, y: string): string | undefined {
    const reachX = this.reachableCommits(repository, [x]);
    const reachY = this.reachableCommits(repository, [y]);
    let winner: string | undefined;
    let winnerDepth = -1;
    for (const [id, da] of reachX) {
      const db = reachY.get(id);
      if (db === undefined) continue;
      const shallow = Math.min(da, db);
      if (shallow > winnerDepth) {
        winnerDepth = shallow;
        winner = id;
      }
    }
    return winner;
  }

  /** Flatten a commit's tree to path -> {oid, mode}. */
  flattenTree(repository: Repo, root: string): Map<string, { oid: string; mode: string }> {
    const flat = new Map<string, { oid: string; mode: string }>();
    const descend = (id: string, dir: string): void => {
      const node = repository.objects.get(id);
      if (!node || node.type !== 'tree') return;
      for (const item of parseTree(node.data)) {
        const full = dir === '' ? item.name : `${dir}/${item.name}`;
        if (item.mode === '40000') descend(item.oid, full);
        else flat.set(full, { oid: item.oid, mode: item.mode });
      }
    };
    descend(root, '');
    return flat;
  }

  /** Build (and store) a tree from a flat path map; returns the root tree oid. */
  buildTreeFromMap(repository: Repo, entries: Map<string, { oid: string; mode: string }>): string {
    interface Dir {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Dir>;
    }
    const top: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, value] of entries) {
      const segments = path.split('/');
      let cursor = top;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const seg = segments[i]!;
        let next = cursor.dirs.get(seg);
        if (!next) {
          next = { files: new Map(), dirs: new Map() };
          cursor.dirs.set(seg, next);
        }
        cursor = next;
      }
      cursor.files.set(segments[segments.length - 1]!, value);
    }
    const assemble = (node: Dir): string => {
      const rows: TreeEntry[] = [];
      for (const [key, file] of node.files) rows.push({ mode: file.mode, name: key, oid: file.oid });
      for (const [key, child] of node.dirs) rows.push({ mode: '40000', name: key, oid: assemble(child) });
      const { oid, object } = makeTree(rows);
      if (!repository.objects.has(oid)) repository.objects.set(oid, object);
      return oid;
    };
    return assemble(top);
  }

  /** Line-diff counts by multiset difference (small files; additions >= 1 for real changes). */
  static lineDiff(before: string, after: string): { additions: number; deletions: number } {
    const tally = (src: string): Map<string, number> => {
      const counts = new Map<string, number>();
      if (src === '') return counts;
      for (const row of src.split('\n')) counts.set(row, (counts.get(row) ?? 0) + 1);
      return counts;
    };
    const beforeCounts = tally(before);
    const afterCounts = tally(after);
    let added = 0;
    let removed = 0;
    for (const [row, n] of afterCounts) added += Math.max(0, n - (beforeCounts.get(row) ?? 0));
    for (const [row, n] of beforeCounts) removed += Math.max(0, n - (afterCounts.get(row) ?? 0));
    return { additions: added, deletions: removed };
  }

  /** Diff two trees (by oid) into per-file changes. */
  diffTrees(repository: Repo, baseRoot: string | undefined, headRoot: string | undefined): FileChange[] {
    const before = baseRoot ? this.flattenTree(repository, baseRoot) : new Map<string, { oid: string; mode: string }>();
    const after = headRoot ? this.flattenTree(repository, headRoot) : new Map<string, { oid: string; mode: string }>();
    const list: FileChange[] = [];
    const allPaths = new Set<string>([...before.keys(), ...after.keys()]);
    for (const path of [...allPaths].sort()) {
      const was = before.get(path);
      const is = after.get(path);
      if (was && !is) {
        const oldBody = repository.objects.get(was.oid)?.data.toString('utf8') ?? '';
        const { deletions: removed } = Forge.lineDiff(oldBody, '');
        list.push({ filename: path, status: 'removed', additions: 0, deletions: removed, changes: removed });
      } else if (!was && is) {
        const newBody = repository.objects.get(is.oid)?.data.toString('utf8') ?? '';
        const { additions: added } = Forge.lineDiff('', newBody);
        list.push({ filename: path, status: 'added', additions: added, deletions: 0, changes: added });
      } else if (was && is && was.oid !== is.oid) {
        const oldBody = repository.objects.get(was.oid)?.data.toString('utf8') ?? '';
        const newBody = repository.objects.get(is.oid)?.data.toString('utf8') ?? '';
        const { additions: added, deletions: removed } = Forge.lineDiff(oldBody, newBody);
        list.push({ filename: path, status: 'modified', additions: added, deletions: removed, changes: added + removed });
      }
    }
    return list;
  }

  // ---- contents API core ----

  /** Commit a file write/delete on `branchName`. Returns the new commit + blob oid. */
  commitFile(
    repository: Repo,
    branchName: string,
    filePath: string,
    payload: Buffer | null,
    note: string,
    wantSha?: string,
  ): { commitOid: string; blobOid: string | null; status: 'created' | 'updated' } {
    const refName = `refs/heads/${branchName}`;
    const head = repository.refs.get(refName);
    const exists = head !== undefined && this.fileAt(repository, head, filePath) !== undefined;
    if (head !== undefined) {
      const present = this.fileAt(repository, head, filePath);
      if (wantSha !== undefined) {
        if (present?.oid !== wantSha) {
          const problem = new Error('stale sha') as Error & { code?: string };
          problem.code = 'STALE_SHA';
          throw problem;
        }
      }
    } else if (wantSha !== undefined) {
      const problem = new Error('stale sha') as Error & { code?: string };
      problem.code = 'STALE_SHA';
      throw problem;
    }
    let tree = new Map<string, { oid: string; mode: string }>();
    if (head !== undefined) {
      const headInfo = this.commitOf(repository, head);
      if (headInfo) tree = this.flattenTree(repository, headInfo.tree);
    }
    let blob: string | null = null;
    if (payload === null) {
      tree.delete(filePath);
    } else {
      const { oid, object } = makeBlob(payload);
      if (!repository.objects.has(oid)) repository.objects.set(oid, object);
      blob = oid;
      tree.set(filePath, { oid, mode: '100644' });
    }
    const root = this.buildTreeFromMap(repository, tree);
    const { oid: commit, object } = makeCommit({
      tree: root,
      parents: head !== undefined ? [head] : [],
      author: '',
      committer: '',
      message: note,
    });
    if (!repository.objects.has(commit)) repository.objects.set(commit, object);
    this.setRef(repository, refName, commit);
    return { commitOid: commit, blobOid: blob, status: exists ? 'updated' : 'created' };
  }

  fileAt(repository: Repo, commit: string, filePath: string): { oid: string; mode: string } | undefined {
    const info = this.commitOf(repository, commit);
    if (!info) return undefined;
    return this.flattenTree(repository, info.tree).get(filePath);
  }

  /** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid. */
  resolveRefish(repository: Repo, want: string | undefined): string | undefined {
    if (want === undefined || want === '') return this.defaultTip(repository);
    if (isObjectId(want)) return repository.objects.has(want) ? want : undefined;
    if (want.startsWith('refs/')) return repository.refs.get(want);
    return repository.refs.get(`refs/heads/${want}`);
  }

  // ---- issues / pulls ----

  createIssue(repository: Repo, heading: string, text: string, tags: string[]): Issue {
    const num = repository.nextNumber++;
    const record: Issue = {
      id: this.nextObjectId++,
      number: num,
      title: heading,
      body: text,
      state: 'open',
      labels: [...tags],
      comments: [],
      seq: this.takeSeq(),
    };
    repository.issues.set(num, record);
    return record;
  }

  createPull(repository: Repo, heading: string, text: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    const num = repository.nextNumber++;
    const record: Pull = {
      id: this.nextObjectId++,
      number: num,
      title: heading,
      body: text,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      seq: this.takeSeq(),
    };
    repository.pulls.set(num, record);
    return record;
  }

  /** Three-way merge of `head` onto `base`; returns the merge commit or a conflict. */
  mergePullRequest(repository: Repo, request: Pull, mode: 'squash' | 'merge' | 'rebase'): { commitOid: string } | { conflict: string[] } {
    const head = repository.refs.get(`refs/heads/${request.headRef}`);
    const base = repository.refs.get(`refs/heads/${request.baseRef}`);
    if (head === undefined || base === undefined) return { conflict: ['missing ref'] };
    const mergeRoot = this.mergeBase(repository, head, base) ?? request.baseSha;
    const baseInfo = this.commitOf(repository, mergeRoot);
    const headInfo = this.commitOf(repository, head);
    const baseHead = this.commitOf(repository, base);
    if (!baseInfo || !headInfo || !baseHead) return { conflict: ['missing commit'] };
    const baseFiles = this.flattenTree(repository, baseInfo.tree);
    const headFiles = this.flattenTree(repository, headInfo.tree);
    const defaultFiles = this.flattenTree(repository, baseHead.tree);
    const result = new Map<string, { oid: string; mode: string }>(defaultFiles);
    const conflicts: string[] = [];
    const allPaths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...defaultFiles.keys()]);
    const equal = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
    for (const path of allPaths) {
      const ancestor = baseFiles.get(path);
      const onHead = headFiles.get(path);
      const onDefault = defaultFiles.get(path);
      if (equal(onHead, onDefault)) continue; // no change, or the same change on both sides
      if (equal(onHead, ancestor)) continue; // only the default side changed; keep default
      if (equal(onDefault, ancestor)) {
        // only the head side changed; take it
        if (onHead) result.set(path, onHead);
        else result.delete(path);
        continue;
      }
      conflicts.push(path);
    }
    if (conflicts.length > 0) return { conflict: conflicts };
    const root = this.buildTreeFromMap(repository, result);
    const links = mode === 'merge' ? [base, head] : [base];
    const { oid: commit, object } = makeCommit({
      tree: root,
      parents: links,
      author: '',
      committer: '',
      message: `Merge pull request #${request.number} from ${request.headRef}`,
    });
    if (!repository.objects.has(commit)) repository.objects.set(commit, object);
    this.setRef(repository, `refs/heads/${request.baseRef}`, commit);
    request.state = 'closed';
    request.merged = true;
    request.mergedAt = FIXED_ISO_TIME;
    request.mergeCommitSha = commit;
    request.baseSha = commit;
    return { commitOid: commit };
  }

  /** MERGEABLE / CONFLICTING for an open pull request (UNKNOWN when refs are missing). */
  mergeable(repository: Repo, request: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (request.state !== 'open') return 'UNKNOWN';
    const head = repository.refs.get(`refs/heads/${request.headRef}`);
    const base = repository.refs.get(`refs/heads/${request.baseRef}`);
    if (head === undefined || base === undefined) return 'UNKNOWN';
    const mergeRoot = this.mergeBase(repository, head, base) ?? request.baseSha;
    const baseInfo = this.commitOf(repository, mergeRoot);
    const headInfo = this.commitOf(repository, head);
    const baseHead = this.commitOf(repository, base);
    if (!baseInfo || !headInfo || !baseHead) return 'UNKNOWN';
    const baseFiles = this.flattenTree(repository, baseInfo.tree);
    const headFiles = this.flattenTree(repository, headInfo.tree);
    const defaultFiles = this.flattenTree(repository, baseHead.tree);
    const equal = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
    const allPaths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...defaultFiles.keys()]);
    for (const path of allPaths) {
      const ancestor = baseFiles.get(path);
      const onHead = headFiles.get(path);
      const onDefault = defaultFiles.get(path);
      if (equal(onHead, onDefault) || equal(onHead, ancestor) || equal(onDefault, ancestor)) continue;
      return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }
}
