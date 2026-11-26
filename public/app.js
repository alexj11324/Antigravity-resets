import {
  COPY,
  LANGUAGES,
  LANG_PATHS,
  MONTHS_SHORT,
  WEEKDAYS_SHORT,
  detectLocale,
} from "/assets/i18n.js";

const OFFICIAL_ACCOUNTS = {
  leadHandle: "@_mohansolo",
  leadUrl: "https://x.com/_mohansolo",
  telegramUrl: "https://t.me/antigravity_resets_alert",
};

const FALLBACK_AVATAR_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#FFF9EB"/><ellipse cx="48" cy="52" rx="34" ry="12" fill="none" stroke="#181614" stroke-width="4" transform="rotate(-22 48 52)"/><circle cx="48" cy="48" r="22" fill="#FFD84D" stroke="#181614" stroke-width="4"/><circle cx="41" cy="45" r="3" fill="#181614"/><circle cx="55" cy="45" r="3" fill="#181614"/><path d="M41 55q7 6 14 0" fill="none" stroke="#181614" stroke-width="3.5" stroke-linecap="round"/></svg>`,
  );

function getSessionId() {
  let id = sessionStorage.getItem("ag_session_id");
  if (!id) {
    id =
      typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem("ag_session_id", id);
  }
  return id;
}

const state = {
  locale: detectLocale(),
  theme: localStorage.getItem("ag_theme") || "light",
  tzMode: localStorage.getItem("ag_tz_mode") || "local",
  showAll: false,
  resets: [],
  upcomingReset: null,
  stats: {
    latest: null,
    totalResets: 0,
    avgIntervalDays: 0,
    longestWaitDays: 0,
  },
  thanksCount: 0,
  onlineCount: 1,
  browserFeedbackKey: null,
  emailFeedback: null, // { key, value? }
  heroTipLocked: false,
  openFaqIdx: 0,
  scrolledHeatmapOnce: false,
};

let pendingThanksDelta = 0;
let thanksFlushTimer = null;

const els = {
  brandAvatar: document.getElementById("brandAvatar"),
  siteTitle: document.getElementById("siteTitle"),
  onlineCount: document.getElementById("onlineCount"),
  onlineLabel: document.getElementById("onlineLabel"),
  langBtn: document.getElementById("langBtn"),
  langDropdown: document.getElementById("langDropdown"),
  themeBtn: document.getElementById("themeBtn"),
  themeIcon: document.getElementById("themeIcon"),
  subtitle: document.getElementById("subtitle"),
  browserAlertBtn: document.getElementById("browserAlertBtn"),
  browserAlertLabel: document.getElementById("browserAlertLabel"),
  telegramLink: document.getElementById("telegramLink"),
  telegramAlertLabel: document.getElementById("telegramAlertLabel"),
  emailAlertBtn: document.getElementById("emailAlertBtn"),
  emailAlertLabel: document.getElementById("emailAlertLabel"),
  tzPtBtn: document.getElementById("tzPtBtn"),
  tzPtLabel: document.getElementById("tzPtLabel"),
  tzLocalBtn: document.getElementById("tzLocalBtn"),
  tzLocalLabel: document.getElementById("tzLocalLabel"),
  mobileTzBtn: document.getElementById("mobileTzBtn"),
  mobileTzLabel: document.getElementById("mobileTzLabel"),
  alertFeedback: document.getElementById("alertFeedback"),
  emailForm: document.getElementById("emailForm"),
  emailInput: document.getElementById("emailInput"),
  emailSubmitBtn: document.getElementById("emailSubmitBtn"),
  emailStatus: document.getElementById("emailStatus"),
  upcomingBanner: document.getElementById("upcomingBanner"),
  upcomingBadge: document.getElementById("upcomingBadge"),
  upcomingCountdown: document.getElementById("upcomingCountdown"),
  upcomingTitle: document.getElementById("upcomingTitle"),
  upcomingQuote: document.getElementById("upcomingQuote"),
  upcomingUpdates: document.getElementById("upcomingUpdates"),
  upcomingMeta: document.getElementById("upcomingMeta"),
  upcomingLink: document.getElementById("upcomingLink"),
  heroCard: document.getElementById("heroCard"),
  particleLayer: document.getElementById("particleLayer"),
  latestKicker: document.getElementById("latestKicker"),
  latestRelative: document.getElementById("latestRelative"),
  resetTypeBtn: document.getElementById("resetTypeBtn"),
  resetTypeTip: document.getElementById("resetTypeTip"),
  latestExact: document.getElementById("latestExact"),
  thanksBtn: document.getElementById("thanksBtn"),
  thanksLabel: document.getElementById("thanksLabel"),
  thanksCount: document.getElementById("thanksCount"),
  statResetsLabel: document.getElementById("statResetsLabel"),
  statResetsVal: document.getElementById("statResetsVal"),
  statAvgLabel: document.getElementById("statAvgLabel"),
  statAvgShortLabel: document.getElementById("statAvgShortLabel"),
  statAvgVal: document.getElementById("statAvgVal"),
  statLongestLabel: document.getElementById("statLongestLabel"),
  statLongestVal: document.getElementById("statLongestVal"),
  tipCornerLabel: document.getElementById("tipCornerLabel"),
  cliTipTitle: document.getElementById("cliTipTitle"),
  cliTipDesc: document.getElementById("cliTipDesc"),
  advertiseBtn: document.getElementById("advertiseBtn"),
  advertiseTitle: document.getElementById("advertiseTitle"),
  advertiseDesc: document.getElementById("advertiseDesc"),
  historyHeading: document.getElementById("historyHeading"),
  legendRegular: document.getElementById("legendRegular"),
  legendBankedBtn: document.getElementById("legendBankedBtn"),
  legendBanked: document.getElementById("legendBanked"),
  bankedLegendTip: document.getElementById("bankedLegendTip"),
  legendNone: document.getElementById("legendNone"),
  heatmapAxis: document.getElementById("heatmapAxis"),
  heatmapScroll: document.getElementById("heatmapScroll"),
  heatmapGrid: document.getElementById("heatmapGrid"),
  cellTooltip: document.getElementById("cellTooltip"),
  announcementsHeading: document.getElementById("announcementsHeading"),
  announcementsSub: document.getElementById("announcementsSub"),
  announcementsList: document.getElementById("announcementsList"),
  toggleAllBtn: document.getElementById("toggleAllBtn"),
  faqHeading: document.getElementById("faqHeading"),
  faqList: document.getElementById("faqList"),
  footerLangs: document.getElementById("footerLangs"),
  footerDisclaimer: document.getElementById("footerDisclaimer"),
  apiDocsLink: document.getElementById("apiDocsLink"),
  sponsorDialog: document.getElementById("sponsorDialog"),
  sponsorDialogTitle: document.getElementById("sponsorDialogTitle"),
  sponsorDialogDesc: document.getElementById("sponsorDialogDesc"),
  sponsorDialogNote: document.getElementById("sponsorDialogNote"),
  closeSponsorBtn: document.getElementById("closeSponsorBtn"),
};

