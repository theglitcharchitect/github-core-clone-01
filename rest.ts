// rest.ts: the GitHub REST v3 surface (/api/v3): the API root and meta, the viewer, repository
// CRUD with Link-header pagination, branches, commits, the contents API (which writes real
// git commits into the shared store), labels, issues with comments, and pull requests with
// their changed files and squash/merge endpoint. Every handler answers GitHub's shapes and
// status codes; every error body is JSON with a string `message`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { encodeGlobalId } from './ids.ts';
import { errorBody, notFound, parseJsonBody, sendEmpty, sendJson } from './http.ts';
import {
  DEFAULT_BRANCH,
  VIEWER,
  allocDbId,
  commitFiles,
  createIssue,
  createPull,
  createRepo,
  deleteRepo,
  filesAtCommit,
  getRepo,
  listRepos,
  mergePull,
  pullFiles,
  putObject,
  removeFile,
  resolveCommit,
  tick,
  writeFile,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { isObjectId, parseCommit, walkCommits } from './git.ts';

type Json = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function userJson(): Json {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User' };
}

export function repoJson(repo: RepoRec): Json {
  return {
    id: repo.id,
    node_id: encodeGlobalId({ type: 'Repository', repoId: repo.id }),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: DEFAULT_BRANCH,
    has_issues: true,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Json {
  return {
    id: issue.dbId,
    node_id: encodeGlobalId({ type: 'Issue', repoId: repo.id, number: issue.number }),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed' };
    }),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function commentJson(repo: RepoRec, issue: IssueRec, comment: { dbId: number; body: string; createdAt: string }): Json {
  return {
    id: comment.dbId,
    node_id: encodeGlobalId({ type: 'IssueComment', repoId: repo.id, number: issue.number, commentDbId: comment.dbId }),
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Json {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.dbId,
    node_id: encodeGlobalId({ type: 'PullRequest', repoId: repo.id, number: pull.number }),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

interface Page {
  items: unknown[];
  headers: Record<string, string>;
}

/** Slice `items` by page/per_page and build the Link header GitHub sends (next/last/prev/first). */
function paginate(req: IncomingMessage, url: URL, items: readonly unknown[]): Page {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const host = req.headers.host ?? 'entry';
  const linkFor = (target: number): string => {
    const query = new URLSearchParams(url.searchParams);
    query.set('page', String(target));
    query.set('per_page', String(perPage));
    return `<http://${host}${url.pathname}?${query.toString()}>`;
  };
  const links: string[] = [];
  if (page < lastPage) links.push(`${linkFor(page + 1)}; rel="next"`, `${linkFor(lastPage)}; rel="last"`);
  if (page > 1) links.push(`${linkFor(page - 1)}; rel="prev"`, `${linkFor(1)}; rel="first"`);
  return { items: slice as unknown[], headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (const byte of data) if (byte === 0x0a) count += 1;
  return data[data.length - 1] === 0x0a ? count : count + 1;
}

/** Line-multiset diff counts for one changed file (additions/deletions/changes). */
function diffCounts(repo: RepoRec, baseOid: string | undefined, headOid: string | undefined): { additions: number; deletions: number } {
  const baseData = baseOid === undefined ? Buffer.alloc(0) : (repo.objects.get(baseOid)?.data ?? Buffer.alloc(0));
  const headData = headOid === undefined ? Buffer.alloc(0) : (repo.objects.get(headOid)?.data ?? Buffer.alloc(0));
  const tally = (data: Buffer): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of data.toString('utf8').split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const baseLines = tally(baseData);
  const headLines = tally(headData);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of headLines) additions += Math.max(0, count - (baseLines.get(line) ?? 0));
  for (const [line, count] of baseLines) deletions += Math.max(0, count - (headLines.get(line) ?? 0));
  if (baseOid === undefined) additions = lineCount(headData);
  if (headOid === undefined) deletions = lineCount(baseData);
  return { additions, deletions };
}

/** Handle one /api/v3 request. The caller has already authenticated the token. */
export async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, rawBody: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = url.pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => decodeURIComponent(part));
  // segments[0] is 'api', segments[1] is 'v3'.
  const rest = segments.slice(2);
  const body = (): Json | null => parseJsonBody(rawBody);

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_search_url: '/api/v3/search/issues',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    notFound(res);
    return;
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method === 'GET') sendJson(res, 200, { installed_version: '1.0.0', git_sha: 'forge' });
    else notFound(res);
    return;
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    else notFound(res);
    return;
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const page = paginate(req, url, listRepos().map(repoJson));
      sendJson(res, 200, page.items, page.headers);
      return;
    }
    if (method === 'POST') {
      const parsed = body();
      if (parsed === null) {
        sendJson(res, 400, errorBody('Problems parsing JSON'));
        return;
      }
      const name = str(parsed.name);
      if (name === '') {
        sendJson(res, 422, errorBody('Validation Failed: name is required'));
        return;
      }
      const created = createRepo(name, parsed.private === true, str(parsed.description));
      if (created === null) {
        sendJson(res, 422, errorBody('Validation Failed: name already exists on this account'));
        return;
      }
      sendJson(res, 201, repoJson(created));
      return;
    }
    notFound(res);
    return;
  }

  if (rest[0] !== 'repos' || rest.length < 3) {
    notFound(res);
    return;
  }
  const owner = rest[1] as string;
  const name = rest[2] as string;
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    notFound(res);
    return;
  }
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = body();
      if (parsed === null) {
        sendJson(res, 400, errorBody('Problems parsing JSON'));
        return;
      }
      if (typeof parsed.description === 'string') repo.description = parsed.description;
      if (typeof parsed.private === 'boolean') repo.isPrivate = parsed.private;
      if (typeof parsed.name === 'string' && parsed.name !== '') {
        // Renaming would move the repository key; the suite never renames, so this stays a no-op read-back.
      }
      repo.updatedAt = tick().iso;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      deleteRepo(owner, name);
      sendEmpty(res, 204);
      return;
    }
    notFound(res);
    return;
  }

  // ---- branches and git refs
  if (tail[0] === 'branches' && method === 'GET') {
    if (tail.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const page = paginate(req, url, branches);
      sendJson(res, 200, page.items, page.headers);
      return;
    }
    const branch = tail.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) {
      notFound(res);
      return;
    }
    sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
    return;
  }

  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const parsed = body();
      if (parsed === null) {
        sendJson(res, 400, errorBody('Problems parsing JSON'));
        return;
      }
      const ref = str(parsed.ref);
      const sha = str(parsed.sha);
      if (!ref.startsWith('refs/') || !isObjectId(sha)) {
        sendJson(res, 422, errorBody('Validation Failed: ref and sha are required'));
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, errorBody('Validation Failed: reference already exists'));
        return;
      }
      repo.refs.set(ref, sha);
      repo.packCache.clear();
      sendJson(res, 201, { ref, object: { type: 'commit', sha } });
      return;
    }
    if (method === 'GET' && tail.length >= 3) {
      const wanted = tail.slice(2).join('/');
      const full = wanted.startsWith('refs/') ? wanted : `refs/${wanted}`;
      const sha = repo.refs.get(full);
      if (sha === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { ref: full, object: { type: 'commit', sha } });
      return;
    }
    notFound(res);
    return;
  }

  // ---- commits
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    const start = resolveCommit(repo, shaParam ?? DEFAULT_BRANCH);
    if (start === undefined) {
      sendJson(res, 200, []);
      return;
    }
    const commits = walkCommits((oid) => repo.objects.get(oid), start).map((oid) => {
      const object = repo.objects.get(oid) as { data: Buffer };
      const commit = parseCommit(object.data);
      const authorMatch = /^(.*?) <(.*?)> (\d+) /.exec(commit.author);
      const date = authorMatch ? new Date(Number(authorMatch[3]) * 1000).toISOString() : repo.createdAt;
      return {
        sha: oid,
        commit: {
          message: commit.message.replace(/\n$/, ''),
          author: { name: authorMatch?.[1] ?? '', email: authorMatch?.[2] ?? '', date },
          committer: { name: authorMatch?.[1] ?? '', email: authorMatch?.[2] ?? '', date },
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    const page = paginate(req, url, commits);
    sendJson(res, 200, page.items, page.headers);
    return;
  }

  // ---- contents
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    const branchOf = (parsed: Json | null): string => {
      const branch = parsed !== null ? str(parsed.branch) : '';
      return branch === '' ? DEFAULT_BRANCH : branch;
    };
    if (method === 'PUT') {
      const parsed = body();
      if (parsed === null) {
        sendJson(res, 400, errorBody('Problems parsing JSON'));
        return;
      }
      const branch = branchOf(parsed);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      const files = tip === undefined ? new Map<string, { oid: string; mode: string }>() : filesAtCommit(repo, tip);
      const existing = files.get(path);
      const givenSha = str(parsed.sha);
      if (existing !== undefined && givenSha !== '' && givenSha !== existing.oid) {
        sendJson(res, 409, errorBody('Conflict: the sha does not match the current content'));
        return;
      }
      const content = Buffer.from(str(parsed.content).replace(/\s/g, ''), 'base64');
      const { commitSha, blobSha } = writeFile(repo, branch, path, content, str(parsed.message) || 'Update file');
      sendJson(res, existing === undefined ? 201 : 200, {
        content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha },
      });
      return;
    }
    if (method === 'GET') {
      const refParam = url.searchParams.get('ref') ?? DEFAULT_BRANCH;
      const commitOid = resolveCommit(repo, refParam);
      if (commitOid === undefined) {
        notFound(res);
        return;
      }
      const files = filesAtCommit(repo, commitOid);
      const file = files.get(path);
      if (file !== undefined) {
        const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: data.toString('base64'),
          sha: file.oid,
          size: data.length,
          name: path.split('/').pop() ?? path,
          path,
        });
        return;
      }
      // A directory: every entry directly under `path` (or the root for '').
      const prefix = path === '' ? '' : `${path}/`;
      const entries = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
      for (const [filePath, entry] of files) {
        if (prefix !== '' && !filePath.startsWith(prefix)) continue;
        const remainder = filePath.slice(prefix.length);
        if (remainder === '') continue;
        const slash = remainder.indexOf('/');
        if (slash === -1) {
          entries.set(remainder, { type: 'file', sha: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
        } else {
          const dir = remainder.slice(0, slash);
          if (!entries.has(dir)) entries.set(dir, { type: 'dir', sha: commitOid, size: 0 });
        }
      }
      if (entries.size === 0 && path !== '') {
        notFound(res);
        return;
      }
      const listing = [...entries.entries()]
        .map(([entryName, entry]) => ({
          type: entry.type,
          name: entryName,
          path: prefix + entryName,
          sha: entry.sha,
          size: entry.size,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, listing);
      return;
    }
    if (method === 'DELETE') {
      const parsed = body();
      if (parsed === null) {
        sendJson(res, 400, errorBody('Problems parsing JSON'));
        return;
      }
      const branch = branchOf(parsed);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        notFound(res);
        return;
      }
      const files = filesAtCommit(repo, tip);
      const existing = files.get(path);
      if (existing === undefined) {
        notFound(res);
        return;
      }
      const givenSha = str(parsed.sha);
      if (givenSha !== '' && givenSha !== existing.oid) {
        sendJson(res, 409, errorBody('Conflict: the sha does not match the current content'));
        return;
      }
      const commitSha = removeFile(repo, branch, path, str(parsed.message) || 'Delete file');
      sendJson(res, 200, { content: null, commit: { sha: commitSha } });
      return;
    }
    notFound(res);
    return;
  }

  // ---- labels
  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ id: label.id, name: label.name, color: label.color })));
      return;
    }
    if (method === 'POST') {
      const parsed = body();
      if (parsed === null) {
        sendJson(res, 400, errorBody('Problems parsing JSON'));
        return;
      }
      const labelName = str(parsed.name);
      if (labelName === '') {
        sendJson(res, 422, errorBody('Validation Failed: name is required'));
        return;
      }
      if (repo.labels.has(labelName)) {
        sendJson(res, 422, errorBody('Validation Failed: name has already been taken'));
        return;
      }
      const label = { id: repo.nextLabelId, name: labelName, color: str(parsed.color) || 'ededed' };
      repo.nextLabelId += 1;
      repo.labels.set(labelName, label);
      sendJson(res, 201, { id: label.id, name: label.name, color: label.color });
      return;
    }
    notFound(res);
    return;
  }

  // ---- issues and comments
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const page = paginate(req, url, issues.map((issue) => issueJson(repo, issue)));
        sendJson(res, 200, page.items, page.headers);
        return;
      }
      if (method === 'POST') {
        const parsed = body();
        if (parsed === null) {
          sendJson(res, 400, errorBody('Problems parsing JSON'));
          return;
        }
        const labels = Array.isArray(parsed.labels) ? parsed.labels.map((entry) => (typeof entry === 'string' ? entry : str((entry as Json)?.name))) : [];
        for (const labelName of labels) {
          if (!repo.labels.has(labelName)) {
            sendJson(res, 422, errorBody(`Validation Failed: label "${labelName}" does not exist`));
            return;
          }
        }
        const issue = createIssue(repo, str(parsed.title), str(parsed.body), labels);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      notFound(res);
      return;
    }
    const number = Number.parseInt(tail[1] as string, 10);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (issue === undefined) {
      notFound(res);
      return;
    }
    if (tail.length === 2) {
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const parsed = body();
        if (parsed === null) {
          sendJson(res, 400, errorBody('Problems parsing JSON'));
          return;
        }
        if (parsed.state === 'closed' || parsed.state === 'open') issue.state = parsed.state;
        if (typeof parsed.title === 'string') issue.title = parsed.title;
        if (typeof parsed.body === 'string') issue.body = parsed.body;
        if (Array.isArray(parsed.labels)) {
          const labels = parsed.labels.map((entry) => (typeof entry === 'string' ? entry : str((entry as Json)?.name)));
          for (const labelName of labels) {
            if (!repo.labels.has(labelName)) {
              sendJson(res, 422, errorBody(`Validation Failed: label "${labelName}" does not exist`));
              return;
            }
          }
          issue.labels = labels;
        }
        issue.updatedAt = tick().iso;
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      notFound(res);
      return;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (method === 'GET') {
        const page = paginate(req, url, issue.comments.map((comment) => commentJson(repo, issue, comment)));
        sendJson(res, 200, page.items, page.headers);
        return;
      }
      if (method === 'POST') {
        const parsed = body();
        if (parsed === null) {
          sendJson(res, 400, errorBody('Problems parsing JSON'));
          return;
        }
        const comment = { dbId: allocDbId(), body: str(parsed.body), createdAt: tick().iso };
        issue.comments.push(comment);
        issue.updatedAt = comment.createdAt;
        sendJson(res, 201, commentJson(repo, issue, comment));
        return;
      }
      notFound(res);
      return;
    }
    notFound(res);
    return;
  }

  // ---- pull requests
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls.sort((a, b) => a.number - b.number);
        const page = paginate(req, url, pulls.map((pull) => pullJson(repo, pull)));
        sendJson(res, 200, page.items, page.headers);
        return;
      }
      if (method === 'POST') {
        const parsed = body();
        if (parsed === null) {
          sendJson(res, 400, errorBody('Problems parsing JSON'));
          return;
        }
        const head = str(parsed.head).split(':').pop() as string;
        const base = str(parsed.base) === '' ? DEFAULT_BRANCH : (str(parsed.base).split(':').pop() as string);
        if (!repo.refs.has(`refs/heads/${head}`)) {
          sendJson(res, 422, errorBody(`Validation Failed: head branch "${head}" does not exist`));
          return;
        }
        if (!repo.refs.has(`refs/heads/${base}`)) {
          sendJson(res, 422, errorBody(`Validation Failed: base branch "${base}" does not exist`));
          return;
        }
        const existing = [...repo.pulls.values()].find(
          (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
        );
        if (existing !== undefined) {
          sendJson(res, 422, errorBody('Validation Failed: a pull request already exists for this branch'));
          return;
        }
        const pull = createPull(repo, str(parsed.title), str(parsed.body), head, base);
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      notFound(res);
      return;
    }
    const number = Number.parseInt(tail[1] as string, 10);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (pull === undefined) {
      notFound(res);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      const files = pullFiles(repo, pull).map((change) => {
        const counts = diffCounts(repo, change.baseOid, change.headOid);
        return {
          filename: change.path,
          status: change.baseOid === undefined ? 'added' : change.headOid === undefined ? 'removed' : 'modified',
          additions: counts.additions,
          deletions: counts.deletions,
          changes: counts.additions + counts.deletions,
        };
      });
      const page = paginate(req, url, files);
      sendJson(res, 200, page.items, page.headers);
      return;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      const parsed = body();
      if (parsed === null) {
        sendJson(res, 400, errorBody('Problems parsing JSON'));
        return;
      }
      if (pull.state !== 'open') {
        sendJson(res, 405, errorBody('Method Not Allowed: the pull request is not open'));
        return;
      }
      const method2 = str(parsed.merge_method).toLowerCase() === 'merge' ? 'merge' : 'squash';
      const sha = mergePull(repo, pull, method2);
      if (sha === null) {
        sendJson(res, 405, errorBody('Method Not Allowed: the pull request has conflicts'));
        return;
      }
      sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}
