// forgejo_update_issue handler, against an in-memory stand-in for the Forgejo API.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ForgejoClient } from "../src/forgejo.js";
import type { ToolResult } from "../src/format.js";
import { registerTools } from "../src/tools.js";
import type { ForgejoIssue, ForgejoLabel } from "../src/types.js";

const ISSUE_PATH = "/repos/Ruches/crm/issues/13";

interface Call {
  method: "GET" | "PATCH" | "PUT";
  path: string;
  body?: unknown;
}

/**
 * Mimics the Forgejo endpoints the handler touches, including the behaviour
 * behind the bug: EditIssueOption has no labels field, so PATCH drops it.
 */
class FakeForgejo {
  readonly calls: Call[] = [];
  readonly repoLabels: ForgejoLabel[] = [
    { id: 1, name: "bug" },
    { id: 2, name: "enhancement" },
    { id: 3, name: "urgent" },
  ];
  issue: ForgejoIssue = {
    number: 13,
    title: "Original title",
    state: "open",
    labels: [{ id: 2, name: "enhancement" }],
    assignees: [],
    comments: 0,
    created_at: "2026-09-25T00:00:00Z",
    updated_at: "2026-09-25T00:00:00Z",
    html_url: "https://forgejo.example.org/Ruches/crm/issues/13",
  };

  async get<T>(path: string): Promise<T> {
    this.calls.push({ method: "GET", path });
    return structuredClone(this.issue) as T;
  }

  async getList<T>(path: string): Promise<{ items: T[]; total: number }> {
    this.calls.push({ method: "GET", path });
    return { items: structuredClone(this.repoLabels) as T[], total: this.repoLabels.length };
  }

  async patch<T>(path: string, body: Record<string, unknown>): Promise<T> {
    this.calls.push({ method: "PATCH", path, body });
    const { title, state, body: text, assignees } = body;
    if (typeof title === "string") this.issue.title = title;
    if (typeof state === "string") this.issue.state = state;
    if (typeof text === "string") this.issue.body = text;
    if (Array.isArray(assignees)) {
      this.issue.assignees = assignees.map((login: string, id) => ({ id, login }));
    }
    return structuredClone(this.issue) as T;
  }

  async put<T>(path: string, body: { labels: number[] }): Promise<T> {
    this.calls.push({ method: "PUT", path, body });
    this.issue.labels = this.repoLabels.filter((label) => body.labels.includes(label.id));
    return structuredClone(this.issue.labels) as T;
  }
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResult>;

function updateIssueHandler(forgejo: FakeForgejo): Handler {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  registerTools(server as unknown as McpServer, forgejo as unknown as ForgejoClient, {
    owner: "Ruches",
    repo: "crm",
  });
  const handler = handlers.get("forgejo_update_issue");
  assert.ok(handler, "forgejo_update_issue is registered");
  return handler;
}

describe("forgejo_update_issue", () => {
  let forgejo: FakeForgejo;
  let update: (params: Record<string, unknown>) => Promise<ToolResult>;

  beforeEach(() => {
    forgejo = new FakeForgejo();
    const handler = updateIssueHandler(forgejo);
    update = (params) => handler({ number: 13, response_format: "json", ...params });
  });

  it("replaces the labels alone through PUT, without an empty PATCH", async () => {
    const result = await update({ labels: ["bug", "Urgent"] });

    assert.equal(result.isError, undefined);
    assert.deepEqual(forgejo.calls, [
      { method: "GET", path: "/repos/Ruches/crm/labels" },
      { method: "GET", path: ISSUE_PATH },
      { method: "PUT", path: `${ISSUE_PATH}/labels`, body: { labels: [1, 3] } },
    ]);
    assert.deepEqual(result.structuredContent, {
      number: 13,
      title: "Original title",
      state: "open",
      labels: ["bug", "urgent"],
      assignees: [],
      html_url: forgejo.issue.html_url,
      unresolved_labels: [],
    });
  });

  it("sends the title through PATCH and the labels through PUT", async () => {
    const result = await update({ title: "New title", labels: ["bug"] });

    assert.deepEqual(forgejo.calls, [
      { method: "GET", path: "/repos/Ruches/crm/labels" },
      { method: "PATCH", path: ISSUE_PATH, body: { title: "New title" } },
      { method: "PUT", path: `${ISSUE_PATH}/labels`, body: { labels: [1] } },
    ]);
    assert.equal(result.structuredContent?.title, "New title");
    assert.deepEqual(result.structuredContent?.labels, ["bug"]);
  });

  it("clears every label when given an empty list", async () => {
    const result = await update({ labels: [] });

    assert.deepEqual(forgejo.calls, [
      { method: "GET", path: ISSUE_PATH },
      { method: "PUT", path: `${ISSUE_PATH}/labels`, body: { labels: [] } },
    ]);
    assert.deepEqual(result.structuredContent?.labels, []);
    assert.deepEqual(forgejo.issue.labels, []);
  });

  it("reports unknown labels and applies the known ones", async () => {
    const result = await update({ labels: ["bug", "wontfix"], response_format: "markdown" });

    const put = forgejo.calls.find((call) => call.method === "PUT");
    assert.deepEqual(put?.body, { labels: [1] });
    assert.deepEqual(result.structuredContent?.labels, ["bug"]);
    assert.deepEqual(result.structuredContent?.unresolved_labels, ["wontfix"]);
    assert.match(result.content[0]?.text ?? "", /labels: bug\n/);
    assert.match(result.content[0]?.text ?? "", /Unknown labels, skipped: wontfix/);
  });

  it("leaves the labels untouched when they are not given", async () => {
    const result = await update({ state: "closed" });

    assert.deepEqual(forgejo.calls, [
      { method: "PATCH", path: ISSUE_PATH, body: { state: "closed" } },
    ]);
    assert.deepEqual(result.structuredContent?.labels, ["enhancement"]);
  });

  it("refuses a call that changes nothing", async () => {
    const result = await update({});

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /nothing to update/);
    assert.deepEqual(forgejo.calls, []);
  });
});
