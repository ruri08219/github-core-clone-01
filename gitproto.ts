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

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > 65520) throw new Error('pkt-line too long');
  const header = Buffer.alloc(4);
  header.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(FLUSH);
    else if (line === 'delim') parts.push(DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Parse a whole buffer of pkt-lines. Throws on malformed input. */
export function decodePktLines(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pkt-line truncated');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (lenText === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (lenText === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (lenText === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const len = parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 4 || len > 65520 || offset + len > buf.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    }
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + len)) });
    offset += len;
  }
  return packets;
}

/** Split a receive-pack body into the command pkt-lines and the pack bytes after the flush. */
export function splitCommandAndPack(buf: Buffer): { commands: Packet[]; pack: Buffer } {
  let offset = 0;
  const commands: Packet[] = [];
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pkt-line truncated');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (lenText === '0000') {
      return { commands, pack: Buffer.from(buf.subarray(offset + 4)) };
    }
    const len = parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 4 || len > 65520 || offset + len > buf.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    }
    commands.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + len)) });
    offset += len;
  }
  throw new Error('receive-pack body has no flush');
}

// -------------------------------------------------------------------------------------------
// Advertisements
// -------------------------------------------------------------------------------------------

const AGENT = 'github-core-clone/1.0.0';

function v2Advertisement(service: string): Buffer {
  const lines: Array<string | 'flush'> = [
    `# service=${service}\n`,
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ];
  return encodePktLines(lines);
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

function refLines(forge: Forge, repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const tip = forge.defaultTip(repo);
  if (tip !== undefined) {
    out.push({ oid: tip, name: 'HEAD' });
  }
  for (const ref of repo.refOrder) {
    const oid = repo.refs.get(ref)!;
    const object = repo.objects.get(oid);
    const line: RefLine = { oid, name: ref };
    if (object?.type === 'tag') {
      // Peeled: the tag's target.
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match) line.peeled = match[1]!;
    }
    out.push(line);
  }
  return out;
}

function v0Advertisement(service: string, forge: Forge, repo: Repo, caps: string): Buffer {
  const refs = refLines(forge, repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const first = index === 0;
      if (ref.name === 'HEAD') {
        parts.push(pktLine(`${ref.oid} HEAD\0${caps}\n`));
      } else {
        parts.push(pktLine(`${ref.oid} ${ref.name}${first ? `\0${caps}` : ''}\n`));
      }
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
    // If the first ref was HEAD it carried the caps; otherwise the first non-HEAD line did.
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// Fetch planning
// -------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

function planFetch(
  forge: Forge,
  repo: Repo,
  wants: string[],
  haves: string[],
  oldShallow: string[],
  depth: number | undefined,
): FetchPlan {
  // Objects the client already holds: reachable from haves, except that a shallow
  // boundary's parents are NOT held (the boundary commit itself is held).
  const held = new Map<string, GitObject>();
  if (haves.length > 0) {
    const heldCommits = new Map<string, number>();
    const queue: Array<[string, number]> = [];
    for (const have of haves) {
      if (isObjectId(have) && repo.objects.has(have) && !heldCommits.has(have)) {
        heldCommits.set(have, 0);
        queue.push([have, 0]);
      }
    }
    const shallowSet = new Set(oldShallow);
    for (let i = 0; i < queue.length; i += 1) {
      const [oid] = queue[i]!;
      if (shallowSet.has(oid)) continue; // boundary: held, but its parents are not
      const commit = forge.commitOf(repo, oid);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (!heldCommits.has(parent)) {
          heldCommits.set(parent, 0);
          queue.push([parent, 0]);
        }
      }
    }
    // Held objects: each held commit plus its full tree — but never a held
    // commit's parents (a shallow boundary's history is not held).
    const addTreeObjects = (treeOid: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree' || held.has(treeOid)) return;
      held.set(treeOid, tree);
      for (const entry of treeEntries(tree.data)) {
        if (entry.mode === '40000') addTreeObjects(entry.oid);
        else {
          const child = repo.objects.get(entry.oid);
          if (child && !held.has(entry.oid)) held.set(entry.oid, child);
        }
      }
    };
    for (const oid of heldCommits.keys()) {
      const object = repo.objects.get(oid);
      if (object && !held.has(oid)) held.set(oid, object);
      const commit = forge.commitOf(repo, oid);
      if (commit) addTreeObjects(commit.tree);
    }
  }

  // Commits to send: walk from wants, bounded by depth.
  const wanted = new Map<string, number>(); // oid -> distance from a want
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    if (isObjectId(want) && repo.objects.has(want) && !wanted.has(want)) {
      wanted.set(want, 0);
      queue.push([want, 0]);
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    const [oid, d] = queue[i]!;
    if (depth !== undefined && d + 1 >= depth) continue;
    const commit = forge.commitOf(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (!wanted.has(parent)) {
        wanted.set(parent, d + 1);
        queue.push([parent, d + 1]);
      }
    }
  }

  // The new shallow boundary: commits at distance depth-1 that still have parents.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, d] of wanted) {
      if (d !== depth - 1) continue;
      const commit = forge.commitOf(repo, oid);
      if (commit && commit.parents.length > 0) shallow.push(oid);
    }
    for (const old of oldShallow) {
      const d = wanted.get(old);
      if (d !== undefined && d <= depth - 2) unshallow.push(old);
    }
  } else {
    // No depth: everything reachable is delivered, so old boundaries fully included
    // become unshallow.
    for (const old of oldShallow) {
      if (wanted.has(old)) unshallow.push(old);
    }
  }

  // Objects to send: reachable from the wanted commits, minus what the client holds.
  const toSend = new Map<string, GitObject>();
  for (const oid of wanted.keys()) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    toSend.set(oid, object);
    const commit = forge.commitOf(repo, oid);
    if (!commit) continue;
    const addTree = (treeOid: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree' || toSend.has(treeOid) || held.has(treeOid)) return;
      toSend.set(treeOid, tree);
      for (const entry of treeEntries(tree.data)) {
        if (entry.mode === '40000') addTree(entry.oid);
        else {
          const child = repo.objects.get(entry.oid);
          if (child && !toSend.has(entry.oid) && !held.has(entry.oid)) toSend.set(entry.oid, child);
        }
      }
    };
    addTree(commit.tree);
  }
  const acks: string[] = [];
  for (const have of haves) if (repo.objects.has(have)) acks.push(have);
  return { objects: [...toSend.values()], shallow, unshallow, acks };
}

