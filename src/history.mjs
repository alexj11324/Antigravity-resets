// Dedicated, server-rendered reset history. The home page already contains the
// same rows, but "antigravity reset history" is a data-shaped query that needs
// its own indexable URL, and a table is easier to cite than a scroll target.

import {
  escapeHtml,
  formatExact,
  loadSeoData,
  safeHttpsUrl,
  SITE_ORIGIN,
  SITE_NAME,
} from "./seo-data.mjs";
import { buildOrganizationNode } from "./seo-jsonld.mjs";

const HISTORY_PATH = {
  en: "/history",
  "zh-CN": "/zh-CN/history",
  "zh-TW": "/zh-TW/history",
  ja: "/ja/history",
  ko: "/ko/history",
};

const OG_LOCALE = { en: "en_US", "zh-CN": "zh_CN", "zh-TW": "zh_TW", ja: "ja_JP", ko: "ko_KR" };

const COPY = {
  en: {
    title: "Antigravity Reset History",
    description:
      "Every verified Google Antigravity quota reset, newest first, with the announcing account, affected models, and a link to the original X post.",
    h1: "Antigravity reset history",
    intro:
      "Every official reset this tracker has verified, newest first. The list comes from the same archive that powers the API, so it grows as new announcements are confirmed.",
    stats: (s) => `${s.total} verified resets. Average interval ${s.avg} days, longest wait ${s.longest} days.`,
    headers: ["Date", "Type", "Announced by", "Models", "Source"],
    types: { regular: "Regular", banked: "Banked" },
    source: "View on X",
    back: "Back to the live tracker",
  },
  "zh-CN": {
    title: "Antigravity 重置历史",
    description:
      "按时间倒序排列的全部已验证 Google Antigravity 配额重置，包含公告账号、受影响的模型与原始 X 帖子链接。",
    h1: "Antigravity 重置历史",
    intro:
      "本追踪器核实过的全部官方重置，按时间倒序排列。这份列表由驱动 API 的同一份档案生成，新公告确认后会自动更新。",
    stats: (s) => `共 ${s.total} 次已验证重置。平均间隔 ${s.avg} 天，最长等待 ${s.longest} 天。`,
    headers: ["日期", "类型", "公告账号", "受影响模型", "来源"],
    types: { regular: "常规", banked: "存储型" },
    source: "查看原帖",
    back: "返回实时追踪页",
  },
  "zh-TW": {
    title: "Antigravity 重置歷史",
    description:
      "按時間倒序排列的全部已驗證 Google Antigravity 配額重置，包含公告帳號、受影響的模型與原始 X 貼文連結。",
    h1: "Antigravity 重置歷史",
    intro:
      "本追蹤器核實過的全部官方重置，按時間倒序排列。這份列表由驅動 API 的同一份檔案生成，新公告確認後會自動更新。",
    stats: (s) => `共 ${s.total} 次已驗證重置。平均間隔 ${s.avg} 天，最長等待 ${s.longest} 天。`,
    headers: ["日期", "類型", "公告帳號", "受影響模型", "來源"],
    types: { regular: "常規", banked: "儲存型" },
    source: "查看原文",
    back: "返回即時追蹤頁",
  },
  ja: {
    title: "Antigravity リセット履歴",
    description:
      "確認済みの Google Antigravity クォータリセットを新しい順に掲載。発表アカウント、対象モデル、元の X 投稿へのリンク付き。",
    h1: "Antigravity リセット履歴",
    intro:
      "この追跡サイトが確認した公式リセットのすべてを、新しい順に掲載しています。API と同じアーカイブから生成されるため、新しい告知が確認されると自動で増えます。",
    stats: (s) => `確認済みリセット ${s.total} 件。平均間隔 ${s.avg} 日、最長待機 ${s.longest} 日。`,
    headers: ["日時", "種類", "発表アカウント", "対象モデル", "出典"],
    types: { regular: "通常", banked: "バンク型" },
    source: "X で見る",
    back: "ライブ追跡ページへ戻る",
  },
  ko: {
    title: "Antigravity 리셋 기록",
    description:
      "확인된 Google Antigravity 할당량 리셋을 최신순으로 정리했습니다. 발표 계정, 대상 모델, 원문 X 게시물 링크를 포함합니다.",
    h1: "Antigravity 리셋 기록",
    intro:
      "이 추적 사이트가 확인한 모든 공식 리셋을 최신순으로 정리했습니다. API 와 같은 아카이브에서 생성되므로 새 공지가 확인되면 자동으로 늘어납니다.",
    stats: (s) => `확인된 리셋 ${s.total}건. 평균 간격 ${s.avg}일, 최장 대기 ${s.longest}일.`,
    headers: ["날짜", "유형", "발표 계정", "대상 모델", "출처"],
    types: { regular: "일반", banked: "적립형" },
    source: "X 에서 보기",
    back: "실시간 추적 페이지로 돌아가기",
  },
};

