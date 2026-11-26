// Shared SEO data layer: constants, escaping, locale helpers, and one
// deduplicated data fetch for every server-rendered surface (HTML, Markdown,
// llms.txt, sitemap).

import { computeStats } from "./seed-data.mjs";
import { listResets } from "./store.mjs";
import { COPY, LANGUAGES, LANG_PATHS, MONTHS_SHORT } from "../public/assets/i18n.js";

export const SITE_ORIGIN = "https://antigravity-resets.com";
export const SITE_NAME = "Antigravity Resets";

// Single source of truth lives in public/assets/i18n.js so the Worker and the
// browser bundle can never drift apart.
export { LANG_PATHS };

export const LANG_CODES = Object.freeze(LANGUAGES.map((entry) => entry.code));

export const LANG_LABEL = Object.freeze(
  Object.fromEntries(LANGUAGES.map((entry) => [entry.code, entry.label])),
);

const PATH_TO_LANG = new Map(
  Object.entries(LANG_PATHS).map(([code, path]) => [path.replace(/\/$/, ""), code]),
);

/**
 * Map a request pathname to a supported locale.
 * Both the English root ("/") and a bare path normalize to the same key.
 * @param {string} pathname
 * @returns {string|null} locale code, or null when the path is not a home page
 */
export function langFromPath(pathname) {
  return PATH_TO_LANG.get(pathname.replace(/\/+$/, "")) ?? null;
}

/**
 * @param {string} lang
 * @returns {typeof COPY[string]}
 */
export function copyFor(lang) {
  return COPY[lang] || COPY.en;
}

/**
 * @param {string} lang
 * @returns {string} canonical URL for a locale home page
 */
