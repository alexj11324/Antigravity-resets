// Remote MCP server (Streamable HTTP, JSON-RPC 2.0) so AI agents can query the
// tracker directly instead of scraping the page.
//
// Mirrors what codex-resets.com exposes at /mcp: read-only tools, no auth,
// responses as text/event-stream to match the widely-tested path.

import { loadSeoData, SITE_NAME, SITE_ORIGIN } from "./seo-data.mjs";
import { getActiveExpectedReset } from "./store.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;
const CURSOR_ERROR = "Invalid cursor.";
const RANGE_ERROR = "Invalid time range.";

/**
 * Read and parse a JSON body without buffering more than `maxBytes`. The
 * unbounded `request.json()` would let a caller stream arbitrary memory into
 * the isolate before any validation runs.
 * @param {Request} request
 * @returns {Promise<{data?: unknown, error?: string, status?: number}>}
 */
async function readBoundedJson(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { error: "Payload too large", status: 413 };
  }
  if (!request.body) return { data: {} };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { error: "Payload too large", status: 413 };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  if (total === 0) return { data: {} };
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { data: JSON.parse(new TextDecoder().decode(buffer)) };
  } catch {
    return { error: "Parse error", status: 400 };
  }
}

const SERVER_ICONS = Object.freeze([
  Object.freeze({
    src: `${SITE_ORIGIN}/icon-512.png`,
    mimeType: "image/png",
    sizes: Object.freeze(["512x512"]),
  }),
]);

const SERVER_INFO = {
  name: "com.antigravity-resets/tracker",
  title: SITE_NAME,
  version: "1.0.0",
  description:
    "Public Google Antigravity quota reset status, verified announcement history, and reset statistics.",
  websiteUrl: SITE_ORIGIN,
  icons: SERVER_ICONS,
};

const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
});

