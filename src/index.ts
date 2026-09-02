#!/usr/bin/env node
// Point d'entrée du serveur MCP Forgejo.
//
// Deux transports :
//   - stdio : usage local, le token vient de FORGEJO_TOKEN.
//   - http  : déploiement partagé (Railway), le token vient de l'en-tête
//             Authorization de CHAQUE requête.
//
// Le serveur n'a jamais d'autorité propre en mode http : sans token d'appelant,
// il ne peut rien faire. C'est ce qui rend une URL publique acceptable, et ce
// qui préserve l'attribution des écritures à leur véritable auteur.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { ForgejoClient } from "./forgejo.js";
import { registerTools, type RepoDefaults } from "./tools.js";

/** Coupe le process avec un message lisible plutôt qu'une pile d'appels. */
function fatal(message: string): never {
  console.error(`[${SERVER_NAME}] ${message}`);
  process.exit(1);
}

function readInstanceUrl(): string {
  const raw = process.env.FORGEJO_URL;
  if (!raw) {
    fatal("FORGEJO_URL est obligatoire (ex. https://forgejo.example.org).");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fatal(`FORGEJO_URL n'est pas une URL valide : ${raw}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fatal("FORGEJO_URL doit être en http ou https.");
  }
  return raw;
}

const instanceUrl = readInstanceUrl();
const defaults: RepoDefaults = {
  owner: process.env.FORGEJO_DEFAULT_OWNER || undefined,
  repo: process.env.FORGEJO_DEFAULT_REPO || undefined,
};

/** Un serveur MCP par token : les outils ferment sur le client authentifié. */
function createServer(token: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, new ForgejoClient(instanceUrl, token), defaults);
  return server;
}

/** Extrait le token de l'en-tête, sans jamais le journaliser. */
function extractToken(req: Request): string | null {
  const authorization = req.get("authorization");
  if (authorization) {
    const match = /^(?:Bearer|token)\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  const fallback = req.get("x-forgejo-token");
  return fallback?.trim() || null;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

async function runStdio(): Promise<void> {
  const token = process.env.FORGEJO_TOKEN;
  if (!token) {
    fatal(
      "FORGEJO_TOKEN est obligatoire en mode stdio. En créer un sur " +
        `${instanceUrl}/user/settings/applications (scopes : write:issue, write:repository).`,
    );
  }
  const server = createServer(token);
  await server.connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME}] prêt en stdio sur ${instanceUrl}`);
}

async function runHttp(): Promise<void> {
  if (process.env.FORGEJO_TOKEN) {
    fatal(
      "FORGEJO_TOKEN ne doit PAS être défini en mode http : le token doit venir de " +
        "chaque appelant, sinon tous les utilisateurs agiraient sous une seule identité.",
    );
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION, instance: instanceUrl });
  });

  app.post("/mcp", async (req, res) => {
    const token = extractToken(req);
    if (!token) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="forgejo-mcp"');
      jsonRpcError(
        res,
        401,
        -32001,
        "Token Forgejo manquant. Envoyer un en-tête 'Authorization: Bearer <token>'. " +
          "Chaque utilisateur fournit le sien : ce serveur n'en détient aucun.",
      );
      return;
    }

    // Transport et serveur neufs à chaque requête : mode sans session, et
    // surtout aucune fuite de token d'un appelant vers un autre.
    const server = createServer(token);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(`[${SERVER_NAME}] échec du traitement MCP :`, error);
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Erreur interne du serveur MCP.");
      }
    }
  });

  // Mode sans session : pas de flux SSE à ouvrir ni de session à fermer.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    jsonRpcError(res, 405, -32000, "Seul POST /mcp est accepté (mode sans session).");
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  app.listen(port, () => {
    console.error(`[${SERVER_NAME}] prêt en http sur :${port}/mcp → ${instanceUrl}`);
  });
}

const transport = (process.env.TRANSPORT ?? "stdio").toLowerCase();
const start = transport === "http" ? runHttp : runStdio;

start().catch((error: unknown) => {
  console.error(`[${SERVER_NAME}] démarrage impossible :`, error);
  process.exit(1);
});
