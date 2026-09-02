// Déclaration des outils MCP.
//
// Le client Forgejo est injecté : en stdio il porte le token d'environnement,
// en HTTP celui de la requête en cours. Aucun outil ne connaît sa provenance.

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

/** Erreur d'usage : message rendu tel quel à l'agent, sans passer par describeError. */
class UsageError extends Error {}

export interface RepoDefaults {
  owner?: string;
  repo?: string;
}

// --- Fragments de schéma réutilisés ---------------------------------------

const repoShape = {
  owner: z
    .string()
    .min(1)
    .optional()
    .describe("Propriétaire du dépôt (utilisateur ou organisation). Par défaut : FORGEJO_DEFAULT_OWNER."),
  repo: z
    .string()
    .min(1)
    .optional()
    .describe("Nom du dépôt. Par défaut : FORGEJO_DEFAULT_REPO."),
};

const paginationShape = {
  page: z.number().int().min(1).default(1).describe("Page à récupérer, 1 = première."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe(`Nombre d'éléments par page (max ${MAX_PAGE_SIZE}).`),
};

const formatShape = {
  response_format: z
    .enum(RESPONSE_FORMATS)
    .default("markdown")
    .describe("'markdown' pour un rendu lisible, 'json' pour la donnée complète."),
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

// --- Utilitaires partagés --------------------------------------------------

/** Exécute un handler en convertissant toute erreur en réponse actionnable. */
async function run(handler: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof UsageError) return errorResult(error.message);
    return errorResult(describeError(error));
  }
}

/** Résout owner/repo depuis les paramètres puis les défauts d'environnement. */
function resolveRepo(
  params: { owner?: string; repo?: string },
  defaults: RepoDefaults,
): { owner: string; repo: string; slug: string } {
  const owner = params.owner ?? defaults.owner;
  const repo = params.repo ?? defaults.repo;
  if (!owner || !repo) {
    throw new UsageError(
      "Erreur : dépôt non déterminé. Fournir 'owner' et 'repo' dans l'appel, ou définir FORGEJO_DEFAULT_OWNER et FORGEJO_DEFAULT_REPO côté serveur.",
    );
  }
  return { owner, repo, slug: encodePath(owner, repo) };
}