export function langUrl(lang) {
  return `${SITE_ORIGIN}${LANG_PATHS[lang] || "/"}`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Only absolute https URLs may become an href or a Markdown link target.
 * `escapeHtml` stops attribute breakout but says nothing about the scheme.
 * @param {unknown} value
 * @returns {string} the normalized URL, or "" when it is not safe
 */
export function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/** Strip characters that would break inline `<script>` JSON embedding. */
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Human-readable absolute timestamp, localized per language.
 * en: "Nov 26, 2026, 07:19 UTC" · zh: "2026年11月26日 07:19 UTC"
 * ja: "2026年11月26日 07:19 UTC" · ko: "2026년 11월 26일 07:19 UTC"
 * @param {string} isoTimestamp
 * @param {string} lang
 */
export function formatExact(isoTimestamp, lang) {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return "";
  const months = MONTHS_SHORT[lang] || MONTHS_SHORT.en;
  const month = months[date.getUTCMonth()];
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const clock = `${hh}:${mm} UTC`;

  if (lang === "en") return `${month} ${day}, ${year}, ${clock}`;
  if (lang === "ko") return `${year}년 ${month} ${day}일 ${clock}`;
  // zh-CN, zh-TW and ja share the same order; MONTHS_SHORT already ends in 月.
  return `${year}年${month}${day}日 ${clock}`;
}

/**
 * Localized relative age, e.g. "13 hours ago" / "13 小时前".
 * @param {string} isoTimestamp
 * @param {string} lang
 */
export function formatRelative(isoTimestamp, lang) {
  const copy = copyFor(lang);
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return copy.relative?.justNow || "just now";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return copy.relative?.justNow || "just now";
  if (minutes < 60) return copy.relative?.minute?.(minutes) || `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return copy.relative?.hour?.(hours) || `${hours} hours ago`;
  return copy.relative?.day?.(Math.floor(hours / 24)) || `${Math.floor(hours / 24)} days ago`;
}

/**
 * Return source post text in its original language, without generated summaries.
 * @param {{quoteText?: string}} item
 */
export function originalPostText(item) {
  return typeof item?.quoteText === "string" && item.quoteText.trim() ? item.quoteText : "";
}

/**
 * One database read shared by every SEO surface.
 * Falls back to seed data when D1 is not bound (local preview / tests).
 * @param {object} env
 */
export async function loadSeoData(env) {
  // Only the reset list is needed: every SEO surface derives stats from it, and
  // the online counter / upcoming-reset banner stay client-side.
  const resets = await listResets(env?.DB);
  return {
    resets,
    stats: computeStats(resets),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Public Open Graph copy per locale. Titles keep the query keyword first and
 * the brand last, matching how codex-resets.com structures its <title>.
 * @param {string} lang
 */
export function pageMeta(lang) {
  const meta = {
    en: {
      title: "Antigravity Reset Tracker — Did Antigravity Reset Today? Live Status & History",
      description:
        "Did Antigravity reset today? Live Google Antigravity quota reset tracker watching @_mohansolo and @antigravity for official resets, plus full history, alerts, and a free JSON API.",
      answerPrefix: "Yes.",
      noResetYet: "No official Antigravity reset has been announced yet.",
      answerSuffix:
        "official resets are tracked from posts by Varun Mohan (@_mohansolo) and the Antigravity team; verify your live meter inside the IDE or CLI.",
      answerLead: (author, when, exact) =>
        author + " announced an official reset " + when + " (" + exact + ").",
    },
    "zh-CN": {
      title: "Antigravity 重置追踪 — 今天 Antigravity 重置了吗？实时状态与历史",
      description:
        "今天 Antigravity 重置了吗？实时追踪 @_mohansolo 与 @antigravity 发布的 Google Antigravity 官方配额重置公告，提供完整历史、提醒与免费 JSON API。",
      answerPrefix: "是的。",
      noResetYet: "目前还没有官方 Antigravity 重置公告。",
      answerSuffix: "官方重置以 Varun Mohan (@_mohansolo) 与 Antigravity 团队在 X 上的公告为准；你的实时额度请在 IDE 或 CLI 中查看。",
      answerLead: (author, when, exact) =>
        author + " 在 " + when + "发布了官方重置公告（" + exact + "）。",
    },
    "zh-TW": {
      title: "Antigravity 重置追蹤 — 今天 Antigravity 重置了嗎？即時狀態與歷史",
      description:
        "今天 Antigravity 重置了嗎？即時追蹤 @_mohansolo 與 @antigravity 發布的 Google Antigravity 官方配額重置公告，提供完整歷史、提醒與免費 JSON API。",
      answerPrefix: "是的。",
      noResetYet: "目前還沒有官方 Antigravity 重置公告。",
      answerSuffix: "官方重置以 Varun Mohan (@_mohansolo) 與 Antigravity 團隊在 X 上的公告為準；你的即時額度請在 IDE 或 CLI 中查看。",
      answerLead: (author, when, exact) =>
        author + " 在 " + when + "發布了官方重置公告（" + exact + "）。",
    },
    ja: {
      title: "Antigravity リセット追跡 — 今日 Antigravity はリセットされた？ライブ状況と履歴",
      description:
        "今日 Antigravity はリセットされた？@_mohansolo と @antigravity が発表する Google Antigravity の公式クォータリセットをリアルタイムで追跡。履歴、通知、無料 JSON API を提供します。",
      answerPrefix: "はい。",
      noResetYet: "公式の Antigravity リセットはまだ発表されていません。",
      answerSuffix: "公式リセットは Varun Mohan (@_mohansolo) と Antigravity チームの X 投稿に基づきます。残量は IDE または CLI で確認してください。",
      answerLead: (author, when, exact) =>
        author + " が " + when + "に公式リセットを発表しました（" + exact + "）。",
    },
    ko: {
      title: "Antigravity 리셋 추적 — 오늘 Antigravity 가 리셋되었나요? 실시간 상태와 기록",
      description:
        "오늘 Antigravity 가 리셋되었나요? @_mohansolo 와 @antigravity 가 발표하는 Google Antigravity 공식 할당량 리셋을 실시간으로 추적합니다. 전체 기록, 알림, 무료 JSON API 제공.",
      answerPrefix: "네.",
      noResetYet: "아직 공식 Antigravity 리셋 발표가 없습니다.",
      answerSuffix: "공식 리셋은 Varun Mohan(@_mohansolo) 과 Antigravity 팀의 X 게시물을 기준으로 합니다. 남은 할당량은 IDE 또는 CLI 에서 확인하세요.",
      answerLead: (author, when, exact) =>
        author + " 님이 " + when + "에 공식 리셋을 발표했습니다 (" + exact + ").",
    },
  };
  return meta[lang] || meta.en;
}
