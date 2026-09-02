#!/usr/bin/env node
// Entry point of the Forgejo MCP server.
//
// Two transports:
//   - stdio: local use, the token comes from FORGEJO_TOKEN.
//   - http:  shared deployment (Railway), the token comes from the
//            Authorization header of EVERY request.
//
// In http mode the server never holds authority of its own: with no caller
// token it can do nothing. That is what makes a public URL acceptable, and what
// keeps writes attributed to their actual author.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { ForgejoClient } from "./forgejo.js";
import { registerTools, type RepoDefaults } from "./tools.js";

/** Exits with a readable message rather than a stack trace. */
function fatal(message: string): never {
  console.error(`[${SERVER_NAME}] ${message}`);
  process.exit(1);
}

function readInstanceUrl(): string {
  const raw = process.env.FORGEJO_URL;
  if (!raw) {
    fatal("FORGEJO_URL is required (e.g. https://forgejo.example.org).");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fatal(`FORGEJO_URL is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fatal("FORGEJO_URL must use http or https.");
  }
  return raw;
}

const instanceUrl = readInstanceUrl();
const defaults: RepoDefaults = {
  owner: process.env.FORGEJO_DEFAULT_OWNER || undefined,
  repo: process.env.FORGEJO_DEFAULT_REPO || undefined,
};

/** One MCP server per token: the tools close over the authenticated client. */
function createServer(token: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, new ForgejoClient(instanceUrl, token), defaults);
  return server;
}

/** Extracts the token from the headers, never logging it. */
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
      "FORGEJO_TOKEN is required in stdio mode. Create one at " +
        `${instanceUrl}/user/settings/applications (scopes: write:issue, write:repository).`,
    );
  }
  const server = createServer(token);
  await server.connect(new StdioServerTransport());
  console.error(`[${SERVER_NAME}] ready on stdio against ${instanceUrl}`);
}

async function runHttp(): Promise<void> {
  if (process.env.FORGEJO_TOKEN) {
    fatal(
      "FORGEJO_TOKEN must NOT be set in http mode: the token has to come from each " +
        "caller, otherwise every user would act under a single identity.",
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
        "Missing Forgejo token. Send an 'Authorization: Bearer <token>' header. " +
          "Each user supplies their own: this server holds none.",
      );
      return;
    }

    // Fresh transport and server per request: stateless mode, and above all no
    // token leaking from one caller to another.
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
      console.error(`[${SERVER_NAME}] MCP request failed:`, error);
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal MCP server error.");
      }
    }
  });

  // Stateless mode: no SSE stream to open, no session to delete.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    jsonRpcError(res, 405, -32000, "Only POST /mcp is accepted (stateless mode).");
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  // Bind explicitly to 0.0.0.0: containerised platforms (Railway, Fly, Cloud
  // Run) route to that interface. Letting Node choose can end up listening on
  // :: only, and the platform then never gets a response.
  app.listen(port, "0.0.0.0", () => {
    console.error(`[${SERVER_NAME}] ready on http 0.0.0.0:${port}/mcp against ${instanceUrl}`);
  });
}

const transport = (process.env.TRANSPORT ?? "stdio").toLowerCase();
const start = transport === "http" ? runHttp : runStdio;

start().catch((error: unknown) => {
  console.error(`[${SERVER_NAME}] failed to start:`, error);
  process.exit(1);
});
