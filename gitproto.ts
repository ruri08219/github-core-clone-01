// gitproto.ts — the smart-HTTP wire: pkt-lines, packfiles, upload-pack and receive-pack.
//
// The server speaks protocol v2 for upload-pack (when the client asks with
// `Git-Protocol: version=2`) and protocol v0 for receive-pack and for v0 clients.
// Packs are written without deltas: every object is a whole zlib stream, which keeps
// the pack builder a straight line and the trailer a single SHA-1. The client never
// sends deltas either, but the reader resolves OFS_DELTA and REF_DELTA anyway so a
// delta-carrying push cannot corrupt the store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync as zlibInflate } from 'node:zlib';
import type { ForgeStore, GitObject, GitObjectType, Repo } from './store.ts';
import {
  ZERO_OID,
  hashObject,
  isOid,
  parseTag,
} from './store.ts';

const PKT_MAX = 65520;
const AGENT = 'forge/1.0';
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export type PktKind = 'flush' | 'delim' | 'response-end' | 'data';
export interface Pkt {
  kind: PktKind;
  payload?: Buffer;
}

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new Error('pkt-line payload too large');
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

/** Decode a whole buffer of pkt-lines. Throws on a malformed header. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line payload');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

/** Split a receive-pack body into its command pkt-lines and the trailing pack bytes. */
function splitCommands(buf: Buffer): { lines: Pkt[]; pack: Buffer } {
  let offset = 0;
  const lines: Pkt[] = [];
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      lines.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length < 4 || length > PKT_MAX || offset + length > buf.length) throw new Error('bad pkt-line in command list');
    lines.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { lines, pack: buf.subarray(offset) };
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function writePackHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from whole objects (no deltas). The trailer is SHA-1 over the rest. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    parts.push(writePackHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and the next offset. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  const result = zlibInflate(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a packfile and resolve every object, including OFS_DELTA and REF_DELTA.
 * `lookup` supplies a base a thin pack leaves out. Throws on any corruption.
 */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: Buffer;
    resolvedType?: GitObjectType;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declared; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry has no size header');
    let byte = pack[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
      byte = pack[offset];
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        byte = pack[offset++];
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${value}`);
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = lookup?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

/** All refs, sorted: heads first, then tags, then the rest. */
function sortedRefs(repo: Repo): Array<{ oid: string; name: string }> {
  const out: Array<{ oid: string; name: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ oid, name });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack'): string {
  if (service === 'git-receive-pack') return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  return `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`;
}

/** A v0 ref advertisement: service line, flush, ref lines, flush. */
export function v0Advertisement(store: ForgeStore, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = v0Capabilities(service);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} HEAD\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headTip ?? refs[0].oid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      // Peeled tag lines, for annotated tags.
      const stored = store.getObject(ref.oid);
      if (stored?.type === 'tag') {
        const target = parseTag(stored.data).object;
        parts.push(pktLine(`${target} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: identical for every repository, built once. */
let v2AdvertisementCache: Buffer | null = null;
export function v2Advertisement(): Buffer {
  if (v2AdvertisementCache !== null) return v2AdvertisementCache;
  v2AdvertisementCache = Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
  return v2AdvertisementCache;
}

// ---------------------------------------------------------------------------
// sideband framing
// ---------------------------------------------------------------------------

/** Wrap pack bytes in band-1 sideband packets (each pkt-line holds at most 65515 data bytes). */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const piece = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function gitResult(body: Buffer, service: 'git-upload-pack' | 'git-receive-pack'): GitResponse {
  return { status: 200, contentType: `application/x-${service}-result`, body };
}

/** The refs a v2 ls-refs answers, in git's order: HEAD first, then sorted refs. */
function lsRefsLines(store: ForgeStore, repo: Repo, options: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): string[] {
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const keep = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  const headTip = repo.refs.get('refs/heads/main');
  if (options.symrefs && keep('HEAD')) {
    if (headTip !== undefined) lines.push(`${headTip} HEAD symref-target:refs/heads/main`);
    else if (options.unborn) lines.push(`unborn HEAD symref-target:refs/heads/main`);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (options.peel) {
      const object = store.getObject(ref.oid);
      if (object?.type === 'tag') line += ` peeled:${parseTag(object.data).object}`;
    }
    lines.push(line);
  }
  return lines;
}

function handleLsRefs(store: ForgeStore, repo: Repo, lines: Pkt[]): GitResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let seenDelim = false;
  for (const pkt of lines) {
    if (pkt.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (pkt.kind !== 'data' || !pkt.payload) continue;
    const text = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue; // command + agent/object-format lines before the delim
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const out: Buffer[] = [];
  for (const line of lsRefsLines(store, repo, { peel, symrefs, unborn, prefixes })) out.push(pktLine(`${line}\n`));
  out.push(pktFlush());
  return gitResult(Buffer.concat(out), 'git-upload-pack');
}

function fetchPackFor(store: ForgeStore, repo: Repo, options: {
  wants: string[];
  haves: string[];
  depth?: number;
  shallow: string[];
}): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = `${repo.id}|${[...options.wants].sort().join(',')}|${[...options.haves].sort().join(',')}|${options.depth ?? ''}|${[...options.shallow].sort().join(',')}`;
  const cached = repo.fetchCache.get(key);
  if (cached !== undefined) return cached;
  const computed = store.fetchObjects({
    wants: options.wants,
    haves: options.haves,
    depth: options.depth,
    shallow: options.shallow,
  });
  const objects = [...computed.objects.values()];
  objects.sort((a, b) => {
    const rank = (type: GitObjectType): number => (type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'tag' ? 2 : 3);
    const ra = rank(a.type);
    const rb = rank(b.type);
    if (ra !== rb) return ra - rb;
    return 0;
  });
  const pack = writePack(objects);
  const result = { pack, shallow: computed.shallow, unshallow: computed.unshallow };
  if (repo.fetchCache.size > 16) repo.fetchCache.clear();
  repo.fetchCache.set(key, result);
  return result;
}

function handleFetchV2(store: ForgeStore, repo: Repo, lines: Pkt[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let seenDelim = false;
  for (const pkt of lines) {
    if (pkt.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (pkt.kind !== 'data' || !pkt.payload) continue;
    const text = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue;
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7), 10);
  }
  const validWants = wants.filter((oid) => isOid(oid) && store.getObject(oid) !== undefined);
  const { pack, shallow: outShallow, unshallow } = fetchPackFor(store, repo, {
    wants: validWants,
    haves: haves.filter(isOid),
    depth: Number.isFinite(depth) ? depth : undefined,
    shallow: shallow.filter(isOid),
  });
  const parts: Buffer[] = [
    pktLine('acknowledgments\n'),
    pktLine('NAK\n'),
    pktFlush(),
  ];
  if (outShallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of outShallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return gitResult(Buffer.concat(parts), 'git-upload-pack');
}

function handleFetchV0(store: ForgeStore, repo: Repo, lines: Pkt[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let section = 0;
  for (const pkt of lines) {
    if (pkt.kind === 'flush') {
      section += 1;
      continue;
    }
    if (pkt.kind !== 'data' || !pkt.payload) continue;
    const text = pkt.payload.toString('utf8').replace(/\n$/, '');
    const firstSpace = text.indexOf(' ');
    const word = firstSpace < 0 ? text : text.slice(0, firstSpace);
    if (word === 'want') wants.push(text.slice(5).trim().split(' ')[0]);
    else if (word === 'have') haves.push(text.slice(5).trim());
    else if (word === 'shallow') shallow.push(text.slice(8).trim());
    else if (word === 'deepen') depth = Number.parseInt(text.slice(7), 10);
  }
  const validWants = wants.filter((oid) => isOid(oid) && store.getObject(oid) !== undefined);
  const { pack, shallow: outShallow, unshallow } = fetchPackFor(store, repo, {
    wants: validWants,
    haves: haves.filter(isOid),
    depth: Number.isFinite(depth) ? depth : undefined,
    shallow: shallow.filter(isOid),
  });
  const parts: Buffer[] = [];
  for (const oid of outShallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return gitResult(Buffer.concat(parts), 'git-upload-pack');
}

/** POST /{owner}/{repo}.git/git-upload-pack. `v2` when the client asked for version 2. */
export function handleUploadPack(store: ForgeStore, repo: Repo, body: Buffer, v2: boolean): GitResponse {
  let lines: Pkt[];
  try {
    lines = decodePktLines(body);
  } catch (err) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `malformed pkt-line: ${err instanceof Error ? err.message : String(err)}` }), 'utf8') };
  }
  if (!v2) return handleFetchV0(store, repo, lines);
  const first = lines.find((pkt) => pkt.kind === 'data')?.payload?.toString('utf8') ?? '';
  if (first.startsWith('command=ls-refs')) return handleLsRefs(store, repo, lines);
  if (first.startsWith('command=fetch')) return handleFetchV2(store, repo, lines);
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `unknown v2 command ${JSON.stringify(first.trim())}` }), 'utf8') };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack. */
export function handleReceivePack(store: ForgeStore, repo: Repo, body: Buffer): GitResponse {
  let split: { lines: Pkt[]; pack: Buffer };
  try {
    split = splitCommands(body);
  } catch (err) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `malformed pkt-line: ${err instanceof Error ? err.message : String(err)}` }), 'utf8') };
  }
  const commands: PushCommand[] = [];
  for (const pkt of split.lines) {
    if (pkt.kind !== 'data' || !pkt.payload) continue;
    const text = pkt.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const head = (nul < 0 ? text : text.slice(0, nul)).replace(/\n$/, '');
    const parts = head.split(' ');
    if (parts.length < 3 || !isOid(parts[0]) || !isOid(parts[1])) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'no push commands' }), 'utf8') };
  }

  // Unpack first: a refused update still unpacks, and a corrupt pack unpacks nothing.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (split.pack.length > 0) {
    try {
      const objects = readPack(split.pack, (oid) => store.getObject(oid));
      for (const [oid, object] of objects) {
        if (!store.objects.has(oid)) store.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} remote ref does not exist`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists`);
        } else if (store.getObject(command.newOid) === undefined) {
          reportLines.push(`ng ${command.ref} missing object`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      // Update: the old tip must match and the new tip must descend from it.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist`);
      } else if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else if (store.getObject(command.newOid) === undefined) {
        reportLines.push(`ng ${command.ref} missing object`);
      } else if (!store.isAncestor(command.oldOid, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      }
    }
    if (reportLines.some((line) => line.startsWith('ok '))) store.bumpRefs(repo);
  }

  const parts: Buffer[] = [];
  for (const line of reportLines) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(`${line}\n`)])));
  }
  parts.push(pktFlush());
  return gitResult(Buffer.concat(parts), 'git-receive-pack');
}
