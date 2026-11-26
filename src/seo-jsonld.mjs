// Structured data for the tracker. Kept separate from the HTML rewriter so the
// schema graph can be unit-tested and reused by the Markdown surface.

import { copyFor, formatExact, formatRelative, jsonForScript, originalPostText, pageMeta, SITE_NAME, SITE_ORIGIN } from "./seo-data.mjs";

const DEVELOPER_ORGANIZATION = Object.freeze({
  name: SITE_NAME,
  url: `${SITE_ORIGIN}/`,
  sameAs: ["https://x.com/_mohansolo", "https://t.me/antigravity_resets"],
});

/**
 * The answer shown to both humans and crawlers for "Did Antigravity reset today?".
 * Regenerated per request so it never goes stale.
 * @param {object} data
 * @param {string} lang
 */
export function buildLiveAnswer(data, lang) {
  const meta = pageMeta(lang);
  const latest = data?.stats?.latest;
  if (!latest) return `${meta.noResetYet} ${meta.answerSuffix}`;
  const text = originalPostText(latest);
  const quoted = text ? `"${text}"` : "";
  const author = `${latest.authorName || "The Antigravity team"} (${latest.authorHandle})`;
  const when = formatRelative(latest.timestamp, lang);
  const exact = formatExact(latest.timestamp, lang);

  return [meta.answerPrefix, meta.answerLead(author, when, exact), quoted, meta.answerSuffix]
    .filter(Boolean)
    .join(" ");
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
    {
      "@type": "Organization",
      "@id": `${SITE_ORIGIN}/#organization`,
      name: DEVELOPER_ORGANIZATION.name,
      url: DEVELOPER_ORGANIZATION.url,
      logo: `${SITE_ORIGIN}/assets/varun-avatar-512.jpg`,
      sameAs: DEVELOPER_ORGANIZATION.sameAs,
    },
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
      ...(oldest && latest
        ? {
            temporalCoverage: `${new Date(oldest.timestamp).toISOString().slice(0, 10)}/${new Date(latest.timestamp)
              .toISOString()
              .slice(0, 10)}`,
            dateModified: new Date(latest.timestamp).toISOString(),
          }
        : {}),
      distribution: [
        {
          "@type": "DataDownload",
          encodingFormat: "application/json",
          contentUrl: `${SITE_ORIGIN}/api/v1/resets`,
        },
        {
          "@type": "DataDownload",
          encodingFormat: "application/json",
          contentUrl: `${SITE_ORIGIN}/api/v1/status`,
        },
        {
          "@type": "DataDownload",
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
