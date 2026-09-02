// Mise en forme des réponses d'outils : pagination, troncature et rendu.
//
// Deux formats sont supportés partout : 'markdown' (lisible, par défaut) et
// 'json' (complet, pour un traitement programmatique).

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
  /** Le SDK exige une signature d'index sur le résultat d'un outil. */
  [key: string]: unknown;
}

/** Réponse d'erreur : pas de structuredContent, l'agent lit le texte. */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Réduit un texte multiligne à une ligne bornée, pour les vues liste. */
export function oneLine(text: string | undefined | null, max = 120): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Coupe un gros bloc (diff, contenu de fichier) en annonçant la coupe. */
export function truncateBlob(blob: string, max: number): { text: string; truncated: boolean } {
  if (blob.length <= max) return { text: blob, truncated: false };
  return {
    text: `${blob.slice(0, max)}\n\n[…tronqué : ${blob.length - max} caractères de plus]`,
    truncated: true,
  };
}

interface ListRender {
  structured: Record<string, unknown>;
  markdown: string;
}

/**
 * Construit une réponse de liste en respectant CHARACTER_LIMIT : tant que le
 * rendu dépasse, on divise le nombre d'éléments par deux et on le signale.
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
            truncation_message: `Réponse réduite de ${returned} à ${items.length} éléments pour tenir dans la limite de contexte. Baisser 'limit' ou affiner les filtres.`,
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

/** Réponse pour une ressource unique (issue, PR, fichier…). */
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

// --- Rendus markdown -------------------------------------------------------

export function labelNames(issue: ForgejoIssue): string[] {
  return (issue.labels ?? []).map((label) => label.name);
}

export function issueLine(issue: ForgejoIssue): string {
  const labels = labelNames(issue);
  const suffix = labels.length > 0 ? ` [${labels.join(", ")}]` : "";
  return `- **#${issue.number}** ${issue.title} — *${issue.state}*, par ${issue.user?.login ?? "?"}, ${issue.comments} commentaire(s)${suffix}`;
}

export function issueDetail(issue: ForgejoIssue, comments: ForgejoComment[] | null): string {
  const labels = labelNames(issue);
  const lines = [
    `# #${issue.number} — ${issue.title}`,
    "",
    `- **État** : ${issue.state}`,
    `- **Auteur** : ${issue.user?.login ?? "?"}`,
    `- **Créée le** : ${issue.created_at}`,
    `- **Mise à jour** : ${issue.updated_at}`,
    ...(labels.length > 0 ? [`- **Étiquettes** : ${labels.join(", ")}`] : []),
    ...((issue.assignees ?? []).length > 0
      ? [`- **Assignée à** : ${(issue.assignees ?? []).map((u) => u.login).join(", ")}`]
      : []),
    `- **URL** : ${issue.html_url}`,
    "",
    "## Description",
    "",
    issue.body?.trim() ? issue.body : "*(vide)*",
  ];
  if (comments !== null) {
    lines.push("", `## Commentaires (${comments.length})`, "");
    if (comments.length === 0) lines.push("*(aucun)*");
    for (const comment of comments) {
      lines.push(`### ${comment.user?.login ?? "?"} — ${comment.created_at}`, "", comment.body, "");
    }
  }
  return lines.join("\n");
}

export function pullLine(pull: ForgejoPullRequest): string {
  const state = pull.merged ? "fusionnée" : pull.state;
  const draft = pull.draft ? " (brouillon)" : "";
  return `- **#${pull.number}** ${pull.title} — *${state}*${draft}, ${pull.head?.ref ?? "?"} → ${pull.base?.ref ?? "?"}, par ${pull.user?.login ?? "?"}`;
}

export function pullDetail(pull: ForgejoPullRequest, diff: string | null): string {
  const mergeable =
    pull.mergeable === undefined || pull.mergeable === null
      ? "non calculé"
      : pull.mergeable
        ? "oui"
        : "non (conflits)";
  const lines = [
    `# PR #${pull.number} — ${pull.title}`,
    "",
    `- **État** : ${pull.merged ? "fusionnée" : pull.state}${pull.draft ? " (brouillon)" : ""}`,
    `- **Branches** : ${pull.head?.ref ?? "?"} → ${pull.base?.ref ?? "?"}`,
    `- **Auteur** : ${pull.user?.login ?? "?"}`,
    `- **Fusionnable** : ${mergeable}`,
    ...(pull.changed_files !== undefined
      ? [`- **Diff** : ${pull.changed_files} fichier(s), +${pull.additions ?? 0} / -${pull.deletions ?? 0}`]
      : []),
    `- **URL** : ${pull.html_url}`,
    "",
    "## Description",
    "",
    pull.body?.trim() ? pull.body : "*(vide)*",
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
  const visibility = repo.private ? "privé" : "public";
  const description = repo.description ? ` — ${oneLine(repo.description, 80)}` : "";
  return `- **${repo.full_name}** (${visibility}, défaut: ${repo.default_branch})${description}`;
}
