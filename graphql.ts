// graphql.ts: the GraphQL surface at /api/graphql. A small hand-written parser and executor
// (the suite's query shapes are fixed and known) over the same store the REST and MCP
// surfaces use: viewer, repository, node, the issue and pull-request connections with cursor
// pagination, the five mutations the suite drives, and the slice of introspection it reads
// (__type with fields and enumValues). Global ids are the opaque relay ids from ids.ts, so a
// GraphQL-created issue is the same object REST reads, and an id handed to a mutation decodes
// back to the same record. An array request body answers an array of results, in order.

import { decodeGlobalId, encodeGlobalId, type GlobalId } from './ids.ts';
import {
  VIEWER,
  allocDbId,
  createIssue,
  createPull,
  getRepo,
  listRepos,
  mergePull,
  pullFiles,
  simulateMerge,
  tick,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

// ---------------------------------------------------------------- tokenizer and parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$=!@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias?: string;
  args: Array<{ name: string; value: Value }>;
  selection?: Selection[];
}
type Selection =
  | FieldNode
  | { kind: 'inlineFragment'; typeName: string; selection: Selection[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  selection: Selection[];
  variableDefaults: Map<string, Value>;
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeName: string; selection: Selection[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected '${value}' in GraphQL document`);
  }
  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }
  private name(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('Expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeName: string; selection: Selection[] }>();
    while (this.pos < this.tokens.length) {
      if (this.atPunct('{')) {
        operations.push({ type: 'query', selection: this.selectionSet(), variableDefaults: new Map() });
        continue;
      }
      const keyword = this.name();
      if (keyword === 'query' || keyword === 'mutation') {
        if (this.peek()?.kind === 'name') this.next(); // operation name
        const variableDefaults = new Map<string, Value>();
        if (this.atPunct('(')) {
          this.next();
          while (!this.atPunct(')')) {
            this.expectPunct('$');
            const varName = this.name();
            this.expectPunct(':');
            this.typeRef();
            if (this.atPunct('=')) {
              this.next();
              variableDefaults.set(varName, this.value());
            }
            if (this.atPunct('@')) this.directives();
          }
          this.next();
        }
        if (this.atPunct('@')) this.directives();
        operations.push({ type: keyword, selection: this.selectionSet(), variableDefaults });
      } else if (keyword === 'fragment') {
        const fragName = this.name();
        const on = this.name();
        if (on !== 'on') throw new Error('Expected `on` in fragment definition');
        const typeName = this.name();
        fragments.set(fragName, { typeName, selection: this.selectionSet() });
      } else {
        throw new Error(`Unexpected definition '${keyword}'`);
      }
    }
    return { operations, fragments };
  }

  private typeRef(): void {
    if (this.atPunct('[')) {
      this.next();
      this.typeRef();
      this.expectPunct(']');
    } else {
      this.name();
    }
    if (this.atPunct('!')) this.next();
  }

  private directives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.name();
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          this.name();
          this.expectPunct(':');
          this.value();
        }
        this.next();
      }
    }
  }

  private selectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.atPunct('}')) {
      if (this.atPunct('...')) {
        this.next();
        const token = this.peek();
        if (token?.kind === 'name' && token.value === 'on') {
          this.next();
          const typeName = this.name();
          if (this.atPunct('@')) this.directives();
          selections.push({ kind: 'inlineFragment', typeName, selection: this.selectionSet() });
        } else {
          selections.push({ kind: 'fragmentSpread', name: this.name() });
        }
        continue;
      }
      let name = this.name();
      let alias: string | undefined;
      if (this.atPunct(':')) {
        this.next();
        alias = name;
        name = this.name();
      }
      const args: FieldNode['args'] = [];
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          const argName = this.name();
          this.expectPunct(':');
          args.push({ name: argName, value: this.value() });
        }
        this.next();
      }
      if (this.atPunct('@')) this.directives();
      const selection = this.atPunct('{') ? this.selectionSet() : undefined;
      selections.push({ kind: 'field', name, alias, args, selection });
    }
    this.next();
    return selections;
  }

  private value(): Value {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.name() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.atPunct(']')) items.push(this.value());
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.atPunct('}')) {
        const fieldName = this.name();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.value() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error('Unexpected value in GraphQL document');
  }
}

function evalValue(value: Value, variables: Record<string, unknown>, defaults: Map<string, Value>): unknown {
  switch (value.kind) {
    case 'variable': {
      if (value.name in variables) return variables[value.name];
      const fallback = defaults.get(value.name);
      return fallback === undefined ? undefined : evalValue(fallback, variables, defaults);
    }
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => evalValue(item, variables, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalValue(field.value, variables, defaults);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema description (introspection)

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'isPrivate', 'description', 'issue', 'issues', 'pullRequest', 'pullRequests',
  ],
  Ref: ['name', 'target'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'repository', 'comments', 'labels'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'author',
  ],
  IssueComment: ['id', 'body', 'author'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  State: ['OPEN', 'CLOSED'],
};

// ---------------------------------------------------------------- wrapped domain values

type Wrapped =
  | { __typename: 'User' }
  | { __typename: 'Repository'; repo: RepoRec }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { __typename: 'PullRequest'; repo: RepoRec; pull: PullRec }
  | { __typename: 'IssueComment'; repo: RepoRec; issue: IssueRec; commentDbId: number; body: string }
  | { __typename: 'IssueConnection'; nodes: Array<Extract<Wrapped, { __typename: 'Issue' }>>; endCursor: string | null; hasNextPage: boolean }
  | { __typename: 'PullRequestConnection'; nodes: Array<Extract<Wrapped, { __typename: 'PullRequest' }>>; endCursor: string | null; hasNextPage: boolean }
  | { __typename: 'PullRequestFile'; path: string }
  | { __typename: 'PullRequestFileConnection'; nodes: Array<{ __typename: 'PullRequestFile'; path: string }>; endCursor: string | null; hasNextPage: boolean }
  | { __typename: 'PageInfo'; endCursor: string | null; hasNextPage: boolean }
  | { __typename: 'CreateIssuePayload'; issue: Extract<Wrapped, { __typename: 'Issue' }> }
  | { __typename: 'CloseIssuePayload'; issue: Extract<Wrapped, { __typename: 'Issue' }> }
  | { __typename: 'CreatePullRequestPayload'; pull: Extract<Wrapped, { __typename: 'PullRequest' }> }
  | { __typename: 'MergePullRequestPayload'; pull: Extract<Wrapped, { __typename: 'PullRequest' }> }
  | { __typename: 'AddCommentPayload'; comment: Extract<Wrapped, { __typename: 'IssueComment' }> }
  | { __typename: 'IssueCommentEdge'; node: Extract<Wrapped, { __typename: 'IssueComment' }> }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string };

type Scalar = string | number | boolean | null;

class GqlError extends Error {}

const cursorOf = (index: number): string => Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
function indexOfCursor(after: unknown): number {
  if (typeof after !== 'string') return -1;
  try {
    const raw = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(raw);
    return match ? Number.parseInt(match[1] as string, 10) : -1;
  } catch {
    return -1;
  }
}

function paged<T>(items: readonly T[], args: Record<string, unknown>): { slice: T[]; endCursor: string | null; hasNextPage: boolean } {
  const start = indexOfCursor(args.after) + 1;
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : items.length;
  const slice = items.slice(start, start + first);
  const lastIndex = start + slice.length - 1;
  return {
    slice,
    endCursor: slice.length === 0 ? null : cursorOf(lastIndex),
    hasNextPage: start + slice.length < items.length,
  };
}

function repoById(repoId: number): RepoRec | undefined {
  return listRepos().find((repo) => repo.id === repoId);
}

// ---------------------------------------------------------------- field resolution

function resolveField(obj: Wrapped | null, field: string, args: Record<string, unknown>): Wrapped | Scalar | Array<Wrapped | Scalar> {
  if (obj === null) throw new GqlError('Cannot resolve a field on null');
  switch (obj.__typename) {
    case '__Type': {
      if (field === 'name') return obj.name;
      if (field === 'kind') return ENUM_VALUES[obj.name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field === 'fields') {
        const names = OBJECT_FIELDS[obj.name];
        return names === undefined ? null : names.map((name) => ({ __typename: '__Field', name }) as Wrapped);
      }
      if (field === 'enumValues') {
        const values = ENUM_VALUES[obj.name];
        return values === undefined ? null : values.map((name) => ({ __typename: '__EnumValue', name }) as Wrapped);
      }
      throw new GqlError(`Field '${field}' doesn't exist on type '__Type'`);
    }
    case '__Field':
    case '__EnumValue':
      if (field === 'name') return obj.name;
      throw new GqlError(`Field '${field}' doesn't exist on type '${obj.__typename}'`);
    case 'User':
      if (field === 'login') return VIEWER.login;
      if (field === 'name') return VIEWER.name;
      if (field === 'email') return VIEWER.email;
      if (field === 'databaseId') return VIEWER.id;
      if (field === 'id') return Buffer.from(`User:${VIEWER.id}`, 'utf8').toString('base64');
      break;
    case 'Repository': {
      const { repo } = obj;
      switch (field) {
        case 'id': return encodeGlobalId({ type: 'Repository', repoId: repo.id });
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __typename: 'User' };
        case 'isPrivate': return repo.isPrivate;
        case 'description': return repo.description;
        case 'hasIssuesEnabled': return true;
        case 'viewerPermission': return 'ADMIN';
        case 'defaultBranchRef': {
          return repo.refs.has('refs/heads/main') ? { __typename: 'Ref', name: 'main' } : null;
        }
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : { __typename: 'Issue', repo, issue };
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const states = args.states;
          if (Array.isArray(states)) {
            const wanted = states.map((state) => String(state).toLowerCase());
            issues = issues.filter((issue) => wanted.includes(issue.state));
          }
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          if (orderBy?.direction === 'DESC') issues.sort((a, b) => b.number - a.number);
          else if (orderBy?.direction === 'ASC') issues.sort((a, b) => a.number - b.number);
          else issues.sort((a, b) => a.number - b.number);
          const page = paged(issues, args);
          return {
            __typename: 'IssueConnection',
            nodes: page.slice.map((issue) => ({ __typename: 'Issue', repo, issue }) as Wrapped),
            endCursor: page.endCursor,
            hasNextPage: page.hasNextPage,
          } as Wrapped;
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const states = args.states;
          if (Array.isArray(states)) {
            const wanted = states.map((state) => String(state).toUpperCase());
            pulls = pulls.filter((pull) => wanted.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          }
          pulls.sort((a, b) => a.number - b.number);
          const page = paged(pulls, args);
          return {
            __typename: 'PullRequestConnection',
            nodes: page.slice.map((pull) => ({ __typename: 'PullRequest', repo, pull }) as Wrapped),
            endCursor: page.endCursor,
            hasNextPage: page.hasNextPage,
          } as Wrapped;
        }
      }
      break;
    }
    case 'Ref':
      if (field === 'name') return obj.name;
      break;
    case 'Issue': {
      const { issue } = obj;
      switch (field) {
        case 'id': return encodeGlobalId({ type: 'Issue', repoId: obj.repo.id, number: issue.number });
        case 'databaseId': return issue.dbId;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'author': return { __typename: 'User' };
        case 'repository': return { __typename: 'Repository', repo: obj.repo };
      }
      break;
    }
    case 'PullRequest': {
      const { pull, repo } = obj;
      switch (field) {
        case 'id': return encodeGlobalId({ type: 'PullRequest', repoId: repo.id, number: pull.number });
        case 'databaseId': return pull.dbId;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'author': return { __typename: 'User' };
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return simulateMerge(repo, pull).ok ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'files': {
          const files = pullFiles(repo, pull).map((change) => ({ path: change.path }));
          const page = paged(files, args);
          return {
            __typename: 'PullRequestFileConnection',
            nodes: page.slice.map((file) => ({ __typename: 'PullRequestFile', path: file.path })),
            endCursor: page.endCursor,
            hasNextPage: page.hasNextPage,
          } as Wrapped;
        }
      }
      break;
    }
    case 'PullRequestFile':
      if (field === 'path') return obj.path;
      if (field === 'additions') return 0;
      if (field === 'deletions') return 0;
      break;
    case 'IssueComment':
      if (field === 'id') {
        return encodeGlobalId({ type: 'IssueComment', repoId: obj.repo.id, number: obj.issue.number, commentDbId: obj.commentDbId });
      }
      if (field === 'body') return obj.body;
      if (field === 'author') return { __typename: 'User' };
      break;
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
      if (field === 'nodes') return obj.nodes as unknown as Array<Wrapped | Scalar>;
      if (field === 'totalCount') return obj.nodes.length;
      if (field === 'pageInfo') return { __typename: 'PageInfo', endCursor: obj.endCursor, hasNextPage: obj.hasNextPage };
      break;
    case 'PageInfo':
      if (field === 'endCursor') return obj.endCursor;
      if (field === 'startCursor') return obj.endCursor;
      if (field === 'hasNextPage') return obj.hasNextPage;
      if (field === 'hasPreviousPage') return false;
      break;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (field === 'issue') return obj.issue as unknown as Wrapped;
      if (field === 'clientMutationId') return null;
      break;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field === 'pullRequest') return obj.pull as unknown as Wrapped;
      if (field === 'clientMutationId') return null;
      break;
    case 'AddCommentPayload':
      if (field === 'commentEdge') return { __typename: 'IssueCommentEdge', node: obj.comment } as unknown as Wrapped;
      if (field === 'clientMutationId') return null;
      break;
    case 'IssueCommentEdge':
      if (field === 'node') return obj.node as unknown as Wrapped;
      if (field === 'cursor') return cursorOf(0);
      break;
  }
  throw new GqlError(`Field '${field}' doesn't exist on type '${obj.__typename}'`);
}

