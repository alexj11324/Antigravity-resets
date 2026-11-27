import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { buildJsonLd, buildLiveAnswer } from "../src/seo-jsonld.mjs";
import { escapeHtml, formatExact, langFromPath } from "../src/seo-data.mjs";

const SITE = "https://antigravity-resets.com";

/** Minimal env: no DB, so every read falls back to seed data. */
const env = {};
const ctx = {};

test("langFromPath resolves every locale and rejects unknown paths", () => {
  assert.equal(langFromPath("/"), "en");
  assert.equal(langFromPath("/zh-CN"), "zh-CN");
  assert.equal(langFromPath("/zh-TW"), "zh-TW");
  assert.equal(langFromPath("/ja"), "ja");
  assert.equal(langFromPath("/ko"), "ko");
  // Trailing slashes normalize to the same locale, never to null.
  assert.equal(langFromPath("/ko/"), "ko");
  assert.equal(langFromPath("/zh-CN/"), "zh-CN");
  assert.equal(langFromPath("/api-docs"), null);
  assert.equal(langFromPath("/nope"), null);
});

test("www host 301s to the apex host", async () => {
  const res = await worker.fetch(new Request("https://www.antigravity-resets.com/"), env, ctx);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), `${SITE}/`);
});

test("www redirect preserves the path and query", async () => {
  const res = await worker.fetch(
    new Request("https://www.antigravity-resets.com/ja?ref=x"),
    env,
    ctx,
  );
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), `${SITE}/ja?ref=x`);
});

test("legacy /api/docs becomes a permanent redirect", async () => {
  const res = await worker.fetch(new Request(`${SITE}/api/docs`), env, ctx);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), `${SITE}/api-docs`);
});

test("/index.html and trailing slashes collapse to one URL", async () => {
  const a = await worker.fetch(new Request(`${SITE}/index.html`), env, ctx);
  assert.equal(a.status, 301);
  assert.equal(a.headers.get("location"), `${SITE}/`);

  const b = await worker.fetch(new Request(`${SITE}/zh-CN/`), env, ctx);
  assert.equal(b.status, 301);
  assert.equal(b.headers.get("location"), `${SITE}/zh-CN`);
});

