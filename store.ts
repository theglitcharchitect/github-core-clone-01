// store.ts: the forge's one in-memory store, shared by the REST, GraphQL, MCP and git
// smart-HTTP surfaces so an object created on one surface is the same object on every other.
// All state is per-process and starts empty, as a trial expects. Time comes from a logical
// clock seeded by MAKEFUN_TRIAL_NOW (the only "now" a request may carry): every mutation
// advances it one second, so two runs that take the same requests stamp the same times.

import {
  buildCommit,
  buildTreeFromFiles,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  mergeFileMaps,
  parseCommit,
  type GitObject,
  type GitObjectType,
} from './git.ts';

/** The one user the trial token names; every repository belongs to this login. */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const DEFAULT_BRANCH = 'main';

const clockBaseMs = (() => {
  const fromEnv = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '');
  return Number.isFinite(fromEnv) ? fromEnv : Date.parse('2025-01-01T00:00:00.000Z');
})();
let clockMs = clockBaseMs;

/** The next logical timestamp (ISO) and its epoch seconds; advances one second per call. */
export function tick(): { iso: string; epochSec: number } {
  clockMs += 1000;
  return { iso: new Date(clockMs).toISOString(), epochSec: Math.floor(clockMs / 1000) };
}

export interface CommentRec {
  dbId: number;
  body: string;
  createdAt: string;
}

export interface IssueRec {
  kind: 'issue';
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  kind: 'pull';
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  nextLabelId: number;
  createdAt: string;
  updatedAt: string;
  packCache: Map<string, Buffer>;
  packInflight: Map<string, Promise<Buffer>>;
}

const repos = new Map<string, RepoRec>();
let nextRepoId = 1;
let nextDbId = 1;

export function allocDbId(): number {
  const id = nextDbId;
  nextDbId += 1;
  return id;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): RepoRec | undefined {
  return repos.get(repoKey(owner, name));
}

