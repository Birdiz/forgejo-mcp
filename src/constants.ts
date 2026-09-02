// Shared constants. Dependency-free: this module is imported everywhere.

export const SERVER_NAME = "forgejo-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Character ceiling for a tool response, so we never flood the agent's context. */
export const CHARACTER_LIMIT = 25_000;

/** Maximum duration of a single Forgejo API call. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Forgejo caps pagination itself; we stay under its default limit. */
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;