els.brandAvatar.addEventListener("error", () => {
  els.brandAvatar.src = FALLBACK_AVATAR_SVG;
});

function t() {
  return COPY[state.locale] || COPY.en;
}

function getRelativeParts(isoString) {
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000));
  const mins = Math.floor(diffSec / 60);
  const hours = Math.floor(diffSec / 3600);
  const days = Math.floor(diffSec / 86400);
  if (days >= 1) return { unit: "day", value: days };
  if (hours >= 1) return { unit: "hour", value: hours };
  if (mins >= 1) return { unit: "minute", value: mins };
  return { unit: "justNow", value: 0 };
}

function formatRelative(isoString) {
  if (!isoString) return "";
  const parts = getRelativeParts(isoString);
  const rel = t().relative;
  if (parts.unit === "justNow") return rel.justNow;
  return rel[parts.unit](parts.value);
}

function formatTimestamp(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  const timeZone =
    state.tzMode === "pt"
      ? "America/Los_Angeles"
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const loc = state.locale === "en" ? "en-US" : state.locale;
  const formatted = new Intl.DateTimeFormat(loc, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date);
  return state.tzMode === "pt" ? `${formatted} PT` : formatted;
}

function formatShortDate(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const loc = state.locale === "en" ? "en-US" : state.locale;
  return new Intl.DateTimeFormat(loc, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function getDateKeyInZone(date, tzMode) {
  const timeZone =
    tzMode === "pt"
      ? "America/Los_Angeles"
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function buildHeatmapWeeks(resets) {
  const resetMap = new Map();
  for (const r of resets) {
    const key = getDateKeyInZone(new Date(r.timestamp), state.tzMode);
    const list = resetMap.get(key) || [];
    list.push(r);
    resetMap.set(key, list);
  }

  const now = new Date();
  const todayKey = getDateKeyInZone(now, state.tzMode);
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  endDate.setUTCDate(endDate.getUTCDate() + (6 - endDate.getUTCDay()));

  // 28 trailing weeks (May -> Nov) fits edge-to-edge at 23px squares on 960px desktop
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - (28 * 7 - 1));

  const weeks = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    const week = [];
    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const y = cursor.getUTCFullYear();
      const m = String(cursor.getUTCMonth() + 1).padStart(2, "0");
      const day = String(cursor.getUTCDate()).padStart(2, "0");
      const key = `${y}-${m}-${day}`;
      const isFuture = key > todayKey;
      const dayResets = isFuture ? [] : resetMap.get(key) || [];
      week.push({
        key,
        month: cursor.getUTCMonth(),
        dayOfMonth: cursor.getUTCDate(),
        isFuture,
        isToday: key === todayKey,
        resets: dayResets,
        reset: dayResets[0] || null,
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

function applyTheme() {
  document.documentElement.setAttribute("data-theme", state.theme);
  localStorage.setItem("ag_theme", state.theme);
  if (state.theme === "dark") {
    els.themeIcon.innerHTML =
      '<circle cx="12" cy="12" r="4.5"></circle><path d="M12 2v2.2M12 19.8V22M4.93 4.93l1.55 1.55M17.52 17.52l1.55 1.55M2 12h2.2M19.8 12H22M4.93 19.07l1.55-1.55M17.52 6.48l1.55-1.55"></path>';
  } else {
    els.themeIcon.innerHTML =
      '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
  }
}

function renderLangControls() {
  els.langDropdown.innerHTML = "";
  els.footerLangs.innerHTML = "";
  for (const lang of LANGUAGES) {
    const isCurrent = lang.code === state.locale;
    const href = LANG_PATHS[lang.code] || "/";

    // Plain anchors that navigate for real. A client-side switch would leave
    // the server-rendered <title>, canonical and JSON-LD describing the old
    // locale, so the address bar and the document head would disagree.
    const opt = document.createElement("a");
    opt.className = "lang-option";
    opt.href = href;
    opt.hreflang = lang.code;
    opt.setAttribute("role", "menuitem");
    opt.setAttribute("aria-current", String(isCurrent));

    const labelSpan = document.createElement("span");
    labelSpan.textContent = lang.label;
    opt.appendChild(labelSpan);

    if (isCurrent) {
      const check = document.createElement("span");
      check.className = "lang-check";
      check.textContent = "✓";
      check.setAttribute("aria-hidden", "true");
      opt.appendChild(check);
    }

    els.langDropdown.appendChild(opt);

    const footerBtn = document.createElement("a");
    footerBtn.className = "footer-lang-btn";
    footerBtn.href = href;
    footerBtn.hreflang = lang.code;
    footerBtn.setAttribute("aria-current", String(isCurrent));
    footerBtn.textContent = lang.label;
    els.footerLangs.appendChild(footerBtn);
  }
}

function showCellTooltip(targetEl, cellData) {
  const c = t();
  const dateLabel = formatShortDate(cellData.key);
  const tzTag = state.tzMode === "pt" ? " (PT)" : "";

  els.cellTooltip.innerHTML = "";

  const dateLine = document.createElement("div");
  dateLine.className = "cell-tip-date";
  dateLine.textContent = `${dateLabel}${tzTag}`;
  els.cellTooltip.appendChild(dateLine);

  if (cellData.reset) {
    const titleLine = document.createElement("div");
    titleLine.className = "cell-tip-title";
    const baseTitle =
      cellData.reset.type === "banked" ? c.tipBankedTitle : c.tipRegularTitle;
    titleLine.textContent =
      cellData.resets.length > 1
        ? `${cellData.resets.length} ${c.tipMultiSuffix}`
        : baseTitle;

    const rawText = cellData.reset.summary?.[state.locale] || cellData.reset.summary?.en || "";
    const bodyLine = document.createElement("div");
    bodyLine.className = "cell-tip-body";
    bodyLine.textContent =
      rawText.length > 105 ? `${rawText.slice(0, 102)}...` : rawText;

    const hintLine = document.createElement("div");
    hintLine.className = "cell-tip-date";
    hintLine.style.marginTop = "5px";
    hintLine.textContent = c.tipClickHint;

    els.cellTooltip.append(titleLine, bodyLine, hintLine);
  } else {
    const quietLine = document.createElement("div");
    quietLine.className = "cell-tip-title";
    quietLine.textContent = c.tipQuietTitle;
    els.cellTooltip.appendChild(quietLine);
  }

  els.cellTooltip.hidden = false;
  const rect = targetEl.getBoundingClientRect();
  const tipWidth = els.cellTooltip.offsetWidth;
  const centerX = rect.left + rect.width / 2;
  const clampedX = Math.max(
    tipWidth / 2 + 12,
    Math.min(window.innerWidth - tipWidth / 2 - 12, centerX),
  );
  els.cellTooltip.style.left = `${clampedX}px`;
  els.cellTooltip.style.top = `${rect.top - 10}px`;
}

function hideCellTooltip() {
  els.cellTooltip.hidden = true;
}

function renderHeatmap() {
  const c = t();
  const weeks = buildHeatmapWeeks(state.resets);
  const months = MONTHS_SHORT[state.locale] || MONTHS_SHORT.en;
  const weekdays = WEEKDAYS_SHORT[state.locale] || WEEKDAYS_SHORT.en;

  // Pinned left axis outside the horizontal scroll track
  els.heatmapAxis.innerHTML = "";
  const axisSpacer = document.createElement("span");
  els.heatmapAxis.appendChild(axisSpacer);
  for (let row = 0; row < 7; row++) {
    const lbl = document.createElement("span");
    lbl.textContent = row === 1 || row === 3 || row === 5 ? weekdays[row] : "";
    els.heatmapAxis.appendChild(lbl);
  }

  const monthRow = document.createElement("div");
  monthRow.className = "heatmap-months";

  let lastMonth = -1;
  weeks.forEach((week, idx) => {
    const label = document.createElement("span");
    const m = week[0].month;
    if (m !== lastMonth && (idx === 0 || week[0].dayOfMonth <= 14 || idx > 1)) {
      label.textContent = months[m];
      lastMonth = m;
    }
    monthRow.appendChild(label);
  });

  const body = document.createElement("div");
  body.className = "heatmap-body";

  for (let row = 0; row < 7; row++) {
    weeks.forEach((week) => {
      const cellData = week[row];
      const dateLabel = formatShortDate(cellData.key);
      let cell;

      if (cellData.reset) {
        cell = document.createElement("a");
        cell.href = cellData.reset.url;
        cell.target = "_blank";
        cell.rel = "noopener noreferrer";
        cell.className = `heat-cell ${
          cellData.reset.type === "banked" ? "is-banked" : "is-reset"
        }`;
        cell.setAttribute(
          "aria-label",
          `${dateLabel}: ${cellData.reset.summary?.[state.locale] || cellData.reset.summary?.en || c.tipRegularTitle}`,
        );
      } else {
        cell = document.createElement("button");
        cell.type = "button";
        cell.className = "heat-cell";
        if (cellData.isFuture) cell.classList.add("is-future");
        if (cellData.isToday) cell.classList.add("is-today");
        cell.setAttribute("aria-label", `${dateLabel}: ${c.tipQuietTitle}`);
      }

      if (!cellData.isFuture) {
        cell.addEventListener("mouseenter", () => showCellTooltip(cell, cellData));
        cell.addEventListener("focus", () => showCellTooltip(cell, cellData));
        cell.addEventListener("mouseleave", hideCellTooltip);
        cell.addEventListener("blur", hideCellTooltip);
      }

      body.appendChild(cell);
    });
  }

  els.heatmapGrid.innerHTML = "";
  els.heatmapGrid.style.setProperty("--weeks", String(weeks.length));
  els.heatmapGrid.appendChild(monthRow);
  els.heatmapGrid.appendChild(body);

  if (!state.scrolledHeatmapOnce) {
    state.scrolledHeatmapOnce = true;
    requestAnimationFrame(() => {
      els.heatmapScroll.scrollLeft = els.heatmapScroll.scrollWidth;
    });
  }
}

function renderAnnouncements() {
  const c = t();
  const visible = state.showAll ? state.resets : state.resets.slice(0, 3);
  els.announcementsList.innerHTML = "";

  visible.forEach((item, idx) => {
    const row = document.createElement("article");
    row.className = "bubble-row";
    row.id = `reset-${item.id}`;

    const avatarWrap = document.createElement("div");
    avatarWrap.className = "bubble-avatar";
    const img = document.createElement("img");
    img.src = els.brandAvatar.src || "/assets/varun-avatar.webp";
    img.alt = item.authorName;
    img.addEventListener("error", () => {
      img.src = FALLBACK_AVATAR_SVG;
    });
    avatarWrap.appendChild(img);

    const card = document.createElement("div");
    card.className = "bubble-card";

    const meta = document.createElement("div");
    meta.className = "bubble-meta";

    const ago = document.createElement("span");
    ago.className = "bubble-ago";
    ago.textContent = formatRelative(item.timestamp);

    const exact = document.createElement("span");
    exact.className = "bubble-date";
    exact.textContent = formatTimestamp(item.timestamp);

    meta.append(ago, exact);

    const text = document.createElement("p");
    text.className = "bubble-text";
    text.textContent = item.summary?.[state.locale] || item.summary?.en || "";

    const foot = document.createElement("div");
    foot.className = "bubble-footer";

    const author = document.createElement("span");
    author.className = "bubble-author";
    author.textContent = `${item.authorName} (${item.authorHandle})`;

    const link = document.createElement("a");
    link.className = "x-link";
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `${c.viewOnX} →`;

    foot.append(author, link);
    card.append(meta, text, foot);
    row.append(avatarWrap, card);
    els.announcementsList.appendChild(row);

    // Mirror codex-resets.com: place a quick "Show fewer" control right after the 3rd item when expanded
    if (state.showAll && idx === 2 && state.resets.length > 3) {
      const collapseRow = document.createElement("div");
      collapseRow.className = "inline-collapse-row";
      const quickBtn = document.createElement("button");
      quickBtn.type = "button";
      quickBtn.className = "pill-btn";
      quickBtn.textContent = `${c.showFewer} ↑`;
      quickBtn.addEventListener("click", () => {
        state.showAll = false;
        renderAnnouncements();
      });
      collapseRow.appendChild(quickBtn);
      els.announcementsList.appendChild(collapseRow);
    }
  });

  if (state.resets.length <= 3) {
    els.toggleAllBtn.hidden = true;
  } else {
    els.toggleAllBtn.hidden = false;
    els.toggleAllBtn.textContent = state.showAll
      ? `${c.showFewer} ↑`
      : `${c.showAllPrefix} ${state.resets.length} ${c.showAllSuffix}`;
  }
}

function renderFaq() {
  const c = t();
  els.faqList.innerHTML = "";
  c.faqs.forEach((item, idx) => {
    const isOpen = state.openFaqIdx === idx;
    const wrap = document.createElement("div");
    wrap.className = "faq-item";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "faq-trigger";
    btn.setAttribute("aria-expanded", String(isOpen));

    const qSpan = document.createElement("span");
    qSpan.textContent = item.q;
    const icon = document.createElement("span");
    icon.className = "faq-icon";
    icon.textContent = "+";
    icon.setAttribute("aria-hidden", "true");
    btn.append(qSpan, icon);

    const body = document.createElement("div");
    body.className = `faq-body${isOpen ? " is-open" : ""}`;
    const bodyInner = document.createElement("div");
    bodyInner.className = "faq-body-inner";
    const ans = document.createElement("p");
    ans.className = "faq-answer";
    ans.textContent = item.a;
    bodyInner.appendChild(ans);
    body.appendChild(bodyInner);

    btn.addEventListener("click", () => {
      state.openFaqIdx = state.openFaqIdx === idx ? -1 : idx;
      renderFaq();
    });

    wrap.append(btn, body);
    els.faqList.appendChild(wrap);
  });
}

function renderFeedbackMessages() {
  const c = t();
  if (state.browserFeedbackKey && c[state.browserFeedbackKey]) {
    els.alertFeedback.hidden = false;
    els.alertFeedback.textContent = c[state.browserFeedbackKey];
  } else {
    els.alertFeedback.hidden = true;
  }

  if (state.emailFeedback) {
    els.emailStatus.hidden = false;
    const msg = c[state.emailFeedback.key] || "";
    els.emailStatus.textContent = state.emailFeedback.value
      ? `${msg} ${state.emailFeedback.value}`
      : msg;
  } else {
    els.emailStatus.hidden = true;
  }
}

// Clean per-click floating sticker burst + per-digit rolling counter matching codex-resets.com
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

function renderAnimatedCount(value, animate = true) {
  const formatted = Number(value).toLocaleString();
  const chars = Array.from(formatted);
  const existing = Array.from(els.thanksCount.children);
  const shouldAnimate = animate && !reducedMotionQuery.matches;

  const makeSpan = (ch, changing = false) => {
    const s = document.createElement("span");
    s.className = changing ? "t-digit is-changing" : "t-digit";
    s.textContent = ch;
    return s;
  };

  if (existing.length === chars.length && existing.length > 0) {
    chars.forEach((ch, idx) => {
      if (existing[idx].textContent !== ch) {
        const next = makeSpan(ch, shouldAnimate);
        existing[idx].replaceWith(next);
      }
    });
  } else {
    els.thanksCount.innerHTML = "";
    chars.forEach((ch) => els.thanksCount.appendChild(makeSpan(ch, false)));
  }
}

function spawnStickerBurst() {
  if (reducedMotionQuery.matches) return;
  const c = t();
  const pool = ["+1", "🙏", c.thanksBurstWord || "thx", "🧡", "avatar", "avatar"];
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const isAvatar = pick === "avatar";

  const el = document.createElement("span");
  el.className = "reset-plea-burst";
  if (isAvatar) {
    el.classList.add("reset-plea-burst--avatar");
    const img = document.createElement("img");
    img.src = els.brandAvatar.src || "/assets/varun-avatar.webp";
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    el.appendChild(img);
  } else {
    el.textContent = pick;
  }

  // Float higher (-86px to -138px) and smoother (1.08s cubic-bezier) straight from the button center
  const bx = Math.round(Math.random() * 88 - 44);
  const by = -86 - Math.round(Math.random() * 52);
  const rot = Math.round(Math.random() * 28 - 14);
  const size = isAvatar
    ? 38 + Math.round(Math.random() * 5)
    : 18 + Math.round(Math.random() * 6);

  el.style.setProperty("--burst-x", `${bx}px`);
  el.style.setProperty("--burst-y", `${by}px`);
  el.style.setProperty("--burst-rotate", `${rot}deg`);
  el.style.setProperty("--burst-size", `${size}px`);

  els.particleLayer.appendChild(el);
  while (els.particleLayer.childElementCount > 14) {
    els.particleLayer.firstElementChild?.remove();
  }
  el.addEventListener("animationend", () => el.remove(), { once: true });
}

function flushThanks() {
  const latest = state.stats.latest;
  if (!latest || pendingThanksDelta <= 0) return;
  const deltaToSend = pendingThanksDelta;
  pendingThanksDelta = 0;

  fetch("/api/v1/thanks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resetId: latest.id, delta: deltaToSend }),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data && typeof data.thanksCount === "number") {
        state.thanksCount = data.thanksCount + pendingThanksDelta;
        renderAnimatedCount(state.thanksCount, false);
      }
    })
    .catch(() => {});
}

function formatUtcShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
}

function formatFutureCountdown(iso) {
  const c = t();
  if (!iso) return "";
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return "";
  if (diffMs <= 60 * 1000) return c.upcomingSoon;
  const totalMin = Math.round(diffMs / 60000);
  if (totalMin < 60) {
    return state.locale === "en"
      ? `${c.upcomingInPrefix} ${totalMin}m`
      : `${c.upcomingInPrefix} ${totalMin}m`;
  }
  const hrs = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (hrs < 48) {
    return remMin > 0
      ? `${c.upcomingInPrefix} ${hrs}h ${remMin}m`
      : `${c.upcomingInPrefix} ${hrs}h`;
  }
  const days = Math.round(hrs / 24);
  return `${c.upcomingInPrefix} ${days}${c.daysSuffix}`;
}

function renderUpcomingBanner() {
  const ann = state.upcomingReset;
  if (!els.upcomingBanner) return;
  if (!ann) {
    els.upcomingBanner.hidden = true;
    return;
  }
  const c = t();
  const isWatch = ann.status === "possible";
  els.upcomingBanner.hidden = false;
  els.upcomingBanner.classList.toggle("is-watch", isWatch);
  els.upcomingBadge.textContent = isWatch ? c.upcomingWatchBadge : c.upcomingExpectedBadge;
  els.upcomingCountdown.textContent = ann.expectedBy ? formatFutureCountdown(ann.expectedBy) : "";

  const utcLabel = ann.expectedBy ? formatUtcShort(ann.expectedBy) : "";
  if (isWatch) {
    els.upcomingTitle.textContent = utcLabel
      ? `${c.upcomingPossibleByPrefix} ${utcLabel}`
      : c.upcomingPossiblePlain;
  } else {
    els.upcomingTitle.textContent = utcLabel
      ? `${c.upcomingExpectedByPrefix} ${utcLabel}`
      : c.upcomingExpectedTba;
  }

  const authorShort =
    ann.authorHandle === "@_mohansolo"
      ? "Varun"
      : ann.authorHandle === "@_anshulr"
        ? "Anshul"
        : ann.authorName || ann.authorHandle;
  const mainQuote = ann.quoteText || ann.summary?.[state.locale] || ann.summary?.en || "";
  els.upcomingQuote.textContent = `${mainQuote} - ${authorShort}`;

  const updates = Array.isArray(ann.updates) ? ann.updates : [];
  if (updates.length > 0) {
    els.upcomingUpdates.hidden = false;
    els.upcomingUpdates.innerHTML = "";
    for (const upd of updates) {
      const label = document.createElement("div");
      label.className = "upcoming-update-label";
      label.textContent = c.upcomingUpdateLabel;
      const bq = document.createElement("blockquote");
      bq.className = "upcoming-quote";
      const uShort =
        upd.authorHandle === "@_mohansolo"
          ? "Varun"
          : upd.authorName || upd.authorHandle || authorShort;
      bq.textContent = `${upd.quoteText || ""} - ${uShort}`;
      els.upcomingUpdates.append(label, bq);
    }
  } else {
    els.upcomingUpdates.hidden = true;
    els.upcomingUpdates.innerHTML = "";
  }

  els.upcomingMeta.textContent = ann.expectedBy
    ? `${formatTimestamp(ann.expectedBy)} · ${ann.authorHandle}`
    : `${formatTimestamp(ann.announcedAt)} · ${ann.authorHandle}`;
  els.upcomingLink.href = ann.url || OFFICIAL_ACCOUNTS.leadUrl;
  els.upcomingLink.textContent = `${c.viewOnX} →`;
}

function render() {
  const c = t();
  const latest = state.stats.latest;

  document.documentElement.lang = state.locale;
  els.siteTitle.textContent = c.siteName;
  els.onlineCount.textContent = String(state.onlineCount);
  els.onlineLabel.textContent = c.hereNow;

  els.subtitle.innerHTML = `${c.subtitlePrefix} <a href="${OFFICIAL_ACCOUNTS.leadUrl}" target="_blank" rel="noopener noreferrer">${OFFICIAL_ACCOUNTS.leadHandle}</a> ${c.subtitleSuffix}`;

  els.browserAlertLabel.textContent = c.alertsBrowser;
  els.telegramAlertLabel.textContent = c.alertsTelegram;
  els.emailAlertLabel.textContent = c.alertsEmail;
  els.telegramLink.href = OFFICIAL_ACCOUNTS.telegramUrl;

  els.tzPtLabel.textContent = c.tzVarun;
  els.tzLocalLabel.textContent = c.tzLocal;
  els.tzPtBtn.setAttribute("aria-pressed", String(state.tzMode === "pt"));
  els.tzLocalBtn.setAttribute("aria-pressed", String(state.tzMode === "local"));
  els.mobileTzLabel.textContent = state.tzMode === "pt" ? c.tzVarun : c.tzLocal;

  els.emailInput.placeholder = c.emailPlaceholder;
  els.emailSubmitBtn.textContent = c.emailBtn;

  els.latestKicker.textContent = c.latestKicker;
  if (latest) {
    els.resetTypeBtn.textContent =
      latest.type === "banked" ? c.typeBanked : c.typeRegular;
    els.resetTypeTip.textContent =
      latest.type === "banked" ? c.typeBankedTip : c.typeRegularTip;
    els.latestRelative.textContent = formatRelative(latest.timestamp);
    els.latestExact.textContent = formatTimestamp(latest.timestamp);
  } else {
    els.resetTypeBtn.textContent = c.typeRegular;
    els.resetTypeTip.textContent = c.typeRegularTip;
  }

  els.thanksLabel.textContent = c.thanksBtn;
  renderAnimatedCount(state.thanksCount, false);

  els.statResetsLabel.textContent = c.statResets;
  els.statResetsVal.textContent = String(state.stats.totalResets);
  els.statAvgLabel.textContent = c.statAvg;
  els.statAvgShortLabel.textContent = c.statAvgShort;
  els.statAvgVal.textContent = `${Number(state.stats.avgIntervalDays).toFixed(1)}${c.daysSuffix}`;
  els.statLongestLabel.textContent = c.statLongest;
  els.statLongestVal.textContent = `${Number(state.stats.longestWaitDays).toFixed(1)}${c.daysSuffix}`;

  els.tipCornerLabel.textContent = c.sponsorLabel;
  els.cliTipTitle.textContent = c.cliTipTitle;
  els.cliTipDesc.textContent = c.cliTipDesc;
  els.advertiseTitle.textContent = c.advertiseTitle;
  els.advertiseDesc.textContent = c.advertiseDesc;

  els.historyHeading.textContent = c.historyHeading;
  els.legendRegular.textContent = c.legendRegular;
  els.legendBanked.textContent = c.legendBanked;
  els.bankedLegendTip.textContent = c.legendBankedTip;
  els.legendNone.textContent = c.legendNone;

  els.announcementsHeading.textContent = c.announcementsHeading;
  els.announcementsSub.textContent = c.announcementsSub;
  els.faqHeading.textContent = c.faqHeading;

  els.footerDisclaimer.textContent = c.footerDisclaimer;
  els.apiDocsLink.textContent = c.apiDocsLink;

  els.sponsorDialogTitle.textContent = c.advertiseModalTitle;
  els.sponsorDialogDesc.textContent = c.advertiseModalDesc;
  els.sponsorDialogNote.textContent = c.advertiseModalNote;
  els.closeSponsorBtn.textContent = c.close;

  renderFeedbackMessages();
  renderUpcomingBanner();
  renderLangControls();
  renderHeatmap();
  renderAnnouncements();
  renderFaq();
}

let lastKnownLatestId = null;

async function fetchLiveData() {
  const [statusRes, resetsRes] = await Promise.all([
    fetch("/api/v1/status", { headers: { Accept: "application/json" } }),
    fetch("/api/v1/resets", { headers: { Accept: "application/json" } }),
  ]);

  if (!statusRes.ok || !resetsRes.ok) {
    throw new Error("Failed to load live reset data");
  }

  const statusData = await statusRes.json();
  const resetsData = await resetsRes.json();

  state.resets = Array.isArray(resetsData.resets) ? resetsData.resets : [];
  state.upcomingReset = statusData.upcomingReset || null;
  const nextLatest = statusData.latest || state.resets[0] || null;
  if (
    lastKnownLatestId &&
    nextLatest?.id &&
    nextLatest.id !== lastKnownLatestId &&
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    const c = t();
    const label = nextLatest.type === "banked" ? c.typeBanked : c.typeRegular;
    const body =
      nextLatest.summary?.[state.locale] ||
      nextLatest.summary?.en ||
      "Official Antigravity quota reset announced.";
    try {
      const n = new Notification(`${c.siteName}: ${label}`, {
        body,
        icon: "/favicon.png",
      });
      n.onclick = () => {
        window.focus();
        if (nextLatest.url) window.open(nextLatest.url, "_blank", "noopener,noreferrer");
      };
    } catch {
      // non-fatal
    }
  }
  if (nextLatest?.id) {
    lastKnownLatestId = nextLatest.id;
  }

  state.stats = {
    latest: nextLatest,
    totalResets: statusData.stats?.totalResets ?? state.resets.length,
    avgIntervalDays: statusData.stats?.avgIntervalDays ?? 0,
    longestWaitDays: statusData.stats?.longestWaitDays ?? 0,
  };
  state.thanksCount =
    (statusData.thanksCount ?? state.stats.latest?.thanksCount ?? 0) + pendingThanksDelta;
  state.onlineCount = statusData.onlineCount ?? state.onlineCount;
  render();
}

async function pingPresence() {
  try {
    const res = await fetch("/api/v1/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: getSessionId() }),
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.onlineCount === "number") {
        state.onlineCount = data.onlineCount;
        els.onlineCount.textContent = String(state.onlineCount);
      }
    }
  } catch {
    // non-fatal
  }
}

// Event bindings
els.themeBtn.addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  applyTheme();
});

