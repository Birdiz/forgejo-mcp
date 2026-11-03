// forgejo_get_commit_status handler, against an in-memory stand-in for the Forgejo API.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ForgejoClient } from "../src/forgejo.js";
import type { ToolResult } from "../src/format.js";
import { registerTools } from "../src/tools.js";
import type { ForgejoCombinedStatus } from "../src/types.js";

type Handler = (params: Record<string, unknown>) => Promise<ToolResult>;

function statusHandler(combined: ForgejoCombinedStatus, paths: string[]): Handler {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  const forgejo = {
    async get(path: string) {
      paths.push(path);
      return combined;
    },
  };
  registerTools(server as unknown as McpServer, forgejo as unknown as ForgejoClient, {
    owner: "Ruches",
    repo: "crm",
  });
  const handler = handlers.get("forgejo_get_commit_status");
  assert.ok(handler, "forgejo_get_commit_status is registered");
  return handler;
}

describe("forgejo_get_commit_status", () => {
  it("returns the combined state and one entry per job", async () => {
    const paths: string[] = [];
    const handler = statusHandler(
      {
        sha: "c101ddd",
        state: "pending",
        total_count: 2,
        statuses: [
          { context: "CI / Tests (push)", status: "success", description: "Successful in 1m" },
          { context: "CI / Deploy (push)", status: "pending" },
        ],
      },
      paths,
    );

    const result = await handler({ ref: "feat/branch", response_format: "json" });

    assert.deepEqual(paths, ["/repos/Ruches/crm/commits/feat/branch/status"]);
    assert.deepEqual(result.structuredContent, {
      sha: "c101ddd",
      state: "pending",
      total_count: 2,
      statuses: [
        {
          context: "CI / Tests (push)",
          status: "success",
          description: "Successful in 1m",
          target_url: null,
          updated_at: null,
        },
        {
          context: "CI / Deploy (push)",
          status: "pending",
          description: null,
          target_url: null,
          updated_at: null,
        },
      ],
    });
  });

  it("says so when no job has reported, as Forgejo answers for an unknown ref", async () => {
    const handler = statusHandler({ sha: "", state: "", total_count: 0, statuses: null }, []);

    const result = await handler({ ref: "nope", response_format: "markdown" });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0]!.text, /CI status of nope: no job reported/);
  });
});