// ---------------------------------------------------------------- root fields

function resolveRoot(type: 'query' | 'mutation', field: string, args: Record<string, unknown>): Wrapped | Scalar {
  if (type === 'query') {
    switch (field) {
      case 'viewer':
        return { __typename: 'User' };
      case 'repository': {
        const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : { __typename: 'Repository', repo };
      }
      case 'node': {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        return nodeFor(decoded);
      }
      case '__type':
        return { __typename: '__Type', name: String(args.name ?? '') };
      case '__typename':
        return 'Query';
    }
    throw new GqlError(`Field '${field}' doesn't exist on type 'Query'`);
  }
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field) {
    case 'createIssue': {
      const repo = repoById(Number(String(decodeRepoId(input.repositoryId))));
      if (repo === undefined) throw new GqlError('Repository not found');
      const issue = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } } as Wrapped;
    }
    case 'closeIssue': {
      const found = findIssue(input.issueId);
      if (found === undefined) throw new GqlError('Issue not found');
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo: found.repo, issue: found.issue } } as Wrapped;
    }
    case 'createPullRequest': {
      const repo = repoById(Number(String(decodeRepoId(input.repositoryId))));
      if (repo === undefined) throw new GqlError('Repository not found');
      const headRefName = String(input.headRefName ?? '');
      const baseRefName = String(input.baseRefName ?? 'main');
      if (!repo.refs.has(`refs/heads/${headRefName}`)) throw new GqlError(`Head branch "${headRefName}" does not exist`);
      if (!repo.refs.has(`refs/heads/${baseRefName}`)) throw new GqlError(`Base branch "${baseRefName}" does not exist`);
      const pull = createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRefName, baseRefName);
      return { __typename: 'CreatePullRequestPayload', pull: { __typename: 'PullRequest', repo, pull } } as Wrapped;
    }
    case 'mergePullRequest': {
      const found = findPull(input.pullRequestId);
      if (found === undefined) throw new GqlError('Pull request not found');
      if (found.pull.state !== 'open') throw new GqlError('Pull request is not open');
      const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase() === 'merge' ? 'merge' : 'squash';
      const sha = mergePull(found.repo, found.pull, method);
      if (sha === null) throw new GqlError('Pull request has conflicts');
      return { __typename: 'MergePullRequestPayload', pull: { __typename: 'PullRequest', repo: found.repo, pull: found.pull } } as Wrapped;
    }
    case 'addComment': {
      const found = findIssue(input.subjectId);
      if (found === undefined) throw new GqlError('Subject not found');
      const comment = { dbId: allocDbId(), body: String(input.body ?? ''), createdAt: tick().iso };
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        comment: { __typename: 'IssueComment', repo: found.repo, issue: found.issue, commentDbId: comment.dbId, body: comment.body },
      } as unknown as Wrapped;
    }
  }
  throw new GqlError(`Field '${field}' doesn't exist on type 'Mutation'`);
}

