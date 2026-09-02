// Tool response shaping: pagination, truncation and rendering.
//
// Every tool supports two formats: 'markdown' (readable, default) and 'json'
// (complete, for programmatic processing).

import { CHARACTER_LIMIT } from "./constants.js";
import type {
  ForgejoBranch,
  ForgejoComment,
  ForgejoCommit,
  ForgejoIssue,
  ForgejoPullRequest,
  ForgejoRepo,
} from "./types.js";

export const RESPONSE_FORMATS = ["markdown", "json"] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /** The SDK requires an index signature on a tool result. */
  [key: string]: unknown;
}

/** Error response: no structuredContent, the agent reads the text. */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Collapses multi-line text to a single bounded line, for list views. */
export function oneLine(text: string | undefined | null, max = 120): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Cuts a large blob (diff, file contents) while announcing the cut. */
export function truncateBlob(blob: string, max: number): { text: string; truncated: boolean } {
  if (blob.length <= max) return { text: blob, truncated: false };
  return {
    text: `${blob.slice(0, max)}\n\n[…truncated: ${blob.length - max} more characters]`,
    truncated: true,
  };
}

interface ListRender {
  structured: Record<string, unknown>;
  markdown: string;
}

/**
 * Builds a list response that respects CHARACTER_LIMIT: while the rendering is
 * too large, halve the number of items and report that it happened.
 */
export function listResult<T>(params: {
  format: ResponseFormat;
  items: T[];
  total: number;
  page: number;
  limit: number;
  render: (items: T[], truncated: boolean) => ListRender;
}): ToolResult {
  const { format, total, page, limit } = params;
  let items = params.items;

  for (;;) {
    const truncated = items.length < params.items.length;
    const { structured, markdown } = params.render(items, truncated);
    const returned = params.items.length;
    const meta = {
      total,
      count: items.length,
      page,
      limit,
      has_more: total > page * limit,
      ...(total > page * limit ? { next_page: page + 1 } : {}),
      ...(truncated
        ? {
            truncated: true,
            truncation_message: `Response reduced from ${returned} to ${items.length} items to fit the context limit. Lower 'limit' or narrow the filters.`,
          }
        : {}),
    };
    const payload = { ...meta, ...structured };
    const text = format === "json" ? JSON.stringify(payload, null, 2) : markdown;

    if (text.length <= CHARACTER_LIMIT || items.length <= 1) {
      return { content: [{ type: "text", text }], structuredContent: payload };
    }
    items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
  }
}

/** Response for a single resource (issue, PR, file…). */
export function singleResult(params: {
  format: ResponseFormat;
  structured: Record<string, unknown>;
  markdown: string;
}): ToolResult {
  const text =
    params.format === "json" ? JSON.stringify(params.structured, null, 2) : params.markdown;
  const { text: bounded } = truncateBlob(text, CHARACTER_LIMIT);
  return { content: [{ type: "text", text: bounded }], structuredContent: params.structured };
}

// --- Markdown rendering ----------------------------------------------------

export function labelNames(issue: ForgejoIssue): string[] {
  return (issue.labels ?? []).map((label) => label.name);
}

export function issueLine(issue: ForgejoIssue): string {
  const labels = labelNames(issue);
  const suffix = labels.length > 0 ? ` [${labels.join(", ")}]` : "";
  return `- **#${issue.number}** ${issue.title} — *${issue.state}*, by ${issue.user?.login ?? "?"}, ${issue.comments} comment(s)${suffix}`;
}

export function issueDetail(issue: ForgejoIssue, comments: ForgejoComment[] | null): string {
  const labels = labelNames(issue);
  const lines = [
    `# #${issue.number} — ${issue.title}`,
    "",
    `- **State**: ${issue.state}`,
    `- **Author**: ${issue.user?.login ?? "?"}`,
    `- **Created**: ${issue.created_at}`,
    `- **Updated**: ${issue.updated_at}`,
    ...(labels.length > 0 ? [`- **Labels**: ${labels.join(", ")}`] : []),
    ...((issue.assignees ?? []).length > 0
      ? [`- **Assignees**: ${(issue.assignees ?? []).map((u) => u.login).join(", ")}`]
      : []),
    `- **URL**: ${issue.html_url}`,
    "",
    "## Description",
    "",
    issue.body?.trim() ? issue.body : "*(empty)*",
  ];
  if (comments !== null) {
    lines.push("", `## Comments (${comments.length})`, "");
    if (comments.length === 0) lines.push("*(none)*");
    for (const comment of comments) {
      lines.push(`### ${comment.user?.login ?? "?"} — ${comment.created_at}`, "", comment.body, "");
    }
  }
  return lines.join("\n");
}

export function pullLine(pull: ForgejoPullRequest): string {
  const state = pull.merged ? "merged" : pull.state;
  const draft = pull.draft ? " (draft)" : "";
  return `- **#${pull.number}** ${pull.title} — *${state}*${draft}, ${pull.head?.ref ?? "?"} → ${pull.base?.ref ?? "?"}, by ${pull.user?.login ?? "?"}`;
}

export function pullDetail(pull: ForgejoPullRequest, diff: string | null): string {
  const mergeable =
    pull.mergeable === undefined || pull.mergeable === null
      ? "not computed"
      : pull.mergeable
        ? "yes"
        : "no (conflicts)";
  const lines = [
    `# PR #${pull.number} — ${pull.title}`,
    "",
    `- **State**: ${pull.merged ? "merged" : pull.state}${pull.draft ? " (draft)" : ""}`,
    `- **Branches**: ${pull.head?.ref ?? "?"} → ${pull.base?.ref ?? "?"}`,
    `- **Author**: ${pull.user?.login ?? "?"}`,
    `- **Mergeable**: ${mergeable}`,
    ...(pull.changed_files !== undefined
      ? [`- **Diff**: ${pull.changed_files} file(s), +${pull.additions ?? 0} / -${pull.deletions ?? 0}`]
      : []),
    `- **URL**: ${pull.html_url}`,
    "",
    "## Description",
    "",
    pull.body?.trim() ? pull.body : "*(empty)*",
  ];
  if (diff !== null) lines.push("", "## Diff", "", "```diff", diff, "```");
  return lines.join("\n");
}

export function branchLine(branch: ForgejoBranch): string {
  const protectedMark = branch.protected ? " 🔒" : "";
  return `- **${branch.name}**${protectedMark} — ${branch.commit?.id?.slice(0, 7) ?? "?"} ${oneLine(branch.commit?.message, 80)}`;
}

export function commitLine(commit: ForgejoCommit): string {
  const author = commit.commit.author?.name ?? commit.author?.login ?? "?";
  const date = commit.commit.author?.date ?? "?";
  return `- **${commit.sha.slice(0, 7)}** ${oneLine(commit.commit.message, 100)} — ${author}, ${date}`;
}

export function repoLine(repo: ForgejoRepo): string {
  const visibility = repo.private ? "private" : "public";
  const description = repo.description ? ` — ${oneLine(repo.description, 80)}` : "";
  return `- **${repo.full_name}** (${visibility}, default: ${repo.default_branch})${description}`;
}
