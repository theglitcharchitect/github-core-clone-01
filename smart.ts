// smart.ts: git smart HTTP at /<owner>/<repo>.git: info/refs advertisements (protocol v2
// capability advertisement for upload-pack when the client asks, v0 ref advertisements
// otherwise and always for receive-pack), the v2 ls-refs and fetch commands, a v0 fetch
// fallback, and receive-pack pushes with report-status in sideband frames. Objects live in
// the shared store; a push cannot invent a repository (an unknown one is a 404), pushes are
// fast-forward only per ref, and fetch packs for identical requests are computed once and
// cached (the clone workload asks for the same shallow pack fifty times at once).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorBody, sendJson } from './http.ts';
import { DEFAULT_BRANCH, getRepo, lookup, type RepoRec } from './store.ts';
import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  peelToCommit,
  readPack,
  splitPktBody,
  writePack,
  type GitObject,
  type PktPacket,
} from './git.ts';

const AGENT = 'makefun-forge/1.0';

function pktText(packet: PktPacket): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8') : '';
}

/** The refs a repository advertises, in git's order: HEAD first, then refs by name. */
function advertisedRefs(repo: RepoRec): Array<{ name: string; oid: string; peeled?: string; symref?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string; symref?: string }> = [];
  const headTarget = `refs/heads/${DEFAULT_BRANCH}`;
  const headOid = repo.refs.get(headTarget);
  out.push({ name: 'HEAD', oid: headOid ?? ZERO_OID, symref: headTarget });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') entry.peeled = peelToCommit(lookup(repo), oid);
    out.push(entry);
  }
  return out;
}

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: string[] = [];
  const refs = advertisedRefs(repo);
  if (repo.refs.size === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      lines.push(`${ref.oid} ${ref.name}${suffix}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  return encodePktLines([`# service=${service}\n`, 'flush', ...lines, 'flush']);
}

function v2Advertisement(service: 'git-upload-pack'): Buffer {
  return encodePktLines([
    `# service=${service}\n`,
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** GET /<owner>/<repo>.git/info/refs?service=... */
export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: RepoRec, url: URL): void {
  const service = url.searchParams.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 400, errorBody('Invalid service'));
    return;
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    sendBytes(res, 200, v2Advertisement(service), 'application/x-git-upload-pack-advertisement');
    return;
  }
  sendBytes(res, 200, v0Advertisement(repo, service), `application/x-${service}-advertisement`);
}

// ---------------------------------------------------------------- ls-refs

function handleLsRefs(res: ServerResponse, repo: RepoRec, args: string[]): void {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  for (const ref of advertisedRefs(repo)) {
    if (!matches(ref.name)) continue;
    if (ref.oid === ZERO_OID) {
      if (unborn && ref.name === 'HEAD') lines.push(`unborn HEAD symref-target:${ref.symref}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symref !== undefined) line += ` symref-target:${ref.symref}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  sendBytes(res, 200, encodePktLines([...lines, 'flush']), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Objects reachable from `roots`, cutting commit parent edges at the client's shallow boundary. */
function closureCutAt(repo: RepoRec, roots: readonly string[], cut: ReadonlySet<string>): Set<string> {
  const lookupFn = lookup(repo);
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookupFn(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const oid2 of collectReachable(lookupFn, [commit.tree])) seen.add(oid2);
      if (!cut.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const oid2 of collectReachable(lookupFn, [oid])) seen.add(oid2);
    }
  }
  return seen;
}

/** The commits a fetch includes: all reachable from the wants, or only those within `depth`. */
function includedCommits(repo: RepoRec, wants: readonly string[], depth: number | null): Set<string> {
  const lookupFn = lookup(repo);
  const included = new Set<string>();
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const commitOid = peelToCommit(lookupFn, want);
    if (lookupFn(commitOid)?.type === 'commit' && !distance.has(commitOid)) {
      distance.set(commitOid, 1);
      queue.push(commitOid);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const dist = distance.get(oid) as number;
    if (depth !== null && dist > depth) continue;
    included.add(oid);
    const object = lookupFn(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
  }
  return included;
}

/** Compute (or fetch from cache) the pack bytes for one fetch request. */
function packFor(repo: RepoRec, args: FetchArgs): Promise<Buffer> {
  const key = [
    [...args.wants].sort().join(','),
    [...args.haves].sort().join(','),
    [...args.shallow].sort().join(','),
    args.depth === null ? 'full' : `d${args.depth}`,
  ].join('|');
  const cached = repo.packCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = repo.packInflight.get(key);
  if (inflight !== undefined) return inflight;
  const promise = Promise.resolve().then(() => {
    const lookupFn = lookup(repo);
    const haveObjects = closureCutAt(repo, args.haves, new Set(args.shallow));
    let send: Set<string>;
    if (args.depth === null) {
      send = collectReachable(lookupFn, args.wants);
    } else {
      send = new Set<string>();
      for (const commitOid of includedCommits(repo, args.wants, args.depth)) {
        send.add(commitOid);
        const commit = parseCommit((lookupFn(commitOid) as GitObject).data);
        for (const oid of collectReachable(lookupFn, [commit.tree])) send.add(oid);
      }
      // Tag objects naming an included commit ride along (an annotated tag want).
      for (const want of args.wants) {
        if (lookupFn(want)?.type === 'tag') {
          for (const oid of collectReachable(lookupFn, [want])) {
            if (!send.has(oid) && lookupFn(oid)?.type !== 'commit') send.add(oid);
          }
        }
      }
    }
    for (const oid of haveObjects) send.delete(oid);
    const rank = (object: GitObject): number => (object.type === 'commit' ? 0 : object.type === 'tree' ? 1 : object.type === 'blob' ? 2 : 3);
    const objects = [...send]
      .map((oid) => lookupFn(oid) as GitObject)
      .filter((object) => object !== undefined)
      .sort((a, b) => rank(a) - rank(b) || (hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1));
    const pack = writePack(objects);
    repo.packCache.set(key, pack);
    repo.packInflight.delete(key);
    return pack;
  });
  repo.packInflight.set(key, promise);
  return promise;
}

/** The shallow boundary lines a fetch response owes, when shallow is in play. */
function shallowLines(repo: RepoRec, args: FetchArgs): { shallow: string[]; unshallow: string[] } {
  const included = includedCommits(repo, args.wants, args.depth);
  const lookupFn = lookup(repo);
  const shallow: string[] = [];
  for (const oid of included) {
    const object = lookupFn(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => !included.has(parent) && lookupFn(parent)?.type === 'commit')) shallow.push(oid);
  }
  const unshallow = args.shallow.filter((oid) => included.has(oid) && !shallow.includes(oid));
  return { shallow, unshallow };
}

/** Wrap a pack in sideband band-1 pkt-lines (the only band this server sends: no progress). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    const framed = Buffer.allocUnsafe(chunk.length + 1);
    framed[0] = 1;
    chunk.copy(framed, 1);
    parts.push(encodePktLine(framed));
  }
  if (pack.length === 0) parts.push(encodePktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

async function handleFetchV2(res: ServerResponse, repo: RepoRec, args: FetchArgs): Promise<void> {
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    const lines: string[] = ['acknowledgments\n'];
    for (const have of args.haves) {
      if (repo.objects.has(have)) lines.push(`ACK ${have}\n`);
    }
    lines.push('ready\n');
    parts.push(encodePktLines([...lines, 'flush']));
  }
  if (args.depth !== null || args.shallow.length > 0) {
    const { shallow, unshallow } = shallowLines(repo, args);
    const lines: string[] = ['shallow-info\n'];
    for (const oid of shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
    parts.push(encodePktLines([...lines, 'flush']));
  }
  const pack = await packFor(repo, args);
  parts.push(encodePktLines(['packfile\n']));
  parts.push(sidebandPack(pack));
  parts.push(encodePktLines(['flush']));
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

async function handleFetchV0(res: ServerResponse, repo: RepoRec, args: FetchArgs): Promise<void> {
  const parts: Buffer[] = [];
  const { shallow } = args.depth !== null || args.shallow.length > 0 ? shallowLines(repo, args) : { shallow: [] as string[] };
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  parts.push(encodePktLine('NAK\n'));
  const pack = await packFor(repo, args);
  parts.push(sidebandPack(pack));
  parts.push(encodePktLines(['flush']));
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

/** POST /<owner>/<repo>.git/git-upload-pack: an ls-refs or a fetch command. */
export async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: RepoRec, rawBody: Buffer): Promise<void> {
  let packets: PktPacket[];
  try {
    packets = decodePktLines(rawBody);
  } catch {
    sendJson(res, 400, errorBody('Malformed pkt-line request'));
    return;
  }
  const lines = packets.filter((packet) => packet.kind === 'data').map(pktText);
  const commandLine = lines[0] ?? '';
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const argLines = delimIndex === -1 ? lines.slice(1) : packets.slice(delimIndex + 1).filter((packet) => packet.kind === 'data').map(pktText);
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2') || commandLine.startsWith('command=');

  if (commandLine.startsWith('command=ls-refs')) {
    handleLsRefs(res, repo, argLines.map((line) => line.replace(/\n$/, '')));
    return;
  }
  if (commandLine.startsWith('command=fetch')) {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
    for (const raw of argLines) {
      const line = raw.replace(/\n$/, '');
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    }
    await handleFetchV2(res, repo, args);
    return;
  }
  // Protocol v0: want lines, a flush, have lines and done.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
  }
  if (args.wants.length === 0 && !wantsV2) {
    sendJson(res, 400, errorBody('Malformed upload-pack request'));
    return;
  }
  await handleFetchV0(res, repo, args);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /<owner>/<repo>.git/git-receive-pack: apply a command list and report per ref. */
export async function handleReceivePack(res: ServerResponse, repo: RepoRec, rawBody: Buffer): Promise<void> {
  let commands: PushCommand[] = [];
  let pack = Buffer.alloc(0);
  try {
    const split = splitPktBody(rawBody);
    pack = split.rest;
    for (const packet of split.packets) {
      if (packet.kind !== 'data') continue;
      let line = pktText(packet).replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul !== -1) line = line.slice(0, nul);
      const parts = line.split(' ');
      if (parts.length !== 3 || !isObjectId(parts[0] as string) || !isObjectId(parts[1] as string)) {
        throw new Error('bad ref-update command');
      }
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  } catch {
    sendJson(res, 400, errorBody('Malformed receive-pack request'));
    return;
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, lookup(repo));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'index-pack failed';
    }
  }

  const lookupFn = lookup(repo);
  const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  let refsChanged = false;
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (!unpackOk) {
      report.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    if (command.oldOid !== current) {
      report.push(`ng ${command.ref} reference update failed\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      refsChanged = true;
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (newObject === undefined) {
      report.push(`ng ${command.ref} missing object\n`);
      continue;
    }
    if (current !== ZERO_OID) {
      const currentObject = repo.objects.get(current);
      if (
        newObject.type === 'commit' &&
        currentObject?.type === 'commit' &&
        command.ref.startsWith('refs/heads/') &&
        !isAncestor(lookupFn, current, command.newOid)
      ) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    refsChanged = true;
    report.push(`ok ${command.ref}\n`);
  }
  if (refsChanged) repo.packCache.clear();

  const inner = encodePktLines([...report, 'flush']);
  const framed = Buffer.allocUnsafe(inner.length + 1);
  framed[0] = 1;
  inner.copy(framed, 1);
  const body = Buffer.concat([encodePktLine(framed), encodePktLines(['flush'])]);
  sendBytes(res, 200, body, 'application/x-git-receive-pack-result');
}
