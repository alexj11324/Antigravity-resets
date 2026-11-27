// OpenAPI 3.1 description of the public read-only API, served at
// /api/openapi.json so agents and code generators can discover it.

import { SITE_ORIGIN } from "./seo-data.mjs";

/** @returns {object} OpenAPI document */
export function buildOpenApi() {
  const reset = {
    type: "object",
    required: ["id", "timestamp", "type", "authorHandle", "url", "summary"],
    properties: {
      id: { type: "string", description: "Stable reset id." },
      tweetId: { type: ["string", "null"], description: "Source X post id when known." },
      timestamp: { type: "string", format: "date-time", description: "UTC announcement time." },
      type: { type: "string", enum: ["regular", "banked"], description: "Kind of reset granted." },
      authorHandle: { type: "string", description: "Announcing X handle." },
      authorName: { type: "string", description: "Announcing account display name." },
      models: {
        type: "array",
        items: { type: "string" },
        description: "Models named in the announcement.",
      },
      url: { type: "string", format: "uri", description: "Original X post." },
      thanksCount: { type: "integer", description: "Reaction tally recorded by this tracker." },
      summary: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Localized one-line summary keyed by locale (en, zh-CN, zh-TW, ja, ko).",
      },
      textI18n: {
        type: ["object", "null"],
        additionalProperties: { type: "string" },
        description:
          "Machine translation of the original post text keyed by locale (zh-CN, zh-TW, ja, ko). Null until the backfill has translated it; see /api-docs for the AI-translation label.",
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Antigravity Resets Public API",
      version: "1.0.0",
      description:
        "Read-only access to verified official Google Antigravity quota reset announcements. Independent community tracker, not affiliated with Google.",
    },
    servers: [{ url: SITE_ORIGIN }],
    paths: {
      "/api/v1/status": {
        get: {
          operationId: "getStatus",
          summary: "Latest reset and aggregate statistics",
          responses: {
            200: {
              description: "Current status.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      service: { type: "string" },
                      watchedAccounts: { type: "array", items: { type: "string" } },
                      latest: { anyOf: [{ $ref: "#/components/schemas/Reset" }, { type: "null" }] },
                      stats: {
                        type: "object",
                        properties: {
                          totalResets: { type: "integer" },
                          avgIntervalDays: { type: "number" },
                          longestWaitDays: { type: "number" },
                          regularCount: { type: "integer" },
                          bankedCount: { type: "integer" },
                        },
                      },
                      thanksCount: { type: "integer" },
                      onlineCount: {
                        type: ["integer", "null"],
                        minimum: 0,
                        description: "Sessions active in the last 90 seconds, or null when presence storage is unavailable.",
                      },
                      generatedAt: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/resets": {
        get: {
          operationId: "listResets",
          summary: "Full verified reset history",
          parameters: [
            {
              name: "type",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["regular", "banked"] },
              description: "Restrict to one reset type.",
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 200 },
              description: "Maximum number of resets to return.",
            },
          ],
          responses: {
            200: {
              description: "Reset list, newest first.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      count: { type: "integer" },
                      stats: {
                        type: "object",
                        properties: {
                          totalResets: { type: "integer" },
                          avgIntervalDays: { type: "number" },
                          longestWaitDays: { type: "number" },
                        },
                      },
                      resets: { type: "array", items: { $ref: "#/components/schemas/Reset" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/badge.svg": {
        get: {
          operationId: "getBadge",
          summary: "Embeddable live status badge",
          responses: {
            200: {
              description: "SVG badge.",
              content: { "image/svg+xml": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/feed.xml": {
        get: {
          operationId: "getFeed",
          summary: "RSS 2.0 feed of verified announcements",
          responses: {
            200: {
              description: "RSS feed.",
              content: { "application/rss+xml": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/mcp": {
        post: {
          operationId: "mcp",
          summary: "Model Context Protocol endpoint (Streamable HTTP, JSON-RPC 2.0)",
          description:
            "Exposes read-only tools: get_status and list_resets. Also reachable at the same URL from any MCP client.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jsonrpc: { type: "string", const: "2.0" },
                    id: { type: ["string", "integer", "null"] },
                    method: { type: "string" },
                    params: { type: "object" },
                  },
                  required: ["jsonrpc", "method"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "JSON-RPC response (application/json or text/event-stream).",
              content: {
                "application/json": { schema: { type: "object" } },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
          },
        },
      },
    },
    components: { schemas: { Reset: reset } },
  };
}
