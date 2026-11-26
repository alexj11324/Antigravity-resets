// MCP endpoint contract: bounded input, no internal detail in responses, and
// the two read-only tools the llms.txt advertises.

import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest } from "../src/mcp.mjs";

const SITE = "https://antigravity-resets.com";

function rpc(method, params, { id = 1, headers = {}, body } = {}) {
  return new Request(`${SITE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: body !== undefined ? body : JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

test("tools/list exposes exactly the documented read-only tools", async () => {
  const res = await handleMcpRequest(rpc("tools/list"), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    body.result.tools.map((tool) => tool.name).sort(),
    ["get_status", "list_resets"],
  );
  for (const tool of body.result.tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
  }
});

test("initialize reports the protocol version and server info", async () => {
  const res = await handleMcpRequest(
    rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
    {},
  );
  const body = await res.json();
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.equal(body.result.serverInfo.title, "Antigravity Resets");
});

test("get_status returns structured data from the seed history", async () => {
  const res = await handleMcpRequest(
    rpc("tools/call", { name: "get_status", arguments: {} }),
    {},
  );
  const body = await res.json();
  const data = body.result.structuredContent;
  assert.ok(data.stats.totalResets > 0);
  assert.match(data.latest.url, /^https:\/\/x\.com\//);
});

test("list_resets honours the limit argument", async () => {
  const res = await handleMcpRequest(
    rpc("tools/call", { name: "list_resets", arguments: { limit: 2 } }),
    {},
  );
  const body = await res.json();
  assert.equal(body.result.structuredContent.resets.length, 2);
});

test("an unknown tool is a client error and names only the tool", async () => {
  const res = await handleMcpRequest(
    rpc("tools/call", { name: "drop_tables", arguments: {} }),
    {},
  );
  const body = await res.json();
  assert.equal(body.error.code, -32602);
  assert.match(body.error.message, /Unknown tool: drop_tables/);
});

test("a body over 64 KB is rejected before parsing", async () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
    padding: "x".repeat(70 * 1024),
  });
  const res = await handleMcpRequest(
    rpc("ping", undefined, { body, headers: { "Content-Length": String(body.length) } }),
    {},
  );
  assert.equal(res.status, 413);
  const payload = await res.json();
  assert.match(payload.error.message, /Payload too large/);
});

test("malformed JSON returns a parse error instead of throwing", async () => {
  const res = await handleMcpRequest(rpc("ping", undefined, { body: "{not json" }), {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32700);
});

test("internal failures never echo exception text to the client", async (t) => {
  t.mock.method(console, "error", () => {});
  const env = {
    DB: {
      prepare() {
        throw new Error("SECRET_INTERNAL_DETAIL_should_not_leak");
      },
    },
  };
  const res = await handleMcpRequest(
    rpc("tools/call", { name: "get_status", arguments: {} }),
    env,
  );
  const raw = await res.text();
  assert.ok(!raw.includes("SECRET_INTERNAL_DETAIL"), "internal detail must not reach the client");
  assert.match(raw, /failed to complete|Internal error/);
  JSON.parse(raw);
});

test("GET is refused with a JSON-RPC error, as MCP clients expect", async () => {
  const res = await handleMcpRequest(new Request(`${SITE}/mcp`, { method: "GET" }), {});
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST, OPTIONS");
});
