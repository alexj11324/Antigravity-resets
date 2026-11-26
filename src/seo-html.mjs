// Server-side rendering for the home page. Everything here runs inside
// Cloudflare's HTMLRewriter so the static shell becomes a fully populated
// document without a build step or a framework swap.

import {
  copyFor,
  escapeHtml,
  formatExact,
  formatRelative,
  jsonForScript,
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
import { buildFaqEntries, buildLiveAnswer, renderJsonLdScript } from "./seo-jsonld.mjs";

const AVATAR_PATH = "/assets/varun-avatar.webp";

// Open Graph wants language_TERRITORY, not a bare language tag.
const OG_LOCALE = Object.freeze({
  en: "en_US",
  "zh-CN": "zh_CN",
  "zh-TW": "zh_TW",
  ja: "ja_JP",
  ko: "ko_KR",
});

/** Static shell text that must be localized before hydration. */
const UI_COPY_TARGETS = Object.freeze([
  ["#onlineLabel", "hereNow"],
  ["#browserAlertLabel", "alertsBrowser"],
  ["#telegramAlertLabel", "alertsTelegram"],
  ["#emailAlertLabel", "alertsEmail"],
  ["#tzPtLabel", "tzVarun"],
  ["#tzLocalLabel", "tzLocal"],
  ["#mobileTzLabel", "tzLocal"],
  ["#latestKicker", "latestKicker"],
  ["#resetTypeBtn", "typeRegular"],
  ["#thanksLabel", "thanksBtn"],
  ["#statResetsLabel", "statResets"],
  ["#statAvgLabel", "statAvg"],
  ["#statAvgShortLabel", "statAvgShort"],
  ["#statLongestLabel", "statLongest"],
  ["#cliTipTitle", "cliTipTitle"],
  ["#cliTipDesc", "cliTipDesc"],
  ["#advertiseTitle", "advertiseTitle"],
  ["#advertiseDesc", "advertiseDesc"],
  ["#tipCornerLabel", "sponsorLabel"],
  ["#historyHeading", "historyHeading"],
  ["#legendRegular", "legendRegular"],
  ["#legendBanked", "legendBanked"],
  ["#legendNone", "legendNone"],
  ["#announcementsHeading", "announcementsHeading"],
  ["#announcementsSub", "announcementsSub"],
  ["#faqHeading", "faqHeading"],
  ["#apiDocsLink", "apiDocsLink"],
  ["#sponsorDialogTitle", "advertiseModalTitle"],
  ["#closeSponsorBtn", "close"],
  ["#emailSubmitBtn", "emailBtn"],
]);

/**
 * @param {Array<{q: string, a: string}>} entries
 */
export function renderFaqHtml(entries) {
  return entries
    .map((item, idx) => {
      const open = idx === 0;
      return [
        '<div class="faq-item">',
        `<button type="button" class="faq-trigger" aria-expanded="${open}">`,
        `<span>${escapeHtml(item.q)}</span>`,
        '<span class="faq-icon" aria-hidden="true">+</span>',
        "</button>",
        `<div class="faq-body${open ? " is-open" : ""}">`,
        '<div class="faq-body-inner">',
        `<p class="faq-answer">${escapeHtml(item.a)}</p>`,
        "</div></div></div>",
      ].join("");
    })
    .join("");
}

/**
 * @param {Array<object>} resets
 * @param {string} lang
 */
export function renderAnnouncementsHtml(resets, lang) {
  const copy = copyFor(lang);
  return resets
    .map((item) => {
      const translated = item.textI18n?.[lang];
      const text = translated || originalPostText(item) || copy.viewOnX || "View on X";
      const viewLabel = copy.viewOnX || "View on X";
      const href = safeHttpsUrl(item.url);
      return [
        `<article class="bubble-row" id="reset-${escapeHtml(item.id)}">`,
        '<div class="bubble-avatar">',
        `<img src="${AVATAR_PATH}" alt="${escapeHtml(item.authorName || SITE_NAME)}" width="40" height="40" loading="lazy" />`,
        "</div>",
        '<div class="bubble-card">',
        '<div class="bubble-meta">',
        `<span class="bubble-ago">${escapeHtml(formatRelative(item.timestamp, lang))}</span>`,
        `<span class="bubble-date">${escapeHtml(formatExact(item.timestamp, lang))}</span>`,
        translated
          ? `<span class="bubble-translated">${escapeHtml(copy.autoTranslated || "AI translation")}</span>`
          : "",
        "</div>",
        `<p class="bubble-text" style="white-space: pre-wrap">${escapeHtml(text)}</p>`,
        '<div class="bubble-footer">',
        `<span class="bubble-author">${escapeHtml(`${item.authorName} (${item.authorHandle})`)}</span>`,
        href
          ? `<a class="x-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(viewLabel)} &rarr;</a>`
          : "",
        "</div></div></article>",
      ].join("");
    })
    .join("");
}

/**
 * Language switcher links, rendered as real anchors: both crawlers and app.js
 * navigate with them, so the address bar and document head always agree.
 * @param {string} lang
 */
function renderLangLinksHtml(lang) {
  return LANG_CODES.map((code) => {
    const current = code === lang;
    return `<a class="footer-lang-btn" href="${langUrl(code)}" hreflang="${code}"${
      current ? ' aria-current="true"' : ""
    }>${escapeHtml(LANG_LABEL[code] || code)}</a>`;
  }).join("");
}

/**
 * `<head>` additions that do not already exist in the static shell. Anything
 * index.html already ships (description, og:image, twitter:card, theme-color…)
 * is updated in place by the rewriter instead of being duplicated here.
 * @param {object} data
 * @param {string} lang
 */
export function buildHeadHtml(data, lang, faqEntries) {
  const canonical = langUrl(lang);
  const alternates = [
    ...LANG_CODES.map(
      (code) =>
        `<link rel="alternate" hreflang="${code}" href="${langUrl(code)}" />`,
    ),
    `<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/" />`,
  ].join("");
  return [
    `<script>window.__SSR_LANG__=${jsonForScript(lang)};</script>`,
    '<meta name="robots" content="index,follow,max-image-preview:large" />',
    `<link rel="canonical" href="${canonical}" />`,
    alternates,
    `<link rel="alternate" type="text/markdown" title="Markdown" href="${
      lang === "en" ? `${SITE_ORIGIN}/index.md` : `${SITE_ORIGIN}/${lang}.md`
    }" />`,
    `<link rel="alternate" type="text/plain" title="llms.txt" href="${SITE_ORIGIN}/llms.txt" />`,
    `<meta property="og:locale" content="${OG_LOCALE[lang] || "en_US"}" />`,
    renderJsonLdScript(data, lang, faqEntries),
  ].join("");
}

/**
 * Turn the static shell into a locale-specific, fully populated page.
 * @param {Request} request
 * @param {object} env
 * @param {string} lang
 */
export async function handleHtmlRequest(request, env, lang) {
  const url = new URL(request.url);
  // Fetch the root, not /index.html: Cloudflare's auto-trailing-slash handling
  // 307s /index.html back to /, which would turn the response into a redirect
  // loop instead of the page shell.
  const assetUrl = new URL("/", url.origin);

  // Never forward conditional headers to the asset server. If it honoured the
  // client's If-None-Match it would answer 304 for the unchanged shell and we
  // would return that instead of server-rendering the page.
  const shellHeaders = new Headers(request.headers);
  shellHeaders.delete("if-none-match");
  shellHeaders.delete("if-modified-since");
  shellHeaders.delete("range");

  // The shell fetch and the data read are independent: run them together so
  // TTFB reflects the slower one instead of their sum.
  const [assetResponse, data] = await Promise.all([
    env.ASSETS.fetch(new Request(assetUrl, { method: "GET", headers: shellHeaders })),
    loadSeoData(env),
  ]);
  if (assetResponse.status !== 200) return assetResponse;

  const meta = pageMeta(lang);
  const copy = copyFor(lang);
  const latest = data.stats.latest;
  const faqEntries = buildFaqEntries(data, lang);

  const leadUrl = "https://x.com/_mohansolo";
  const subtitleHtml = `${escapeHtml(copy.subtitlePrefix)} <a href="${leadUrl}" target="_blank" rel="noopener noreferrer">@_mohansolo</a> ${escapeHtml(copy.subtitleSuffix)}`;

  // Static UI labels ship as English in the shell. Rewrite them server-side so a
  // locale page never flashes English before app.js hydrates, and so crawlers
  // see a page that is genuinely in its declared language.
  const rewriter = new HTMLRewriter();
  for (const [selector, key] of UI_COPY_TARGETS) {
    const value = copy[key];
    if (typeof value !== "string") continue;
    rewriter.on(selector, {
      element(el) {
        el.setInnerContent(value);
      },
    });
  }

  rewriter
    .on("html", {
      element(el) {
        el.setAttribute("lang", lang);
      },
    })
    .on("title", {
      element(el) {
        el.setInnerContent(meta.title);
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        el.setAttribute("content", meta.description);
      },
    })
    .on('meta[property="og:image:alt"]', {
      element(el) {
        el.setAttribute("content", meta.title);
      },
    })
    .on('meta[name="twitter:image:alt"]', {
      element(el) {
        el.setAttribute("content", meta.title);
      },
    })
    .on('meta[property="og:title"]', {
      element(el) {
        el.setAttribute("content", meta.title);
      },
    })
    .on('meta[property="og:description"]', {
      element(el) {
        el.setAttribute("content", meta.description);
      },
    })
    .on('meta[property="og:url"]', {
      element(el) {
        el.setAttribute("content", langUrl(lang));
      },
    })
    .on('meta[name="twitter:title"]', {
      element(el) {
        el.setAttribute("content", meta.title);
      },
    })
    .on('meta[name="twitter:description"]', {
      element(el) {
        el.setAttribute("content", meta.description);
      },
    })
    .on("head", {
      element(el) {
        el.append(buildHeadHtml(data, lang, faqEntries), { html: true });
      },
    })
    .on("#emailInput", {
      element(el) {
        el.setAttribute("placeholder", copy.emailPlaceholder || "you@example.com");
      },
    })
    .on("#subtitle", {
      element(el) {
        el.setInnerContent(subtitleHtml, { html: true });
      },
    })
    .on("#footerLangs", {
      element(el) {
        el.setInnerContent(renderLangLinksHtml(lang), { html: true });
      },
    })
    .on("#latestRelative", {
      element(el) {
        el.setInnerContent(latest ? formatRelative(latest.timestamp, lang) : "—");
      },
    })
    .on("#latestExact", {
      element(el) {
        el.setInnerContent(latest ? formatExact(latest.timestamp, lang) : "");
      },
    })
    .on("#thanksCount", {
      element(el) {
        el.setInnerContent(Number(latest?.thanksCount ?? 0).toLocaleString(lang));
      },
    })
    .on("#statResetsVal", {
      element(el) {
        el.setInnerContent(String(data.stats.total));
      },
    })
    .on("#statAvgVal", {
      element(el) {
        el.setInnerContent(`${data.stats.avgIntervalDays.toFixed(1)}${copy.daysSuffix || "d"}`);
      },
    })
    .on("#statLongestVal", {
      element(el) {
        el.setInnerContent(`${data.stats.longestWaitDays.toFixed(1)}${copy.daysSuffix || "d"}`);
      },
    })
    .on("#faqList", {
      element(el) {
        el.setInnerContent(renderFaqHtml(faqEntries), { html: true });
      },
    })
    .on("#announcementsList", {
      element(el) {
        el.setInnerContent(renderAnnouncementsHtml(data.resets, lang), { html: true });
      },
    })
    .on("#footerDisclaimer", {
      element(el) {
        el.setInnerContent(copy.footerDisclaimer || "");
      },
    });

  const transformed = rewriter.transform(assetResponse);
  const headers = new Headers(transformed.headers);
  headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  headers.set("Content-Language", lang);
  // No Vary: Accept-Language here. The response body is a pure function of the
  // URL, so varying on a request header would only split the cache for nothing.
  headers.set("X-Antigravity-Page-Version", "seo-p0-20261126");

  // Drop the shell's validators. They describe index.html, not this body: a
  // client holding them would revalidate, match the unchanged shell, get a 304
  // and keep serving a stale reset history. max-age above is the only contract.
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.set(
    "Link",
    `<${lang === "en" ? `${SITE_ORIGIN}/index.md` : `${SITE_ORIGIN}/${lang}.md`}>; rel="alternate"; type="text/markdown", <${SITE_ORIGIN}/llms.txt>; rel="service-doc"; type="text/plain"`,
  );

  return new Response(transformed.body, {
    status: 200,
    headers,
  });
}
