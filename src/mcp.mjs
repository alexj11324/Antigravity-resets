// Remote MCP server (Streamable HTTP, JSON-RPC 2.0) so AI agents can query the
// tracker directly instead of scraping the page.
//
// Mirrors what codex-resets.com exposes at /mcp: read-only tools, no auth,
// responses as text/event-stream to match the widely-tested path.

import { loadSeoData, SITE_NAME, SITE_ORIGIN } from "./seo-data.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = {
  name: "com.antigravity-resets/tracker",
  title: SITE_NAME,
  version: "1.0.0",
  description:
    "Public Google Antigravity quota reset status, verified announcement history, and reset statistics.",
  websiteUrl: SITE_ORIGIN,
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
      "Return the latest verified official Google Antigravity quota reset, aggregate statistics (total resets, average interval, longest wait), and the announcing account. This is a factual record of public announcements, not an official Google commitment.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: "list_resets",
    title: "List Antigravity reset announcements",
    description:
      "List verified official Google Antigravity quota reset announcements, newest first, with timestamps, announcing account, affected models, source X links, and a localized summary.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum number of announcements to return. Defaults to 20.",
        },
        type: {
          type: "string",
          enum: ["regular", "banked"],
          description: "Restrict to one reset type.",
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

async function callTool(name, args, env) {
  const data = await loadSeoData(env);
  if (name === "get_status") {
    return toolText({
      latest: data.stats.latest,
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
    const limit = Number.isInteger(args?.limit)
      ? Math.min(Math.max(args.limit, 1), 200)
      : 20;
    const type = args?.type === "regular" || args?.type === "banked" ? args.type : null;
    const items = (data.resets || [])
      .filter((r) => !type || r.type === type)
      .slice(0, limit);
    return toolText({
      count: items.length,
      total: data.stats.total,
      resets: items.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        type: r.type,
        authorHandle: r.authorHandle,
        authorName: r.authorName,
        models: r.models,
        url: r.url,
        thanksCount: r.thanksCount,
        summary: r.summary,
      })),
      source: `${SITE_ORIGIN}/api/v1/resets`,
    });
  }

  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
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
      const code = error?.code || -32603;
      return rpcResult(id, {
        content: [{ type: "text", text: String(error?.message || "Tool failed") }],
        isError: true,
      }) && rpcError(id, code, String(error?.message || "Tool failed"));
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

  let message;
  try {
    message = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let payload;
  try {
    payload = await dispatch(message, env);
  } catch (error) {
    payload = rpcError(message?.id, -32603, String(error?.message || "Internal error"));
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