test("markdown mirror is served for every locale", async () => {
  for (const [path, lang] of [
    ["/index.md", "en"],
    ["/zh-CN.md", "zh-CN"],
    ["/zh-TW.md", "zh-TW"],
    ["/ja.md", "ja"],
    ["/ko.md", "ko"],
  ]) {
    const res = await worker.fetch(new Request(`${SITE}${path}`), env, ctx);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type"), /text\/markdown/, path);
    assert.equal(res.headers.get("content-language"), lang, path);
    const body = await res.text();
    assert.match(body, /## Current status/, path);
    assert.match(body, /## FAQ/, path);
  }
});

test("llms.txt advertises locales, API, and terminology", async () => {
  const res = await worker.fetch(new Request(`${SITE}/llms.txt`), env, ctx);
  assert.equal(res.status, 200);
  const body = await res.text();
  for (const needle of ["index.md", "/zh-CN", "/api/v1/status", "/api/v1/resets", "Terminology"]) {
    assert.ok(body.includes(needle), needle);
  }
});

test("sitemap carries hreflang for all locales and no redirecting URL", async () => {
  const res = await worker.fetch(new Request(`${SITE}/sitemap.xml`), env, ctx);
  assert.equal(res.status, 200);
  const body = await res.text();
  for (const code of ["en", "zh-CN", "zh-TW", "ja", "ko", "x-default"]) {
    assert.ok(body.includes(`hreflang="${code}"`), code);
  }
  assert.ok(body.includes(`${SITE}/api-docs`), "api-docs must be listed");
  assert.ok(!body.includes(`${SITE}/api/docs<`), "redirecting URL must not be listed");
  // Five locale homes, five locale guides, api-docs, about, privacy.
  assert.equal(body.match(/<loc>/g).length, 13, "five homes, five guides, api-docs, about, privacy");
  assert.ok(body.includes(`${SITE}/guide`), "English guide must be listed");
  assert.ok(body.includes(`${SITE}/ja/guide`), "localized guides must be listed");
});

test("robots.txt names the major AI crawlers", async () => {
  const res = await worker.fetch(new Request(`${SITE}/robots.txt`), env, ctx);
  const body = await res.text();
  for (const agent of ["GPTBot", "ClaudeBot", "PerplexityBot", "OAI-SearchBot"]) {
    assert.ok(body.includes(`User-agent: ${agent}`), agent);
  }
  assert.ok(body.includes(`Sitemap: ${SITE}/sitemap.xml`));
});

test("formatExact localizes dates per language", () => {
  const iso = "2026-11-26T07:19:24Z";
  assert.equal(formatExact(iso, "en"), "Nov 26, 2026, 07:19 UTC");
  assert.equal(formatExact(iso, "zh-CN"), "2026年11月26日 07:19 UTC");
  assert.equal(formatExact(iso, "zh-TW"), "2026年11月26日 07:19 UTC");
  assert.equal(formatExact(iso, "ja"), "2026年11月26日 07:19 UTC");
  assert.equal(formatExact(iso, "ko"), "2026년 11월 26일 07:19 UTC");
});

test("escapeHtml neutralizes markup and quotes", () => {
  assert.equal(escapeHtml('<img onerror="x">&'), "&lt;img onerror=&quot;x&quot;&gt;&amp;");
  assert.equal(escapeHtml(null), "");
});

test("JSON-LD graph exposes the expected entity types", () => {
  const data = {
    stats: {
      latest: {
        id: "r1",
        timestamp: "2026-11-26T07:19:24Z",
        type: "regular",
        authorName: "Varun Mohan",
        authorHandle: "@_mohansolo",
        url: "https://x.com/_mohansolo/status/1",
        summary: { en: "A reset happened." },
        thanksCount: 1,
      },
      total: 1,
      avgIntervalDays: 1,
      longestWaitDays: 1,
    },
    resets: [
      {
        id: "r1",
        timestamp: "2026-11-26T07:19:24Z",
        type: "regular",
        authorName: "Varun Mohan",
        authorHandle: "@_mohansolo",
        url: "https://x.com/_mohansolo/status/1",
        summary: { en: "A reset happened." },
        thanksCount: 1,
      },
    ],
  };
  const doc = buildJsonLd(data, "en");
  assert.equal(doc["@context"], "https://schema.org");
  assert.deepEqual(
    doc["@graph"].map((node) => node["@type"]),
    ["Organization", "WebSite", "WebApplication", "Dataset", "FAQPage"],
  );
  const dataset = doc["@graph"].find((node) => node["@type"] === "Dataset");
  assert.equal(dataset.temporalCoverage, "2026-11-26/2026-11-26");
  assert.equal(dataset.distribution.length, 3);
  const faq = doc["@graph"].find((node) => node["@type"] === "FAQPage");
  assert.ok(faq.mainEntity.length > 0);
  // The first FAQ answer must carry the live, date-stamped answer.
  assert.match(faq.mainEntity[0].acceptedAnswer.text, /Varun Mohan/);
});

test("live answer degrades gracefully with no resets", () => {
  const answer = buildLiveAnswer({ stats: { latest: null }, resets: [] }, "en");
  assert.match(answer, /No official Antigravity reset/);
});

test("non-GET requests get 308 so their bodies survive the redirect", async () => {
  // A 301 lets some clients rewrite POST to GET, which would drop the payload.
  const slash = await worker.fetch(new Request(`${SITE}/api/v1/thanks/`, { method: "POST" }), env, ctx);
  assert.equal(slash.status, 308);

  const www = await worker.fetch(
    new Request("https://www.antigravity-resets.com/api/v1/thanks", { method: "POST" }),
    env,
    ctx,
  );
  assert.equal(www.status, 308);

  // GET/HEAD keep the permanent 301.
  const get = await worker.fetch(new Request(`${SITE}/zh-CN/`), env, ctx);
  assert.equal(get.status, 301);
});

test("safeHttpsUrl only admits absolute https URLs", async () => {
  const { safeHttpsUrl } = await import("../src/seo-data.mjs");
  assert.equal(safeHttpsUrl("https://x.com/a/status/1"), "https://x.com/a/status/1");
  assert.equal(safeHttpsUrl("http://x.com/a"), "");
  assert.equal(safeHttpsUrl("javascript:alert(1)"), "");
  assert.equal(safeHttpsUrl("data:text/html,<script>"), "");
  assert.equal(safeHttpsUrl(""), "");
  assert.equal(safeHttpsUrl(null), "");
});

test("each guide page points at its own Markdown mirror and that mirror exists", async () => {
  for (const [path, md] of [
    ["/guide", "/guide.md"],
    ["/zh-CN/guide", "/zh-CN/guide.md"],
    ["/ja/guide", "/ja/guide.md"],
    ["/ko/guide", "/ko/guide.md"],
  ]) {
    const html = await (await worker.fetch(new Request(`${SITE}${path}`), env, ctx)).text();
    assert.match(
      html,
      new RegExp(`href="${SITE.replace(/\./g, "\\.")}${md.replace(/\//g, "\\/")}"`),
      `${path} must advertise its own Markdown mirror`,
    );
    const mirror = await worker.fetch(new Request(`${SITE}${md}`), env, ctx);
    assert.equal(mirror.status, 200, `${md} must exist`);
    assert.match(mirror.headers.get("content-type"), /text\/markdown/);
    assert.match(await mirror.text(), /^# /, `${md} must carry the guide content`);
  }
});

test("robots.txt states the same content policy for every group", async () => {
  const text = await (
    await worker.fetch(new Request(`${SITE}/robots.txt`), env, ctx)
  ).text();
  const groups = text.split(/\n{2,}/).filter((group) => group.includes("User-agent:"));
  assert.ok(groups.length >= 2);
  for (const group of groups) {
    assert.match(
      group,
      /Content-Signal: search=yes, ai-input=yes, ai-train=yes/,
      "a group without Content-Signal silently opts out of the stated policy",
    );
  }
});

test("unknown URLs return a real HTML 404 that is not indexable", async () => {
  const res = await worker.fetch(new Request(`${SITE}/no-such-page`), env, ctx);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(res.headers.get("x-robots-tag") || "", /noindex/);
  const body = await res.text();
  assert.match(body, /Page not found/);
  assert.match(body, /href="\/"/);
});

test("Markdown mirrors stay fetchable but are not indexable", async () => {
  const res = await worker.fetch(new Request(`${SITE}/guide.md`), env, ctx);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("x-robots-tag") || "", /noindex/);
});

test("the guide defines the organization its Article references", async () => {
  const html = await (await worker.fetch(new Request(`${SITE}/guide`), env, ctx)).text();
  const block = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(block, "guide must carry JSON-LD");
  const graph = JSON.parse(block)["@graph"];
  const ids = new Set(graph.map((node) => node["@id"]));
  const article = graph.find((node) => node["@type"] === "Article");
  assert.ok(ids.has(article.author["@id"]), "author @id must resolve inside the document");
  assert.ok(ids.has(article.publisher["@id"]));
});

test("the guide carries a self-contained answer block", async () => {
  const html = await (await worker.fetch(new Request(`${SITE}/guide`), env, ctx)).text();
  assert.match(html, /class="guide-answer"/);
  const md = await (await worker.fetch(new Request(`${SITE}/guide.md`), env, ctx)).text();
  assert.match(md, /^> /m, "the Markdown mirror must keep the quotable answer");
});

test("the API catalog points at the OpenAPI document and the human docs", async () => {
  const res = await worker.fetch(new Request(`${SITE}/.well-known/api-catalog`), env, ctx);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/linkset\+json/);
  const body = await res.json();
  const link = body.linkset[0];
  assert.equal(link["service-desc"][0].href, `${SITE}/api/openapi.json`);
  assert.equal(link["service-doc"][0].href, `${SITE}/api-docs`);
});

test("original posts cannot break out of the Markdown document", async () => {
  const { buildAnnouncementsMarkdown } = await import("../src/seo-text.mjs");
  assert.equal(typeof buildAnnouncementsMarkdown, "function");
  const md = buildAnnouncementsMarkdown([
    {
      id: "r",
      timestamp: "2026-11-26T00:00:00Z",
      type: "regular",
      authorHandle: "@a",
      authorName: "A",
      url: "javascript:alert(1)",
      quoteText: "# heading `code` [link](http://evil)\n<script>bad</script>",
      thanksCount: 0,
    },
  ]);
  assert.ok(!md.includes("javascript:"), "unsafe scheme must not become a link");
  assert.ok(!md.includes("`code`"), "backticks must be neutralized");
  assert.ok(!md.includes("[link](http://evil)"), "raw markdown must be escaped");
  assert.match(md, /> \\# heading/);
  assert.match(md, /> &lt;script&gt;bad&lt;\/script&gt;/);
});
