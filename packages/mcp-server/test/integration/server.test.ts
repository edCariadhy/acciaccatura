import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AnnotationStore } from "@acciaccatura/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../../src/server.js";

/**
 * Integration test: drives the server through a real MCP {@link Client} over an
 * in-memory transport pair — the same request/response path an agent host uses,
 * without spawning a process or needing a prior build. Exercises the tools and
 * the product invariants they must uphold.
 */
let root: string;
let client: Client;

async function connect(): Promise<Client> {
  const store = new AnnotationStore(join(root, ".acciaccatura", "annotations.json"));
  await store.load();
  const server = createServer(store, root);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(clientT);
  return c;
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((p) => p.text ?? "").join("\n");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "acc-int-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "math.ts"), "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
  client = await connect();
});

afterEach(async () => {
  await client.close();
  await rm(root, { recursive: true, force: true });
});

describe("MCP server integration", () => {
  it("advertises exactly the three tools, each with a when-to-call description", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "annotate_code",
      "get_annotations",
      "remove_annotation",
    ]);
    const get = tools.find((t) => t.name === "get_annotations");
    expect(get?.description ?? "").toMatch(/before editing/i);
  });

  it("round-trips annotate → get, reporting drift 'aligned' while code is unchanged", async () => {
    const snap = "export function add(a, b) {\n  return a + b;";
    const saved = await client.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: 1, endLine: 2, snapshot: snap, body: "add() is pure — keep it side-effect free." },
    });
    expect(textOf(saved as never)).toMatch(/^Saved annotation /);

    const got = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts", line: 1 } });
    const text = textOf(got as never);
    expect(text).toContain("drift: aligned");
    expect(text).toContain("keep it side-effect free");
    expect(text).toContain("[agent/suggested]");
  });

  it("degrades loudly: drift flips to 'drifted' when code changes under the anchor", async () => {
    const snap = "export function add(a, b) {\n  return a + b;";
    await client.callTool({ name: "annotate_code", arguments: { file: "src/math.ts", startLine: 1, endLine: 2, snapshot: snap, body: "note" } });
    await writeFile(join(root, "src", "math.ts"), "export function add(a, b) {\n  return a - b;\n}\n", "utf8");

    const got = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts", line: 1 } });
    expect(textOf(got as never)).toContain("drift: drifted");
  });

  it("bounds results to 3 by default and honors an explicit limit", async () => {
    for (let i = 1; i <= 5; i++) {
      await client.callTool({ name: "annotate_code", arguments: { file: "src/math.ts", startLine: i, endLine: i, snapshot: `l${i}`, body: `n${i}` } });
    }
    const def = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts" } });
    expect((textOf(def as never).match(/drift:/g) ?? []).length).toBe(3);

    const all = await client.callTool({ name: "get_annotations", arguments: { file: "src/math.ts", limit: 10 } });
    expect((textOf(all as never).match(/drift:/g) ?? []).length).toBe(5);
  });

  it("rejects malformed input at the tool boundary (negative startLine)", async () => {
    const bad = await client.callTool({
      name: "annotate_code",
      arguments: { file: "src/math.ts", startLine: -1, endLine: 2, snapshot: "x", body: "y" },
    });
    expect((bad as { isError?: boolean }).isError).toBe(true);
  });
});