/**
 * @param {string} pathname
 * @returns {string|null} locale for a history path, or null
 */
export function historyLang(pathname) {
  for (const [code, path] of Object.entries(HISTORY_PATH)) {
    if (path === pathname) return code;
  }
  return null;
}

function alternates() {
  return [
    ...Object.entries(HISTORY_PATH).map(
      ([code, path]) => `<link rel="alternate" hreflang="${code}" href="${SITE_ORIGIN}${path}" />`,
    ),
    `<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/history" />`,
  ].join("");
}

function renderRows(resets, copy, lang) {
  return resets
    .map((item) => {
      const href = safeHttpsUrl(item.url);
      const models = Array.isArray(item.models) && item.models.length > 0
        ? item.models.join(", ")
        : "—";
      return [
        "<tr>",
        `<td data-label="${escapeHtml(copy.headers[0])}"><time datetime="${escapeHtml(String(item.timestamp))}">${escapeHtml(formatExact(item.timestamp, lang))}</time></td>`,
        `<td data-label="${escapeHtml(copy.headers[1])}">${escapeHtml(copy.types[item.type] || copy.types.regular)}</td>`,
        `<td data-label="${escapeHtml(copy.headers[2])}">${escapeHtml(`${item.authorName} (${item.authorHandle})`)}</td>`,
        `<td data-label="${escapeHtml(copy.headers[3])}">${escapeHtml(models)}</td>`,
        `<td data-label="${escapeHtml(copy.headers[4])}">${
          href
            ? `<a class="x-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(copy.source)} &rarr;</a>`
            : "—"
        }</td>`,
        "</tr>",
      ].join("");
    })
    .join("");
}

/**
 * @param {object} env
 * @param {string} lang
 * @returns {Promise<Response>}
 */
export async function handleHistoryRequest(env, lang) {
  const code = HISTORY_PATH[lang] ? lang : "en";
  const copy = COPY[code];
  const data = await loadSeoData(env);
  const canonical = `${SITE_ORIGIN}${HISTORY_PATH[code]}`;
  const home = code === "en" ? "/" : `/${code}`;
  const s = data.stats;
  const statsLine = copy.stats({
    total: s.total,
    avg: s.avgIntervalDays.toFixed(1),
    longest: s.longestWaitDays.toFixed(1),
  });

  const jsonld = {
    "@context": "https://schema.org",
    "@graph": [
      buildOrganizationNode(),
      {
        "@type": "Dataset",
        "@id": `${canonical}#dataset`,
        name: copy.h1,
        description: copy.description,
        url: canonical,
        inLanguage: code,
        isAccessibleForFree: true,
        license: `${SITE_ORIGIN}/api-docs`,
        creator: { "@id": `${SITE_ORIGIN}/#organization` },
        ...(data.resets.length > 0
          ? {
              temporalCoverage: `${new Date(data.resets[data.resets.length - 1].timestamp)
                .toISOString()
                .slice(0, 10)}/${new Date(data.resets[0].timestamp).toISOString().slice(0, 10)}`,
              dateModified: new Date(data.resets[0].timestamp).toISOString(),
            }
          : {}),
        distribution: [
          {
            "@type": "DataDownload",
            name: "Reset history (JSON)",
            encodingFormat: "application/json",
            contentUrl: `${SITE_ORIGIN}/api/v1/resets`,
          },
        ],
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: SITE_NAME, item: `${SITE_ORIGIN}${home}` },
          { "@type": "ListItem", position: 2, name: copy.h1, item: canonical },
        ],
      },
    ],
  };

  const html = `<!doctype html>
<html lang="${code}" data-theme="light">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(copy.title)} &mdash; ${escapeHtml(SITE_NAME)}</title>
    <meta name="description" content="${escapeHtml(copy.description)}" />
    <meta name="robots" content="index,follow,max-image-preview:large" />
    <link rel="canonical" href="${canonical}" />
    ${alternates()}
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
    <meta property="og:title" content="${escapeHtml(copy.title)}" />
    <meta property="og:description" content="${escapeHtml(copy.description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${SITE_ORIGIN}/og-image.jpg" />
    <meta property="og:locale" content="${OG_LOCALE[code] || "en_US"}" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" type="image/png" sizes="256x256" href="/favicon.png" />
    <link rel="stylesheet" href="/styles.css" />
    <script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
  </head>
  <body>
    <div class="page">
      <header class="top-header">
        <div class="brand-group">
          <div class="avatar-ring">
            <img src="/assets/varun-avatar.webp" alt="Varun Mohan" width="48" height="48" />
          </div>
          <a class="brand-title" href="${home}">${escapeHtml(SITE_NAME)}</a>
        </div>
        <div class="header-actions">
          <a class="pill-btn yellow-btn" href="${home}">&larr; ${escapeHtml(copy.back)}</a>
        </div>
      </header>
      <main>
        <section class="section-block">
          <h1 class="section-title">${escapeHtml(copy.h1)}</h1>
          <p class="section-sub">${escapeHtml(copy.intro)}</p>
          <p class="guide-answer">${escapeHtml(statsLine)}</p>
          <div class="docs-table-wrap">
            <table class="docs-table history-table">
              <thead><tr>${copy.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
              <tbody>${renderRows(data.resets, copy, code)}</tbody>
            </table>
          </div>
        </section>
      </main>
      <footer class="site-footer">
        <nav class="footer-links" aria-label="Related pages">
          <a class="text-link" href="${home}">${escapeHtml(SITE_NAME)}</a>
          <span aria-hidden="true">&middot;</span>
          <a class="text-link" href="${code === "en" ? "/guide" : `/${code}/guide`}">Guide</a>
          <span aria-hidden="true">&middot;</span>
          <a class="text-link" href="/api-docs">API</a>
          <span aria-hidden="true">&middot;</span>
          <a class="text-link" href="/about">About</a>
        </nav>
      </footer>
    </div>
  </body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Language": code,
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

/**
 * Markdown mirror of the history page.
 * @param {object} env
 * @param {string} lang
 * @returns {Promise<Response>}
 */
export async function handleHistoryMarkdownRequest(env, lang) {
  const code = HISTORY_PATH[lang] ? lang : "en";
  const copy = COPY[code];
  const data = await loadSeoData(env);
  const s = data.stats;
  const lines = [
    `# ${copy.h1}`,
    "",
    copy.intro,
    "",
    copy.stats({ total: s.total, avg: s.avgIntervalDays.toFixed(1), longest: s.longestWaitDays.toFixed(1) }),
    "",
    `| ${copy.headers.join(" | ")} |`,
    `| ${copy.headers.map(() => "---").join(" | ")} |`,
    ...data.resets.map((item) => {
      const href = safeHttpsUrl(item.url);
      const models = Array.isArray(item.models) && item.models.length > 0 ? item.models.join(", ") : "—";
      return `| ${formatExact(item.timestamp, lang)} | ${copy.types[item.type] || copy.types.regular} | ${item.authorName} (${item.authorHandle}) | ${models} | ${href ? `[${copy.source}](${href})` : "—"} |`;
    }),
    "",
    `[${copy.back}](${SITE_ORIGIN}${HISTORY_PATH[code]})`,
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Language": code,
      "X-Robots-Tag": "noindex",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}

export { HISTORY_PATH };
