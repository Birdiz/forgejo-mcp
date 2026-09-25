// HTTP client for the Forgejo v1 API.
//
// Two security invariants:
//   1. The instance URL is fixed at construction time and never supplied by the
//      caller, so a model cannot redirect the server at another host (SSRF).
//   2. The token is never logged nor echoed back in an error message.

import { REQUEST_TIMEOUT_MS } from "./constants.js";

/** API failure carrying the HTTP status, so callers can build actionable messages. */
export class ForgejoApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly path: string,
  ) {
    super(`Forgejo responded ${status} on ${path}`);
    this.name = "ForgejoApiError";
  }
}

/** Result of a list endpoint, enriched with the total Forgejo reports. */
export interface ListResult<T> {
  items: T[];
  /** Server-side total (X-Total-Count header), falling back to the page size. */
  total: number;
}

export type QueryValue = string | number | boolean | undefined;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, QueryValue>;
  accept?: string;
}

/** Encodes each path segment, neutralising `..` and injected slashes. */
export function encodePath(...segments: string[]): string {
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

/** Encodes a file path segment by segment, preserving genuine `/` separators. */
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
          // Authentication scheme specific to Forgejo/Gitea.
          Authorization: `token ${this.#token}`,
          Accept: options.accept ?? "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      // AbortSignal.timeout raises a TimeoutError: name it explicitly, otherwise
      // it surfaces as a bare "fetch failed" that helps nobody.
      const isTimeout = cause instanceof Error && cause.name === "TimeoutError";
      const reason = isTimeout
        ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
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

  /** For endpoints returning raw text (diff, patch). */
  async getText(path: string, query?: Record<string, QueryValue>): Promise<string> {
    const response = await this.#request(path, { query, accept: "text/plain" });
    return await response.text();
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.#request(path, { method: "POST", body });
    return (await response.json()) as T;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const response = await this.#request(path, { method: "PATCH", body });
    return (await response.json()) as T;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const response = await this.#request(path, { method: "PUT", body });
    return (await response.json()) as T;
  }
}

/**
 * Turns an API failure into a message that tells the agent what to do next.
 * Never discloses the token or a stack trace.
 */
export function describeError(error: unknown): string {
  if (error instanceof ForgejoApiError) {
    const suffix = error.detail ? ` Forgejo said: ${error.detail}` : "";
    switch (error.status) {
      case 0:
        return `Error: Forgejo instance unreachable (${error.detail}). Check FORGEJO_URL and network connectivity.`;
      case 401:
        return "Error: token rejected (401). It is missing, expired or revoked — issue a new one at /user/settings/applications.";
      case 403: {
        // The expected scope depends on the endpoint family: a generic message
        // sends the reader looking in the wrong place.
        const scope = error.path.startsWith("/user")
          ? "'read:user' (the /user endpoints, including whoami and the repository list)"
          : "'write:issue' for issues, 'write:repository' for pull requests and repository reads";
        return `Error: forbidden (403). Missing token scope: ${scope}. Adjust it at /user/settings/applications — an existing token cannot be widened, a new one is required.${suffix}`;
      }
      case 404:
        return `Error: not found (404). Check owner/repo, and the number or branch name. A private repository the token cannot reach also answers 404.${suffix}`;
      case 409:
        return `Error: conflict (409). Typically a pull request already open for this branch pair, or identical branches.${suffix}`;
      case 422:
        return `Error: rejected by Forgejo (422). Invalid field or non-existent branch.${suffix}`;
      case 429:
        return "Error: rate limit exceeded (429). Wait before retrying.";
      default:
        return `Error: the Forgejo API responded ${error.status}.${suffix}`;
    }
  }
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}