function decodeRepoId(id: unknown): number | null {
  const decoded = decodeGlobalId(String(id ?? ''));
  return decoded !== null && decoded.type === 'Repository' ? decoded.repoId : null;
}

function findIssue(id: unknown): { repo: RepoRec; issue: IssueRec } | undefined {
  const decoded = decodeGlobalId(String(id ?? ''));
  if (decoded === null || decoded.type !== 'Issue') return undefined;
  const repo = repoById(decoded.repoId);
  const issue = repo?.issues.get(decoded.number);
  return repo !== undefined && issue !== undefined ? { repo, issue } : undefined;
}

function findPull(id: unknown): { repo: RepoRec; pull: PullRec } | undefined {
  const decoded = decodeGlobalId(String(id ?? ''));
  if (decoded === null || decoded.type !== 'PullRequest') return undefined;
  const repo = repoById(decoded.repoId);
  const pull = repo?.pulls.get(decoded.number);
  return repo !== undefined && pull !== undefined ? { repo, pull } : undefined;
}

function nodeFor(decoded: GlobalId): Wrapped | null {
  switch (decoded.type) {
    case 'Repository': {
      const repo = repoById(decoded.repoId);
      return repo === undefined ? null : { __typename: 'Repository', repo };
    }
    case 'Issue': {
      const found = findIssue(encodeGlobalId(decoded));
      return found === undefined ? null : { __typename: 'Issue', repo: found.repo, issue: found.issue };
    }
    case 'PullRequest': {
      const found = findPull(encodeGlobalId(decoded));
      return found === undefined ? null : { __typename: 'PullRequest', repo: found.repo, pull: found.pull };
    }
    case 'IssueComment':
      return null;
  }
}

