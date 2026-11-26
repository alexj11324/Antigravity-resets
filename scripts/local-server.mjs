#!/usr/bin/env node
// Local development server that runs the exact Cloudflare Worker entrypoint (src/index.mjs)
// backed by a lightweight in-memory D1-compatible adapter and static file serving from ./public.
// Optionally loads .dev.vars if present (never logs secret values).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.mjs";
import { createMemoryD1 } from "./memory-d1.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function loadDevVars() {
  const vars = {
    WATCHED_X_HANDLES: process.env.WATCHED_X_HANDLES || "_mohansolo,_anshulr,antigravity",
    SITE_URL: `http://${HOST}:${PORT}`,
  };
  for (const key of [
    "X_OAUTH2_CLIENT_SECRET",
    "X_API_KEY_SECRET",
    "X_BEARER_TOKEN",
    "GEMINI_API_KEY",
    "GEMINI_API_BASE_URL",
    "DECISIONS_API_URL",
    "DECISIONS_MODEL",
    "FLASH_MODEL",
    "ARBITRATOR_MODEL",
    "ENABLE_TIER2_ARBITRATOR",
    "JOINT_JUDGE_MODE",
    "ALLOW_HEURISTIC_FALLBACK",
    "ADMIN_API_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "ADMIN_TELEGRAM_BOT_TOKEN",
    "ADMIN_TELEGRAM_CHAT_ID",
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL",
  ]) {
    if (process.env[key]) vars[key] = process.env[key];
  }
  const devVarsPath = path.join(ROOT, ".dev.vars");
  if (fs.existsSync(devVarsPath)) {
    const lines = fs.readFileSync(devVarsPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        try {
          val = JSON.parse(val);
        } catch {
          val = val.slice(1, -1);
        }
      }
      if (!vars[key]) vars[key] = val;
    }
  }
  return vars;
}

function createStaticAssetsBinding(publicDir) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const target = path.resolve(publicDir, "." + rel);
      if (!target.startsWith(publicDir)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        return new Response("Not found", { status: 404 });
      }
      const ext = path.extname(target).toLowerCase();
      const body = fs.readFileSync(target);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
          "Cache-Control": "no-cache",
        },
      });
    },
  };
}

const env = {
  ...loadDevVars(),
  DB: createMemoryD1(),
  ASSETS: createStaticAssetsBinding(PUBLIC_DIR),
};

const server = http.createServer(async (req, res) => {
  try {
    const origin = `http://${req.headers.host || `${HOST}:${PORT}`}`;
    const url = new URL(req.url || "/", origin);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuf = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const webReq = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : bodyBuf,
    });

    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(promise) };
    const webRes = await worker.fetch(webReq, env, ctx);

    res.statusCode = webRes.status;
    webRes.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const out = Buffer.from(await webRes.arrayBuffer());
    res.end(out);
    if (pending.length > 0) {
      Promise.allSettled(pending);
    }
  } catch (err) {
    console.error("Local Worker error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Antigravity Resets local Worker running at http://${HOST}:${PORT}`);
  console.log(`API status:  http://${HOST}:${PORT}/api/v1/status`);
  console.log(`API docs:    http://${HOST}:${PORT}/api/docs`);
  console.log(`X webhook:   http://${HOST}:${PORT}/api/webhooks/x`);
});
