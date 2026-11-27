import { handleApiRequest } from "./api.mjs";
import { handleXWebhook } from "./x-webhook.mjs";
import { drainTelegramOutbox } from "./telegram-outbox.mjs";
import { langFromPath, SITE_ORIGIN } from "./seo-data.mjs";
import { handleHtmlRequest } from "./seo-html.mjs";
import {
  renderLlmsTxt,
  renderMarkdownResponse,
  renderRobots,
  renderSitemap,
} from "./seo-text.mjs";
import { handleMcpRequest } from "./mcp.mjs";
import { buildOpenApi } from "./openapi.mjs";
import { handleGuideMarkdownRequest, handleGuideRequest } from "./guide.mjs";
import { translatePendingResets } from "./translate.mjs";

const APEX_HOST = "antigravity-resets.com";
const WWW_HOST = `www.${APEX_HOST}`;
const MARKDOWN_ROUTE = /^\/(index|zh-CN|zh-TW|ja|ko)\.md$/;

/**
 * 301 for document requests, 308 for anything with a body: a 301 lets some
 * clients rewrite a POST to GET, which would silently break the webhook and
 * the /api/v1 writes if they ever arrive on a non-canonical spelling.
 * @param {Request} request
 */
function redirectStatus(request) {
  return request.method === "GET" || request.method === "HEAD" ? 301 : 308;
}

const app = {
  async scheduled(_controller, env) {
    // Translations first: they are independent of the outbox, and a broken
    // outbox must not starve the backfill.
    try {
      await translatePendingResets(env, 2);
    } catch (error) {
      console.error("translation_backfill_failed", error);
    }
    const result = await drainTelegramOutbox(env);
    if (result.error) throw new Error("Telegram outbox drain failed");
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Single canonical hostname, otherwise both hosts serve identical pages.
    if (url.hostname === WWW_HOST) {
      const canonical = new URL(request.url);
      canonical.hostname = APEX_HOST;
      return Response.redirect(canonical.toString(), redirectStatus(request));
    }

    if (pathname === "/api/webhooks/x") {
      return handleXWebhook(request, env, ctx);
    }

    // The documented path used to 307 to /api-docs. Make it a permanent
    // redirect so sitemaps and inbound links settle on one URL. Handled before
    // the generic trailing-slash rule so it stays a single hop.
    if (pathname === "/api/docs" || pathname === "/api/docs/") {
      return Response.redirect(new URL("/api-docs", url.origin).toString(), redirectStatus(request));
    }

    // Collapse duplicate URL spellings before any router sees the path. This has
    // to run ahead of the /api/ branch: otherwise POST /api/v1/thanks/ would 404
    // instead of redirecting, and a body-bearing request would lose its target.
    if (pathname === "/index.html") {
      return Response.redirect(new URL("/", url.origin).toString(), redirectStatus(request));
    }
    if (pathname.length > 1 && pathname.endsWith("/")) {
      return Response.redirect(
        new URL(pathname.replace(/\/+$/, ""), url.origin).toString(),
        redirectStatus(request),
      );
    }

    if (pathname === "/mcp") {
      return handleMcpRequest(request, env);
    }

    if (pathname === "/api/openapi.json") {
      return Response.json(buildOpenApi(), {
        headers: { "Cache-Control": "public, max-age=3600" },
      });
    }

    // RFC 9727 API catalog: one machine-readable place that points at the
    // OpenAPI description, the human docs, and a live status representation.
    if (pathname === "/.well-known/api-catalog") {
      const linkset = {
        linkset: [
          {
            anchor: `${SITE_ORIGIN}/api/v1`,
            "service-desc": [
              { href: `${SITE_ORIGIN}/api/openapi.json`, type: "application/json" },
            ],
            "service-doc": [{ href: `${SITE_ORIGIN}/api-docs`, type: "text/html" }],
            status: [{ href: `${SITE_ORIGIN}/api/v1/status`, type: "application/json" }],
          },
        ],
      };
      return new Response(JSON.stringify(linkset), {
        headers: {
          "Content-Type":
            'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // The HTML reference should name its machine-readable sibling.
    if (pathname === "/api-docs" && env?.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      headers.set(
        "Link",
        '</api/openapi.json>; rel="service-desc"; type="application/json"',
      );
      return new Response(asset.body, { status: asset.status, headers });
    }

    if (
      pathname.startsWith("/api/") ||
      pathname === "/feed.xml" ||
      pathname === "/rss.xml"
    ) {
      return handleApiRequest(request, env);
    }

    // Machine-readable surfaces.
    if (pathname === "/llms.txt") {
      const body = await renderLlmsTxt(env);
      return new Response(body, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    if (pathname === "/sitemap.xml") {
      const body = await renderSitemap(env);
      return new Response(body, {
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          "Cache-Control": "public, max-age=600",
        },
      });
    }

    if (pathname === "/robots.txt") {
      return new Response(renderRobots(), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    const markdownMatch = pathname.match(MARKDOWN_ROUTE);
    if (markdownMatch) {
      const lang = markdownMatch[1] === "index" ? "en" : markdownMatch[1];
      return renderMarkdownResponse(env, lang);
    }

    // Each guide page advertises its own Markdown mirror; serving the homepage
    // mirror from a guide URL made the alternate a lie for five URLs.
    const guideMarkdownMatch = pathname.match(/^\/(?:(zh-CN|zh-TW|ja|ko)\/)?guide\.md$/);
    if (guideMarkdownMatch) {
      return handleGuideMarkdownRequest(guideMarkdownMatch[1] || "en");
    }

    if (pathname === "/guide" || /^\/(zh-CN|zh-TW|ja|ko)\/guide$/.test(pathname)) {
      return handleGuideRequest(request, env, pathname);
    }

    const lang = langFromPath(pathname);
    if (lang && env?.ASSETS) {
      return handleHtmlRequest(request, env, lang);
    }

    if (env?.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

export default {
  scheduled: app.scheduled,
  async fetch(request, env, ctx) {
    // Every route matches on GET, so a HEAD request has to run the GET path and
    // then drop the body. Answering 404 to HEAD would break uptime checks and
    // link validators that only ask for headers.
    if (request.method !== "HEAD") return app.fetch(request, env, ctx);
    const response = await app.fetch(new Request(request, { method: "GET" }), env, ctx);
    return new Response(null, { status: response.status, headers: response.headers });
  },
};
