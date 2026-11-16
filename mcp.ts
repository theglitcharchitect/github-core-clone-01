// mcp.ts: the MCP endpoint at /mcp, speaking JSON-RPC 2.0 over streamable HTTP in both eras
// the suite probes: the modern server/discover handshake (protocol 2026-07-28) and the legacy
// initialize handshake (2025-11-25 and earlier). The handler is stateless: every request is
// answered from the shared store on its own, ids are echoed untouched, and tools/list returns
// one serialized constant so two calls are byte-identical. Tools are thin wrappers over the
// same records REST serves, so an object created here reads back identically over REST.

import type { ServerResponse } from 'node:http';
import { sendEmpty, sendJson } from './http.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { createIssue, createPull, createRepo, getRepo, listRepos, mergePull, type RepoRec } from './store.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type Json = Record<string, unknown>;

const strProp = (description: string): Json => ({ type: 'string', description });
const TOOLS: Json[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated viewer.',
    inputSchema: {
      type: 'object',
      properties: { name: strProp('Repository name'), description: strProp('Repository description'), private: { type: 'boolean', description: 'Whether the repository is private' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: strProp('Repository owner login'), repo: strProp('Repository name') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated viewer.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: strProp('Repository owner login'), repo: strProp('Repository name'), title: strProp('Issue title'), body: strProp('Issue body') },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: {
      type: 'object',
      properties: { owner: strProp('Repository owner login'), repo: strProp('Repository name'), issue_number: { type: 'number', description: 'Issue number' } },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: { owner: strProp('Repository owner login'), repo: strProp('Repository name'), state: strProp('open, closed, or all') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'close_issue',
    description: 'Close an open issue.',
    inputSchema: {
      type: 'object',
      properties: { owner: strProp('Repository owner login'), repo: strProp('Repository name'), issue_number: { type: 'number', description: 'Issue number' } },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Repository owner login'),
        repo: strProp('Repository name'),
        title: strProp('Pull request title'),
        body: strProp('Pull request body'),
        head: strProp('Head branch name'),
        base: strProp('Base branch name'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request (squash by default).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: strProp('Repository owner login'),
        repo: strProp('Repository name'),
        pull_number: { type: 'number', description: 'Pull request number' },
        merge_method: strProp('squash or merge'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolOk(value: unknown): Json {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function toolError(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function needRepo(args: Json): RepoRec {
  const repo = getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  if (repo === undefined) throw new Error(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
  return repo;
}

function callTool(name: string, args: Json): Json {
  switch (name) {
    case 'create_repo': {
      const created = createRepo(String(args.name ?? ''), args.private === true, String(args.description ?? ''));
      if (created === null) return toolError(`Repository "${String(args.name)}" already exists`);
      return toolOk(repoJson(created));
    }
    case 'get_repo':
      return toolOk(repoJson(needRepo(args)));
    case 'list_repos':
      return toolOk({ repositories: listRepos().map(repoJson) });
    case 'create_issue': {
      const repo = needRepo(args);
      const issue = createIssue(repo, String(args.title ?? ''), String(args.body ?? ''), []);
      return toolOk(issueJson(repo, issue));
    }
    case 'get_issue': {
      const repo = needRepo(args);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return toolError(`Issue ${String(args.issue_number)} not found`);
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = needRepo(args);
      const state = typeof args.state === 'string' ? args.state : 'all';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return toolOk({ issues: issues.map((issue) => issueJson(repo, issue)) });
    }
    case 'close_issue': {
      const repo = needRepo(args);
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return toolError(`Issue ${String(args.issue_number)} not found`);
      issue.state = 'closed';
      return toolOk(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = needRepo(args);
      const head = String(args.head ?? '');
      const base = String(args.base ?? 'main');
      if (!repo.refs.has(`refs/heads/${head}`)) return toolError(`Head branch "${head}" does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return toolError(`Base branch "${base}" does not exist`);
      const pull = createPull(repo, String(args.title ?? ''), String(args.body ?? ''), head, base);
      return toolOk(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = needRepo(args);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolError(`Pull request ${String(args.pull_number)} not found`);
      if (pull.state !== 'open') return toolError('Pull request is not open');
      const method = String(args.merge_method ?? 'squash').toLowerCase() === 'merge' ? 'merge' : 'squash';
      const sha = mergePull(repo, pull, method);
      if (sha === null) return toolError('Pull request has conflicts');
      return toolOk({ sha, merged: true, pull_request: pullJson(repo, pull) });
    }
    default:
      throw new UnknownTool(name);
  }
}

class UnknownTool extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
  }
}

interface RpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Json;
}

function handleMessage(message: RpcMessage): Json | null {
  const id = message.id ?? null;
  const method = typeof message.method === 'string' ? message.method : '';
  const isNotification = message.id === undefined;
  if (method.startsWith('notifications/')) return null;
  switch (method) {
    case 'server/discover':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    case 'initialize': {
      const requested = (message.params as Json | undefined)?.protocolVersion;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof requested === 'string' ? requested : '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const params = (message.params ?? {}) as Json;
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Json;
      const tool = TOOLS.find((entry) => entry.name === name);
      if (tool === undefined) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      }
      const required = ((tool.inputSchema as Json).required as string[] | undefined) ?? [];
      for (const key of required) {
        if (args[key] === undefined || args[key] === null || args[key] === '') {
          return { jsonrpc: '2.0', id, result: toolError(`Missing required argument: ${key}`) };
        }
      }
      try {
        return { jsonrpc: '2.0', id, result: callTool(name, args) };
      } catch (err) {
        if (err instanceof UnknownTool) return { jsonrpc: '2.0', id, error: { code: -32602, message: err.message } };
        return { jsonrpc: '2.0', id, result: toolError(err instanceof Error ? err.message : 'Tool failed') };
      }
    }
    default:
      if (isNotification) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

/** Handle one POST /mcp. Auth has already run; a non-JSON body is a -32700 parse error. */
export function handleMcp(res: ServerResponse, rawBody: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => handleMessage(entry as RpcMessage))
      .filter((entry) => entry !== null);
    sendJson(res, 200, responses);
    return;
  }
  const response = handleMessage(parsed as RpcMessage);
  if (response === null) {
    sendEmpty(res, 202);
    return;
  }
  sendJson(res, 200, response);
}
