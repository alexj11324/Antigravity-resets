// MCP endpoint contract: bounded input, no internal detail in responses, and
// the two read-only tools the llms.txt advertises.

import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest } from "../src/mcp.mjs";
import { createMemoryD1 } from "./sqlite-d1.mjs";

const SITE = "https://antigravity-resets.com";

function rpc(method, params, { id = 1, headers = {}, body } = {}) {
  return new Request(`${SITE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: body !== undefined ? body : JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function callTool(name, args = {}, env = {}) {
  const res = await handleMcpRequest(rpc("tools/call", { name, arguments: args }), env);
  return res.json();
}

/** D1 double that serves `count` already-seeded rows without touching SQLite. */
function bulkResetsDb(count) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `x-bulk-${String(index).padStart(4, "0")}`,
    tweet_id: null,
    timestamp: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
    type: "regular",
    author_handle: "@bulk",
    author_name: "Bulk Test",
    models_json: "[]",
    url: `https://x.com/bulk/status/${index}`,
    quote_text: null,
    summary_en: "Bulk reset.",
    summary_i18n_json: "{}",
    judge_summary_json: null,
    thanks_count: 0,
    source: "test",
  }));
  return {
    prepare(sql) {
      if (sql.includes("COUNT(*)")) return { first: async () => ({ count: rows.length }) };
      if (sql.includes("FROM resets")) return { all: async () => ({ results: rows }) };
      throw new Error(`Unexpected SQL in test double: ${sql}`);
    },
  };
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
  assert.deepEqual(body.result.serverInfo.icons, [
    {
      src: "https://antigravity-resets.com/icon-512.png",
      mimeType: "image/png",
      sizes: ["512x512"],
    },
  ]);
  // We have no event subscription implementation, so it must not be advertised.
  assert.equal(body.result.capabilities.events, undefined);
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

test("list_resets advertises the pagination arguments", async () => {
  const res = await handleMcpRequest(rpc("tools/list"), {});
  const body = await res.json();
  const tool = body.result.tools.find((entry) => entry.name === "list_resets");
  const schema = tool.inputSchema.properties;
  assert.equal(schema.limit.minimum, 1);
  assert.equal(schema.limit.maximum, 100);
  assert.deepEqual(schema.order.enum, ["asc", "desc"]);
  assert.equal(schema.order.default, "desc");
  assert.equal(schema.cursor.pattern, "^[A-Za-z0-9_-]{1,1024}$");
  assert.equal(schema.cursor.maxLength, 1024);
  assert.ok(schema.from, "from must be documented");
  assert.ok(schema.to, "to must be documented");
});

test("list_resets applies from/to as inclusive timestamp bounds", async () => {
  const body = await callTool("list_resets", {
    from: "2026-11-21T09:18:53Z",
    to: "2026-11-23T20:16:58Z",
  });
  const data = body.result.structuredContent;
  assert.equal(data.total, 2);
  assert.equal(data.count, 2);
  assert.equal(data.hasMore, false);
  assert.equal(data.nextCursor, null);
  assert.deepEqual(
    data.resets.map((item) => item.id),
    ["x-2124960419429458207", "x-2124070033534161407"],
  );
});