export function createRepo(name: string, isPrivate: boolean, description: string): RepoRec | null {
  const key = repoKey(VIEWER.login, name);
  if (repos.has(key)) return null;
  const now = tick().iso;
  const repo: RepoRec = {
    id: nextRepoId,
    owner: VIEWER.login,
    name,
    isPrivate,
    description,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextLabelId: 1,
    createdAt: now,
    updatedAt: now,
    packCache: new Map(),
    packInflight: new Map(),
  };
  nextRepoId += 1;
  repos.set(key, repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

export function listRepos(): RepoRec[] {
  return [...repos.values()].sort((a, b) => a.id - b.id);
}

export function lookup(repo: RepoRec): (oid: string) => GitObject | undefined {
  return (oid: string) => repo.objects.get(oid);
}

export function putObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** The commit a ref or a raw object id names, or undefined. */
export function resolveCommit(repo: RepoRec, refOrOid: string): string | undefined {
  if (repo.refs.has(refOrOid)) return repo.refs.get(refOrOid);
  const branchRef = `refs/heads/${refOrOid}`;
  if (repo.refs.has(branchRef)) return repo.refs.get(branchRef);
  const tagRef = `refs/tags/${refOrOid}`;
  if (repo.refs.has(tagRef)) return repo.refs.get(tagRef);
  const object = repo.objects.get(refOrOid);
  if (object !== undefined && object.type === 'commit') return refOrOid;
  return undefined;
}

/** The flattened file map at a commit (empty when the commit is unknown). */
export function filesAtCommit(repo: RepoRec, commitOid: string): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(lookup(repo), parseCommit(object.data).tree);
}

/** Commit a file map onto a branch, creating the branch when it is unborn. Returns the commit id. */
export function commitFiles(
  repo: RepoRec,
  branch: string,
  files: ReadonlyMap<string, { oid: string; mode: string }>,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const tree = buildTreeFromFiles((type, data) => putObject(repo, type, data), files);
  const now = tick();
  const identity = `${VIEWER.name} <${VIEWER.email}>`;
  const commit = buildCommit({
    tree,
    parents: parent === undefined ? [] : [parent],
    message,
    author: identity,
    committer: identity,
    timestamp: now.epochSec,
  });
  const oid = putObject(repo, 'commit', commit);
  repo.refs.set(ref, oid);
  repo.updatedAt = now.iso;
  repo.packCache.clear();
  return oid;
}

/** Set one file's bytes on a branch (the contents API's write), returning the commit and blob ids. */
export function writeFile(
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string } {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const files = tip === undefined ? new Map<string, { oid: string; mode: string }>() : filesAtCommit(repo, tip);
  const blobSha = putObject(repo, 'blob', content);
  const existing = files.get(path);
  files.set(path, { oid: blobSha, mode: existing?.mode ?? '100644' });
  const commitSha = commitFiles(repo, branch, files, message);
  return { commitSha, blobSha };
}

/** Remove one file from a branch (the contents API's delete), returning the commit id. */
export function removeFile(repo: RepoRec, branch: string, path: string, message: string): string {
  const tip = repo.refs.get(`refs/heads/${branch}`) as string;
  const files = filesAtCommit(repo, tip);
  files.delete(path);
  return commitFiles(repo, branch, files, message);
}

// ---------------------------------------------------------------- issues and pulls

export function createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
  const now = tick().iso;
  const issue: IssueRec = {
    kind: 'issue',
    dbId: allocDbId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
  const now = tick().iso;
  const pull: PullRec = {
    kind: 'pull',
    dbId: allocDbId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The files a pull request changes: merge base tree against head tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): Array<{ path: string; baseOid?: string; headOid?: string }> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = mergeBase(lookup(repo), baseTip, headTip) ?? baseTip;
  const baseFiles = filesAtCommit(repo, base);
  const headFiles = filesAtCommit(repo, headTip);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const changed: Array<{ path: string; baseOid?: string; headOid?: string }> = [];
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid;
    const h = headFiles.get(path)?.oid;
    if (b !== h) changed.push({ path, baseOid: b, headOid: h });
  }
  return changed.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** Simulate the three-way merge a pull request would perform; names the merged tree or the conflict. */
export function simulateMerge(
  repo: RepoRec,
  pull: PullRec,
): { conflict: boolean; mergedFiles?: Map<string, { oid: string; mode: string }>; baseTip?: string; headTip?: string } {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { conflict: true };
  if (isAncestor(lookup(repo), headTip, baseTip)) {
    return { conflict: false, mergedFiles: filesAtCommit(repo, baseTip), baseTip, headTip };
  }
  const base = mergeBase(lookup(repo), baseTip, headTip);
  const ancestorFiles = base === null ? new Map<string, { oid: string; mode: string }>() : filesAtCommit(repo, base);
  const { merged, conflict } = mergeFileMaps(ancestorFiles, filesAtCommit(repo, baseTip), filesAtCommit(repo, headTip));
  if (conflict) return { conflict: true, baseTip, headTip };
  return { conflict: false, mergedFiles: merged, baseTip, headTip };
}

/**
 * Merge a pull request into its base branch (squash: one parent; merge: two). Answers the
 * merge commit id, or null when the merge conflicts. Marks the pull closed and merged.
 */
export function mergePull(repo: RepoRec, pull: PullRec, method: 'squash' | 'merge'): string | null {
  const simulation = simulateMerge(repo, pull);
  if (simulation.conflict || simulation.mergedFiles === undefined || simulation.baseTip === undefined) return null;
  const { baseTip, headTip } = simulation;
  const tree = buildTreeFromFiles((type, data) => putObject(repo, type, data), simulation.mergedFiles);
  const now = tick();
  const identity = `${VIEWER.name} <${VIEWER.email}>`;
  const message =
    method === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.headRef}`;
  const parents = method === 'squash' ? [baseTip] : [baseTip, ...(headTip === undefined ? [] : [headTip])];
  const commit = buildCommit({ tree, parents, message, author: identity, committer: identity, timestamp: now.epochSec });
  const oid = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  repo.packCache.clear();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now.iso;
  pull.mergeCommitSha = oid;
  pull.updatedAt = now.iso;
  repo.updatedAt = now.iso;
  return oid;
}
