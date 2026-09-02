# forgejo-mcp-server

An [MCP](https://modelcontextprotocol.io) server for Forgejo: it gives an
assistant (Claude Code, Cursor…) what it needs to read a repository and manage
issues and pull requests without leaving the working session.

It works against any Forgejo instance: the target URL is an environment
variable, never a hardcoded value.

## Security model

**The server holds no authority of its own.** It does not own a token — it
relays the caller's, and without one it can do nothing.

| | Token source |
|---|---|
| `stdio` (local) | the user's own `FORGEJO_TOKEN` environment variable |
| `http` (Railway) | the `Authorization` header of **every request** |

This is not cosmetic. A single server-side token would mean three things: every
write attributed to one person in the Forgejo history, individual permissions
bypassed, and a public URL handing Forgejo access to whoever finds it. The
server **refuses to start** in `http` mode if `FORGEJO_TOKEN` is set.

Two further guards:

- **The instance URL is fixed server-side**, never supplied by the caller, so a
  model cannot redirect the server at another host (SSRF).
- **Path segments are encoded** one by one, which neutralises `..` and slashes
  injected into `owner`, `repo` or a file path.

The token is never logged, and never echoed back in an error message.

## Forgejo token

Create one at `<instance>/user/settings/applications` with these scopes:

| Scope | What it allows |
|---|---|
| `read:user` | `forgejo_whoami` and the repository list (`/user` endpoints) |
| `write:issue` | creating and commenting on issues |
| `write:repository` | creating pull requests, reading files, branches and commits |

⚠️ **Forgejo cannot separate "create a PR" from "write files"**: both live in
`write:repository`. The token is therefore broader than the tools exposed here —
no tool in this server modifies a file, but the token itself would allow it
through the API.

An existing token cannot be widened: adding a scope means issuing a new one.

## Tools

| Tool | Access | Purpose |
|---|---|---|
| `forgejo_whoami` | read | token identity (check before writing) |
| `forgejo_list_repos` | read | accessible repositories |
| `forgejo_list_issues` | read | issues, filterable by state/labels/text |
| `forgejo_get_issue` | read | full issue + comments |
| `forgejo_create_issue` | **write** | open an issue (labels by name) |
| `forgejo_comment_issue` | **write** | comment on an issue or a PR |
| `forgejo_list_pull_requests` | read | pull requests by state |
| `forgejo_get_pull_request` | read | full PR, optional diff |
| `forgejo_create_pull_request` | **write** | open a PR between two branches |
| `forgejo_list_branches` | read | branches and protection |
| `forgejo_list_commits` | read | a branch's history |
| `forgejo_get_file` | read | file or directory at a revision |

All of them accept `response_format` (`markdown` by default, `json` for raw
data) and cap their response at 25,000 characters, reporting any cut.

## Local use (stdio)

```bash
pnpm install
pnpm build
```

The token comes from the shell environment, so it is never written to a
versioned file:

```bash
export FORGEJO_TOKEN="<your token>"
claude mcp add forgejo -e FORGEJO_URL=https://forgejo.example.org -e FORGEJO_TOKEN=$FORGEJO_TOKEN -- node /absolute/path/to/dist/index.js
```

## Railway deployment (http)

Connect the repository as a Railway service, then set:

| Variable | Value |
|---|---|
| `FORGEJO_URL` | your instance, e.g. `https://forgejo.example.org` |
| `TRANSPORT` | `http` |
| `PORT` | `3000` — and use **the same value** as the domain's target port |
| `FORGEJO_DEFAULT_OWNER` | optional, saves repeating `owner` on every call |
| `FORGEJO_DEFAULT_REPO` | optional, saves repeating `repo` on every call |

Railway requires the domain's target port to be exactly the one the service
listens on, otherwise the platform returns "Application failed to respond". The
server listens on `0.0.0.0:$PORT`: setting `PORT` explicitly and reusing the
same value for the domain removes any ambiguity.

**Never set `FORGEJO_TOKEN`** on the service: the server refuses to start,
precisely to prevent that mistake.

`railway.json` supplies the build, start command and `/healthz` probe.

Each developer then registers the server with **their own** token:

```bash
claude mcp add --transport http forgejo https://<service>.up.railway.app/mcp \
  --header "Authorization: Bearer <your forgejo token>"
```

The service being public is acceptable precisely because a call without a valid
token grants nothing. `/healthz` only reports the instance URL and the version.

## Development

```bash
pnpm dev        # tsc --watch
pnpm typecheck
pnpm start      # node dist/index.js
```

Quick check without an MCP client:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | FORGEJO_URL="https://forgejo.example.org" FORGEJO_TOKEN="x" node dist/index.js
```

## Known limitations

- No PR merging, no reviews, no label or milestone management: the scope stops
  at reading, opening and commenting.
- `forgejo_create_issue` only applies **existing** labels; unknown names are
  skipped and reported in the response.
- Binary files are not decoded (size and SHA only).
- Pagination is capped at 50 items per page, the Forgejo API limit.
