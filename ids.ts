// ids.ts: Relay-style global ids for the GraphQL surface. An id is the base64 of a clear
// internal address (`Repository:3`, `Issue:3:7`, `PullRequest:3:9`, `IssueComment:3:7:2`),
// which makes it opaque (never the plain database id), stable across reads, and decodable
// by this server alone when a mutation hands one back.

export type GlobalId =
  | { type: 'Repository'; repoId: number }
  | { type: 'Issue'; repoId: number; number: number }
  | { type: 'PullRequest'; repoId: number; number: number }
  | { type: 'IssueComment'; repoId: number; number: number; commentDbId: number };

export function encodeGlobalId(id: GlobalId): string {
  let raw: string;
  switch (id.type) {
    case 'Repository':
      raw = `Repository:${id.repoId}`;
      break;
    case 'Issue':
      raw = `Issue:${id.repoId}:${id.number}`;
      break;
    case 'PullRequest':
      raw = `PullRequest:${id.repoId}:${id.number}`;
      break;
    case 'IssueComment':
      raw = `IssueComment:${id.repoId}:${id.number}:${id.commentDbId}`;
      break;
  }
  return Buffer.from(raw, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): GlobalId | null {
  let raw: string;
  try {
    raw = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = raw.split(':');
  const num = (value: string | undefined): number | null => {
    if (value === undefined || !/^\d+$/.test(value)) return null;
    return Number.parseInt(value, 10);
  };
  if (parts[0] === 'Repository' && parts.length === 2) {
    const repoId = num(parts[1]);
    return repoId === null ? null : { type: 'Repository', repoId };
  }
  if (parts[0] === 'Issue' && parts.length === 3) {
    const repoId = num(parts[1]);
    const number = num(parts[2]);
    return repoId === null || number === null ? null : { type: 'Issue', repoId, number };
  }
  if (parts[0] === 'PullRequest' && parts.length === 3) {
    const repoId = num(parts[1]);
    const number = num(parts[2]);
    return repoId === null || number === null ? null : { type: 'PullRequest', repoId, number };
  }
  if (parts[0] === 'IssueComment' && parts.length === 4) {
    const repoId = num(parts[1]);
    const number = num(parts[2]);
    const commentDbId = num(parts[3]);
    return repoId === null || number === null || commentDbId === null
      ? null
      : { type: 'IssueComment', repoId, number, commentDbId };
  }
  return null;
}
