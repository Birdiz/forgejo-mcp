// MCP tool declarations.
//
// The Forgejo client is injected: in stdio it carries the environment token, in
// HTTP the one from the current request. No tool knows where it came from.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, CHARACTER_LIMIT } from "./constants.js";
import {
  ForgejoClient,
  describeError,
  encodeFilePath,
  encodePath,
} from "./forgejo.js";
import {
  RESPONSE_FORMATS,
  type ResponseFormat,
  type ToolResult,
  branchLine,
  commitLine,
  errorResult,
  issueDetail,
  issueLine,
  labelNames,
  listResult,
  oneLine,
  pullDetail,
  pullLine,
  repoLine,
  singleResult,
  truncateBlob,
} from "./format.js";
import type {
  ForgejoBranch,
  ForgejoComment,
  ForgejoCommit,
  ForgejoFileContent,
  ForgejoIssue,
  ForgejoLabel,
  ForgejoPullRequest,
  ForgejoRepo,
  ForgejoUser,
} from "./types.js";

/** Usage error: surfaced verbatim to the agent, bypassing describeError. */
class UsageError extends Error {}

export interface RepoDefaults {
  owner?: string;
  repo?: string;
}

// --- Reused schema fragments ----------------------------------------------

const repoShape = {
  owner: z
    .string()
    .min(1)
    .optional()
    .describe("Repository owner (user or organisation). Defaults to FORGEJO_DEFAULT_OWNER."),
  repo: z
    .string()
    .min(1)
    .optional()
    .describe("Repository name. Defaults to FORGEJO_DEFAULT_REPO."),
};

const paginationShape = {
  page: z.number().int().min(1).default(1).describe("Page to fetch, 1 = first."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe(`Items per page (max ${MAX_PAGE_SIZE}).`),
};

const formatShape = {
  response_format: z
    .enum(RESPONSE_FORMATS)
    .default("markdown")
    .describe("'markdown' for a readable rendering, 'json' for the full data."),
};

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const writeCreate = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

// Updating overwrites fields that already hold content, hence destructiveHint.
// Applying the same patch twice lands on the same state, hence idempotent.
const writeUpdate = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// --- Shared helpers --------------------------------------------------------

/** Runs a handler, converting any failure into an actionable response. */
async function run(handler: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof UsageError) return errorResult(error.message);
    return errorResult(describeError(error));
  }
}

/** Resolves owner/repo from the call parameters, then the environment defaults. */
function resolveRepo(
  params: { owner?: string; repo?: string },
  defaults: RepoDefaults,
): { owner: string; repo: string; slug: string } {
  const owner = params.owner ?? defaults.owner;
  const repo = params.repo ?? defaults.repo;
  if (!owner || !repo) {
    throw new UsageError(
      "Error: repository not determined. Pass 'owner' and 'repo' in the call, or set FORGEJO_DEFAULT_OWNER and FORGEJO_DEFAULT_REPO server-side.",
    );
  }
  return { owner, repo, slug: encodePath(owner, repo) };
}

/** Translates label names into the identifiers the API expects. */
async function resolveLabelIds(
  client: ForgejoClient,
  slug: string,
  names: string[],
): Promise<{ ids: number[]; unresolved: string[] }> {
  if (names.length === 0) return { ids: [], unresolved: [] };
  const { items } = await client.getList<ForgejoLabel>(`/repos/${slug}/labels`, {
    limit: MAX_PAGE_SIZE,
  });
  const byName = new Map(items.map((label) => [label.name.toLowerCase(), label.id]));
  const ids: number[] = [];
  const unresolved: string[] = [];
  for (const name of names) {
    const id = byName.get(name.toLowerCase());
    if (id === undefined) unresolved.push(name);
    else ids.push(id);
  }
  return { ids, unresolved };
}