/** Traduit des noms d'étiquettes en identifiants, seuls acceptés par l'API. */
async function resolveLabelIds(
  client: ForgejoClient,
  slug: string,
  names: string[],
): Promise<{ ids: number[]; unresolved: string[] }> {
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
  // --- Identité ------------------------------------------------------------

  server.registerTool(
    "forgejo_whoami",
    {
      title: "Identité du token Forgejo",
      description: `Renvoie le compte Forgejo auquel appartient le token utilisé pour cet appel.

Aucun paramètre.

Retourne : { id, login, full_name, email }

À utiliser pour : vérifier qu'un token est valide et sous quelle identité les écritures seront attribuées, avant de créer une issue ou une pull request.
Erreurs : 401 si le token est absent, expiré ou révoqué.`,
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
          markdown: `# ${user.login}\n\n- **Nom** : ${user.full_name || "*(non renseigné)*"}\n- **Courriel** : ${user.email || "*(masqué)*"}\n- **ID** : ${user.id}`,
        });
      }),
  );

  server.registerTool(
    "forgejo_list_repos",
    {
      title: "Lister les dépôts accessibles",
      description: `Liste les dépôts auxquels le token donne accès, du plus récemment mis à jour au plus ancien.

Paramètres : page, limit, response_format.

Retourne : { total, count, page, limit, has_more, repos: [{ full_name, private, fork, default_branch, description, updated_at, html_url }] }

À utiliser pour : découvrir les valeurs owner/repo à passer aux autres outils quand elles ne sont pas connues.`,
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
          return errorResult("Aucun dépôt accessible avec ce token.");
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
            markdown: [`# Dépôts accessibles (${total})`, "", ...shown.map(repoLine)].join("\n"),
          }),
        });
      }),
  );

  // --- Issues --------------------------------------------------------------

  server.registerTool(
    "forgejo_list_issues",
    {
      title: "Lister les issues",
      description: `Liste les issues d'un dépôt. Les pull requests sont exclues (utiliser forgejo_list_pull_requests).

Paramètres :
  - owner, repo (string, optionnels si défauts configurés)
  - state ('open' | 'closed' | 'all', défaut 'open')
  - labels (string[], optionnel) : noms d'étiquettes, toutes exigées
  - query (string, optionnel) : recherche plein texte dans titre et corps
  - page, limit, response_format

Retourne : { total, count, page, limit, has_more, issues: [{ number, title, state, author, labels, comments, created_at, updated_at, html_url }] }

Exemples :
  - « les issues ouvertes sur le CRM » -> state='open'
  - « les bugs fermés » -> state='closed', labels=['bug']`,
      inputSchema: {
        ...repoShape,
        state: z.enum(["open", "closed", "all"]).default("open").describe("Filtre d'état."),
        labels: z.array(z.string()).optional().describe("Noms d'étiquettes exigées."),
        query: z.string().optional().describe("Recherche plein texte dans le titre et le corps."),
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
            `Aucune issue ne correspond (état '${params.state}'${params.labels ? `, étiquettes ${params.labels.join(", ")}` : ""}${params.query ? `, recherche « ${params.query} »` : ""}).`,
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
      title: "Détail d'une issue",
      description: `Renvoie une issue complète : description, métadonnées et, si demandé, ses commentaires.

Paramètres : owner, repo, number (obligatoire), include_comments (bool, défaut true), response_format.

Retourne : { number, title, state, author, labels, assignees, body, html_url, comments: [{ author, body, created_at }] }

Fonctionne aussi avec un numéro de pull request : issues et PR partagent la même numérotation dans Forgejo.
Erreurs : 404 si le numéro n'existe pas dans ce dépôt.`,
      inputSchema: {
        ...repoShape,
        number: z.number().int().min(1).describe("Numéro de l'issue, tel qu'affiché (#42 -> 42)."),
        include_comments: z
          .boolean()
          .default(true)
          .describe("Récupérer aussi le fil de commentaires."),
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
      title: "Créer une issue",
      description: `Ouvre une nouvelle issue. Écriture : requiert le scope 'write:issue'.

Paramètres :
  - owner, repo (optionnels si défauts configurés)
  - title (string, obligatoire)
  - body (string, optionnel) : description en markdown
  - labels (string[], optionnel) : noms d'étiquettes ; les noms inconnus sont ignorés et signalés
  - assignees (string[], optionnel) : identifiants de connexion

Retourne : { number, title, state, html_url, unresolved_labels }

L'issue est attribuée au compte propriétaire du token — vérifier avec forgejo_whoami en cas de doute.`,
      inputSchema: {
        ...repoShape,
        title: z.string().min(1).max(255).describe("Titre de l'issue."),
        body: z.string().max(65_535).optional().describe("Description en markdown."),
        labels: z.array(z.string()).optional().describe("Noms d'étiquettes à poser."),
        assignees: z.array(z.string()).optional().describe("Logins à assigner."),
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
            ? `\n\n⚠️ Étiquettes inconnues, ignorées : ${unresolved.join(", ")}. Les créer dans le dépôt puis les reposer si besoin.`
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
          markdown: `Issue **#${issue.number}** créée : ${issue.title}\n\n${issue.html_url}${warning}`,
        });
      }),
  );

  server.registerTool(
    "forgejo_comment_issue",
    {
      title: "Commenter une issue ou une PR",
      description: `Ajoute un commentaire sur une issue ou une pull request (numérotation commune).

Paramètres : owner, repo, number (obligatoire), body (string, obligatoire), response_format.

Retourne : { id, author, created_at, html_url }

Écriture : requiert le scope 'write:issue'. Le commentaire est attribué au propriétaire du token et ne peut pas être supprimé par cet outil.`,
      inputSchema: {
        ...repoShape,
        number: z.number().int().min(1).describe("Numéro de l'issue ou de la pull request."),
        body: z.string().min(1).max(65_535).describe("Contenu du commentaire, en markdown."),
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
          markdown: `Commentaire publié sur #${params.number} par ${comment.user?.login ?? "?"}\n\n${comment.html_url}`,
        });
      }),
  );

  // --- Pull requests -------------------------------------------------------

  server.registerTool(
    "forgejo_list_pull_requests",
    {
      title: "Lister les pull requests",
      description: `Liste les pull requests d'un dépôt.

Paramètres : owner, repo, state ('open' | 'closed' | 'all', défaut 'open'), page, limit, response_format.

Retourne : { total, count, page, limit, has_more, pull_requests: [{ number, title, state, merged, draft, head, base, author, html_url }] }

Note : une PR fermée sans fusion et une PR fusionnée ont toutes deux state='closed' — se fier au champ 'merged'.`,
      inputSchema: {
        ...repoShape,
        state: z.enum(["open", "closed", "all"]).default("open").describe("Filtre d'état."),
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
          return errorResult(`Aucune pull request avec l'état '${params.state}'.`);
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
      title: "Détail d'une pull request",
      description: `Renvoie une pull request : description, état de fusion, statistiques et, si demandé, le diff unifié.

Paramètres : owner, repo, number (obligatoire), include_diff (bool, défaut false), response_format.

Retourne : { number, title, state, merged, mergeable, head, base, additions, deletions, changed_files, body, html_url, diff? }

Le diff est tronqué au-delà de la limite de contexte : la coupe est explicitement signalée dans le texte renvoyé.
Astuce : laisser include_diff=false pour un simple état des lieux, il économise beaucoup de contexte.`,
      inputSchema: {
        ...repoShape,
        number: z.number().int().min(1).describe("Numéro de la pull request."),
        include_diff: z.boolean().default(false).describe("Joindre le diff unifié (volumineux)."),
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
          // On garde de la marge pour la description et les métadonnées.
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
      title: "Ouvrir une pull request",
      description: `Ouvre une pull request entre deux branches du dépôt. Écriture : requiert le scope 'write:repository'.

Paramètres :
  - owner, repo (optionnels si défauts configurés)
  - head (string, obligatoire) : branche source, déjà poussée sur le serveur
  - base (string, obligatoire) : branche cible, typiquement 'main'
  - title (string, obligatoire)
  - body (string, optionnel)

Retourne : { number, title, state, head, base, html_url }

Prérequis : la branche 'head' doit exister côté serveur — pousser avant d'appeler.
Erreurs : 409 si une PR est déjà ouverte pour ce couple de branches ; 422 si une branche n'existe pas ou si head et base sont identiques.`,
      inputSchema: {
        ...repoShape,
        head: z.string().min(1).describe("Branche source, poussée sur le serveur."),
        base: z.string().min(1).describe("Branche cible, par exemple 'main'."),
        title: z.string().min(1).max(255).describe("Titre de la pull request."),
        body: z.string().max(65_535).optional().describe("Description en markdown."),
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
            "Erreur : 'head' et 'base' sont identiques. Une pull request compare deux branches différentes.",
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
          markdown: `Pull request **#${pull.number}** ouverte : ${pull.title}\n\n${params.head} → ${params.base}\n\n${pull.html_url}`,
        });
      }),
  );

  // --- Lecture du dépôt ----------------------------------------------------

  server.registerTool(
    "forgejo_list_branches",
    {
      title: "Lister les branches",
      description: `Liste les branches du dépôt avec leur dernier commit et leur éventuelle protection.

Paramètres : owner, repo, page, limit, response_format.

Retourne : { total, count, page, limit, has_more, branches: [{ name, protected, commit_sha, commit_message }] }

À utiliser pour : vérifier qu'une branche existe avant d'ouvrir une pull request avec forgejo_create_pull_request.`,
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
      title: "Lister les commits",
      description: `Liste les commits d'une branche, du plus récent au plus ancien.

Paramètres : owner, repo, branch (string, optionnel — branche par défaut du dépôt si omis), page, limit, response_format.

Retourne : { total, count, page, limit, has_more, commits: [{ sha, message, author, date, html_url }] }

Exemples :
  - « qu'est-ce qui a changé récemment » -> limit=10
  - « l'historique de la branche de migration » -> branch='birdiz/migration'`,
      inputSchema: {
        ...repoShape,
        branch: z.string().optional().describe("Branche ou SHA de départ. Défaut : branche principale."),
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
      title: "Lire un fichier ou un dossier",
      description: `Lit le contenu d'un fichier texte, ou liste un dossier, à une révision donnée.

Paramètres :
  - owner, repo (optionnels si défauts configurés)
  - path (string, obligatoire) : chemin depuis la racine, par exemple 'lib/filters.ts' ; '' ou '.' pour la racine
  - ref (string, optionnel) : branche, tag ou SHA. Défaut : branche principale
  - response_format

Retourne, pour un fichier : { type: 'file', path, size, sha, content, truncated, html_url }
Retourne, pour un dossier : { type: 'directory', path, entries: [{ name, type, size }] }

Les fichiers binaires ne sont pas décodés : leur taille et leur SHA sont renvoyés avec une mention explicite.
Le contenu est tronqué au-delà de la limite de contexte, la coupe est signalée.`,
      inputSchema: {
        ...repoShape,
        path: z.string().default("").describe("Chemin du fichier ou du dossier. Vide = racine."),
        ref: z.string().optional().describe("Branche, tag ou SHA. Défaut : branche principale."),
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
              `# ${cleaned || "/"} (${entries.length} entrée(s))`,
              "",
              ...entries.map((e) => `- ${e.type === "dir" ? "📁" : "📄"} **${e.name}**${e.type === "dir" ? "" : ` — ${e.size} o`}`),
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
            markdown: `# ${response.path}\n\nFichier binaire (${response.size} octets), non décodé. SHA : ${response.sha}`,
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
          markdown: `# ${response.path}\n\n${response.size} octets — SHA ${response.sha}\n\n\`\`\`\n${bounded.text}\n\`\`\``,
        });
      }),
  );
}