export const MCP_TOOLS = [
  {
    name: "get_status",
    title: "Get Antigravity reset status",
    description:
      "Return the latest verified official Google Antigravity quota reset, any scheduled reset awaiting execution evidence, aggregate statistics (total resets, average interval, longest wait), and the announcing account. This is a factual record of public announcements, not an official Google commitment.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: "list_resets",
    title: "List Antigravity reset announcements",
    description:
      "List verified official Google Antigravity quota reset announcements with timestamps, announcing account, affected models, source X links, and a localized summary. Supports type filtering, an inclusive ISO 8601 time range, ascending or descending order, and opaque cursor pagination.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: DEFAULT_LIMIT,
          description: "Maximum number of announcements to return. Defaults to 20.",
        },
        type: {
          type: "string",
          enum: ["regular", "banked"],
          description: "Restrict to one reset type.",
        },
        from: {
          type: "string",
          format: "date-time",
          description: "Inclusive lower bound on the announcement timestamp (ISO 8601).",
        },
        to: {
          type: "string",
          format: "date-time",
          description: "Inclusive upper bound on the announcement timestamp (ISO 8601).",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          default: "desc",
          description: "Sort direction by timestamp. Defaults to desc (newest first).",
        },
        cursor: {
          type: "string",
          minLength: 1,
          maxLength: 1024,
          pattern: "^[A-Za-z0-9_-]{1,1024}$",
          description:
            "Opaque cursor from a previous list_resets response. Pass it back unchanged to fetch the next page.",
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolText(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** A caller-input error whose fixed message is safe to return verbatim. */
class ToolInputError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ToolInputError";
    this.code = -32602;
  }
}

/**
 * @param {unknown} value requested page size
 * @returns {number} page size clamped to the advertised 1-100 range
 */
function normalizeLimit(value) {
  if (!Number.isInteger(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(value, 1), MAX_LIMIT);
}

/**
 * Parse an optional ISO 8601 bound. Absent bounds are null; anything else
 * that does not parse is a client error with a fixed message.
 * @param {unknown} value
 * @returns {number|null} epoch milliseconds, or null when the bound is absent
 */
function parseBound(value) {
  if (value === undefined || value === null) return null;
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new ToolInputError(RANGE_ERROR);
  return ms;
}

/**
 * Total order for reset sort keys: timestamp first, then id so equal
 * timestamps still paginate deterministically.
 * @param {{reset: object, ms: number}} a
 * @param {{reset: object, ms: number}} b
 * @param {"asc"|"desc"} order
 * @returns {number}
 */
function compareSortKeys(a, b, order) {
  if (a.ms !== b.ms) return order === "asc" ? a.ms - b.ms : b.ms - a.ms;
  if (a.reset.id === b.reset.id) return 0;
  const byId = a.reset.id < b.reset.id ? -1 : 1;
  return order === "asc" ? byId : -byId;
}

/**
 * @param {{reset: object, ms: number}} entry
 * @param {{id: string, ms: number}} cursor decoded cursor key
 * @param {"asc"|"desc"} order
 * @returns {boolean} whether `entry` sorts strictly after the cursor key
 */
function isAfterCursor(entry, cursor, order) {
  if (entry.ms !== cursor.ms) {
    return order === "asc" ? entry.ms > cursor.ms : entry.ms < cursor.ms;
  }
  return order === "asc" ? entry.reset.id > cursor.id : entry.reset.id < cursor.id;
}

/**
 * Encode the last returned item's sort key as an opaque base64url cursor.
 * The order travels with the key so a cursor cannot be replayed across sort
 * directions.
 * @param {object} reset
 * @param {"asc"|"desc"} order
 * @returns {string}
 */
function encodeCursor(reset, order) {
  const json = JSON.stringify({ order, timestamp: reset.timestamp, id: reset.id });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode an opaque cursor. Total for every input: anything malformed becomes
 * a fixed -32602 error, never an exception that could carry internals.
 * @param {unknown} raw
 * @returns {{order: "asc"|"desc", timestamp: string, id: string, ms: number}}
 */
function decodeCursor(raw) {
  if (typeof raw !== "string" || !CURSOR_PATTERN.test(raw)) {
    throw new ToolInputError(CURSOR_ERROR);
  }

  let decoded;
  try {
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ToolInputError(CURSOR_ERROR);
  }

  if (!decoded || typeof decoded !== "object") throw new ToolInputError(CURSOR_ERROR);
  const { order, timestamp, id } = decoded;
  if (
    (order !== "asc" && order !== "desc") ||
    typeof timestamp !== "string" ||
    typeof id !== "string"
  ) {
    throw new ToolInputError(CURSOR_ERROR);
  }
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) throw new ToolInputError(CURSOR_ERROR);
  return { order, timestamp, id, ms };
}

/**
 * Project a stored reset onto the public tool shape. `textI18n` is passed
 * through only when the stored record actually carries it.
 * @param {object} reset
 * @returns {object}
 */
function projectReset(reset) {
  return {
    id: reset.id,
    timestamp: reset.timestamp,
    type: reset.type,
    authorHandle: reset.authorHandle,
    authorName: reset.authorName,
    models: reset.models,
    url: reset.url,
    thanksCount: reset.thanksCount,
    summary: reset.summary,
    ...(reset.textI18n !== undefined ? { textI18n: reset.textI18n } : {}),
  };
}

/**
 * Filter, sort, and paginate announcements for `list_resets`. Counts and
 * totals are derived from the filtered list, before the cursor is applied.
 * @param {object[]} resets
 * @param {Record<string, unknown>} args
 * @returns {{count: number, total: number, hasMore: boolean, nextCursor: string|null, resets: object[]}}
 */
function buildResetPage(resets, args) {
  const limit = normalizeLimit(args.limit);
  const type = args.type === "regular" || args.type === "banked" ? args.type : null;
  const order = args.order === "asc" ? "asc" : "desc";
  const fromMs = parseBound(args.from);
  const toMs = parseBound(args.to);
  const cursor =
    args.cursor === undefined || args.cursor === null ? null : decodeCursor(args.cursor);
  if (cursor && cursor.order !== order) throw new ToolInputError(CURSOR_ERROR);

  const entries = (Array.isArray(resets) ? resets : [])
    .filter((reset) => !type || reset.type === type)
    .map((reset) => ({ reset, ms: Date.parse(reset.timestamp) }))
    .filter(({ ms }) => Number.isFinite(ms))
    .filter(({ ms }) => (fromMs === null || ms >= fromMs) && (toMs === null || ms <= toMs))
    .sort((a, b) => compareSortKeys(a, b, order));

  const total = entries.length;
  const remaining = cursor
    ? entries.filter((entry) => isAfterCursor(entry, cursor, order))
    : entries;
  const page = remaining.slice(0, limit);
  const hasMore = remaining.length > page.length;
  const nextCursor = hasMore ? encodeCursor(page[page.length - 1].reset, order) : null;

  return {
    count: page.length,
    total,
    hasMore,
    nextCursor,
    resets: page.map(({ reset }) => projectReset(reset)),
  };
}

async function callTool(name, args, env) {
  const data = await loadSeoData(env);
  if (name === "get_status") {
    const upcomingReset = await getActiveExpectedReset(env?.DB);
    return toolText({
      latest: data.stats.latest,
      upcomingReset,
      stats: {
        totalResets: data.stats.total,
        avgIntervalDays: data.stats.avgIntervalDays,
        longestWaitDays: data.stats.longestWaitDays,
        regularCount: data.stats.regularCount,
        bankedCount: data.stats.bankedCount,
      },
      generatedAt: data.generatedAt,
      source: `${SITE_ORIGIN}/api/v1/status`,
    });
  }

  if (name === "list_resets") {
    return toolText(buildResetPage(data.resets, args ?? {}));
  }

  throw new ToolInputError(`Unknown tool: ${name}`);
}

async function dispatch(message, env) {
  const { id, method, params } = message || {};

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: MCP_TOOLS });

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const result = await callTool(name, args, env);
      return rpcResult(id, result);
    } catch (error) {
      console.error("mcp_tool_failed", name, error);
      // Only fixed input-error messages may reach the client; anything else
      // could carry internal detail, so return a fixed message.
      if (error instanceof ToolInputError) return rpcError(id, -32602, error.message);
      return rpcError(id, -32603, "The tool failed to complete.");
    }
  }

  // Notifications carry no id and expect no response.
  if (id === undefined || id === null) return null;

  return rpcError(id, -32601, `Method not found: ${method}`);
}