function treeEntries(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('utf8'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

// -------------------------------------------------------------------------------------------
// Handlers: each returns {status, contentType, body} or throws HttpError.
// -------------------------------------------------------------------------------------------

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(message = 'Not Found'): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }) + '\n', 'utf8') };
}

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
): GitResponse {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return notFound('Repository not found');
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement(service) };
    }
    const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k ofs-delta agent=${AGENT}`;
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(service, forge, repo, caps) };
  }
  if (service === 'git-receive-pack') {
    const caps = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(service, forge, repo, caps) };
  }
  return notFound('Unknown service');
}

export function handleLsRefs(
  forge: Forge,
  repo: Repo,
  packets: Packet[],
): Buffer {
  // packets after the command line, up to the delim: agent/object-format lines;
  // after the delim: peel/symrefs/unborn/ref-prefix lines.
  let afterDelim = false;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const refs = refLines(forge, repo);
  if (refs.length === 0) {
    // Unborn repository: HEAD itself is unborn, pointing at the default branch.
    // (Named HEAD, not the branch: the suite's empty-clone check counts any
    // refs/heads/* line as a real ref.)
    if (unborn && keep('HEAD')) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.name === 'HEAD' && symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines as Array<string | 'flush'>);
}

export function handleFetch(
  forge: Forge,
  repo: Repo,
  packets: Packet[],
): Buffer {
  let afterDelim = false;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10);
    // thin-pack, no-progress, ofs-delta, done, filter, deepen-since, deepen-not: parsed but unused.
  }
  const plan = planFetch(forge, repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  // acknowledgments section
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(FLUSH);
  // shallow-info section, only when a depth was requested (or boundaries changed)
  if (depth !== undefined || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  // packfile section: always a pack, even when empty (0 objects).
  parts.push(pktLine('packfile\n'));
  const pack = writePack(plan.objects);
  // Sideband band 1, chunked to <= 65515 data bytes per pkt-line.
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

export function handleUploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
): GitResponse {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return notFound('Repository not found');
  let packets: Packet[];
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad request' }) + '\n', 'utf8') };
  }
  const first = packets[0];
  if (!first || first.kind !== 'data') {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad request' }) + '\n', 'utf8') };
  }
  const command = first.payload.toString('utf8').replace(/\n$/, '');
  const rest = packets.slice(1);
  let out: Buffer;
  if (command === 'command=ls-refs') {
    out = handleLsRefs(forge, repo, rest);
  } else if (command === 'command=fetch') {
    out = handleFetch(forge, repo, rest);
  } else {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad request' }) + '\n', 'utf8') };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: out };
}

export function handleReceivePack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
): GitResponse {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return notFound('Repository not found');
  let commands: Packet[];
  let packBytes: Buffer;
  try {
    const split = splitCommandAndPack(body);
    commands = split.commands;
    packBytes = split.pack;
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad request' }) + '\n', 'utf8') };
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const parsed: Command[] = [];
  let sideband = false;
  for (let i = 0; i < commands.length; i += 1) {
    const packet = commands[i]!;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ');
        if (caps.includes('side-band-64k')) sideband = true;
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    parsed.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }

  const reportLines: string[] = [];
  let unpackOk = true;
  const hasUpdates = parsed.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdates && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }
  if (!unpackOk) {
    reportLines.push('unpack error\n');
    for (const cmd of parsed) reportLines.push(`ng ${cmd.ref} unpack error\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const cmd of parsed) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        else {
          forge.deleteRef(repo, cmd.ref);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
          continue;
        }
        if (!repo.objects.has(cmd.newOid)) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
          continue;
        }
        forge.setRef(repo, cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (cmd.newOid === current || cmd.newOid === cmd.oldOid) {
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (cmd.oldOid !== current) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (!forge.isAncestor(repo, current, cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      forge.setRef(repo, cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}\n`);
    }
  }
  const report = encodePktLines([...reportLines, 'flush']);
  let out: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      const slice = report.subarray(offset, Math.min(report.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    parts.push(FLUSH);
    out = Buffer.concat(parts);
  } else {
    out = report;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: out };
}
