// Tests for the server-rendered HTML fragments. HTMLRewriter itself only exists
// in workerd, so the pure builders are exported and covered here; the rewriter
// wiring is exercised by the wrangler dev smoke check documented in tasks/todo.md.

import test from "node:test";
import assert from "node:assert/strict";
import { buildHeadHtml, renderAnnouncementsHtml, renderFaqHtml } from "../src/seo-html.mjs";
import { buildAnnouncementsMarkdown } from "../src/seo-text.mjs";
import { buildLiveAnswer } from "../src/seo-jsonld.mjs";
import { LANG_CODES, escapeHtml } from "../src/seo-data.mjs";

const SITE = "https://antigravity-resets.com";

function sampleData() {
  const reset = {
    id: "x-1",
    timestamp: "2026-11-26T07:19:24Z",
    type: "regular",
    authorHandle: "@_mohansolo",
    authorName: "Varun Mohan",
    url: "https://x.com/_mohansolo/status/1",
    quoteText: "Original Thanksgiving post.\nAll users have a reset!",
    summary: { en: "Reset for Thanksgiving.", "zh-CN": "感恩节重置。" },
    thanksCount: 12,
  };
  return {
    resets: [reset],
    stats: {
      latest: reset,
      total: 17,
      avgIntervalDays: 11.8,
      longestWaitDays: 44,
    },
  };
}

test("buildHeadHtml emits canonical, six hreflang, JSON-LD and SSR locale", () => {
  const head = buildHeadHtml(sampleData(), "zh-CN");
  assert.match(head, new RegExp(`<link rel="canonical" href="${SITE}/zh-CN"`));
  assert.equal((head.match(/hreflang="/g) || []).length, 6, "five locales plus x-default");
  assert.match(head, /hreflang="x-default" href="https:\/\/antigravity-resets\.com\/"/);
  assert.match(head, /<meta property="og:locale" content="zh_CN" \/>/);
  assert.match(head, /window\.__SSR_LANG__="zh-CN"/);
  assert.match(head, /<meta name="robots" content="index,follow,max-image-preview:large" \/>/);
  assert.match(head, /application\/ld\+json/);
  assert.match(head, /rel="alternate" type="text\/markdown"[^>]*\/zh-CN\.md/);
  assert.match(head, /llms\.txt/);
});

test("buildHeadHtml leaves tags the static shell already owns to the shell", () => {
  // Duplicating these would put two <meta name="description"> in one document.
  const head = buildHeadHtml(sampleData(), "en");
  for (const owned of [
    'name="description"',
    'property="og:image"',
    'property="og:site_name"',
    'name="twitter:card"',
    'name="twitter:image"',
    'name="theme-color"',
  ]) {
    assert.ok(!head.includes(owned), `${owned} must not be injected twice`);
  }
});

test("buildHeadHtml keeps JSON-LD parseable when source text contains markup", () => {
  const data = sampleData();
  data.resets[0].quoteText = '</script><img src=x onerror="alert(1)">';
  data.stats.latest = data.resets[0];
  const head = buildHeadHtml(data, "en");
  const raw = head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];

  // The literal </script> sequence must never survive into the document.
  assert.ok(!raw.includes("</script>"));
  const parsed = JSON.parse(raw);
  assert.equal(parsed["@context"], "https://schema.org");
  assert.ok(parsed["@graph"].some((node) => node["@type"] === "FAQPage"));
});

test("renderFaqHtml opens the first answer and escapes both sides", () => {
  const html = renderFaqHtml([
    { q: "Did <it> reset?", a: "Yes & yes." },
    { q: "Second?", a: "Also." },
  ]);
  // First item expanded so the answer is visible without JS.
  assert.equal((html.match(/aria-expanded="true"/g) || []).length, 1);
  assert.match(html, /aria-expanded="true">\s*<span>Did &lt;it&gt; reset\?/);
  assert.match(html, /Yes &amp; yes\./);
  assert.match(html, /class="faq-body is-open"/);
  assert.equal((html.match(/faq-item/g) || []).length, 2);
});

test("renderAnnouncementsHtml drops non-https links and escapes text", () => {
  const resets = [
    {
      id: "a",
      timestamp: "2026-11-26T00:00:00Z",
      type: "regular",
      authorHandle: "@a",
      authorName: "A",
      url: "javascript:alert(1)",
      quoteText: "<script>bad</script>",
      summary: { en: "<script>bad</script>" },
    },
    {
      id: "b",
      timestamp: "2026-11-25T00:00:00Z",
      type: "regular",
      authorHandle: "@b",
      authorName: "B",
      url: "https://x.com/b/status/1",
      quoteText: "fine",
      summary: { en: "fine" },
    },
  ];
  const html = renderAnnouncementsHtml(resets, "en");
  assert.ok(!html.includes("javascript:"), "unsafe scheme must not reach href");
  assert.ok(!html.includes("<script>bad"), "source text must be escaped");
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(html, /href="https:\/\/x\.com\/b\/status\/1"/);
  assert.equal((html.match(/class="bubble-row"/g) || []).length, 2);
});

test("all locales use the complete original post in HTML, Markdown, and live answers", () => {
  const data = sampleData();
  data.resets[0].quoteText += `\n${"Full original content. ".repeat(12)}`;
  const quote = data.resets[0].quoteText;
  for (const lang of LANG_CODES) {
    const html = renderAnnouncementsHtml(data.resets, lang);
    const markdown = buildAnnouncementsMarkdown(data.resets, lang);
    const answer = buildLiveAnswer(data, lang);
    assert.ok(html.includes(escapeHtml(quote)), lang);
    assert.ok(answer.includes(quote), lang);
    assert.match(markdown, /> Original Thanksgiving post\\\.\n> All users have a reset\\!/);
    assert.ok(markdown.includes("Full original content\\. ".repeat(12)), lang);
    for (const summary of Object.values(data.resets[0].summary)) {
      assert.ok(!html.includes(summary), lang);
      assert.ok(!markdown.includes(summary), lang);
      assert.ok(!answer.includes(summary), lang);
    }
  }
});

test("missing originals never turn generated summaries into author text", () => {
  const data = sampleData();
  for (const quoteText of [undefined, "", " \n "]) {
    data.resets[0].quoteText = quoteText;
    for (const lang of LANG_CODES) {
      const surfaces = [
        renderAnnouncementsHtml(data.resets, lang),
        buildAnnouncementsMarkdown(data.resets, lang),
        buildLiveAnswer(data, lang),
      ];
      for (const rendered of surfaces) {
        for (const summary of Object.values(data.resets[0].summary)) {
          assert.ok(!rendered.includes(summary), `${lang}: ${quoteText}`);
        }
      }
      assert.ok(surfaces[0].includes(data.resets[0].url), lang);
      assert.ok(surfaces[1].includes(data.resets[0].url), lang);
    }
  }
});
