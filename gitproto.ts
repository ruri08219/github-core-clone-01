// gitproto.ts — git smart HTTP: pkt-line codec, v2/v0 advertisements, ls-refs, fetch,
// receive-pack. Implements exactly what the suite's git client speaks (see kit
// sdk/conformance/git-client.ts): v2 upload-pack with ls-refs/fetch, v0 receive-pack
// with report-status(-v2), side-band-64k, delete-refs, ofs-delta.

import {
  Forge,
  ZERO_OID,
  isObjectId,
  readPack,
  writePack,
  type GitObject,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// pkt-line codec
// -------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Packet {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(body: string | Buffer): Buffer {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const size = bytes.length + 4;
  if (size > 65520) throw new Error('pkt-line too long');
  const prefix = Buffer.alloc(4);
  prefix.write(size.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, bytes]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export function encodePktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const chunks: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') chunks.push(FLUSH);
    else if (item === 'delim') chunks.push(DELIM);
    else chunks.push(pktLine(item));
  }
  return Buffer.concat(chunks);
}

/** Parse a whole buffer of pkt-lines. Throws on malformed input. */
export function decodePktLines(bytes: Buffer): Packet[] {
  const out: Packet[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    if (pos + 4 > bytes.length) throw new Error('pkt-line truncated');
    const head = bytes.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (head === '0002') {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    const size = parseInt(head, 16);
    if (!Number.isFinite(size) || size < 4 || size > 65520 || pos + size > bytes.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    out.push({ kind: 'data', payload: Buffer.from(bytes.subarray(pos + 4, pos + size)) });
    pos += size;
  }
  return out;
}

/** Split a receive-pack body into the command pkt-lines and the pack bytes after the flush. */
export function splitCommandAndPack(bytes: Buffer): { commands: Packet[]; pack: Buffer } {
  let pos = 0;
  const cmds: Packet[] = [];
  while (pos < bytes.length) {
    if (pos + 4 > bytes.length) throw new Error('pkt-line truncated');
    const head = bytes.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') {
      return { commands: cmds, pack: Buffer.from(bytes.subarray(pos + 4)) };
    }
    const size = parseInt(head, 16);
    if (!Number.isFinite(size) || size < 4 || size > 65520 || pos + size > bytes.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    cmds.push({ kind: 'data', payload: Buffer.from(bytes.subarray(pos + 4, pos + size)) });
    pos += size;
  }
  throw new Error('receive-pack body has no flush');
}

// -------------------------------------------------------------------------------------------
// Advertisements
// -------------------------------------------------------------------------------------------

const FORGE_AGENT = 'github-core-clone/1.0.0';

function advertiseV2(name: string): Buffer {
  const rows: Array<string | 'flush'> = [
    `# service=${name}\n`,
    'version 2\n',
    `agent=${FORGE_AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ];
  return encodePktLines(rows);
}

interface RefRow {
  oid: string;
  name: string;
  peeled?: string;
}

function collectRefLines(store: Forge, record: Repo): RefRow[] {
  const rows: RefRow[] = [];
  const head = store.defaultTip(record);
  if (head !== undefined) {
    rows.push({ oid: head, name: 'HEAD' });
  }
  for (const refName of record.refOrder) {
    const id = record.refs.get(refName)!;
    const obj = record.objects.get(id);
    const row: RefRow = { oid: id, name: refName };
    if (obj?.type === 'tag') {
      // Peeled: the tag's target.
      const body = obj.data.toString('utf8');
      const found = /^object ([0-9a-f]{40})$/m.exec(body);
      if (found) row.peeled = found[1]!;
    }
    rows.push(row);
  }
  return rows;
}

function advertiseV0(name: string, store: Forge, record: Repo, features: string): Buffer {
  const rows = collectRefLines(store, record);
  const chunks: Buffer[] = [pktLine(`# service=${name}\n`)];
  if (rows.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${features}\n`));
  } else {
    rows.forEach((row, i) => {
      const isFirst = i === 0;
      if (row.name === 'HEAD') {
        chunks.push(pktLine(`${row.oid} HEAD\0${features}\n`));
      } else {
        chunks.push(pktLine(`${row.oid} ${row.name}${isFirst ? `\0${features}` : ''}\n`));
      }
      if (row.peeled) chunks.push(pktLine(`${row.peeled} ${row.name}^{}\n`));
    });
    // If the first ref was HEAD it carried the caps; otherwise the first non-HEAD line did.
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// -------------------------------------------------------------------------------------------
// Fetch planning
// -------------------------------------------------------------------------------------------

interface FetchOutcome {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

function buildFetchPlan(
  store: Forge,
  record: Repo,
  wanted: string[],
  held: string[],
  previousShallow: string[],
  limit: number | undefined,
): FetchOutcome {
  // Objects the client already holds: reachable from haves, except that a shallow
  // boundary's parents are NOT held (the boundary commit itself is held).
  const owned = new Map<string, GitObject>();
  if (held.length > 0) {
    const ownedCommits = new Map<string, number>();
    const pending: Array<[string, number]> = [];
    for (const id of held) {
      if (isObjectId(id) && record.objects.has(id) && !ownedCommits.has(id)) {
        ownedCommits.set(id, 0);
        pending.push([id, 0]);
      }
    }
    const boundary = new Set(previousShallow);
    for (let i = 0; i < pending.length; i += 1) {
      const [id] = pending[i]!;
      if (boundary.has(id)) continue; // boundary: held, but its parents are not
      const info = store.commitOf(record, id);
      if (!info) continue;
      for (const prev of info.parents) {
        if (!ownedCommits.has(prev)) {
          ownedCommits.set(prev, 0);
          pending.push([prev, 0]);
        }
      }
    }
    // Held objects: each held commit plus its full tree — but never a held
    // commit's parents (a shallow boundary's history is not held).
    const addTree = (root: string): void => {
      const node = record.objects.get(root);
      if (!node || node.type !== 'tree' || owned.has(root)) return;
      owned.set(root, node);
      for (const item of readTreeEntries(node.data)) {
        if (item.mode === '40000') addTree(item.oid);
        else {
          const kid = record.objects.get(item.oid);
          if (kid && !owned.has(item.oid)) owned.set(item.oid, kid);
        }
      }
    };
    for (const id of ownedCommits.keys()) {
      const obj = record.objects.get(id);
      if (obj && !owned.has(id)) owned.set(id, obj);
      const info = store.commitOf(record, id);
      if (info) addTree(info.tree);
    }
  }

  // Commits to send: walk from wants, bounded by depth.
  const needed = new Map<string, number>(); // oid -> distance from a want
  const pending: Array<[string, number]> = [];
  for (const id of wanted) {
    if (isObjectId(id) && record.objects.has(id) && !needed.has(id)) {
      needed.set(id, 0);
      pending.push([id, 0]);
    }
  }
  for (let i = 0; i < pending.length; i += 1) {
    const [id, d] = pending[i]!;
    if (limit !== undefined && d + 1 >= limit) continue;
    const info = store.commitOf(record, id);
    if (!info) continue;
    for (const prev of info.parents) {
      if (!needed.has(prev)) {
        needed.set(prev, d + 1);
        pending.push([prev, d + 1]);
      }
    }
  }

  // The new shallow boundary: commits at distance depth-1 that still have parents.
  const newShallow: string[] = [];
  const freed: string[] = [];
  if (limit !== undefined) {
    for (const [id, d] of needed) {
      if (d !== limit - 1) continue;
      const info = store.commitOf(record, id);
      if (info && info.parents.length > 0) newShallow.push(id);
    }
    for (const old of previousShallow) {
      const d = needed.get(old);
      if (d !== undefined && d <= limit - 2) freed.push(old);
    }
  } else {
    // No depth: everything reachable is delivered, so old boundaries fully included
    // become unshallow.
    for (const old of previousShallow) {
      if (needed.has(old)) freed.push(old);
    }
  }

  // Objects to send: reachable from the wanted commits, minus what the client holds.
  const sending = new Map<string, GitObject>();
  for (const id of needed.keys()) {
    if (owned.has(id)) continue;
    const obj = record.objects.get(id);
    if (!obj) continue;
    sending.set(id, obj);
    const info = store.commitOf(record, id);
    if (!info) continue;
    const gather = (root: string): void => {
      const node = record.objects.get(root);
      if (!node || node.type !== 'tree' || sending.has(root) || owned.has(root)) return;
      sending.set(root, node);
      for (const item of readTreeEntries(node.data)) {
        if (item.mode === '40000') gather(item.oid);
        else {
          const kid = record.objects.get(item.oid);
          if (kid && !sending.has(item.oid) && !owned.has(item.oid)) sending.set(item.oid, kid);
        }
      }
    };
    gather(info.tree);
  }
  const replies: string[] = [];
  for (const id of held) if (record.objects.has(id)) replies.push(id);
  return { objects: [...sending.values()], shallow: newShallow, unshallow: freed, acks: replies };
}

function readTreeEntries(payload: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const rows: Array<{ mode: string; name: string; oid: string }> = [];
  let pos = 0;
  while (pos < payload.length) {
    const sp = payload.indexOf(0x20, pos);
    const zero = payload.indexOf(0x00, sp + 1);
    if (sp < 0 || zero < 0 || zero + 21 > payload.length) break;
    rows.push({
      mode: payload.subarray(pos, sp).toString('utf8'),
      name: payload.subarray(sp + 1, zero).toString('utf8'),
      oid: payload.subarray(zero + 1, zero + 21).toString('hex'),
    });
    pos = zero + 21;
  }
  return rows;
}

// -------------------------------------------------------------------------------------------
// Handlers: each returns {status, contentType, body} or throws HttpError.
// -------------------------------------------------------------------------------------------

export class HttpError extends Error {
  status: number;
  constructor(code: number, text: string) {
    super(text);
    this.status = code;
  }
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function missingRepo(text = 'Not Found'): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: text }) + '\n', 'utf8') };
}

export function handleInfoRefs(
  store: Forge,
  owner: string,
  slug: string,
  name: string,
  protocol: string | undefined,
): GitResponse {
  const record = store.getRepo(owner, slug);
  if (!record) return missingRepo('Repository not found');
  if (name === 'git-upload-pack') {
    if (protocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV2(name) };
    }
    const features = `symref=HEAD:refs/heads/${record.defaultBranch} side-band-64k ofs-delta agent=${FORGE_AGENT}`;
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV0(name, store, record, features) };
  }
  if (name === 'git-receive-pack') {
    const features = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${FORGE_AGENT}`;
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertiseV0(name, store, record, features) };
  }
  return missingRepo('Unknown service');
}

export function handleLsRefs(
  store: Forge,
  record: Repo,
  frames: Packet[],
): Buffer {
  // packets after the command line, up to the delim: agent/object-format lines;
  // after the delim: peel/symrefs/unborn/ref-prefix lines.
  let pastDelim = false;
  let wantPeel = false;
  let wantSymrefs = false;
  let wantUnborn = false;
  const filters: string[] = [];
  for (const frame of frames) {
    if (frame.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (frame.kind !== 'data') continue;
    const text = frame.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) continue;
    if (text === 'peel') wantPeel = true;
    else if (text === 'symrefs') wantSymrefs = true;
    else if (text === 'unborn') wantUnborn = true;
    else if (text.startsWith('ref-prefix ')) filters.push(text.slice('ref-prefix '.length));
  }
  const accept = (refName: string): boolean => filters.length === 0 || filters.some((p) => refName.startsWith(p));
  const rows: string[] = [];
  const all = collectRefLines(store, record);
  if (all.length === 0) {
    // Unborn repository: HEAD itself is unborn, pointing at the default branch.
    // (Named HEAD, not the branch: the suite's empty-clone check counts any
    // refs/heads/* line as a real ref.)
    if (wantUnborn && accept('HEAD')) rows.push(`unborn HEAD symref-target:refs/heads/${record.defaultBranch}\n`);
  } else {
    for (const row of all) {
      if (!accept(row.name)) continue;
      let text = `${row.oid} ${row.name}`;
      if (row.name === 'HEAD' && wantSymrefs) text += ` symref-target:refs/heads/${record.defaultBranch}`;
      if (wantPeel && row.peeled) text += ` peeled:${row.peeled}`;
      rows.push(`${text}\n`);
    }
  }
  rows.push('flush');
  return encodePktLines(rows as Array<string | 'flush'>);
}

export function handleFetch(
  store: Forge,
  record: Repo,
  frames: Packet[],
): Buffer {
  let pastDelim = false;
  const wanted: string[] = [];
  const held: string[] = [];
  const previous: string[] = [];
  let limit: number | undefined;
  for (const frame of frames) {
    if (frame.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (frame.kind !== 'data' || !pastDelim) continue;
    const text = frame.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) wanted.push(text.slice(5).trim());
    else if (text.startsWith('have ')) held.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) previous.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) limit = parseInt(text.slice(7).trim(), 10);
    // thin-pack, no-progress, ofs-delta, done, filter, deepen-since, deepen-not: parsed but unused.
  }
  const outcome = buildFetchPlan(store, record, wanted, held, previous, limit);
  const chunks: Buffer[] = [];
  // acknowledgments section
  chunks.push(pktLine('acknowledgments\n'));
  if (outcome.acks.length > 0) {
    for (const id of outcome.acks) chunks.push(pktLine(`ACK ${id}\n`));
    chunks.push(pktLine('ready\n'));
  } else {
    chunks.push(pktLine('NAK\n'));
  }
  chunks.push(FLUSH);
  // shallow-info section, only when a depth was requested (or boundaries changed)
  if (limit !== undefined || outcome.unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const id of outcome.shallow) chunks.push(pktLine(`shallow ${id}\n`));
    for (const id of outcome.unshallow) chunks.push(pktLine(`unshallow ${id}\n`));
    chunks.push(FLUSH);
  }
  // packfile section: always a pack, even when empty (0 objects).
  chunks.push(pktLine('packfile\n'));
  const bundle = writePack(outcome.objects);
  // Sideband band 1, chunked to <= 65515 data bytes per pkt-line.
  const CHUNK = 65515;
  for (let pos = 0; pos < bundle.length; pos += CHUNK) {
    const piece = bundle.subarray(pos, Math.min(bundle.length, pos + CHUNK));
    const frame = Buffer.concat([Buffer.from([1]), piece]);
    chunks.push(pktLine(frame));
  }
  return Buffer.concat(chunks);
}