export function registerTools(
  server: McpServer,
  client: ForgejoClient,
  defaults: RepoDefaults,
): void {
  // --- Identity ------------------------------------------------------------

  server.registerTool(
    "forgejo_whoami",
    {
      title: "Forgejo token identity",
      description: `Returns the Forgejo account the token used for this call belongs to.

No parameters.

Returns: { id, login, full_name, email }

Use it to confirm a token is valid and which identity writes will be attributed to, before creating an issue or a pull request.
Errors: 401 if the token is missing, expired or revoked; 403 if it lacks the 'read:user' scope.`,
      inputSchema: { ...formatShape },
      annotations: readOnly,
    },
    async ({ response_format }: { response_format: ResponseFormat }) =>
      run(async () => {
        const user = await client.get<ForgejoUser>("/user");
        const structured = {
          id: user.id,
          login: user.login,
          full_name: user.full_name ?? null,
          email: user.email ?? null,
        };
        return singleResult({
          format: response_format,
          structured,
          markdown: `# ${user.login}\n\n- **Name**: ${user.full_name || "*(not set)*"}\n- **Email**: ${user.email || "*(hidden)*"}\n- **ID**: ${user.id}`,
        });
      }),
  );

  server.registerTool(
    "forgejo_list_repos",
    {
      title: "List accessible repositories",
      description: `Lists the repositories the token can reach, most recently updated first.

Parameters: page, limit, response_format.

Returns: { total, count, page, limit, has_more, repos: [{ full_name, private, fork, default_branch, description, updated_at, html_url }] }

Use it to discover the owner/repo values to pass to the other tools when they are unknown.
Errors: 403 if the token lacks the 'read:user' scope.`,
      inputSchema: { ...paginationShape, ...formatShape },
      annotations: readOnly,
    },
    async ({
      page,
      limit,
      response_format,
    }: {
      page: number;
      limit: number;
      response_format: ResponseFormat;
    }) =>
      run(async () => {
        const { items, total } = await client.getList<ForgejoRepo>("/user/repos", { page, limit });
        if (items.length === 0) {
          return errorResult("No repository reachable with this token.");
        }
        return listResult({
          format: response_format,
          items,
          total,
          page,
          limit,
          render: (shown) => ({
            structured: {
              repos: shown.map((repo) => ({
                full_name: repo.full_name,
                private: repo.private,
                fork: repo.fork,
                default_branch: repo.default_branch,
                description: repo.description ?? null,
                updated_at: repo.updated_at,
                html_url: repo.html_url,
              })),
            },
            markdown: [`# Accessible repositories (${total})`, "", ...shown.map(repoLine)].join("\n"),
          }),
        });
      }),
  );

  // --- Issues --------------------------------------------------------------

  server.registerTool(
    "forgejo_list_issues",
    {
      title: "List issues",
      description: `Lists a repository's issues. Pull requests are excluded (use forgejo_list_pull_requests).

Parameters:
  - owner, repo (string, optional when defaults are configured)
  - state ('open' | 'closed' | 'all', default 'open')
  - labels (string[], optional): label names, all of them required
  - query (string, optional): full-text search across title and body
  - page, limit, response_format

Returns: { total, count, page, limit, has_more, issues: [{ number, title, state, author, labels, comments, created_at, updated_at, html_url }] }

Examples:
  - "open issues on the CRM" -> state='open'
  - "closed bugs" -> state='closed', labels=['bug']`,
      inputSchema: {
        ...repoShape,
        state: z.enum(["open", "closed", "all"]).default("open").describe("State filter."),
        labels: z.array(z.string()).optional().describe("Required label names."),
        query: z.string().optional().describe("Full-text search across title and body."),
        ...paginationShape,
        ...formatShape,
      },
      annotations: readOnly,
    },
    async (params: {
      owner?: string;
      repo?: string;
      state: "open" | "closed" | "all";
      labels?: string[];
      query?: string;
      page: number;
      limit: number;
      response_format: ResponseFormat;
    }) =>
      run(async () => {
        const { slug } = resolveRepo(params, defaults);
        const { items, total } = await client.getList<ForgejoIssue>(`/repos/${slug}/issues`, {
          type: "issues",
          state: params.state,
          labels: params.labels?.join(","),
          q: params.query,
          page: params.page,
          limit: params.limit,
        });
        if (items.length === 0) {
          return errorResult(
            `No issue matches (state '${params.state}'${params.labels ? `, labels ${params.labels.join(", ")}` : ""}${params.query ? `, search "${params.query}"` : ""}).`,
          );
        }
        return listResult({
          format: params.response_format,
          items,
          total,
          page: params.page,
          limit: params.limit,
          render: (shown) => ({
            structured: {
              issues: shown.map((issue) => ({
                number: issue.number,
                title: issue.title,
                state: issue.state,
                author: issue.user?.login ?? null,
                labels: labelNames(issue),
                comments: issue.comments,
                created_at: issue.created_at,
                updated_at: issue.updated_at,
                html_url: issue.html_url,
              })),
            },
            markdown: [`# Issues (${total})`, "", ...shown.map(issueLine)].join("\n"),
          }),
        });
      }),
  );

  server.registerTool(
    "forgejo_get_issue",
    {
      title: "Issue detail",
      description: `Returns a full issue: description, metadata and, on request, its comments.

Parameters: owner, repo, number (required), include_comments (bool, default true), response_format.

Returns: { number, title, state, author, labels, assignees, body, html_url, comments: [{ author, body, created_at }] }

Also works with a pull request number: issues and PRs share one numbering space in Forgejo.
Errors: 404 if the number does not exist in this repository.`,
      inputSchema: {
        ...repoShape,
        number: z.number().int().min(1).describe("Issue number as displayed (#42 -> 42)."),
        include_comments: z
          .boolean()
          .default(true)
          .describe("Also fetch the comment thread."),
        ...formatShape,
      },
      annotations: readOnly,
    },
    async (params: {
      owner?: string;
      repo?: string;
      number: number;
      include_comments: boolean;
      response_format: ResponseFormat;
    }) =>
      run(async () => {
        const { slug } = resolveRepo(params, defaults);
        const issue = await client.get<ForgejoIssue>(`/repos/${slug}/issues/${params.number}`);
        let comments: ForgejoComment[] | null = null;
        if (params.include_comments) {
          const result = await client.getList<ForgejoComment>(
            `/repos/${slug}/issues/${params.number}/comments`,
            { limit: MAX_PAGE_SIZE },
          );
          comments = result.items;
        }
        return singleResult({
          format: params.response_format,
          structured: {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            author: issue.user?.login ?? null,
            labels: labelNames(issue),
            assignees: (issue.assignees ?? []).map((user) => user.login),
            body: issue.body ?? "",
            is_pull_request: Boolean(issue.pull_request),
            created_at: issue.created_at,
            updated_at: issue.updated_at,
            html_url: issue.html_url,
            comments: (comments ?? []).map((comment) => ({
              author: comment.user?.login ?? null,
              body: comment.body,
              created_at: comment.created_at,
            })),
          },
          markdown: issueDetail(issue, comments),
        });
      }),
  );

  server.registerTool(
    "forgejo_create_issue",
    {
      title: "Create an issue",
      description: `Opens a new issue. Write operation: requires the 'write:issue' scope.

Parameters:
  - owner, repo (optional when defaults are configured)
  - title (string, required)
  - body (string, optional): markdown description
  - labels (string[], optional): label names; unknown names are skipped and reported
  - assignees (string[], optional): login names

Returns: { number, title, state, html_url, unresolved_labels }

The issue is attributed to the token's owner — check with forgejo_whoami if unsure.`,
      inputSchema: {
        ...repoShape,
        title: z.string().min(1).max(255).describe("Issue title."),
        body: z.string().max(65_535).optional().describe("Markdown description."),
        labels: z.array(z.string()).optional().describe("Label names to apply."),
        assignees: z.array(z.string()).optional().describe("Logins to assign."),
        ...formatShape,
      },
      annotations: writeCreate,
    },
    async (params: {
      owner?: string;
      repo?: string;
      title: string;
      body?: string;
      labels?: string[];
      assignees?: string[];
      response_format: ResponseFormat;
    }) =>
      run(async () => {
        const { slug } = resolveRepo(params, defaults);
        let labelIds: number[] = [];
        let unresolved: string[] = [];
        if (params.labels && params.labels.length > 0) {
          ({ ids: labelIds, unresolved } = await resolveLabelIds(client, slug, params.labels));
        }
        const issue = await client.post<ForgejoIssue>(`/repos/${slug}/issues`, {
          title: params.title,
          ...(params.body !== undefined ? { body: params.body } : {}),
          ...(labelIds.length > 0 ? { labels: labelIds } : {}),
          ...(params.assignees && params.assignees.length > 0
            ? { assignees: params.assignees }
            : {}),
        });
        const warning =
          unresolved.length > 0
            ? `\n\n⚠️ Unknown labels, skipped: ${unresolved.join(", ")}. Create them in the repository, then apply them again if needed.`
            : "";
        return singleResult({
          format: params.response_format,
          structured: {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            html_url: issue.html_url,
            unresolved_labels: unresolved,
          },
          markdown: `Issue **#${issue.number}** created: ${issue.title}\n\n${issue.html_url}${warning}`,
        });
      }),
  );

  server.registerTool(
    "forgejo_comment_issue",
    {
      title: "Comment on an issue or PR",
      description: `Adds a comment to an issue or a pull request (shared numbering).

Parameters: owner, repo, number (required), body (string, required), response_format.

Returns: { id, author, created_at, html_url }

Write operation: requires the 'write:issue' scope. The comment is attributed to the token's owner and cannot be deleted by this tool.`,
      inputSchema: {
        ...repoShape,
        number: z.number().int().min(1).describe("Issue or pull request number."),
        body: z.string().min(1).max(65_535).describe("Comment body, in markdown."),
        ...formatShape,
      },
      annotations: writeCreate,
    },
    async (params: {
      owner?: string;
      repo?: string;
      number: number;
      body: string;
      response_format: ResponseFormat;
    }) =>
      run(async () => {
        const { slug } = resolveRepo(params, defaults);
        const comment = await client.post<ForgejoComment>(
          `/repos/${slug}/issues/${params.number}/comments`,
          { body: params.body },
        );
        return singleResult({
          format: params.response_format,
          structured: {
            id: comment.id,
            author: comment.user?.login ?? null,
            created_at: comment.created_at,
            html_url: comment.html_url,
          },
          markdown: `Comment posted on #${params.number} by ${comment.user?.login ?? "?"}\n\n${comment.html_url}`,
        });
      }),
  );

  server.registerTool(
    "forgejo_update_issue",
    {
      title: "Update an issue",
      description: `Changes an existing issue: state, title, body, labels or assignees. Write operation: requires the 'write:issue' scope.

Parameters:
  - owner, repo (optional when defaults are configured)
  - number (required)
  - state ('open' | 'closed', optional): closes or reopens the issue
  - title (string, optional): replaces the current title
  - body (string, optional): replaces the current body — this overwrites, it does not append
  - labels (string[], optional): replaces the full label set; unknown names are skipped and reported; [] removes every label
  - assignees (string[], optional): replaces the full assignee list

At least one changing field is required; omitted fields are left untouched.

Returns: { number, title, state, labels, assignees, html_url, unresolved_labels } — labels is the set actually applied.

Examples:
  - "close issue 42" -> number=42, state='closed'
  - "reopen it and retitle it" -> number=42, state='open', title='…'
  - "tag 42 as a bug, drop the rest" -> number=42, labels=['bug']

To add to a discussion without altering the issue, use forgejo_comment_issue instead.
Also accepts a pull request number, but only its issue-side fields change — it cannot merge or close a PR's branch.`,
      inputSchema: {
        ...repoShape,
        number: z.number().int().min(1).describe("Issue number as displayed (#42 -> 42)."),
        state: z
          .enum(["open", "closed"])
          .optional()
          .describe("New state: 'closed' closes the issue, 'open' reopens it."),
        title: z.string().min(1).max(255).optional().describe("Replacement title."),
        body: z.string().max(65_535).optional().describe("Replacement body (overwrites, no append)."),
        labels: z
          .array(z.string())
          .optional()
          .describe("Replacement label set, by name. [] removes every label."),
        assignees: z.array(z.string()).optional().describe("Replacement assignee list, by login."),
        ...formatShape,
      },
      annotations: writeUpdate,
    },
    async (params: {
      owner?: string;
      repo?: string;
      number: number;
      state?: "open" | "closed";
      title?: string;
      body?: string;
      labels?: string[];
      assignees?: string[];
      response_format: ResponseFormat;
    }) =>
      run(async () => {
        const { slug } = resolveRepo(params, defaults);
        const path = `/repos/${slug}/issues/${params.number}`;

        // EditIssueOption has no labels field: Forgejo silently drops one sent
        // in the PATCH, so the label set goes through its own endpoint below.
        const patch: Record<string, unknown> = {};
        if (params.state !== undefined) patch.state = params.state;
        if (params.title !== undefined) patch.title = params.title;
        if (params.body !== undefined) patch.body = params.body;
        if (params.assignees !== undefined) patch.assignees = params.assignees;
        const hasPatch = Object.keys(patch).length > 0;

        if (!hasPatch && params.labels === undefined) {
          throw new UsageError(
            "Error: nothing to update. Provide at least one of: state, title, body, labels, assignees.",
          );
        }

        let labelIds: number[] | undefined;
        let unresolved: string[] = [];
        if (params.labels !== undefined) {
          ({ ids: labelIds, unresolved } = await resolveLabelIds(client, slug, params.labels));
        }

        let issue = hasPatch
          ? await client.patch<ForgejoIssue>(path, patch)
          : await client.get<ForgejoIssue>(path);
        if (labelIds !== undefined) {
          // The PUT answers with the resulting label set, which the issue read
          // above predates.
          const labels = await client.put<ForgejoLabel[]>(`${path}/labels`, { labels: labelIds });
          issue = { ...issue, labels };
        }

        const labels = labelNames(issue);
        const warning =
          unresolved.length > 0
            ? `\n\n⚠️ Unknown labels, skipped: ${unresolved.join(", ")}.`
            : "";
        return singleResult({
          format: params.response_format,
          structured: {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            labels,
            assignees: (issue.assignees ?? []).map((user) => user.login),
            html_url: issue.html_url,
            unresolved_labels: unresolved,
          },
          markdown: `Issue **#${issue.number}** updated — state: ${issue.state}, title: ${issue.title}, labels: ${labels.length > 0 ? labels.join(", ") : "none"}\n\n${issue.html_url}${warning}`,
        });
      }),
  );

  // --- Pull requests -------------------------------------------------------

  server.registerTool(
    "forgejo_list_pull_requests",
    {
      title: "List pull requests",
      description: `Lists a repository's pull requests.

Parameters: owner, repo, state ('open' | 'closed' | 'all', default 'open'), page, limit, response_format.

Returns: { total, count, page, limit, has_more, pull_requests: [{ number, title, state, merged, draft, head, base, author, html_url }] }

Note: a PR closed without merging and a merged PR both report state='closed' — rely on the 'merged' field.`,
      inputSchema: {
        ...repoShape,
        state: z.enum(["open", "closed", "all"]).default("open").describe("State filter."),
        ...paginationShape,
        ...formatShape,
      },
      annotations: readOnly,
    },
    async (params: {
      owner?: string;
      repo?: string;
      state: "open" | "closed" | "all";
      page: number;
      limit: number;
      response_format: ResponseFormat;
    }) =>
      run(async () => {
        const { slug } = resolveRepo(params, defaults);
        const { items, total } = await client.getList<ForgejoPullRequest>(`/repos/${slug}/pulls`, {
          state: params.state,
          page: params.page,
          limit: params.limit,
        });
        if (items.length === 0) {
          return errorResult(`No pull request with state '${params.state}'.`);
        }
        return listResult({
          format: params.response_format,
          items,
          total,
          page: params.page,
          limit: params.limit,
          render: (shown) => ({
            structured: {
              pull_requests: shown.map((pull) => ({
                number: pull.number,
                title: pull.title,
                state: pull.state,
                merged: pull.merged,
                draft: pull.draft ?? false,
                head: pull.head?.ref ?? null,
                base: pull.base?.ref ?? null,
                author: pull.user?.login ?? null,
                html_url: pull.html_url,
              })),
            },
            markdown: [`# Pull requests (${total})`, "", ...shown.map(pullLine)].join("\n"),
          }),
        });
      }),
  );

  server.registerTool(
    "forgejo_get_pull_request",
    {
      title: "Pull request detail",
      description: `Returns a pull request: description, merge state, statistics and, on request, the unified diff.

Parameters: owner, repo, number (required), include_diff (bool, default false), response_format.

Returns: { number, title, state, merged, mergeable, head, base, additions, deletions, changed_files, body, html_url, diff? }

The diff is truncated past the context limit and the cut is explicitly reported in the returned text.
Tip: leave include_diff=false for a status check — it saves a lot of context.`,
      inputSchema: {
        ...repoShape,
        number: z.number().int().min(1).describe("Pull request number."),
        include_diff: z.boolean().default(false).describe("Attach the unified diff (large)."),
        ...formatShape,
      },
      annotations: readOnly,
    },
    async (params: {
      owner?: string;
      repo?: string;
      number: number;
      include_diff: boolean;
      response_format: ResponseFormat;
    }) =>
      run(async () => {
        const { slug } = resolveRepo(params, defaults);
        const pull = await client.get<ForgejoPullRequest>(`/repos/${slug}/pulls/${params.number}`);
        let diff: string | null = null;
        let diffTruncated = false;
        if (params.include_diff) {
          const raw = await client.getText(`/repos/${slug}/pulls/${params.number}.diff`);
          // Leave headroom for the description and metadata.
          const bounded = truncateBlob(raw, Math.floor(CHARACTER_LIMIT * 0.7));
          diff = bounded.text;
          diffTruncated = bounded.truncated;
        }
        return singleResult({
          format: params.response_format,
          structured: {
            number: pull.number,
            title: pull.title,
            state: pull.state,
            merged: pull.merged,
            mergeable: pull.mergeable ?? null,
            draft: pull.draft ?? false,
            head: pull.head?.ref ?? null,
            base: pull.base?.ref ?? null,
            author: pull.user?.login ?? null,
            additions: pull.additions ?? null,
            deletions: pull.deletions ?? null,
            changed_files: pull.changed_files ?? null,
            body: pull.body ?? "",
            html_url: pull.html_url,
            ...(diff !== null ? { diff, diff_truncated: diffTruncated } : {}),
          },
          markdown: pullDetail(pull, diff),
        });
      }),
  );

  server.registerTool(
    "forgejo_create_pull_request",
    {
      title: "Open a pull request",
      description: `Opens a pull request between two branches of the repository. Write operation: requires the 'write:repository' scope.

Parameters:
  - owner, repo (optional when defaults are configured)
  - head (string, required): source branch, already pushed to the server
  - base (string, required): target branch, typically 'main'
  - title (string, required)
  - body (string, optional)

Returns: { number, title, state, head, base, html_url }

Prerequisite: the 'head' branch must exist server-side — push before calling.
Errors: 409 if a PR is already open for this branch pair; 404 if the head or base branch does not exist; 422 if the request is otherwise rejected.`,
      inputSchema: {
        ...repoShape,
        head: z.string().min(1).describe("Source branch, pushed to the server."),
        base: z.string().min(1).describe("Target branch, for example 'main'."),
        title: z.string().min(1).max(255).describe("Pull request title."),
        body: z.string().max(65_535).optional().describe("Markdown description."),
        ...formatShape,
      },
      annotations: writeCreate,
    },
    async (params: {
      owner?: string;
      repo?: string;
      head: string;
      base: string;
      title: string;
      body?: string;
      response_format: ResponseFormat;
    }) =>
      run(async () => {
        const { slug } = resolveRepo(params, defaults);
        if (params.head === params.base) {
          throw new UsageError(
            "Error: 'head' and 'base' are identical. A pull request compares two different branches.",
          );
        }
        const pull = await client.post<ForgejoPullRequest>(`/repos/${slug}/pulls`, {
          head: params.head,
          base: params.base,
          title: params.title,
          ...(params.body !== undefined ? { body: params.body } : {}),
        });
        return singleResult({
          format: params.response_format,
          structured: {
            number: pull.number,
            title: pull.title,
            state: pull.state,
            head: pull.head?.ref ?? params.head,
            base: pull.base?.ref ?? params.base,
            html_url: pull.html_url,
          },
          markdown: `Pull request **#${pull.number}** opened: ${pull.title}\n\n${params.head} → ${params.base}\n\n${pull.html_url}`,
        });
      }),
  );

  // --- Repository reads ----------------------------------------------------

  server.registerTool(
    "forgejo_list_branches",
    {
      title: "List branches",
      description: `Lists the repository's branches with their latest commit and protection status.

Parameters: owner, repo, page, limit, response_format.

Returns: { total, count, page, limit, has_more, branches: [{ name, protected, commit_sha, commit_message }] }

Use it to confirm a branch exists before opening a pull request with forgejo_create_pull_request.`,
      inputSchema: { ...repoShape, ...paginationShape, ...formatShape },
      annotations: readOnly,
    },
    async (params: {
      owner?: string;
      repo?: string;
      page: number;
      limit: number;
      response_format: ResponseFormat;
    }) =>
      run(async () => {
        const { slug } = resolveRepo(params, defaults);
        const { items, total } = await client.getList<ForgejoBranch>(`/repos/${slug}/branches`, {
          page: params.page,
          limit: params.limit,
        });
        return listResult({
          format: params.response_format,
          items,
          total,
          page: params.page,
          limit: params.limit,
          render: (shown) => ({
            structured: {
              branches: shown.map((branch) => ({
                name: branch.name,
                protected: branch.protected ?? false,
                commit_sha: branch.commit?.id ?? null,
                commit_message: oneLine(branch.commit?.message, 200),
              })),
            },
            markdown: [`# Branches (${total})`, "", ...shown.map(branchLine)].join("\n"),
          }),
        });
      }),
  );

  server.registerTool(
    "forgejo_list_commits",
    {
      title: "List commits",
      description: `Lists a branch's commits, newest first.

Parameters: owner, repo, branch (string, optional — the repository's default branch when omitted), page, limit, response_format.

Returns: { total, count, page, limit, has_more, commits: [{ sha, message, author, date, html_url }] }

Examples:
  - "what changed recently" -> limit=10
  - "history of the migration branch" -> branch='birdiz/migration'`,
      inputSchema: {
        ...repoShape,
        branch: z.string().optional().describe("Branch or starting SHA. Defaults to the main branch."),
        ...paginationShape,
        ...formatShape,
      },
      annotations: readOnly,
    },
    async (params: {
      owner?: string;
      repo?: string;
      branch?: string;
      page: number;
      limit: number;
      response_format: ResponseFormat;
    }) =>
      run(async () => {
        const { slug } = resolveRepo(params, defaults);
        const { items, total } = await client.getList<ForgejoCommit>(`/repos/${slug}/commits`, {
          sha: params.branch,
          page: params.page,
          limit: params.limit,
        });
        return listResult({
          format: params.response_format,
          items,
          total,
          page: params.page,
          limit: params.limit,
          render: (shown) => ({
            structured: {
              commits: shown.map((commit) => ({
                sha: commit.sha,
                message: oneLine(commit.commit.message, 300),
                author: commit.commit.author?.name ?? commit.author?.login ?? null,
                date: commit.commit.author?.date ?? null,
                html_url: commit.html_url,
              })),
            },
            markdown: [
              `# Commits${params.branch ? ` (${params.branch})` : ""} — ${total}`,
              "",
              ...shown.map(commitLine),
            ].join("\n"),
          }),
        });
      }),
  );

  server.registerTool(
    "forgejo_get_file",
    {
      title: "Read a file or directory",
      description: `Reads a text file's contents, or lists a directory, at a given revision.

Parameters:
  - owner, repo (optional when defaults are configured)
  - path (string, required): path from the repository root, e.g. 'lib/filters.ts'; '' or '.' for the root
  - ref (string, optional): branch, tag or SHA. Defaults to the main branch
  - response_format

Returns, for a file: { type: 'file', path, size, sha, content, truncated, html_url }
Returns, for a directory: { type: 'directory', path, entries: [{ name, type, size }] }

Binary files are not decoded: their size and SHA are returned with an explicit note.
Contents are truncated past the context limit and the cut is reported.`,
      inputSchema: {
        ...repoShape,
        path: z.string().default("").describe("File or directory path. Empty = root."),
        ref: z.string().optional().describe("Branch, tag or SHA. Defaults to the main branch."),
        ...formatShape,
      },
      annotations: readOnly,
    },
    async (params: {
      owner?: string;
      repo?: string;
      path: string;
      ref?: string;
      response_format: ResponseFormat;
    }) =>
      run(async () => {
        const { slug } = resolveRepo(params, defaults);
        const cleaned = params.path === "." ? "" : params.path;
        const response = await client.get<ForgejoFileContent | ForgejoFileContent[]>(
          `/repos/${slug}/contents/${encodeFilePath(cleaned)}`,
          { ref: params.ref },
        );

        if (Array.isArray(response)) {
          const entries = response.map((entry) => ({
            name: entry.name,
            type: entry.type,
            size: entry.size,
          }));
          return singleResult({
            format: params.response_format,
            structured: { type: "directory", path: cleaned || "/", entries },
            markdown: [
              `# ${cleaned || "/"} (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`,
              "",
              ...entries.map((e) => `- ${e.type === "dir" ? "📁" : "📄"} **${e.name}**${e.type === "dir" ? "" : ` — ${e.size} B`}`),
            ].join("\n"),
          });
        }

        const raw = Buffer.from(response.content ?? "", "base64");
        const isBinary = raw.includes(0);
        if (isBinary) {
          return singleResult({
            format: params.response_format,
            structured: {
              type: "file",
              path: response.path,
              size: response.size,
              sha: response.sha,
              binary: true,
              content: null,
              html_url: response.html_url ?? null,
            },
            markdown: `# ${response.path}\n\nBinary file (${response.size} bytes), not decoded. SHA: ${response.sha}`,
          });
        }

        const decoded = raw.toString("utf8");
        const bounded = truncateBlob(decoded, Math.floor(CHARACTER_LIMIT * 0.8));
        return singleResult({
          format: params.response_format,
          structured: {
            type: "file",
            path: response.path,
            size: response.size,
            sha: response.sha,
            binary: false,
            content: bounded.text,
            truncated: bounded.truncated,
            html_url: response.html_url ?? null,
          },
          markdown: `# ${response.path}\n\n${response.size} bytes — SHA ${response.sha}\n\n\`\`\`\n${bounded.text}\n\`\`\``,
        });
      }),
  );
}
