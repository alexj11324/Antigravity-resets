// Machine-readable surfaces: Markdown mirrors, llms.txt, sitemap, robots.
// These exist so LLM crawlers and agents can read the tracker without executing
// JavaScript.

import {
  copyFor,
  formatExact,
  formatRelative,
  LANG_CODES,
  LANG_LABEL,
  langUrl,
  loadSeoData,
  originalPostText,
  pageMeta,
  safeHttpsUrl,
  SITE_ORIGIN,
  SITE_NAME,
} from "./seo-data.mjs";
import { buildFaqEntries, buildLiveAnswer } from "./seo-jsonld.mjs";
import { GUIDE_PATH } from "./guide.mjs";

function mdPath(lang) {
  return lang === "en" ? "/index.md" : `/${lang}.md`;
}

function mdUrl(lang) {
  return `${SITE_ORIGIN}${mdPath(lang)}`;
}

/** Preserve full post text while keeping each line inside the Markdown quote. */
function mdQuote(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|~-])/g, "\\$1")
    .split(/\r\n?|\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Markdown link line, or an empty string when the URL is not safe. */
function mdLink(label, url) {
  const href = safeHttpsUrl(url);
  return href ? `[${label}](${href})` : "";
}


/**
 * Markdown for the announcement log. Pure so it can be unit-tested without D1.
 * @param {Array<object>} resets
 * @param {string} lang
 */
export function buildAnnouncementsMarkdown(resets, lang) {
  const copy = copyFor(lang);
  return resets
    .map((item) =>
      [
        `### \`${item.timestamp}\` · ${
          item.type === "banked"
            ? copy.typeBanked || "Banked reset"
            : copy.typeRegular || "Regular reset"
        }`,
        "",
        originalPostText(item) ? mdQuote(originalPostText(item)) : "",
        "",
        mdLink(copy.viewOnX || "View on X", item.url),
        "",
      ].join("\n"),
    )
    .join("\n");
}

/**
 * Full plain-Markdown rendering of the tracker, mirroring the HTML page.
 * @param {object} env
 * @param {string} lang
 */
export async function renderMarkdown(env, lang) {
  const data = await loadSeoData(env);
  const meta = pageMeta(lang);
  const copy = copyFor(lang);
  const latest = data.stats.latest;

  const langRow = LANG_CODES.map((code) =>
    code === lang ? `**${LANG_LABEL[code]}**` : `[${LANG_LABEL[code]}](${mdUrl(code)})`,
  ).join(" · ");

  const latestBlock = latest
    ? [
        "## Latest Antigravity reset",
        "",
        `**${formatRelative(latest.timestamp, lang)}** · \`${latest.timestamp}\` · ${
          latest.type === "banked" ? copy.typeBanked || "Banked reset" : copy.typeRegular || "Regular reset"
        }`,
        "",
        originalPostText(latest) ? mdQuote(originalPostText(latest)) : "",
        "",
        mdLink(copy.viewOnX || "View on X", latest.url),
        "",
        `${Number(latest.thanksCount ?? 0).toLocaleString("en-US")} people have said thanks.`,
        "",
      ].join("\n")
    : "";

  const announcements = buildAnnouncementsMarkdown(data.resets || [], lang);

  const faq = buildFaqEntries(data, lang)
    .map((item) => `### ${item.q}\n\n${item.a}\n`)
    .join("\n");

  return [
    `# ${SITE_NAME}`,
    "",
    buildLiveAnswer(data, lang),
    "",
    meta.description,
    "",
    langRow,
    "",
    latestBlock,
    "## Current status",
    "",
    `- **${copy.statResets || "RESETS"}:** ${data.stats.total}`,
    `- **${copy.statAvg || "AVG. RESET INTERVAL"}:** ${data.stats.avgIntervalDays.toFixed(1)}${copy.daysSuffix || "d"}`,
    `- **${copy.statLongest || "LONGEST WAIT"}:** ${data.stats.longestWaitDays.toFixed(1)}${copy.daysSuffix || "d"}`,
    "",
    "## Antigravity reset announcements",
    "",
    announcements || "_No verified announcements yet._",
    "",
    "## FAQ",
    "",
    faq,
    "## Public API",
    "",
    `- [Live reset status JSON](${SITE_ORIGIN}/api/v1/status)`,
    `- [Reset history JSON](${SITE_ORIGIN}/api/v1/resets)`,
    `- [RSS feed](${SITE_ORIGIN}/feed.xml)`,
    `- [Interactive API documentation](${SITE_ORIGIN}/api-docs)`,
    "",
    "## About",
    "",
    copy.footerDisclaimer || "",
    "",
    `Last generated: ${new Date().toISOString()}`,
    "",
  ]
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

/**
 * llms.txt following the emerging convention: title, one-line summary,
 * grouped links, and terminology.
 * @param {object} env
 */
export async function renderLlmsTxt(env) {
  const data = await loadSeoData(env);
  const latest = data.stats.latest;

  const statusLine = latest
    ? `Latest verified reset: ${formatExact(latest.timestamp, "en")} (${formatRelative(
        latest.timestamp,
        "en",
      )}), announced by ${latest.authorName} (${latest.authorHandle}). ${data.stats.total} resets tracked in total.`
    : "No verified reset announcements recorded yet.";

  return [
    `# ${SITE_NAME}`,
    "",
    "> Live Google Antigravity quota reset tracker. Monitors the X accounts that announce official resets, keeps the complete verified history, and exposes a free keyless JSON API plus an RSS feed.",
    "",
    statusLine,
    "",
    "## Live status & pages",
    "",
    `- [Homepage](${SITE_ORIGIN}/): live "Did Antigravity reset today?" status, reset calendar, announcement log, and FAQ.`,
    ...LANG_CODES.filter((code) => code !== "en").map(
      (code) =>
        `- [${LANG_LABEL[code]} (${code})](${langUrl(code)}): localized tracker and history.`,
    ),
    `- [API documentation](${SITE_ORIGIN}/api-docs): request and response reference for the public endpoints.`,
    `- [How Antigravity quota works](${SITE_ORIGIN}/guide): the 5-hour window, weekly cap, and what an official reset is.`,
    "",
    "## Markdown versions (LLM friendly)",
    "",
    ...LANG_CODES.map((code) => `- [${LANG_LABEL[code]} Markdown](${mdUrl(code)})`),
    "",
    "## Public API",
    "",
    `- [Live reset status JSON](${SITE_ORIGIN}/api/v1/status): latest reset timestamp, reset type, statistics, and viewer count.`,
    `- [Reset history JSON](${SITE_ORIGIN}/api/v1/resets): every verified reset with timestamps, announcing account, affected models, and source X links.`,
    `- [Badge SVG](${SITE_ORIGIN}/api/v1/badge.svg): embeddable live status badge.`,
    `- [RSS feed](${SITE_ORIGIN}/feed.xml): verified announcements as RSS 2.0.`,
    `- [OpenAPI 3.1 specification](${SITE_ORIGIN}/api/openapi.json): machine-readable description of every endpoint.`,
    `- [Remote MCP server](${SITE_ORIGIN}/mcp): Streamable HTTP Model Context Protocol endpoint with get_status and list_resets tools.`,
    "",
    "## Terminology",
    "",
    "- **Reset announcement**: A confirmed X post from an official Antigravity account (`@_mohansolo`, `@antigravity`) that grants a quota reset.",
    "- **Regular reset**: An unscheduled global reset that immediately refills eligible Antigravity limits.",
    "- **Banked reset**: A saved reset credit granted to eligible accounts that must be redeemed manually before it expires.",
    "- **Weekly cap**: A ceiling layered above the automatic 5-hour rolling window that pauses routine refreshes once exhausted.",
    "",
    "## Notes",
    "",
    "- Independent community tracker. Not affiliated with Google DeepMind or Google Antigravity.",
    "- All data is derived from public X announcements; no user account access is involved.",
    "",
  ].join("\n");
}

/**
 * @param {object} env
 */
export async function renderSitemap(env) {
  const data = await loadSeoData(env);
  const lastmod = data.stats.latest
    ? new Date(data.stats.latest.timestamp).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const alternates = LANG_CODES.map(
    (code) => `<xhtml:link rel="alternate" hreflang="${code}" href="${langUrl(code)}" />`,
  )
    .concat(`<xhtml:link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/" />`)
    .join("\n    ");

  const homeEntries = LANG_CODES.map((code) => {
    return [
      "  <url>",
      `    <loc>${langUrl(code)}</loc>`,
      `    ${alternates}`,
      `    <lastmod>${lastmod}</lastmod>`,
      "    <changefreq>hourly</changefreq>",
      `    <priority>${code === "en" ? "1.0" : "0.9"}</priority>`,
      "  </url>",
    ].join("\n");
  }).join("\n");

  const guideEntries = Object.entries(GUIDE_PATH)
    .map(
      ([code, path]) =>
        [
          "  <url>",
          `    <loc>${SITE_ORIGIN}${path}</loc>`,
          `    <lastmod>${lastmod}</lastmod>`,
          "    <changefreq>monthly</changefreq>",
          `    <priority>0.7</priority>`,
          "  </url>",
        ].join("\n"),
    )
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    homeEntries,
    guideEntries,
    "  <url>",
    `    <loc>${SITE_ORIGIN}/api-docs</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    "    <changefreq>monthly</changefreq>",
    "    <priority>0.5</priority>",
    "  </url>",
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * robots.txt. `User-agent: *` already permits everything, but naming the major
 * AI crawlers removes any ambiguity about whether this site welcomes them.
 */
export function renderRobots() {
  const aiAgents = [
    "OAI-SearchBot",
    "ChatGPT-User",
    "GPTBot",
    "Claude-SearchBot",
    "Claude-User",
    "ClaudeBot",
    "PerplexityBot",
    "Google-Extended",
  ];
  return [
    "# Antigravity Resets",
    `# AI and search discovery document: ${SITE_ORIGIN}/llms.txt`,
    "",
    ...aiAgents.map((agent) => `User-agent: ${agent}\nAllow: /`),
    "",
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/v1/admin/",
    "",
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    "",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * @param {object} env
 * @param {string} lang
 */
export async function renderMarkdownResponse(env, lang) {
  const body = await renderMarkdown(env, lang);
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Language": lang,
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