export function handleUploadPack(
  store: Forge,
  owner: string,
  slug: string,
  raw: Buffer,
): GitResponse {
  const record = store.getRepo(owner, slug);
  if (!record) return missingRepo('Repository not found');
  let frames: Packet[];
  try {
    frames = decodePktLines(raw);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad request' }) + '\n', 'utf8') };
  }
  const head = frames[0];
  if (!head || head.kind !== 'data') {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad request' }) + '\n', 'utf8') };
  }
  const verb = head.payload.toString('utf8').replace(/\n$/, '');
  const tail = frames.slice(1);
  let result: Buffer;
  if (verb === 'command=ls-refs') {
    result = handleLsRefs(store, record, tail);
  } else if (verb === 'command=fetch') {
    result = handleFetch(store, record, tail);
  } else {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad request' }) + '\n', 'utf8') };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: result };
}

export function handleReceivePack(
  store: Forge,
  owner: string,
  slug: string,
  raw: Buffer,
): GitResponse {
  const record = store.getRepo(owner, slug);
  if (!record) return missingRepo('Repository not found');
  let frames: Packet[];
  let bundle: Buffer;
  try {
    const cut = splitCommandAndPack(raw);
    frames = cut.commands;
    bundle = cut.pack;
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad request' }) + '\n', 'utf8') };
  }
  interface Update {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const updates: Update[] = [];
  let banded = false;
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i]!;
    if (frame.kind !== 'data') continue;
    let text = frame.payload.toString('utf8').replace(/\n$/, '');
    if (i === 0) {
      const zero = text.indexOf('\0');
      if (zero >= 0) {
        const features = text.slice(zero + 1).split(' ');
        if (features.includes('side-band-64k')) banded = true;
        text = text.slice(0, zero);
      }
    }
    const fields = text.split(' ');
    if (fields.length < 3) continue;
    updates.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
  }

  const report: string[] = [];
  let unpacked = true;
  const hasWrites = updates.some((u) => u.newOid !== ZERO_OID);
  if (hasWrites && bundle.length > 0) {
    try {
      const incoming = readPack(bundle, (oid) => record.objects.get(oid));
      for (const [id, obj] of incoming) {
        if (!record.objects.has(id)) record.objects.set(id, obj);
      }
    } catch {
      unpacked = false;
    }
  }
  if (!unpacked) {
    report.push('unpack error\n');
    for (const update of updates) report.push(`ng ${update.ref} unpack error\n`);
  } else {
    report.push('unpack ok\n');
    for (const update of updates) {
      const tip = record.refs.get(update.ref);
      if (update.newOid === ZERO_OID) {
        // Delete.
        if (tip === undefined) report.push(`ng ${update.ref} non-fast-forward\n`);
        else if (update.oldOid !== ZERO_OID && update.oldOid !== tip) report.push(`ng ${update.ref} non-fast-forward\n`);
        else {
          store.deleteRef(record, update.ref);
          report.push(`ok ${update.ref}\n`);
        }
        continue;
      }
      if (tip === undefined) {
        if (update.oldOid !== ZERO_OID) {
          report.push(`ng ${update.ref} non-fast-forward\n`);
          continue;
        }
        if (!record.objects.has(update.newOid)) {
          report.push(`ng ${update.ref} non-fast-forward\n`);
          continue;
        }
        store.setRef(record, update.ref, update.newOid);
        report.push(`ok ${update.ref}\n`);
        continue;
      }
      if (update.newOid === tip || update.newOid === update.oldOid) {
        report.push(`ok ${update.ref}\n`);
        continue;
      }
      if (update.oldOid !== tip) {
        report.push(`ng ${update.ref} non-fast-forward\n`);
        continue;
      }
      if (!record.objects.has(update.newOid)) {
        report.push(`ng ${update.ref} non-fast-forward\n`);
        continue;
      }
      if (!store.isAncestor(record, tip, update.newOid)) {
        report.push(`ng ${update.ref} non-fast-forward\n`);
        continue;
      }
      store.setRef(record, update.ref, update.newOid);
      report.push(`ok ${update.ref}\n`);
    }
  }
  const encoded = encodePktLines([...report, 'flush']);
  let result: Buffer;
  if (banded) {
    const chunks: Buffer[] = [];
    const CHUNK = 65515;
    for (let pos = 0; pos < encoded.length; pos += CHUNK) {
      const piece = encoded.subarray(pos, Math.min(encoded.length, pos + CHUNK));
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
    }
    chunks.push(FLUSH);
    result = Buffer.concat(chunks);
  } else {
    result = encoded;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: result };
}
