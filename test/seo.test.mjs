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
  assert.equal(body.match(/<loc>/g).length, 6, "five locales plus api-docs");
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

test("markdown summaries cannot break out of the document", async () => {
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
      summary: { en: "# heading `code` [link](http://evil)" },
      thanksCount: 0,
    },
  ]);
  assert.ok(!md.includes("javascript:"), "unsafe scheme must not become a link");
  assert.ok(!md.includes("`code`"), "backticks must be neutralized");
  assert.ok(!md.includes("[link](http://evil)"), "raw markdown must be escaped");
});