/**
 * @param {Request} request
 * @param {object} env
 */
export async function handleMcpRequest(request, env) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // GET is the optional server->client stream; we have no server-initiated
  // messages, so answer the way clients expect: 405 with a JSON-RPC error.
  if (request.method !== "POST") {
    return Response.json(rpcError(null, -32000, "Method not allowed."), {
      status: 405,
      headers: { ...cors, Allow: "POST, OPTIONS" },
    });
  }

  const parsed = await readBoundedJson(request);
  if (parsed.error) {
    const status = parsed.status || 400;
    const code = status === 413 ? -32600 : -32700;
    return Response.json(rpcError(null, code, parsed.error), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  const message = parsed.data;

  let payload;
  try {
    payload = await dispatch(message, env);
  } catch (error) {
    console.error("mcp_dispatch_failed", error);
    payload = rpcError(message?.id ?? null, -32603, "Internal error");
  }

  if (payload === null) {
    // Notification: 202 with no body, per the streamable HTTP transport.
    return new Response(null, { status: 202, headers: cors });
  }

  const wantsStream = String(request.headers.get("accept") || "").includes("text/event-stream");
  if (!wantsStream) {
    return Response.json(payload, {
      headers: { ...cors, "Cache-Control": "no-store" },
    });
  }

  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    headers: {
      ...cors,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}