els.langBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = !els.langDropdown.hidden;
  els.langDropdown.hidden = open;
  els.langBtn.setAttribute("aria-expanded", String(!open));
});

document.addEventListener("click", (e) => {
  if (!els.langDropdown.hidden && !els.langDropdown.contains(e.target) && e.target !== els.langBtn) {
    els.langDropdown.hidden = true;
    els.langBtn.setAttribute("aria-expanded", "false");
  }
  if (state.heroTipLocked && e.target !== els.resetTypeBtn && !els.resetTypeTip.contains(e.target)) {
    state.heroTipLocked = false;
    els.resetTypeTip.hidden = true;
    els.resetTypeBtn.setAttribute("aria-expanded", "false");
  }
});

// Hero reset explanation tooltip: supports hover, focus, AND click cleanly above trigger
els.resetTypeBtn.addEventListener("mouseenter", () => {
  els.resetTypeTip.hidden = false;
  els.resetTypeBtn.setAttribute("aria-expanded", "true");
});
els.resetTypeBtn.addEventListener("mouseleave", () => {
  if (!state.heroTipLocked) {
    els.resetTypeTip.hidden = true;
    els.resetTypeBtn.setAttribute("aria-expanded", "false");
  }
});
els.resetTypeBtn.addEventListener("focus", () => {
  els.resetTypeTip.hidden = false;
  els.resetTypeBtn.setAttribute("aria-expanded", "true");
});
els.resetTypeBtn.addEventListener("blur", () => {
  if (!state.heroTipLocked) {
    els.resetTypeTip.hidden = true;
    els.resetTypeBtn.setAttribute("aria-expanded", "false");
  }
});
els.resetTypeBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  state.heroTipLocked = !state.heroTipLocked;
  els.resetTypeTip.hidden = !state.heroTipLocked;
  els.resetTypeBtn.setAttribute("aria-expanded", String(state.heroTipLocked));
});