// ---------------------------------------------------------------- selection application

interface ExecContext {
  variables: Record<string, unknown>;
  defaults: Map<string, Value>;
  fragments: Map<string, { typeName: string; selection: Selection[] }>;
  errors: Array<{ message: string }>;
}

function applySelection(
  value: Wrapped | Scalar | Array<Wrapped | Scalar>,
  selection: Selection[] | undefined,
  ctx: ExecContext,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => (item !== null && typeof item === 'object' ? applySelection(item, selection, ctx) : item));
  }
  if (selection === undefined) return null;
  const out: Record<string, unknown> = {};
  const walk = (selections: Selection[]): void => {
    for (const sel of selections) {
      if (sel.kind === 'inlineFragment') {
        if (sel.typeName === value.__typename) walk(sel.selection);
        continue;
      }
      if (sel.kind === 'fragmentSpread') {
        const fragment = ctx.fragments.get(sel.name);
        if (fragment !== undefined && fragment.typeName === value.__typename) walk(fragment.selection);
        continue;
      }
      const key = sel.alias ?? sel.name;
      if (sel.name === '__typename') {
        out[key] = value.__typename;
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const arg of sel.args) args[arg.name] = evalValue(arg.value, ctx.variables, ctx.defaults);
      try {
        const resolved = resolveField(value, sel.name, args);
        out[key] = applySelection(resolved, sel.selection, ctx);
      } catch (err) {
        if (err instanceof GqlError) {
          ctx.errors.push({ message: err.message });
          out[key] = null;
        } else {
          throw err;
        }
      }
    }
  };
  walk(selection);
  return out;
}

/** Execute one GraphQL operation object ({query, variables}) and return the result body. */
export function executeGraphQL(request: { query?: unknown; variables?: unknown }): Record<string, unknown> {
  const query = typeof request.query === 'string' ? request.query : '';
  const variables = (request.variables ?? {}) as Record<string, unknown>;
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const operation = document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation in document' }] };
  const ctx: ExecContext = { variables, defaults: operation.variableDefaults, fragments: document.fragments, errors: [] };
  const data: Record<string, unknown> = {};
  for (const sel of operation.selection) {
    if (sel.kind !== 'field') continue;
    const key = sel.alias ?? sel.name;
    const args: Record<string, unknown> = {};
    for (const arg of sel.args) args[arg.name] = evalValue(arg.value, variables, operation.variableDefaults);
    try {
      const resolved = resolveRoot(operation.type, sel.name, args);
      data[key] = applySelection(resolved, sel.selection, ctx);
    } catch (err) {
      if (err instanceof GqlError) {
        ctx.errors.push({ message: err.message });
        data[key] = null;
      } else {
        throw err;
      }
    }
  }
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
