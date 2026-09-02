// Client HTTP de l'API Forgejo v1.
//
// Deux invariants de sécurité :
//   1. L'URL de l'instance est fixée à la construction, jamais fournie par
//      l'appelant → un modèle ne peut pas détourner le serveur vers un autre
//      hôte (SSRF).
//   2. Le token n'est jamais journalisé ni renvoyé dans un message d'erreur.

import { REQUEST_TIMEOUT_MS } from "./constants.js";

/** Erreur renvoyée par l'API, porteuse du statut HTTP pour un message actionnable. */
export class ForgejoApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly path: string,
  ) {
    super(`Forgejo a répondu ${status} sur ${path}`);
    this.name = "ForgejoApiError";
  }
}

/** Résultat d'un endpoint de liste, enrichi du total renvoyé par Forgejo. */
export interface ListResult<T> {
  items: T[];
  /** Total côté serveur (en-tête X-Total-Count), sinon la taille de la page. */
  total: number;
}

export type QueryValue = string | number | boolean | undefined;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, QueryValue>;
  accept?: string;
}

/** Encode chaque segment d'un chemin : neutralise `..` et les slashs injectés. */
export function encodePath(...segments: string[]): string {
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

/** Encode un chemin de fichier segment par segment, en gardant les `/` réels. */
export function encodeFilePath(filePath: string): string {
  return filePath
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

export class ForgejoClient {
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#token = token;
  }

  async #request(path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(`${this.#baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          // Schéma d'authentification propre à Forgejo/Gitea.
          Authorization: `token ${this.#token}`,
          Accept: options.accept ?? "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      // AbortSignal.timeout lève une TimeoutError : on la nomme explicitement,
      // sinon elle ressort en « fetch failed » et n'aide personne.
      const isTimeout = cause instanceof Error && cause.name === "TimeoutError";
      const reason = isTimeout
        ? `délai de ${REQUEST_TIMEOUT_MS / 1000} s dépassé`
        : cause instanceof Error
          ? cause.message
          : String(cause);
      throw new ForgejoApiError(0, reason, path);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ForgejoApiError(response.status, detail.slice(0, 500), path);
    }
    return response;
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    const response = await this.#request(path, { query });
    return (await response.json()) as T;
  }

  async getList<T>(path: string, query?: Record<string, QueryValue>): Promise<ListResult<T>> {
    const response = await this.#request(path, { query });
    const items = (await response.json()) as T[];
    const header = response.headers.get("x-total-count");
    const parsed = header === null ? Number.NaN : Number(header);
    return { items, total: Number.isFinite(parsed) ? parsed : items.length };
  }

  /** Pour les endpoints qui renvoient du texte brut (diff, patch). */
  async getText(path: string, query?: Record<string, QueryValue>): Promise<string> {
    const response = await this.#request(path, { query, accept: "text/plain" });
    return await response.text();
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.#request(path, { method: "POST", body });
    return (await response.json()) as T;
  }
}

/**
 * Traduit une erreur d'API en message qui dit à l'agent quoi faire ensuite.
 * Ne divulgue jamais le token ni la pile d'appel.
 */
export function describeError(error: unknown): string {
  if (error instanceof ForgejoApiError) {
    const suffix = error.detail ? ` Détail Forgejo : ${error.detail}` : "";
    switch (error.status) {
      case 0:
        return `Erreur : instance Forgejo injoignable (${error.detail}). Vérifier FORGEJO_URL et la connectivité réseau.`;
      case 401:
        return "Erreur : token refusé (401). Il est absent, expiré ou révoqué — en régénérer un sur /user/settings/applications.";
      case 403: {
        // Le scope attendu dépend de la famille d'endpoint : un message
        // générique envoie chercher au mauvais endroit.
        const scope = error.path.startsWith("/user")
          ? "'read:user' (endpoints /user, dont whoami et la liste des dépôts)"
          : "'write:issue' pour les issues, 'write:repository' pour les pull requests et la lecture du dépôt";
        return `Erreur : accès refusé (403). Scope manquant sur le token : ${scope}. À ajuster sur /user/settings/applications — un token existant ne peut pas être élargi, il faut en créer un nouveau.${suffix}`;
      }
      case 404:
        return `Erreur : ressource introuvable (404). Vérifier owner/repo et le numéro. Un dépôt privé auquel le token n'a pas accès renvoie aussi 404.${suffix}`;
      case 409:
        return `Erreur : conflit (409). Typiquement une pull request déjà ouverte pour ce couple de branches, ou des branches identiques.${suffix}`;
      case 422:
        return `Erreur : requête refusée par Forgejo (422). Champ invalide ou branche inexistante.${suffix}`;
      case 429:
        return "Erreur : quota de requêtes dépassé (429). Attendre avant de réessayer.";
      default:
        return `Erreur : l'API Forgejo a répondu ${error.status}.${suffix}`;
    }
  }
  return `Erreur inattendue : ${error instanceof Error ? error.message : String(error)}`;
}