// Banked (soon) legend hover/focus/click tooltip
els.legendBankedBtn.addEventListener("mouseenter", () => {
  els.bankedLegendTip.hidden = false;
});
els.legendBankedBtn.addEventListener("mouseleave", () => {
  els.bankedLegendTip.hidden = true;
});
els.legendBankedBtn.addEventListener("focus", () => {
  els.bankedLegendTip.hidden = false;
});
els.legendBankedBtn.addEventListener("blur", () => {
  els.bankedLegendTip.hidden = true;
});
els.legendBankedBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  els.bankedLegendTip.hidden = !els.bankedLegendTip.hidden;
});

els.tzPtBtn.addEventListener("click", () => {
  state.tzMode = "pt";
  localStorage.setItem("ag_tz_mode", "pt");
  render();
});

els.tzLocalBtn.addEventListener("click", () => {
  state.tzMode = "local";
  localStorage.setItem("ag_tz_mode", "local");
  render();
});

els.mobileTzBtn.addEventListener("click", () => {
  state.tzMode = state.tzMode === "pt" ? "local" : "pt";
  localStorage.setItem("ag_tz_mode", state.tzMode);
  render();
});

// Crisp codex-resets.com-exact multi-click thanks interaction
let pleadTimer = null;
els.thanksBtn.addEventListener("click", () => {
  if (!state.stats.latest) return;
  state.thanksCount += 1;
  pendingThanksDelta += 1;
  renderAnimatedCount(state.thanksCount, true);

  els.thanksBtn.classList.remove("is-pleading");
  void els.thanksBtn.offsetHeight;
  els.thanksBtn.classList.add("is-pleading");
  clearTimeout(pleadTimer);
  pleadTimer = setTimeout(() => els.thanksBtn.classList.remove("is-pleading"), 280);

  spawnStickerBurst();

  clearTimeout(thanksFlushTimer);
  thanksFlushTimer = setTimeout(flushThanks, 260);
});

