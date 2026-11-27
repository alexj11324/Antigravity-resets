// Structured data for the tracker. Kept separate from the HTML rewriter so the
// schema graph can be unit-tested and reused by the Markdown surface.

import { copyFor, formatExact, formatRelative, jsonForScript, originalPostText, pageMeta, SITE_NAME, SITE_ORIGIN } from "./seo-data.mjs";

const DEVELOPER_ORGANIZATION = Object.freeze({
  name: SITE_NAME,
  url: `${SITE_ORIGIN}/`,
  // sameAs asserts "this is the same entity", not "related to". It may only
  // list channels this site operates: our own X account and the public alert
  // channel. @_mohansolo is the person being tracked, so he never appears here.
  sameAs: [
    "https://x.com/agy_resets",
    "https://t.me/antigravity_resets_alert",
  ],
  disambiguatingDescription:
    "Independent community tracker of publicly announced Google Antigravity quota resets; not affiliated with Google DeepMind or Google Antigravity.",
});

/**
 * The site's Organization node. Any page that references
 * `#organization` must also define it in its own graph: Google parses each
 * document independently and does not merge @id references across URLs.
 * @returns {object}
 */
export function buildOrganizationNode() {
  return {
    "@type": "Organization",
    "@id": `${SITE_ORIGIN}/#organization`,
    name: DEVELOPER_ORGANIZATION.name,
    alternateName: "Antigravity Reset Tracker",
    url: DEVELOPER_ORGANIZATION.url,
    logo: `${SITE_ORIGIN}/assets/varun-avatar-512.jpg`,
    sameAs: DEVELOPER_ORGANIZATION.sameAs,
    disambiguatingDescription: DEVELOPER_ORGANIZATION.disambiguatingDescription,
  };
}

/**
 * The answer shown to both humans and crawlers for "Did Antigravity reset today?".
 * Regenerated per request so it never goes stale.
 * @param {object} data
 * @param {string} lang
 */
export function buildLiveAnswer(data, lang) {
  const meta = pageMeta(lang);
  const latest = data?.stats?.latest;
  if (!latest) return meta.noResetYet;

  const resets = Array.isArray(data?.resets) ? data.resets : [];
  const oldest = resets.length > 0 ? resets[resets.length - 1].timestamp : latest.timestamp;
  const now = new Date();
  // "Today" is UTC, stated explicitly, because the answer is copied into FAQ
  // markup, llms.txt and Markdown where a reader cannot see the timezone.
  const sameDay =
    new Date(latest.timestamp).toISOString().slice(0, 10) ===
    now.toISOString().slice(0, 10);

  return meta.liveAnswer({
    sameDay,
    author: `${latest.authorName || "The Antigravity team"} (${latest.authorHandle})`,
    when: formatRelative(latest.timestamp, lang),
    exact: formatExact(latest.timestamp, lang),
    total: Number(data?.stats?.total ?? resets.length ?? 0),
    since: formatExact(oldest, lang),
    asOf: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
}

/**
 * Build the FAQ list, replacing the first question's canned answer with the
 * live, date-stamped answer.
 * @param {object} data
 * @param {string} lang
 */
export function buildFaqEntries(data, lang) {
  const copy = copyFor(lang);
  const entries = Array.isArray(copy.faqs) ? copy.faqs.map((item) => ({ ...item })) : [];
  if (entries.length > 0) entries[0].a = buildLiveAnswer(data, lang);
  return entries;
}

/**
 * @param {object} data
 * @param {string} lang
 * @returns {object} JSON-LD @graph document
 */
export function buildJsonLd(data, lang, faqEntries = buildFaqEntries(data, lang)) {
  const meta = pageMeta(lang);
  const url = lang === "en" ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}/${lang}`;
  const latest = data?.stats?.latest;
  const sorted = Array.isArray(data?.resets) ? data.resets : [];
  const oldest = sorted.length > 0 ? sorted[sorted.length - 1] : null;

  const graph = [
    buildOrganizationNode(),
    {
      "@type": "WebSite",
      "@id": `${SITE_ORIGIN}/#website`,
      url: DEVELOPER_ORGANIZATION.url,
      name: SITE_NAME,
      alternateName: ["Antigravity Reset Tracker", "Antigravity Reset", "Antigravity Quota Reset"],
      description: meta.description,
      inLanguage: lang,
      publisher: { "@id": `${SITE_ORIGIN}/#organization` },
      sameAs: DEVELOPER_ORGANIZATION.sameAs,
    },
    {
      "@type": "WebApplication",
      "@id": `${SITE_ORIGIN}/#app`,
      name: "Antigravity Reset Tracker",
      url,
      description: meta.description,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Any",
      inLanguage: lang,
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@id": `${SITE_ORIGIN}/#organization` },
    },
    {
      "@type": "Dataset",
      "@id": `${SITE_ORIGIN}/#dataset`,
      name: "Google Antigravity Quota Reset History",
      description:
        "Every verified official Google Antigravity quota reset announcement, with timestamps, announcing account, affected models, and original X post links.",
      url,
      inLanguage: lang,
      isAccessibleForFree: true,
      creator: { "@id": `${SITE_ORIGIN}/#organization` },
      license: `${SITE_ORIGIN}/api-docs`,
      keywords: ["Google Antigravity", "Gemini", "quota reset", "rate limit"],
      variableMeasured: [
        "reset timestamp",
        "reset type",
        "announcing account",
        "affected models",
      ],
      ...(oldest && latest
        ? {
            temporalCoverage: `${new Date(oldest.timestamp).toISOString().slice(0, 10)}/${new Date(latest.timestamp)
              .toISOString()
              .slice(0, 10)}`,
            datePublished: new Date(oldest.timestamp).toISOString().slice(0, 10),
            dateModified: new Date(latest.timestamp).toISOString(),
          }
        : {}),
      distribution: [
        {
          "@type": "DataDownload",
          name: "Reset history (JSON)",
          encodingFormat: "application/json",
          contentUrl: `${SITE_ORIGIN}/api/v1/resets`,
        },
        {
          "@type": "DataDownload",
          name: "Live status (JSON)",
          encodingFormat: "application/json",
          contentUrl: `${SITE_ORIGIN}/api/v1/status`,
        },
        {
          "@type": "DataDownload",
          name: "Page content (Markdown)",
          encodingFormat: "text/markdown",
          contentUrl: lang === "en" ? `${SITE_ORIGIN}/index.md` : `${SITE_ORIGIN}/${lang}.md`,
        },
      ],
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE_ORIGIN}/#faq`,
      url,
      inLanguage: lang,
      mainEntity: (faqEntries || []).map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    },
  ];

  return { "@context": "https://schema.org", "@graph": graph };
}

/**
 * @param {object} data
 * @param {string} lang
 * @returns {string} ready-to-inline `<script type="application/ld+json">`
 */
export function renderJsonLdScript(data, lang, faqEntries) {
  return `<script type="application/ld+json">${jsonForScript(buildJsonLd(data, lang, faqEntries))}</script>`;
}