test("list_resets honours ascending order", async () => {
  const body = await callTool("list_resets", { order: "asc", limit: 3 });
  const data = body.result.structuredContent;
  assert.deepEqual(
    data.resets.map((item) => item.id),
    [
      "x-2057331857755422922",
      "x-2057656550286885284",
      "x-2057910616153882949",
    ],
  );
  const times = data.resets.map((item) => Date.parse(item.timestamp));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("list_resets cursors round-trip without overlap and end with a null nextCursor", async () => {
  const first = (await callTool("list_resets", { limit: 5 })).result.structuredContent;
  assert.equal(first.count, 5);
  assert.equal(first.total, 17);
  assert.equal(first.hasMore, true);
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]{1,1024}$/);

  const second = (await callTool("list_resets", { limit: 5, cursor: first.nextCursor })).result
    .structuredContent;
  assert.equal(second.count, 5);
  assert.equal(second.total, 17);
  assert.equal(second.hasMore, true);
  const firstIds = new Set(first.resets.map((item) => item.id));
  assert.ok(
    second.resets.every((item) => !firstIds.has(item.id)),
    "consecutive pages must not overlap",
  );

  const combinedTimes = [...first.resets, ...second.resets].map((item) => Date.parse(item.timestamp));
  for (let index = 1; index < combinedTimes.length; index++) {
    assert.ok(combinedTimes[index] <= combinedTimes[index - 1], "default order is newest first");
  }

  const head = (await callTool("list_resets", { limit: 10 })).result.structuredContent;
  const tail = (await callTool("list_resets", { limit: 10, cursor: head.nextCursor })).result
    .structuredContent;
  assert.equal(tail.count, 7);
  assert.equal(tail.hasMore, false);
  assert.equal(tail.nextCursor, null);
  assert.equal(new Set([...head.resets, ...tail.resets].map((item) => item.id)).size, 17);
});

test("a cursor issued for one order is rejected under the other", async (t) => {
  t.mock.method(console, "error", () => {});
  const first = (await callTool("list_resets", { limit: 2, order: "desc" })).result.structuredContent;
  const body = await callTool("list_resets", {
    limit: 2,
    order: "asc",
    cursor: first.nextCursor,
  });
  assert.equal(body.error.code, -32602);
  assert.equal(body.error.message, "Invalid cursor.");
});

test("malformed cursors are invalid params with a fixed message", async (t) => {
  t.mock.method(console, "error", () => {});
  const encoded = (value) => Buffer.from(value, "utf8").toString("base64url");
  const cursors = [
    "not a cursor!",
    "%",
    "x".repeat(1025),
    encoded("not json"),
    encoded(JSON.stringify({ order: "desc", timestamp: "not-a-date", id: "x-1" })),
    encoded(JSON.stringify({ order: "sideways", timestamp: "2026-11-01T00:00:00Z", id: "x-1" })),
    encoded(JSON.stringify({ order: "desc", id: "x-1" })),
  ];

  for (const cursor of cursors) {
    const body = await callTool("list_resets", { cursor });
    assert.equal(body.error?.code, -32602, cursor);
    assert.equal(body.error?.message, "Invalid cursor.", cursor);
    assert.ok(!JSON.stringify(body).includes("TypeError"), "decode detail must not leak");
  }
});

test("list_resets clamps limit to 100", async () => {
  const body = await callTool("list_resets", { limit: 1000 }, { DB: bulkResetsDb(150) });
  const data = body.result.structuredContent;
  assert.equal(data.count, 100);
  assert.equal(data.resets.length, 100);
  assert.equal(data.total, 150);
  assert.equal(data.hasMore, true);
  assert.ok(data.nextCursor);
});

test("get_status includes upcomingReset even when no watch is active", async () => {
  const body = await callTool("get_status");
  const data = body.result.structuredContent;
  assert.ok(Object.hasOwn(data, "upcomingReset"));
  assert.equal(data.upcomingReset, null);
});

test("get_status surfaces the scheduled reset awaiting execution evidence", async () => {
  const db = createMemoryD1();
  await db
    .prepare(
      `INSERT INTO announced_resets
        (id, tweet_id, announced_at, expected_by, type, author_handle, author_name, url, quote_text, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "ann-test-1",
      "2130000000000000777",
      "2026-11-27T00:00:00Z",
      "2026-11-28T01:00:00Z",
      "regular",
      "@_mohansolo",
      "Varun Mohan",
      "https://x.com/_mohansolo/status/2130000000000000777",
      "Reset tomorrow.",
      "expected",
    )
    .run();

  const body = await callTool("get_status", {}, { DB: db });
  const data = body.result.structuredContent;
  assert.equal(data.upcomingReset.id, "ann-test-1");
  assert.equal(data.upcomingReset.expectedBy, "2026-11-28T01:00:00Z");
  assert.equal(data.upcomingReset.status, "expected");
  assert.ok(data.stats.totalResets > 0);
});