els.browserAlertBtn.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    state.browserFeedbackKey = "browserPushUnsupported";
    renderFeedbackMessages();
    return;
  }
  try {
    const result = await Notification.requestPermission();
    state.browserFeedbackKey =
      result === "granted" ? "browserPushGranted" : "browserPushDenied";
  } catch {
    state.browserFeedbackKey = "browserPushUnsupported";
  }
  renderFeedbackMessages();
});

els.emailAlertBtn.addEventListener("click", () => {
  const nextOpen = els.emailForm.hidden;
  els.emailForm.hidden = !nextOpen;
  els.emailAlertBtn.setAttribute("aria-expanded", String(nextOpen));
  els.emailAlertBtn.classList.toggle("is-pink-active", nextOpen);
  if (nextOpen) els.emailInput.focus();
});

els.emailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const val = els.emailInput.value.trim();
  if (!val || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
    state.emailFeedback = { key: "emailInvalid" };
    renderFeedbackMessages();
    return;
  }
  try {
    const res = await fetch("/api/v1/subscribe/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: val, locale: state.locale }),
    });
    if (!res.ok) throw new Error("Subscribe failed");
    const payload = await res.json().catch(() => ({}));
    // 202 means a confirmation email went out and nothing is active yet.
    state.emailFeedback = payload.pendingConfirmation
      ? { key: "emailPending" }
      : { key: "emailSuccess", value: val };
    els.emailInput.value = "";
  } catch {
    state.emailFeedback = { key: "emailError" };
  }
  renderFeedbackMessages();
});

els.toggleAllBtn.addEventListener("click", () => {
  state.showAll = !state.showAll;
  renderAnnouncements();
});

els.advertiseBtn.addEventListener("click", () => els.sponsorDialog.showModal());
els.closeSponsorBtn.addEventListener("click", () => els.sponsorDialog.close());

els.heatmapScroll.addEventListener("scroll", hideCellTooltip, { passive: true });
window.addEventListener("scroll", hideCellTooltip, { passive: true });

applyTheme();
fetchLiveData()
  .then(() => pingPresence())
  .catch(() => render());

setInterval(() => {
  if (state.stats.latest) {
    els.latestRelative.textContent = formatRelative(state.stats.latest.timestamp);
  }
}, 30000);

setInterval(() => {
  fetchLiveData().catch(() => {});
  pingPresence();
}, 60000);
