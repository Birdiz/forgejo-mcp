// Constantes partagées. Aucune dépendance : ce module est importé partout.

export const SERVER_NAME = "forgejo-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Plafond de caractères d'une réponse d'outil, pour ne pas noyer le contexte de l'agent. */
export const CHARACTER_LIMIT = 25_000;

/** Délai maximal d'un appel à l'API Forgejo. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Forgejo plafonne lui-même la pagination ; on reste sous sa limite par défaut. */
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;
