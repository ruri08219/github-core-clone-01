# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ruri08219/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ruri08219/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built for make.fun's [GitHub Core Clone](https://make.fun/bounty/github-core-clone-01) bounty ($500 in USDC).

A standalone GitHub-compatible git forge in one Node 22 process, no UI, no
database, no outside service. It serves the four surfaces agents already
speak, from one in-memory store:

- **git smart HTTP** — protocol v2 upload-pack (`ls-refs`, `fetch`, shallow
  clones and deepen), v0 receive-pack (`report-status-v2`, `side-band-64k`,
  `delete-refs`, fast-forward enforcement per ref), pkt-line framing and
  version-2 packs (plain objects, no deltas; OFS/REF deltas resolved on read).
- **REST v3** (`/api/v3`) — repositories, branches, commits, contents,
  labels, issues, comments and pull requests, including squash merges with
  three-way conflict detection, plus the wire discipline the suite checks:
  JSON everywhere, JSON 404s, 400 on malformed bodies, `X-GitHub-Request-Id`
  on every reply, `Link` pagination.
- **GraphQL v4** (`/api/graphql`) — the documents `gh` and
  `github-mcp-server` actually send: `viewer`, `repository`, `node(id:)`,
  `__type` introspection, issue/pull-request reads, `createIssue`,
  `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`,
  cursor pagination, and operation batching. Global ids are opaque and stable.
- **MCP** (`/mcp`) — streamable HTTP, the modern `2026-07-28` era
  (`server/discover`, no session) and the legacy handshake era
  (`initialize` + `notifications/initialized`): `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`, `get_issue`, `list_pull_requests`.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry ↔ env lifecycle (bind an ephemeral port, register it
at `$MAKEFUN_ENV_URL`, poll `/done`, exit 0). `app.ts` is the server; the
store lives in `store.ts`, the git protocol in `gitproto.ts`, REST in
`rest.ts`, GraphQL in `graphql.ts`, MCP in `mcp.ts`.

## Determinism

Commit timestamps and REST timestamps are fixed constants, and the token's
owner is derived from the competition's public scenario seed, so two runs on
the same requests produce the same object ids and the same export.

## Local grading

```sh
node --experimental-strip-types local-run.ts   # listens on 127.0.0.1:18080
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18080 --token test-token --perf --json
```

(`local-run.ts` is a test harness, not part of the entry.)
