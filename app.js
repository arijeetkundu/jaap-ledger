// ---------- Background Theme ----------
let backgroundChoice = localStorage.getItem("backgroundChoice") || "mandala";

// ---------- i18n: language state ----------
// null until the user has explicitly chosen (via the first-run picker or the
// Settings switcher) — that's what gates the first-run picker from showing.
// Lookups always fall back to "en" via t() below, so the app renders in
// English before a choice is made.
let currentAppLanguage = localStorage.getItem("appLanguage") || null;

// The reviewed, locked dictionary lives in i18n/translations.json (every
// user-facing string, each key with { en, hi, bn }; placeholders use
// {name} tokens e.g. {year}/{date}/{crore}/{days}/{count}) rather than
// inline here, keeping data separate from logic. Populated asynchronously
// by loadTranslations() (called from initApp()) via a same-origin fetch —
// a local static asset the app already ships, not an external network
// dependency (same as loading styles.css or a font file); works offline
// once the page has loaded before. Declared here (not further down the
// file) deliberately: several top-level synchronous calls that happen
// before initApp's first await (updateMalaToggleButton(),
// renderSplashSlotUI()) already call t(), which reads this — declaring it
// later in the file would leave those calls hitting the temporal dead zone.
//
// Deliberately NOT translated (decision, not an oversight): the short
// "D MMM YYYY" date format (formatDate() — Ledger List rows, Pace
// predictions, Milestones list, Sankalpa date) stays in English in every
// app language. Only formatDateLong()'s weekday + full month name (Today
// Card date line only) uses datesWeekdaysFull / datesMonthsFull from the
// dictionary. Numerals stay Western (0-9) in every language, everywhere.
let TRANSLATIONS = null;

// One retry on failure — this is normally a same-origin, near-instant
// static-file fetch, so a single short-delay retry meaningfully narrows
// the (already small) window where TRANSLATIONS ends up empty. If BOTH
// attempts fail, loadTranslations() hands off to a slower background retry
// loop (see scheduleTranslationsRetry() below) rather than giving up for
// the rest of the session — loadTranslations() itself is only ever called
// once, at bootstrap, so without a background loop a transient failure
// (a momentary network hiccup, a page loaded mid-deploy) would leave
// TRANSLATIONS empty for the entire session with no way to ever recover.
async function fetchTranslationsOnce() {
  const res = await fetch("i18n/translations.json");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function loadTranslations() {
  try {
    TRANSLATIONS = await fetchTranslationsOnce();
  } catch (e) {
    console.error("Failed to load translations.json, retrying once:", e);
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      TRANSLATIONS = await fetchTranslationsOnce();
    } catch (e2) {
      console.error("Retry failed, falling back to baked-in English for now:", e2);
      TRANSLATIONS = {};
      scheduleTranslationsRetry();
    }
  }
}

// Same-origin static asset, small file — a slow retry cadence is plenty
// responsive for "the network hiccuped" while staying cheap if something
// is genuinely, persistently broken. Capped rather than infinite: after
// TRANSLATIONS_RETRY_MAX_ATTEMPTS (~100s total), give up for the rest of
// the session — static markup already degrades gracefully via
// applyStaticTranslations()'s existing skip-if-missing behavior, and
// dynamic sections falling back to raw keys becomes the documented,
// accepted residual risk only in that genuinely-persistent-failure case.
const TRANSLATIONS_RETRY_MS = 5000;
const TRANSLATIONS_RETRY_MAX_ATTEMPTS = 20;
let translationsRetryTimer = null;
let translationsRetryAttempts = 0;

function scheduleTranslationsRetry() {
  if (translationsRetryTimer) return; // already scheduled
  if (translationsRetryAttempts >= TRANSLATIONS_RETRY_MAX_ATTEMPTS) return;

  translationsRetryTimer = setTimeout(async () => {
    translationsRetryTimer = null;
    translationsRetryAttempts++;
    try {
      const fresh = await fetchTranslationsOnce();
      TRANSLATIONS = fresh;
      // Re-render everything now visible with the real dictionary — static
      // markup was already showing correct (if untranslated) English, so
      // this is what upgrades it to the user's actual chosen language too.
      applyStaticTranslations();
      updateMalaToggleButton();
      renderSplashSlotUI();
      renderToday();
      renderDataSafetyStatus();
      if (document.getElementById("sankalpa-page")?.classList.contains("open")) {
        renderSankalpaPage();
      }
    } catch (e) {
      scheduleTranslationsRetry();
    }
  }, TRANSLATIONS_RETRY_MS);
}

function getEffectiveLang() {
  return currentAppLanguage || "en";
}

// True only when TRANSLATIONS actually has a real entry for this key (not
// just t()'s raw-key fallback) — lets callers distinguish "no translation
// available" from "translated, and it happens to equal the key."
function hasTranslation(key) {
  return !!(TRANSLATIONS && TRANSLATIONS[key]);
}

// Before TRANSLATIONS loads (or if it's still empty because both attempts
// in loadTranslations() failed and the background retry above hasn't
// succeeded yet), falls back to the key itself so nothing throws — this is
// the one dynamic-UI gap that isn't fully closed: while TRANSLATIONS is
// genuinely empty, dynamic sections (rebuilt from scratch every render, no
// prior DOM to preserve the way applyStaticTranslations() does for static
// markup) do show raw key text until the background retry above succeeds
// and re-renders everything. Also guards against a dictionary entry that
// exists but is missing both the active language and "en" (shouldn't
// happen with the current dictionary, but a future edit could introduce
// one) — without this, params interpolation below would throw on
// `undefined.split(...)`.
function t(key, params) {
  const entry = TRANSLATIONS && TRANSLATIONS[key];
  let str = entry ? (entry[getEffectiveLang()] || entry.en) : key;
  if (typeof str !== "string") str = key;
  if (params) {
    Object.keys(params).forEach((k) => {
      str = str.split("{" + k + "}").join(params[k]);
    });
  }
  return str;
}

// Walks every element carrying a data-i18n* attribute and applies the
// current language's text/attribute — covers the static markup in
// index.html (Settings drawer labels, Sunday Backup modal, etc.) that
// isn't rebuilt from scratch on every render the way the dynamic sections
// (Today Card, Ledger List, ...) are. Deliberately leaves an element's
// existing text/attribute untouched when there's no real translation for
// it (TRANSLATIONS still loading, or the load failed) — index.html's own
// markup already has correct English baked in, and overwriting it with
// t()'s raw-key fallback would make a translations.json failure look like
// the whole UI broke, when the pre-i18n app never had that failure mode.
function applyStaticTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    if (hasTranslation(el.dataset.i18n)) el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    if (hasTranslation(el.dataset.i18nAria)) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    if (hasTranslation(el.dataset.i18nTitle)) el.setAttribute("title", t(el.dataset.i18nTitle));
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    if (hasTranslation(el.dataset.i18nPlaceholder)) el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder));
  });
}

// Sets the active language, persists it, and refreshes every already-
// rendered piece of UI in place — called by both the first-run picker and
// the Settings switcher.
function applyAppLanguage(lang) {
  currentAppLanguage = lang;
  // Unguarded (unlike setCustomSplashImage()'s explicit QuotaExceededError
  // handling) this could throw and abort the rest of this function if
  // localStorage is near its shared-origin quota (e.g. several custom
  // splash images already stored) — the language would apply for this
  // session but silently fail to persist, so the first-run picker would
  // incorrectly reappear next load even though the user already chose.
  try {
    localStorage.setItem("appLanguage", lang);
  } catch (e) {
    console.error("Failed to persist appLanguage:", e);
    showToast(t("langErrQuota"));
  }
  applyStaticTranslations();
  updateMalaToggleButton();
  renderSplashSlotUI();
  renderToday();
  renderDataSafetyStatus();
  if (document.getElementById("sankalpa-page")?.classList.contains("open")) {
    renderSankalpaPage();
  }
  updateLanguagePickerSelection();
}
document.body.classList.add("bg-" + backgroundChoice);

// ---------- Splash Screen Rotation ----------
// Hanuman is a fixed, always-present default — not a "slot," never stored,
// never replaceable. Up to 4 additional slots hold the user's own pictures;
// whatever number are actually filled (0-4) rotates alongside Hanuman.
const SPLASH_DEFAULT_IMAGE = {
  id: "hanuman",
  webp: "splash/hanuman-splash.webp",
  png: "splash/hanuman-splash.png",
  alt: "Hanuman meditating",
};
const SPLASH_CUSTOM_SLOT_COUNT = 4;

// A slot's filled/empty state is just "does this key hold a valid data
// URL" — no separate metadata store to keep in sync.
function resolveSplashCustomSlots() {
  const slots = [];
  for (let i = 0; i < SPLASH_CUSTOM_SLOT_COUNT; i++) {
    let dataUrl = null;
    try {
      dataUrl = localStorage.getItem("splashImage:custom" + i);
    } catch (e) {
      dataUrl = null;
    }
    const filled = !!dataUrl && dataUrl.indexOf("data:image/") === 0;
    slots.push({ filled, dataUrl: filled ? dataUrl : null });
  }
  return slots;
}

function resolveSplashRotationPool() {
  const pool = [
    { id: SPLASH_DEFAULT_IMAGE.id, custom: false, webp: SPLASH_DEFAULT_IMAGE.webp, png: SPLASH_DEFAULT_IMAGE.png, alt: SPLASH_DEFAULT_IMAGE.alt },
  ];
  resolveSplashCustomSlots().forEach((slot, i) => {
    if (slot.filled) {
      pool.push({ id: "custom" + i, custom: true, dataUrl: slot.dataUrl, alt: "Your custom splash image" });
    }
  });
  return pool;
}

(function chooseSplashImage() {
  const pool = resolveSplashRotationPool();

  const lastId = localStorage.getItem("lastSplashImage");
  const candidates = pool.filter((r) => r.id !== lastId);
  const chosenFrom = candidates.length > 0 ? candidates : pool;
  const chosen = chosenFrom[Math.floor(Math.random() * chosenFrom.length)];

  const source = document.getElementById("splash-source");
  const img = document.getElementById("splash-img");
  if (chosen.custom) {
    // <source srcset> beats <img src> in a <picture> element, so it must be
    // cleared or the bundled webp would silently keep showing.
    if (source) source.removeAttribute("srcset");
    if (img) {
      img.src = chosen.dataUrl;
      img.alt = chosen.alt;
    }
  } else {
    if (source) source.srcset = chosen.webp;
    if (img) {
      img.src = chosen.png;
      img.alt = chosen.alt;
    }
  }

  localStorage.setItem("lastSplashImage", chosen.id);
})();

// ---------- Splash Screen Logic ----------
window.addEventListener("load", () => {
  const splash = document.getElementById("splash-screen");
  
  // Wait 2 seconds (2000ms) then fade out
  setTimeout(() => {
    if (splash) {
      splash.style.opacity = "0";
      
      // Remove from DOM after fade animation completes
      setTimeout(() => {
        splash.remove();
        document.body.classList.remove("loading");
      }, 500); 
    }
  }, 2000);
});

// Add 'loading' class to body immediately
document.body.classList.add("loading");
// ---------- Toast Notification ----------
function showToast(message = "Saved") {
  const existing = document.getElementById("toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "toast";
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.textContent = message;
  document.body.appendChild(toast);

  // Two rAF frames ensure the element is painted before adding the class
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.classList.add("toast-visible");
    });
  });

  setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// Page-wide falling petal celebration, triggered when a Today Card save
// crosses a new Crore boundary (see updateTodayEntry). Purely decorative —
// builds a batch of .petal-fly spans into #petal-overlay with randomized
// fall paths, then removes them once the longest one has finished.
// Tags each call's batch with an incrementing id so a still-animating
// batch's petals can't be wiped by a second, faster-finishing batch's own
// cleanup timeout — see the id check right before the clearing timeout
// below.
let celebrationBatchId = 0;

function celebrateMilestone() {
  const overlay = document.getElementById("petal-overlay");
  if (!overlay) return;

  const thisBatchId = ++celebrationBatchId;

  const PETAL_COUNT = 96;
  const MIN_DURATION = 4.5;
  const MAX_DURATION = 7.5;
  let maxDurationMs = 0;

  // Random horizontal drift (px) for one of a petal's 5 independent
  // waypoints — a real petal tumbling through the air changes direction
  // unpredictably, not in a neat mirrored left-right-left pattern.
  const randomSway = () => `${(Math.random() * 2 - 1) * (20 + Math.random() * 60)}px`;

  for (let i = 0; i < PETAL_COUNT; i++) {
    const petal = document.createElement("span");
    petal.className = "petal-fly " + (i % 2 === 0 ? "petal-rose" : "petal-marigold");

    const left = Math.random() * 100;
    const size = 7 + Math.random() * 6;
    const duration = MIN_DURATION + Math.random() * (MAX_DURATION - MIN_DURATION);
    const delay = Math.random() * 1.8;
    // Total rotation over the whole fall: random magnitude and direction,
    // so petals don't all spin the same way at the same rate.
    const spinDirection = Math.random() < 0.5 ? -1 : 1;
    const spin = spinDirection * (180 + Math.random() * 720);

    petal.style.setProperty("--petal-left", `${left}%`);
    petal.style.setProperty("--petal-size", `${size}px`);
    petal.style.setProperty("--fall-duration", `${duration}s`);
    petal.style.setProperty("--fall-delay", `${delay}s`);
    petal.style.setProperty("--spin", `${spin}deg`);
    petal.style.setProperty("--sway1", randomSway());
    petal.style.setProperty("--sway2", randomSway());
    petal.style.setProperty("--sway3", randomSway());
    petal.style.setProperty("--sway4", randomSway());
    petal.style.setProperty("--sway5", randomSway());

    overlay.appendChild(petal);
    maxDurationMs = Math.max(maxDurationMs, (duration + delay) * 1000);
  }

  setTimeout(() => {
    // Only clear if no later call has started a newer batch in the
    // meantime — otherwise this stale cleanup would wipe the newer batch's
    // still-animating petals mid-flight. The newer batch's own cleanup
    // timeout will clear everything once it finishes.
    if (thisBatchId === celebrationBatchId) {
      overlay.innerHTML = "";
    }
  }, maxDurationMs + 200);
}

// ---------- Utilities ----------

// Format YYYY-MM-DD → "D MMM YYYY" (e.g. "12 Apr 2026")
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function formatDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

// Format YYYY-MM-DD → "Weekday, D Month YYYY" (e.g. "Thursday, 6 August 2026")
// Today Card only — every other date display keeps the shorter formatDate().
// Hand-rolled (not toLocaleDateString) to stay deterministic across devices/locales.
const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function formatDateLong(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const dayIndex = new Date(year, month - 1, day).getDay();
  const weekdays = (TRANSLATIONS && TRANSLATIONS.datesWeekdaysFull && TRANSLATIONS.datesWeekdaysFull[getEffectiveLang()]) || WEEKDAYS;
  const months = (TRANSLATIONS && TRANSLATIONS.datesMonthsFull && TRANSLATIONS.datesMonthsFull[getEffectiveLang()]) || MONTHS_FULL;
  return `${weekdays[dayIndex]}, ${day} ${months[month - 1]} ${year}`;
}

// ---------- Sumiran-Lite: shared constants & helpers ----------

const CRORE = 10_000_000;
const MALA_SIZE = 108;

// Indian digit grouping, e.g. 6500000 -> "65,00,000"
function formatIndianNumber(n) {
  if (n === null || n === undefined || isNaN(n)) return "0";
  const isNeg = n < 0;
  n = Math.trunc(Math.abs(n));
  const s = String(n);
  if (s.length <= 3) return (isNeg ? "-" : "") + s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return (isNeg ? "-" : "") + rest + "," + last3;
}

// Always floors — 602.4 malas becomes 602, never rounds up.
function jaapToMala(jaap) {
  return Math.floor(jaap / MALA_SIZE);
}

function malaToJaap(malas) {
  return malas * MALA_SIZE;
}

// Pure formatting — never mutates stored data. The "mala" unit word is
// translated (commonMalaUnit) — it was previously a hardcoded English
// literal, so every mala total (Reflection Summary, Ledger List, per-row
// counts) stayed in English even in Hindi/Bangla mode while the
// surrounding labels around it were correctly localized.
function formatAsMala(jaap) {
  return `${formatIndianNumber(jaapToMala(jaap))} ${t("commonMalaUnit")}`;
}

// Shared by every jaap-count total shown in the UI (Reflection Summary's
// lifetime/yearly totals and pace predictions, the Ledger List's per-year
// total) — respects Mala View, unlike a bare toLocaleString() call, which
// would silently ignore it and fall back to locale-default (not Indian)
// digit grouping.
function formatTotal(n) {
  return malaViewEnabled ? formatAsMala(n) : formatIndianNumber(n);
}

// Add/subtract calendar days from an ISO date, local time
function addDaysISO(dateISO, delta) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return dt.getFullYear() + "-" +
    String(dt.getMonth() + 1).padStart(2, "0") + "-" +
    String(dt.getDate()).padStart(2, "0");
}

// Escape user text before inserting into innerHTML
function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// Get today's date in YYYY-MM-DD (local)
function getTodayISO() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Check if a date (YYYY-MM-DD) is a Sunday
function isSunday(dateISO) {
  const [year, month, day] = dateISO.split("-").map(Number);
  const date = new Date(year, month - 1, day); // LOCAL date
  return date.getDay() === 0; // 0 = Sunday
}

// Pure predicate for the Sunday Drive-backup reminder: show only on a
// Sunday whose date doesn't already match the last shown/dismissed/
// completed date. Naturally self-resolves to "next Sunday" with no extra
// date math, since Sundays are 7 days apart and lastPromptDateISO only
// ever matches the *current* day once it's been handled.
function shouldShowSundayBackupReminder(dateISO, lastPromptDateISO) {
  return isSunday(dateISO) && lastPromptDateISO !== dateISO;
}

// Calculate cumulative jaap up to a given date (inclusive)
function getCumulativeJaapUpTo(dateISO) {
  return ledgerData
    .filter(e => e.date <= dateISO)
    .reduce((sum, e) => sum + (e.jaap || 0), 0);
}
// Check if a given date completes a crore milestone
function getCroreMilestone(dateISO) {
  const dates = ledgerData
    .map(e => e.date)
    .filter(d => d <= dateISO)
    .sort();

  const index = dates.indexOf(dateISO);
  if (index === -1) return null;

  const prevDate = index > 0 ? dates[index - 1] : null;

  const prevTotal = prevDate ? getCumulativeJaapUpTo(prevDate) : 0;
  const currentTotal = getCumulativeJaapUpTo(dateISO);

  const prevCrore = Math.floor(prevTotal / CRORE);
  const currentCrore = Math.floor(currentTotal / CRORE);

  if (currentCrore > prevCrore) {
    return currentCrore;
  }

  return null;
}

// ---------- Sumiran-Lite: Milestone Tracking + Predictions ----------

// Which Crore bracket the lifetime total currently sits in (0-indexed count of Crores fully completed).
function getCurrentMilestone(total) {
  return Math.floor(total / CRORE);
}

// Percentage progress within the current (in-progress) Crore. Exact multiples of
// CRORE naturally yield 0 here (start of the next bracket), not 100.
function getMilestoneProgress(total) {
  return ((total % CRORE) / CRORE) * 100;
}

// Every Crore boundary crossed, in order, with the date crossed and days since the previous milestone.
function getMilestoneHistory(entries) {
  const milestones = [];

  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));

  let lastCrore = 0;
  let lastMilestoneDate = null;
  let running = 0;

  sorted.forEach(entry => {
    running += entry.jaap || 0;
    const currentCrore = getCurrentMilestone(running);

    if (currentCrore > lastCrore) {
      let daysSincePrevious = null;

      if (lastMilestoneDate) {
        const prev = new Date(lastMilestoneDate);
        const curr = new Date(entry.date);
        daysSincePrevious = Math.round((curr - prev) / (1000 * 60 * 60 * 24));
      }

      milestones.push({
        crore: currentCrore,
        date: entry.date,
        daysSincePrevious
      });

      lastCrore = currentCrore;
      lastMilestoneDate = entry.date;
    }
  });

  return milestones;
}

// Sum of non-null jaap values (and count of days with recorded practice) within an inclusive date range.
function sumJaapInRange(entries, startISO, endISO) {
  let sum = 0;
  let count = 0;

  entries.forEach(e => {
    if (e.date >= startISO && e.date <= endISO && e.jaap !== null && e.jaap !== undefined) {
      sum += e.jaap;
      count++;
    }
  });

  return { sum, count };
}

// Shared by both prediction functions: project a daily pace forward to the next Crore boundary.
function projectMilestoneFromPace(entries, dailyPace) {
  if (!dailyPace || dailyPace <= 0) return null;

  const total = entries.reduce((s, e) => s + (e.jaap || 0), 0);
  const nextTarget = (getCurrentMilestone(total) + 1) * CRORE;
  const remaining = nextTarget - total;
  const daysNeeded = Math.ceil(remaining / dailyPace);

  return {
    predictedDate: addDaysISO(getTodayISO(), daysNeeded),
    dailyPace
  };
}

// 30-day rolling pace: average daily jaap over the last 30 calendar days ending today,
// divided by the number of days in that window with recorded (non-null) practice —
// not a flat /30 — so long gaps don't artificially deflate pace. Same divisor
// convention as predictNextMilestoneYTD, for consistency.
function predictNextMilestone(entries) {
  const today = getTodayISO();
  const startISO = addDaysISO(today, -29);
  const { sum, count } = sumJaapInRange(entries, startISO, today);

  if (count === 0) return null;
  return projectMilestoneFromPace(entries, sum / count);
}

// Year-to-date pace: only computed once 30+ non-null entries exist in the current calendar year.
function predictNextMilestoneYTD(entries) {
  const today = getTodayISO();
  const yearStart = today.slice(0, 4) + "-01-01";
  const { sum, count } = sumJaapInRange(entries, yearStart, today);

  if (count < 30) return null;
  return projectMilestoneFromPace(entries, sum / count);
}

// ---------- Sumiran-Lite: Ledger Row Sparkline ----------

function buildDateJaapMap(entries) {
  const map = new Map();
  entries.forEach(e => {
    if (e.jaap !== null && e.jaap !== undefined) {
      map.set(e.date, e.jaap);
    }
  });
  return map;
}

// Rolling 7-day window (D-6..D) for a given row date. Missing/null days are skipped, never treated as zero.
function getRollingWindowFromMap(dateJaapMap, targetDate) {
  const points = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDaysISO(targetDate, -i);
    if (dateJaapMap.has(d)) {
      points.push({ date: d, jaap: dateJaapMap.get(d) });
    }
  }
  return points;
}

// Pure, independently testable wrapper matching the spec API — builds its own lookup.
// Production rendering uses getRollingWindowFromMap directly with a precomputed map
// to avoid rebuilding it per row.
function getRollingWindow(allEntries, targetDate) {
  return getRollingWindowFromMap(buildDateJaapMap(allEntries), targetDate);
}

function renderSparklineSVG(points) {
  if (!points || points.length === 0) return "";

  const width = 72, height = 28, pad = 3;
  const usable = height - pad * 2;
  // Horizontal padding must clear the endpoint dot's radius (3px, see the
  // <circle> below) on both sides, or the last point's dot bleeds past the
  // viewBox and gets clipped by the SVG's own edge — previously only 2px,
  // 1px short of the 3px radius.
  const padX = 4;
  const usableX = width - padX * 2;
  const n = points.length;
  const values = points.map(p => p.jaap);
  const lo = Math.min(...values);
  const hi = Math.max(...values);

  const coords = points.map((p, i) => {
    const x = n === 1 ? width / 2 : padX + i * (usableX / (n - 1));
    const y = hi === lo ? height / 2 : pad + ((hi - p.jaap) / (hi - lo)) * usable;
    return { x, y };
  });

  const polyline = coords.map(c => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(" ");
  const last = coords[coords.length - 1];

  return `<svg class="sparkline" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    (n > 1 ? `<polyline points="${polyline}" fill="none" stroke="#C9A227" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : "") +
    `<circle cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="3" fill="#9C7A17"/>` +
    `</svg>`;
}


// Check if Poornima is explicitly mentioned in notes
function hasExplicitPoornima(notes) {
  if (!notes) return false;
  const lower = notes.toLowerCase();
  return notes.includes("पूर्णिमा") || notes.includes("পূর্ণিমা") || lower.includes("poornima") || lower.includes("purnima");
}

// Check if a date is within the last N days (inclusive)
function isWithinLastNDays(dateISO, days) {
  const today = new Date(getTodayISO());
  const entryDate = new Date(dateISO);

  const diffTime = today - entryDate;
  const diffDays = diffTime / (1000 * 60 * 60 * 24);

  return diffDays >= 0 && diffDays <= days;
}

function getYearlyTotals() {
  const totals = {};

  ledgerData.forEach(entry => {
    if (!entry.jaap) return;

    const year = entry.date.slice(0, 4);
    totals[year] = (totals[year] || 0) + entry.jaap;
  });

  return totals;
}

function getCumulativeTotal() {
  return ledgerData.reduce((sum, e) => sum + (e.jaap || 0), 0);
}

function ensureTodayEntryExists() {
  let entry = ledgerData.find(e => e.date === todayISO);

  if (!entry) {
    entry = {
      date: todayISO,
      jaap: null,
      notes: ""
    };
    ledgerData.push(entry);
    // In-memory only — not persisted to IndexedDB until the user actually
    // enters a value and saves (via updateTodayEntry()).
  }

  return entry;
}

function ensureRecentEntriesExist(days = 7) {
  const existingDates = new Set(ledgerData.map(e => e.date));
  const today = getTodayISO();

  for (let i = 0; i < days; i++) {
    const iso = addDaysISO(today, -i);

    if (!existingDates.has(iso)) {
      ledgerData.push({
        date: iso,
        jaap: null,
        notes: ""
      });
    }
  }
}		

function isEditableEntry(dateISO) {
  return dateISO === todayISO || isWithinLastNDays(dateISO, 7);
}

async function loadLedgerFromDB() {
  const db = await openDB();

  // 1️⃣ Try main ledger store
  const ledgerTx = db.transaction(STORE_NAME, "readonly");
  const ledgerStore = ledgerTx.objectStore(STORE_NAME);

  const ledger = await new Promise(resolve => {
    const req = ledgerStore.get("entries");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });

  if (ledger && Array.isArray(ledger)) {
    return ledger;
  }

  // 2️⃣ Fallback: latest automatic backup
  console.warn("Ledger missing — attempting recovery from backup");

  const backupTx = db.transaction(BACKUP_STORE, "readonly");
  const backupStore = backupTx.objectStore(BACKUP_STORE);

  const backup = await new Promise(resolve => {
    const req = backupStore.get("latest");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });

  if (backup && Array.isArray(backup.entries)) {
    await saveLedger(backup.entries);
    return backup.entries;
  }

  // 3️⃣ Final fallback: empty ledger
  console.warn("No ledger or backup found — starting empty");
  return [];
}

function groupEntriesByYear(entries) {
  const grouped = {};

  entries.forEach(entry => {
    const year = entry.date.slice(0, 4);
    if (!grouped[year]) {
      grouped[year] = [];
    }
    grouped[year].push(entry);
  });

  // Sort years descending
  Object.keys(grouped).forEach(year => {
    grouped[year].sort((a, b) => b.date.localeCompare(a.date));
  });

  return Object.keys(grouped)
    .sort((a, b) => b - a)
    .reduce((acc, year) => {
      acc[year] = grouped[year];
      return acc;
    }, {});
}


// Refreshed at the top of every renderToday() call (the app's single
// re-render entry point) rather than only once at script load, so a tab
// left open across midnight doesn't drift out of sync with the real date.
let todayISO = getTodayISO();

// ---------- IndexedDB Storage ----------

const DB_NAME = "jaap-ledger-db";
const STORE_NAME = "ledger";
const BACKUP_STORE = "ledger-backups";
const META_STORE = "meta";            // 👈 ADD
const SANKALPA_STORE = "sankalpa";
const DB_VERSION = 4;                 // 👈 BUMP version


function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }

      if (!db.objectStoreNames.contains(BACKUP_STORE)) {
        db.createObjectStore(BACKUP_STORE);
      }
	  if (!db.objectStoreNames.contains(META_STORE)) {
		db.createObjectStore(META_STORE);
	}
	  if (!db.objectStoreNames.contains(SANKALPA_STORE)) {
		db.createObjectStore(SANKALPA_STORE);
	}

    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveLedger(data) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  await store.put(data, "entries");
}



// ---------- State ----------
let ledgerData = [];
// True once initApp()'s own initial load+save sequence has fully completed.
// Restore-from-backup and Import both replace ledgerData wholesale and are
// reachable (their listeners are wired at top-level script scope) before
// that sequence finishes — without this guard, a fast user action right at
// cold launch could let initApp()'s own pending saveLedger() call (holding
// data captured before the restore/import) run afterward and silently
// overwrite the just-restored/imported ledger.
let appReady = false;
// Display preference only — never mutates stored ledger data. Persisted in
// localStorage (same tier as other display preferences), not IndexedDB.
let malaViewEnabled = localStorage.getItem("malaViewEnabled") === "true";

// ---------- Sumiran-Lite: Sankalpa storage ----------

async function getSankalpa() {
  const db = await openDB();
  const tx = db.transaction(SANKALPA_STORE, "readonly");
  const store = tx.objectStore(SANKALPA_STORE);

  return new Promise(resolve => {
    const req = store.get("primary");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

// Always writes with id = 'primary' — upsert, never insert — so only one Sankalpa ever exists.
async function saveSankalpa({ text, context, date }) {
  const db = await openDB();
  const tx = db.transaction(SANKALPA_STORE, "readwrite");
  const store = tx.objectStore(SANKALPA_STORE);

  return new Promise((resolve, reject) => {
    store.put({ id: "primary", text, context, date }, "primary");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Sumiran-Lite: Mala View input helpers ----------

// Shared jaap-count input markup for Today Card and editable ledger rows.
// Switches label/mode based on the current Mala View toggle state.
function renderJaapInputField(entry, opts = {}) {
  const idAttr = opts.id ? ` id="${opts.id}"` : "";
  const className = opts.className || "edit-jaap";

  if (malaViewEnabled) {
    const malaValue = entry.jaap == null ? "" : jaapToMala(entry.jaap);
    return `
      <label>
        ${t("todayMalaLabel")}<br>
        <input type="number" step="1"${idAttr} class="${className}" value="${malaValue}" placeholder="${t("todayMalaPlaceholder")}">
      </label>
    `;
  }

  return `
    <label>
      ${t("todayJaapLabel")}<br>
      <input type="number"${idAttr} class="${className}" value="${entry.jaap ?? ""}" placeholder="${t("todayJaapPlaceholder")}">
    </label>
  `;
}

// Converts a raw input string back into a jaap count for storage, honoring the
// active input mode. In Mala View, applies the precision guard: if the user left
// the (floored) mala value unchanged and the original jaap was a legacy fractional
// mala entry (not an exact multiple of 108), the original jaap is preserved exactly
// rather than being truncated to malaInput * 108.
function computeJaapFromInput(rawValue, originalJaap) {
  if (rawValue === "" || rawValue === null || rawValue === undefined) return null;
  if (!malaViewEnabled) return Number(rawValue);

  const malaInput = Math.trunc(Number(rawValue));
  const originalMalaFloored = originalJaap == null ? null : jaapToMala(originalJaap);
  const unchanged = originalMalaFloored !== null && malaInput === originalMalaFloored;
  const isLegacyFractional = originalJaap != null && originalJaap % MALA_SIZE !== 0;

  if (unchanged && isLegacyFractional) {
    return originalJaap;
  }

  return malaToJaap(malaInput);
}

// A null jaap (no entry) is always valid; anything else must be a finite,
// non-negative number. Number(rawValue) in computeJaapFromInput() returns
// NaN for garbage input (e.g. a stray non-numeric value slipping past the
// browser's own <input type="number"> validation) with nothing downstream
// to catch it — an unguarded NaN silently poisons every sum that touches
// it (lifetime/yearly totals, milestone %, pace predictions) once written
// to IndexedDB. Call sites must check this before persisting entry.jaap.
function isValidJaapValue(value) {
  return value === null || (Number.isFinite(value) && value >= 0);
}

function updateMalaToggleButton() {
  const input = document.getElementById("mala-toggle");
  if (!input) return;
  input.checked = malaViewEnabled;
  input.title = malaViewEnabled ? t("malaViewOn") : t("malaViewOff");

  const wrap = document.getElementById("mala-toggle-wrap");
  if (wrap) wrap.classList.toggle("mala-view-on", malaViewEnabled);
}

function updateBackgroundSwatchButtons() {
  document.querySelectorAll(".background-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.bg === backgroundChoice);
  });
}
// ---------- Load ledger ----------
(async function initApp() {
  try {
	  
	// Best-effort persistence request, but the answer is now kept and
	// surfaced in Settings — if the browser denied it, the OS can evict the
	// entire ledger under storage pressure, which the user deserves to know.
	await refreshStoragePersistenceState();

    await loadTranslations();

    // renderSplashSlotUI() and updateMalaToggleButton() already ran once,
    // synchronously, before this await resolved — refresh them now that
    // TRANSLATIONS is actually populated, along with every static
    // data-i18n-marked element in the Settings drawer / Sunday modal.
    applyStaticTranslations();
    updateMalaToggleButton();
    renderSplashSlotUI();
    updateLanguagePickerSelection();
    renderDataSafetyStatus();

    // The splash screen's own <img alt> was set synchronously by the
    // chooseSplashImage() IIFE at the very top of this file, long before
    // translations could have loaded — correct it now, in the (typical)
    // case where the splash is still on screen. lastSplashImage records
    // which image was actually chosen ("hanuman" or "customN").
    const splashImgEl = document.getElementById("splash-img");
    if (splashImgEl) {
      const lastSplashId = localStorage.getItem("lastSplashImage");
      const splashAltKey = lastSplashId && lastSplashId !== "hanuman" ? "splashCustomAlt" : "splashHanumanAlt";
      // Only overwrite if a real translation exists — the element's current
      // alt is already correct English (baked into SPLASH_DEFAULT_IMAGE /
      // the custom-pool literal), so leave it alone rather than replacing
      // it with t()'s raw-key fallback if TRANSLATIONS never loaded.
      if (hasTranslation(splashAltKey)) splashImgEl.alt = t(splashAltKey);
    }

    // Load ledger ONLY from IndexedDB — a fresh/empty ledger always starts
    // blank, never seeded from data.json (that file is a local-testing
    // fixture only, not real seed data for new users).
    const existingLedger = await loadLedgerFromDB();
    ledgerData = existingLedger && existingLedger.length > 0 ? existingLedger : [];

// Fix to ensure last 7 days always exists
ensureRecentEntriesExist(7);

//Persist only if we added something
await saveLedger(ledgerData);
await saveAutomaticBackup(ledgerData);
appReady = true;

    renderToday();

    // Checked once at app-open, not inside renderToday() itself (which also
    // runs after every save) — the reminder is an app-open event, not a
    // re-render event.
    if (shouldShowSundayBackupReminder(todayISO, localStorage.getItem("lastSundayBackupPromptDate"))) {
      openSundayBackupModal();
    }

    // First-run only — once a language is chosen (even explicitly English),
    // this is skipped on every subsequent load.
    if (!currentAppLanguage) {
      showLanguagePicker();
    }

  } catch (err) {
    console.error("Initialization failed:", err);
  }
})();

// todayISO is only refreshed at the top of renderToday() — a tab left open
// (or a backgrounded PWA left running) across midnight with no save/toggle/
// language-switch action in between would keep showing yesterday's date on
// the Today Card until some other action happened to trigger a re-render.
// Catch that by refreshing whenever the app is brought back to the
// foreground, which is exactly when a phone user re-opening the app across
// a day boundary would notice the staleness.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && getTodayISO() !== todayISO) {
    renderToday();
  }
});

// visibilitychange only fires on a background<->foreground *transition* —
// a screen that stays continuously on and visible (no app-switch, no lock)
// spanning a local midnight rollover never triggers it, so todayISO could
// stay stale indefinitely on a device left open and awake. A low-frequency
// interval catches that remaining case; the display self-corrects within
// this interval even with zero user interaction. (updateTodayEntry() also
// independently re-syncs todayISO immediately before acting, so a save
// itself is never at risk of writing to the wrong day even in the window
// before this interval next fires — see its own comment.)
setInterval(() => {
  if (document.visibilityState === "visible" && getTodayISO() !== todayISO) {
    renderToday();
  }
}, 60000);

async function saveAutomaticBackup(data) {
  // Captured before the backup transaction opens (a separate store, so a
  // separate transaction) — the Sankalpa previously had no backup coverage
  // at all, meaning a restore silently resurrected the ledger but not the
  // user's vow.
  const sankalpa = sanitizeSankalpaForExport(await getSankalpa());
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_STORE, "readwrite");
    const store = tx.objectStore(BACKUP_STORE);

    const payload = {
      backedUpAt: new Date().toISOString(),
      entries: data,
      sankalpa
    };

    store.put(payload, "latest");

    tx.oncomplete = () => {
      resolve();
    };

    tx.onerror = () => {
      console.error("Backup transaction failed", tx.error);
      reject(tx.error);
    };
  });
}


async function loadLatestBackup() {
  const db = await openDB();
  const tx = db.transaction(BACKUP_STORE, "readonly");
  const store = tx.objectStore(BACKUP_STORE);

  return new Promise((resolve) => {
    const req = store.get("latest");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function restoreFromBackup() {
  if (!appReady) {
    showToast(t("appNotReadyYet"));
    return;
  }

  const backup = await loadLatestBackup();

  if (!backup || !backup.entries) {
    alert(t("ledgerNoBackupFound"));
    return;
  }

  const confirmRestore = confirm(
    t("ledgerRestoreConfirm", {
      date: new Date(backup.backedUpAt).toLocaleString(),
      count: backup.entries.length,
    })
  );

  if (!confirmRestore) return;

  ledgerData = backup.entries;

  await saveLedger(ledgerData);

  // Older backups (taken before the Sankalpa was covered) have no sankalpa
  // field — restoring one must leave the user's current vow alone rather
  // than wiping it.
  if (backup.sankalpa) {
    await saveSankalpa(backup.sankalpa);
  }

  alert(t("ledgerRestoreSuccess"));

  renderToday();
}


// ---------- Data safety status (Settings drawer) ----------
// Two silent risks made visible, informationally — not as nagging prompts.

// null = unknown or unsupported by this browser; true/false = the real
// answer from navigator.storage.persisted(). Kept module-level so the
// (async) query runs once at bootstrap and every later re-render — e.g. a
// language switch — can render from it synchronously.
let storageIsPersistent = null;

async function refreshStoragePersistenceState() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      // Requesting is idempotent — an already-granted origin simply returns
      // true again — so this stays a best-effort ask, as before. The change
      // is that we now read the result back instead of discarding it.
      await navigator.storage.persist();
    }
    if (navigator.storage && navigator.storage.persisted) {
      storageIsPersistent = await navigator.storage.persisted();
    }
  } catch (e) {
    console.warn("Could not determine storage persistence:", e);
    storageIsPersistent = null;
  }
}

// Whole days between two ISO dates. Both parse as UTC midnight, so the
// arithmetic is clean — same approach as isWithinLastNDays().
function daysSinceDateISO(dateISO, referenceISO) {
  const then = new Date(dateISO);
  const now = new Date(referenceISO);
  return Math.round((now - then) / (1000 * 60 * 60 * 24));
}

function describeLastDriveBackup(lastBackupAtISO, referenceISO) {
  if (!lastBackupAtISO) return t("backupStatusNever");
  const days = daysSinceDateISO(lastBackupAtISO.slice(0, 10), referenceISO);
  if (days <= 0) return t("backupStatusToday");
  if (days === 1) return t("backupStatusYesterday");
  return t("backupStatusDaysAgo", { days });
}

function renderDataSafetyStatus() {
  const driveEl = document.getElementById("drive-backup-status");
  if (driveEl) {
    driveEl.textContent = describeLastDriveBackup(
      localStorage.getItem("lastDriveBackupAt"),
      todayISO
    );
  }

  const storageEl = document.getElementById("storage-status");
  if (storageEl) {
    if (storageIsPersistent === true) {
      storageEl.textContent = t("storageStatusProtected");
      storageEl.classList.remove("maintenance-status-warn");
    } else if (storageIsPersistent === false) {
      storageEl.textContent = t("storageStatusAtRisk");
      storageEl.classList.add("maintenance-status-warn");
    } else {
      // Unknown/unsupported — say nothing rather than guess at the user's risk.
      storageEl.textContent = "";
      storageEl.classList.remove("maintenance-status-warn");
    }
  }
}

// ---------- Rendering ----------
function renderToday() {
  todayISO = getTodayISO();
  const entry = ensureTodayEntryExists();
  // Computed once here and threaded through — renderReflectionSummary() and
  // renderLedgerList() previously each called getMilestoneHistory(ledgerData)
  // independently (same input, same O(n log n) result, computed twice per
  // render pass).
  const milestoneHistory = getMilestoneHistory(ledgerData);
  renderTodayCard(entry);
  renderReflectionSummary(milestoneHistory);
  renderLedgerList(milestoneHistory);
}


function renderReflectionSummary(milestoneHistory) {
  const container = document.getElementById("reflection-summary");

  const yearlyTotals = getYearlyTotals();
  const CURRENT_YEAR = getTodayISO().slice(0, 4);
  const currentYearTotal = yearlyTotals[CURRENT_YEAR] || 0;
  const cumulative = getCumulativeTotal();

  const currentCrore = getCurrentMilestone(cumulative);
  const progressInCrore = cumulative - currentCrore * CRORE;
  const percent = Math.floor(getMilestoneProgress(cumulative));

  const pred30 = predictNextMilestone(ledgerData);
  const predYTD = predictNextMilestoneYTD(ledgerData);

  // Lifetime/yearly totals respect Mala View (via the shared formatTotal());
  // Crore/progress numbers stay in jaap terms (Crore is the domain unit for
  // milestones, not malas — per spec §4.5).

  container.innerHTML = `
    <div class="reflection-box">

      <div class="reflection-line">
        <strong>${t("reflectionLifetimeJaap")}</strong>
        ${formatTotal(cumulative)}
      </div>

	<div class="reflection-line">
  <strong>${t("reflectionYearTotal", { year: CURRENT_YEAR })}</strong>
  ${formatTotal(currentYearTotal)}
</div>

      <div class="reflection-line">
        <strong>${t("reflectionNextMilestone")}</strong> ${currentCrore + 1} ${t("commonCroreWord")}
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width: ${percent}%"></div>
      </div>
      <div class="progress-label">
        ${percent}% &nbsp;·&nbsp; ${formatIndianNumber(progressInCrore)} / ${formatIndianNumber(CRORE)}
      </div>

      ${pred30 || predYTD ? `
  <div class="reflection-predictions">
    ${pred30 ? `
      <div class="reflection-line prediction-line">
        <strong>${t("reflectionPace30Day")}</strong> ${formatDate(pred30.predictedDate)}
        <span class="prediction-pace">(${formatTotal(Math.round(pred30.dailyPace))}${t("commonPerDaySuffix")})</span>
      </div>
    ` : ""}
    ${predYTD ? `
      <div class="reflection-line prediction-line">
        <strong>${t("reflectionPaceYTD")}</strong> ${formatDate(predYTD.predictedDate)}
        <span class="prediction-pace">(${formatTotal(Math.round(predYTD.dailyPace))}${t("commonPerDaySuffix")})</span>
      </div>
    ` : ""}
  </div>
` : ""}

	  ${milestoneHistory.length > 0 ? `
  <div class="reflection-milestones">
    <div class="reflection-subtitle">${t("reflectionMilestonesHeading")}</div>
    ${milestoneHistory.map(m => `
      <div class="milestone-line">
        ${t("reflectionMilestoneLine", { crore: m.crore, date: formatDate(m.date) })}
        ${m.daysSincePrevious !== null
          ? `<span class="milestone-gap">${t("reflectionDaysSince", { days: m.daysSincePrevious })}</span>`
          : ""}
      </div>
    `).join("")}
  </div>
` : ""}

	  <div class="legend">
  ${t("reflectionLegend")}
</div>

    </div>
  `;
}


// Builds and appends every row for one year into yearContainer, wiring up
// each row's save/chevron handlers. Factored out of renderLedgerList() so
// it can be called either eagerly (the current, expanded-by-default year)
// or lazily (any other year, only once the user actually expands it or
// jumps to it) — see the "lazy year build" note on renderLedgerList()
// itself for why this split exists.
function buildYearRows(yearContainer, entries, { sparklineMap, milestoneByDate }) {
  entries.forEach(entry => {
    const row = document.createElement("div");
    row.className = "ledger-row";

    if (isSunday(entry.date)) {
      row.classList.add("sunday");
    }

    // Suppress today's sparkline until today's own jaap has been entered and
    // saved — otherwise it renders a (correctly spec'd) trend from the prior
    // 6 days alone, which reads as misleading before today's practice is logged.
    const isUnsavedToday = entry.date === todayISO && (entry.jaap === null || entry.jaap === undefined);
    const sparklinePoints = getRollingWindowFromMap(sparklineMap, entry.date);
    const sparklineHTML = isUnsavedToday ? "" : renderSparklineSVG(sparklinePoints);
    const crossedCrore = milestoneByDate.get(entry.date) || null;

    row.innerHTML = `
      <div class="ledger-main">
        <span class="ledger-chevron">▸</span>

        <span class="ledger-date">
          ${formatDate(entry.date)}
          ${crossedCrore ? " 🏵️" : ""}
          ${hasExplicitPoornima(entry.notes) ? " 🌕" : ""}
        </span>

        <span class="ledger-jaap">${entry.jaap == null ? "—" : (malaViewEnabled ? formatAsMala(entry.jaap) : entry.jaap)}</span>

        <span class="ledger-sparkline">${sparklineHTML}</span>
      </div>

      <div class="ledger-notes">
        ${
          crossedCrore
            ? `<div class="milestone">
                 ${t("ledgerListMilestoneBadge", { crore: crossedCrore })}
               </div>`
            : ""
        }

        ${
          isEditableEntry(entry.date)
            ? `
              ${renderJaapInputField(entry)}

              <br><br>

              <label>
                ${t("commonNotesLabel")}<br>
                <textarea class="edit-notes" rows="3">${escapeHTML(entry.notes || "")}</textarea>
              </label>

              <br>

              <button class="save-entry">${t("ledgerListUpdateBtn")}</button>
            `
            : `
              ${entry.notes ? escapeHTML(entry.notes) : `<em>${t("ledgerListNoNotes")}</em>`}
              <div class="locked-note">${t("ledgerListEntryLocked")}</div>
            `
        }
      </div>
    `;

    const saveBtn = row.querySelector(".save-entry");
    if (saveBtn) {
      saveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();

        const jaapInput = row.querySelector(".edit-jaap").value;
        const notesInput = row.querySelector(".edit-notes").value;

        const newJaap = computeJaapFromInput(jaapInput, entry.jaap);
        if (!isValidJaapValue(newJaap)) {
          showToast(t("commonInvalidNumber"));
          return;
        }

        entry.jaap = newJaap;
        entry.notes = notesInput;

        // Editing a backdated (within-7-day) entry can cross a Crore boundary
        // just as saving today's entry can — previously only the Today Card
        // path checked this, so the same milestone crossing via a Ledger row
        // silently skipped the petal celebration.
        const crossedNewMilestone = getCroreMilestone(entry.date);

        await saveLedger(ledgerData);
        await saveAutomaticBackup(ledgerData);
        renderToday();
        showToast(t("commonSavedToast"));

        if (crossedNewMilestone) {
          celebrateMilestone();
        }
      });
    }

    const chevron = row.querySelector(".ledger-chevron");
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();

      const expanded = row.classList.contains("expanded");

      // Collapse all rows — CSS handles the chevron rotation via .expanded
      document.querySelectorAll(".ledger-row").forEach(r => {
        r.classList.remove("expanded");
      });

      if (!expanded) {
        row.classList.add("expanded");
      }
    });

    yearContainer.appendChild(row);
  });
}

// Rebuilds on every renderToday() call (save, mala toggle, language switch,
// etc.), but only ever eagerly builds row DOM + listeners for the current
// (expanded-by-default) year — other years' containers are created empty
// and marked data-built="false", with their rows built on first expand
// (year-header click or jump-to-year) and cached from then on for this
// render pass. Previously every year was fully built on every single call
// regardless of visibility, which meant a one-row save on a ledger with
// years of daily history rebuilt thousands of already-hidden DOM nodes and
// re-attached thousands of listeners just to update the one row that
// changed.
function renderLedgerList(milestoneHistory) {
  const container = document.getElementById("ledger-list");
  // Uses the module-level todayISO (refreshed at the top of renderToday()) —
  // previously this shadowed it with its own fresh copy, which meant Today
  // Card (stale) and the Ledger List (fresh) could silently disagree about
  // what "today" was after a midnight rollover in a long-lived tab.
  const CURRENT_YEAR = todayISO.slice(0, 4);

  const filtered = ledgerData.filter(entry => entry.date <= todayISO);
  const groupedByYear = groupEntriesByYear(filtered);
  const years = Object.keys(groupedByYear).sort((a, b) => b - a);

  // Precompute once so each row's sparkline is an O(1) lookup instead of an O(n) scan.
  const sparklineMap = buildDateJaapMap(ledgerData);
  // Same idea for milestone crossings: getCroreMilestone() re-derives the
  // whole milestone history from scratch on every call (O(n log n)), and
  // was previously called 3x per row — O(n^2 log n) just to render the
  // markers. milestoneHistory is computed once per renderToday() pass (by
  // the caller, shared with renderReflectionSummary()) — build a lookup
  // once here and reuse it per row.
  const milestoneByDate = new Map(milestoneHistory.map(m => [m.date, m.crore]));
  const rowDeps = { sparklineMap, milestoneByDate };

  container.innerHTML = "";

  // Jump-to-year selector
  const jumpBar = document.createElement("div");
  jumpBar.className = "jump-bar";
  jumpBar.innerHTML = `
    <label class="jump-label" for="jump-year">${t("ledgerListJumpToYear")}</label>
    <select id="jump-year" class="jump-select">
      <option value="">${t("ledgerListSelectPlaceholder")}</option>
      ${years.map(y => `<option value="${y}">${y}</option>`).join("")}
    </select>
  `;
  container.appendChild(jumpBar);

  jumpBar.querySelector("#jump-year").addEventListener("change", (e) => {
    const target = e.target.value;
    if (!target) return;

    // Collapse all, expand only the target year
    container.querySelectorAll(".ledger-year-container").forEach(c => {
      c.style.display = "none";
    });
    container.querySelectorAll(".year-chevron").forEach(ch => {
      ch.textContent = "▸";
    });

    const targetHeader = container.querySelector(`[data-year="${target}"]`);
    if (targetHeader) {
      const targetContainer = targetHeader.nextElementSibling;
      if (targetContainer.dataset.built === "false") {
        buildYearRows(targetContainer, groupedByYear[target], rowDeps);
        targetContainer.dataset.built = "true";
      }
      targetContainer.style.display = "block";
      targetHeader.querySelector(".year-chevron").textContent = "▾";
      targetHeader.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // Reset select back to placeholder so it can be re-used
    e.target.value = "";
  });

  years.forEach(year => {
    const isCurrentYear = year === CURRENT_YEAR;

    const yearHeader = document.createElement("div");
    yearHeader.className = "ledger-year-header";
    yearHeader.dataset.year = year;

    // formatTotal(), not a bare toLocaleString() — the latter ignores Mala
    // View (always showed raw jaap even when every row underneath read "X
    // mala") and uses the browser's default locale grouping instead of the
    // Indian digit grouping every other total in the app uses.
    const yearTotal = formatTotal(
      groupedByYear[year].reduce((sum, e) => sum + (e.jaap || 0), 0)
    );

    yearHeader.innerHTML = `
      <span class="year-left">
        <span class="year-chevron">${isCurrentYear ? "▾" : "▸"}</span>
        <span class="year-label">${year}</span>
      </span>
      <span class="year-total">${yearTotal}</span>
    `;

    container.appendChild(yearHeader);

    const yearContainer = document.createElement("div");
    yearContainer.className = "ledger-year-container";
    yearContainer.dataset.built = "false";

    if (isCurrentYear) {
      buildYearRows(yearContainer, groupedByYear[year], rowDeps);
      yearContainer.dataset.built = "true";
    } else {
      yearContainer.style.display = "none";
    }

    container.appendChild(yearContainer);

    yearHeader.addEventListener("click", () => {
      const isHidden = yearContainer.style.display === "none";

      if (isHidden && yearContainer.dataset.built === "false") {
        buildYearRows(yearContainer, groupedByYear[year], rowDeps);
        yearContainer.dataset.built = "true";
      }

      yearContainer.style.display = isHidden ? "block" : "none";

      const chevron = yearHeader.querySelector(".year-chevron");
      chevron.textContent = isHidden ? "▾" : "▸";
    });
  });
}


function renderTodayCard(entry) {
  const container = document.getElementById("today-card");

  container.innerHTML = `
    <h2>${t("todayHeading")}${hasExplicitPoornima(entry.notes) ? " 🌕" : ""}</h2>

    <p><strong>${formatDateLong(entry.date)}</strong></p>

    ${renderJaapInputField(entry, { id: "today-jaap" })}

    <br><br>

    <label>
      ${t("commonNotesLabel")}<br>
      <textarea
        id="today-notes"
        class="edit-notes"
        rows="3"
        placeholder="${t("commonNotesPlaceholder")}"
      >${escapeHTML(entry.notes || "")}</textarea>
    </label>

    <br>

    ${entry.date === todayISO || isWithinLastNDays(entry.date, 7)
  ? `<button id="update-today">${t("todaySaveBtn")}</button>`
  : `<p><em>${t("todayLockedMsg")}</em></p>`
}


  `;

  document
    .getElementById("update-today")
    .addEventListener("click", updateTodayEntry);
}

// ---------- Update logic ----------
async function updateTodayEntry() {
  const jaapInput = document.getElementById("today-jaap").value;
  const notesInput = document.getElementById("today-notes").value;

  // Re-sync todayISO immediately before acting, independent of the
  // visibilitychange listener / periodic interval elsewhere in this file —
  // those keep the *display* accurate, but a save must never trust a
  // possibly-stale module-level todayISO for which entry it's writing to.
  // Without this, a continuously-open tab spanning midnight would look up
  // ledgerData.find(e => e.date === todayISO) against yesterday's date and
  // silently overwrite yesterday's already-recorded entry instead of
  // creating today's. ensureTodayEntryExists() (not a plain .find()) also
  // creates today's placeholder if the day just rolled over and nothing
  // has backfilled it yet.
  todayISO = getTodayISO();
  const entry = ensureTodayEntryExists();

  // (No isWithinLastNDays(entry.date, 7) guard here — this function only
  // ever edits *today's* entry by construction, which is always within the
  // window; a same-day comparison against itself can never be false, so a
  // guard here was always dead code and has been removed rather than kept
  // as false reassurance.)

  const newJaap = computeJaapFromInput(jaapInput, entry.jaap);
  if (!isValidJaapValue(newJaap)) {
    showToast(t("commonInvalidNumber"));
    return;
  }

  entry.jaap = newJaap;
  entry.notes = notesInput;

  const crossedNewMilestone = getCroreMilestone(entry.date);

  await saveLedger(ledgerData);
  await saveAutomaticBackup(ledgerData);
  renderToday();
  showToast(t("commonSavedToast"));

  if (crossedNewMilestone) {
    celebrateMilestone();
  }
}
document.getElementById("restore-backup-btn")
  ?.addEventListener("click", restoreFromBackup);

// ---------- Maintenance drawer open/close ----------
// Moved here from an inline <script> in index.html so all app logic lives
// in one place, per this file's own no-modules/single-scope convention.
const maintenanceToggleBtn = document.getElementById("maintenance-toggle");
const maintenanceDrawer = document.getElementById("maintenance-drawer");

maintenanceToggleBtn?.addEventListener("click", () => {
  const isOpen = maintenanceDrawer.classList.toggle("open");
  maintenanceDrawer.setAttribute("aria-hidden", !isOpen);
});

document.addEventListener("click", (e) => {
  if (
    maintenanceDrawer?.classList.contains("open") &&
    !maintenanceDrawer.contains(e.target) &&
    e.target !== maintenanceToggleBtn
  ) {
    maintenanceDrawer.classList.remove("open");
    maintenanceDrawer.setAttribute("aria-hidden", "true");
  }
});

// ---------- Mala View toggle ----------

document.getElementById("mala-toggle")?.addEventListener("change", (e) => {
  malaViewEnabled = e.target.checked;
  localStorage.setItem("malaViewEnabled", String(malaViewEnabled));
  updateMalaToggleButton();
  renderToday();
});

updateMalaToggleButton();

// ---------- Background theme swatches ----------

document.querySelectorAll(".background-swatch").forEach((btn) => {
  btn.addEventListener("click", () => {
    const choice = btn.dataset.bg;
    if (choice === backgroundChoice) return;
    document.body.classList.remove("bg-" + backgroundChoice);
    backgroundChoice = choice;
    document.body.classList.add("bg-" + backgroundChoice);
    localStorage.setItem("backgroundChoice", backgroundChoice);
    updateBackgroundSwatchButtons();
  });
});

updateBackgroundSwatchButtons();

// ---------- Language Picker (first-run) + Settings switcher ----------
// Both surfaces call the same applyAppLanguage() — the full-screen picker
// only ever appears once (first run, no language chosen yet); the Settings
// drawer buttons are always available to switch languages afterward.
const languagePickerEl = document.getElementById("language-picker");

function showLanguagePicker() {
  if (!languagePickerEl) return;
  languagePickerEl.classList.add("open");
  languagePickerEl.setAttribute("aria-hidden", "false");
}

function hideLanguagePicker() {
  if (!languagePickerEl) return;
  languagePickerEl.classList.remove("open");
  languagePickerEl.setAttribute("aria-hidden", "true");
}

// Reflects the active language as a filled radio (picker) / highlighted pill
// (Settings) — called after every language change and once at bootstrap.
function updateLanguagePickerSelection() {
  const lang = getEffectiveLang();
  document.querySelectorAll("#lang-picker-options .lang-option").forEach((btn) => {
    const isSelected = btn.dataset.lang === lang;
    btn.classList.toggle("selected", isSelected);
    btn.setAttribute("aria-checked", String(isSelected));
  });
  document.querySelectorAll("#lang-settings-wrap .lang-settings-btn").forEach((btn) => {
    const isActive = btn.dataset.lang === lang;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

document.getElementById("lang-picker-options")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".lang-option");
  if (!btn) return;
  applyAppLanguage(btn.dataset.lang);
  hideLanguagePicker();
});

document.getElementById("lang-settings-wrap")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".lang-settings-btn");
  if (!btn) return;
  applyAppLanguage(btn.dataset.lang);
});

// ---------- Custom splash image upload pipeline ----------
// Two limits matter here: file size protects decode-time RAM (a browser
// must expand an image to a raw width*height*4-byte bitmap before it can
// downscale it), while the megapixel guard catches highly-compressed files
// that are small on disk but huge in pixels. Everything downstream targets
// a small, consistent stored size (~250KB, see SPLASH_TARGET_BYTES) regardless of input size.
const SPLASH_MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const SPLASH_MAX_MEGAPIXELS = 40 * 1000 * 1000; // ~40MP
const SPLASH_MAX_EDGE = 900; // longest stored edge, in px
const SPLASH_TARGET_BYTES = 250 * 1024; // re-encode smaller past this

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error(t("splashErrReadFile")));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t("splashErrDecodeImage")));
    img.src = src;
  });
}

async function processSplashImage(file) {
  if (!file || !file.type || file.type.indexOf("image/") !== 0) {
    throw new Error(t("splashErrNotImage"));
  }
  if (file.size > SPLASH_MAX_FILE_BYTES) {
    throw new Error(t("splashErrTooLarge"));
  }

  let bitmap = null;

  if (typeof createImageBitmap === "function") {
    try {
      // Ask the browser to downsample while decoding, so a huge source
      // photo never has to fully materialize in memory at full resolution.
      bitmap = await createImageBitmap(file, { resizeWidth: SPLASH_MAX_EDGE, resizeQuality: "high" });
    } catch (e) {
      bitmap = null;
    }
  }

  if (!bitmap) {
    // Fallback path decodes at full size, so the megapixel guard is what
    // protects memory here.
    const dataUrl = await readFileAsDataURL(file);
    const imgEl = await loadImageElement(dataUrl);
    if (imgEl.naturalWidth * imgEl.naturalHeight > SPLASH_MAX_MEGAPIXELS) {
      throw new Error(t("splashErrTooHighRes"));
    }
    bitmap = imgEl;
  }

  const sourceWidth = bitmap.width || bitmap.naturalWidth;
  const sourceHeight = bitmap.height || bitmap.naturalHeight;

  const scale = Math.min(1, SPLASH_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

  // Release the decoded bitmap immediately rather than waiting on GC.
  if (typeof bitmap.close === "function") bitmap.close();

  let quality = 0.82;
  let dataUrl = canvas.toDataURL("image/webp", quality);
  if (dataUrl.indexOf("data:image/webp") !== 0) {
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  let attempts = 0;
  while (dataUrl.length * 0.75 > SPLASH_TARGET_BYTES && attempts < 3 && quality > 0.4) {
    quality = Math.max(0.4, quality - 0.15);
    const type = dataUrl.indexOf("data:image/webp") === 0 ? "image/webp" : "image/jpeg";
    dataUrl = canvas.toDataURL(type, quality);
    attempts++;
  }

  return dataUrl;
}

function setCustomSplashImage(slotIndex, dataUrl) {
  const key = "splashImage:custom" + slotIndex;
  const previousDataUrl = localStorage.getItem(key);
  try {
    localStorage.setItem(key, dataUrl);
  } catch (e) {
    // Roll back so a quota error never leaves a slot half-written.
    if (previousDataUrl !== null) {
      try { localStorage.setItem(key, previousDataUrl); } catch (e2) {}
    }
    throw new Error(t("splashErrQuota"));
  }
}

function removeCustomSplashImage(slotIndex) {
  try {
    localStorage.removeItem("splashImage:custom" + slotIndex);
  } catch (e) {}
}

function removeAllCustomSplashImages() {
  for (let i = 0; i < SPLASH_CUSTOM_SLOT_COUNT; i++) removeCustomSplashImage(i);
}

let pendingSplashSlot = null;

function renderSplashSlotUI() {
  const wrap = document.getElementById("splash-slot-wrap");
  if (!wrap) return;
  wrap.innerHTML = "";

  // Tile 0: Hanuman, locked — always shown, never a file-picker trigger.
  const lockedBtn = document.createElement("button");
  lockedBtn.type = "button";
  lockedBtn.className = "splash-slot splash-slot-locked";
  lockedBtn.title = t("splashHanumanLockedMsg");

  const lockedImg = document.createElement("img");
  lockedImg.src = SPLASH_DEFAULT_IMAGE.webp;
  lockedImg.alt = "";
  lockedBtn.appendChild(lockedImg);

  const lockBadge = document.createElement("span");
  lockBadge.className = "splash-slot-lock";
  lockBadge.textContent = "🔒";
  lockedBtn.appendChild(lockBadge);

  lockedBtn.addEventListener("click", () => {
    showToast(t("splashHanumanLockedMsg"));
  });
  wrap.appendChild(lockedBtn);

  // Tiles 1-4: up to 4 user-uploaded slots, each independently empty or filled.
  resolveSplashCustomSlots().forEach((slot, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "splash-slot";
    btn.dataset.slot = String(i);

    if (slot.filled) {
      btn.classList.add("splash-slot-custom");
      btn.title = t("splashCustomTapReplace");

      const img = document.createElement("img");
      img.src = slot.dataUrl;
      img.alt = "";
      btn.appendChild(img);

      const removeBadge = document.createElement("span");
      removeBadge.className = "splash-slot-reset";
      removeBadge.textContent = "✕";
      removeBadge.title = t("splashRemoveImageTitle");
      removeBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        removeCustomSplashImage(i);
        renderSplashSlotUI();
        showToast(t("splashToastImageRemoved"));
      });
      btn.appendChild(removeBadge);
    } else {
      btn.classList.add("splash-slot-empty");
      btn.title = t("splashAddPictureTitle");
      btn.textContent = "+";
    }

    btn.addEventListener("click", () => {
      pendingSplashSlot = i;
      const input = document.getElementById("splash-image-input");
      if (input) input.click();
    });

    wrap.appendChild(btn);
  });
}

document.getElementById("splash-image-input")?.addEventListener("change", async (event) => {
  const input = event.target;
  const file = input.files[0];
  const slotIndex = pendingSplashSlot;
  pendingSplashSlot = null;

  if (!file || slotIndex === null) {
    input.value = "";
    return;
  }

  try {
    const dataUrl = await processSplashImage(file);
    setCustomSplashImage(slotIndex, dataUrl);
    renderSplashSlotUI();
    showToast(t("splashToastUpdated"));
  } catch (err) {
    console.error("Splash image upload failed:", err);
    showToast(err && err.message ? err.message : t("splashErrProcessFallback"));
  } finally {
    input.value = "";
  }
});

document.getElementById("splash-images-reset-btn")?.addEventListener("click", () => {
  const anyFilled = resolveSplashCustomSlots().some((slot) => slot.filled);
  if (!anyFilled) {
    showToast(t("splashToastNoneToRemove"));
    return;
  }
  removeAllCustomSplashImages();
  renderSplashSlotUI();
  showToast(t("splashToastAllRemoved"));
});

renderSplashSlotUI();

// ---------- Sankalpa ----------

function openSankalpaPage() {
  const page = document.getElementById("sankalpa-page");
  if (!page) return;
  page.classList.add("open");
  page.setAttribute("aria-hidden", "false");
  renderSankalpaPage();
}

function closeSankalpaPage() {
  const page = document.getElementById("sankalpa-page");
  if (!page) return;
  page.classList.remove("open");
  page.setAttribute("aria-hidden", "true");
}

async function renderSankalpaPage() {
  const page = document.getElementById("sankalpa-page");
  if (!page) return;

  const sankalpa = await getSankalpa();

  if (!sankalpa) {
    page.innerHTML = `
      <div class="fullscreen-header">
        <h2>${t("sankalpaHeading")}</h2>
        <button id="sankalpa-close" class="fullscreen-close" aria-label="${t("commonCloseAria")}">✕</button>
      </div>
      <div class="sankalpa-body">
        <p class="sankalpa-intro">${t("sankalpaIntro")}</p>

        <label>
          ${t("sankalpaHeading")}<br>
          <textarea id="sankalpa-text" class="edit-notes" rows="4" placeholder="${t("sankalpaVowPlaceholder")}"></textarea>
        </label>

        <br><br>

        <label>
          ${t("sankalpaContextLabel")}<br>
          <input type="text" id="sankalpa-context" class="edit-jaap" placeholder="${t("sankalpaContextPlaceholder")}">
        </label>

        <br><br>

        <button id="sankalpa-establish" class="save-entry" disabled>${t("sankalpaEstablishBtn")}</button>
      </div>
    `;

    const textEl = page.querySelector("#sankalpa-text");
    const establishBtn = page.querySelector("#sankalpa-establish");

    const syncDisabled = () => {
      establishBtn.disabled = textEl.value.trim().length === 0;
    };
    textEl.addEventListener("input", syncDisabled);
    syncDisabled();

    establishBtn.addEventListener("click", async () => {
      const text = textEl.value.trim();
      if (!text) return;

      const context = page.querySelector("#sankalpa-context").value.trim();
      await saveSankalpa({ text, context, date: getTodayISO() });
      showToast(t("sankalpaEstablishedToast"));
      renderSankalpaPage();
    });

    page.querySelector("#sankalpa-close").addEventListener("click", closeSankalpaPage);
    return;
  }

  page.innerHTML = `
    <div class="fullscreen-header">
      <h2>${t("sankalpaHeading")}</h2>
      <button id="sankalpa-close" class="fullscreen-close" aria-label="${t("commonCloseAria")}">✕</button>
    </div>
    <div class="sankalpa-body">
      <div class="sankalpa-view">
        <p class="sankalpa-text-display">${escapeHTML(sankalpa.text)}</p>
        ${sankalpa.context ? `<p class="sankalpa-context-display"><em>${escapeHTML(sankalpa.context)}</em></p>` : ""}
        <p class="sankalpa-date-display">${t("sankalpaEstablishedDate", { date: formatDate(sankalpa.date) })}</p>
      </div>

      <button id="sankalpa-rewrite-btn" class="maintenance-btn">${t("sankalpaRewriteBtn")}</button>

      <div id="sankalpa-rewrite-form" style="display:none;">
        <br>
        <label>
          ${t("sankalpaHeading")}<br>
          <textarea id="sankalpa-text-edit" class="edit-notes" rows="4">${escapeHTML(sankalpa.text)}</textarea>
        </label>

        <br><br>

        <label>
          ${t("sankalpaContextLabel")}<br>
          <input type="text" id="sankalpa-context-edit" class="edit-jaap">
          <!-- value set via JS property assignment below, not interpolated into
               this attribute — escapeHTML() only escapes &/</>, not \", so a
               context containing a literal " would otherwise break out of a
               value="..." attribute and corrupt the rest of this template. -->
        </label>

        <br><br>

        <button id="sankalpa-confirm-rewrite" class="save-entry" disabled>${t("sankalpaConfirmRewriteBtn")}</button>
        <button id="sankalpa-cancel-rewrite" class="maintenance-btn">${t("commonCancelBtn")}</button>
      </div>
    </div>
  `;

  page.querySelector("#sankalpa-close").addEventListener("click", closeSankalpaPage);

  const rewriteBtn = page.querySelector("#sankalpa-rewrite-btn");
  const rewriteForm = page.querySelector("#sankalpa-rewrite-form");
  const textEdit = page.querySelector("#sankalpa-text-edit");
  const confirmBtn = page.querySelector("#sankalpa-confirm-rewrite");
  page.querySelector("#sankalpa-context-edit").value = sankalpa.context || "";

  rewriteBtn.addEventListener("click", () => {
    rewriteForm.style.display = "block";
  });

  const syncConfirmDisabled = () => {
    confirmBtn.disabled = textEdit.value.trim().length === 0;
  };
  textEdit.addEventListener("input", syncConfirmDisabled);
  syncConfirmDisabled();

  page.querySelector("#sankalpa-cancel-rewrite").addEventListener("click", () => {
    rewriteForm.style.display = "none";
  });

  confirmBtn.addEventListener("click", async () => {
    const text = textEdit.value.trim();
    if (!text) return;

    const confirmed = confirm(t("sankalpaRewriteConfirm"));
    if (!confirmed) return;

    const context = page.querySelector("#sankalpa-context-edit").value.trim();
    // date is always preserved from the original record — never reset to today.
    await saveSankalpa({ text, context, date: sankalpa.date });
    showToast(t("sankalpaRewrittenToast"));
    renderSankalpaPage();
  });
}

document.getElementById("sankalpa-open-btn")
  ?.addEventListener("click", openSankalpaPage);

  // ---------- Export Ledger (JSON) ----------

// Shared by the Export button and the Google Drive backup path — both need
// the same clone-and-sanitize shaping of the raw ledger.
//
// Takes `sankalpa` as an argument rather than reading it itself, so this
// stays pure and directly unit-testable without mocking IndexedDB (same
// reasoning as shouldShowSundayBackupReminder()/buildDriveUploadRequest()).
// The Sankalpa is included because it previously had NO export, backup or
// Drive path at all — it lived in one IndexedDB store on one device and was
// lost silently on eviction or a device change.
const LEDGER_EXPORT_VERSION = 2;

function buildLedgerExportPayload(sankalpa) {
  return {
    version: LEDGER_EXPORT_VERSION,
    entries: ledgerData.map(e => ({
      date: e.date,
      jaap: e.jaap ?? null,
      notes: e.notes || ""
    })),
    sankalpa: sanitizeSankalpaForExport(sankalpa)
  };
}

// Keeps only the three fields a Sankalpa record actually carries (the stored
// record also has a fixed `id: "primary"` key, which is storage plumbing, not
// user data) — and returns null for anything unusable, so a missing or
// malformed record can never poison an export or an import.
function sanitizeSankalpaForExport(sankalpa) {
  if (!sankalpa || typeof sankalpa !== "object") return null;
  if (typeof sankalpa.text !== "string" || sankalpa.text.trim() === "") return null;
  return {
    text: sankalpa.text,
    context: typeof sankalpa.context === "string" ? sankalpa.context : "",
    date: typeof sankalpa.date === "string" ? sankalpa.date : ""
  };
}

// Normalizes a parsed import file into { entries, sankalpa }, accepting BOTH
// the current object payload and the legacy bare-array format that every
// export before v2 produced. Without the legacy branch, every file a user
// exported previously would become unimportable — so this compatibility is
// not optional. Returns null for anything that isn't a recognizable ledger
// file; per-entry validation is the caller's job.
function parseImportedLedgerFile(parsed) {
  if (Array.isArray(parsed)) {
    return { entries: parsed, sankalpa: null }; // legacy (pre-v2) export
  }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
    return { entries: parsed.entries, sankalpa: sanitizeSankalpaForExport(parsed.sankalpa) };
  }
  return null;
}

document.getElementById("export-json-btn")
  ?.addEventListener("click", async () => {
    if (!ledgerData || ledgerData.length === 0) {
      alert(t("ledgerEmptyExport"));
      return;
    }

    const exportData = buildLedgerExportPayload(await getSankalpa());

    const blob = new Blob(
      [JSON.stringify(exportData, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `jaap-ledger-export-${getTodayISO()}.json`;

    document.body.appendChild(a);
    a.click();

    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
  
// ---------- Import Ledger (JSON) ----------

const importBtn = document.getElementById("import-json-btn");
const importInput = document.getElementById("import-json-input");

importBtn?.addEventListener("click", () => {
  importInput.click();
});

importInput?.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  if (!appReady) {
    showToast(t("appNotReadyYet"));
    event.target.value = "";
    return;
  }

  try {
    const text = await file.text();
    const parsedFile = JSON.parse(text);

    // ---- Validation ----
    // Accepts both the current object payload and the legacy bare-array
    // format produced by every export before v2.
    const parsed = parseImportedLedgerFile(parsedFile);
    if (!parsed) {
      alert(t("ledgerInvalidFileFormat"));
      return;
    }
    const importedData = parsed.entries;
    const importedSankalpa = parsed.sankalpa;

    const seenDates = new Set();
    for (const entry of importedData) {
      // isValidJaapValue() is the same guard both live save paths (Today
      // Card, Ledger row) already use — reject anything they'd reject,
      // including negative numbers (Number.isFinite(-500) is true, so a
      // plain finite check alone would have silently let negatives through
      // to corrupt every downstream sum).
      const jaapIsValid = isValidJaapValue(entry.jaap);
      const dateIsValid = typeof entry.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && entry.date <= todayISO;
      // notes must actually be a string, not merely present — a truthy
      // non-string (e.g. a hand-edited "notes": 123) crashes the very next
      // render via hasExplicitPoornima()'s notes.toLowerCase() call, and by
      // then the bad entry has already been persisted to IndexedDB.
      const notesIsValid = typeof entry.notes === "string";
      if (
        !dateIsValid ||
        !("jaap" in entry) ||
        !jaapIsValid ||
        !notesIsValid ||
        seenDates.has(entry.date)
      ) {
        alert(t("ledgerInvalidEntryFormat"));
        return;
      }
      seenDates.add(entry.date);
    }

    const confirmReplace = confirm(t("ledgerImportConfirm", { count: importedData.length }));

    if (!confirmReplace) {
      importInput.value = ""; // reset
      return;
    }

    // Snapshot the CURRENT ledger before overwriting it. This used to run
    // after the replace, which meant the backup was overwritten with the
    // imported data in the same breath — so "Restore from Backup" could not
    // undo a mistaken import, and the replaced data was simply gone. Taking
    // it first makes restore a real escape hatch.
    await saveAutomaticBackup(ledgerData);

    // ---- Replace Ledger ----
    ledgerData = importedData;

    await saveLedger(ledgerData);

    // A Sankalpa is only ever restored from a file that actually carries one
    // — a legacy (pre-v2) export has none, and must not wipe the Sankalpa
    // the user already has on this device.
    if (importedSankalpa) {
      await saveSankalpa(importedSankalpa);
    }

    alert(t("ledgerImportSuccess"));

    renderToday();

  } catch (err) {
    console.error("Import failed:", err);
    alert(t("ledgerImportFailed"));
  } finally {
    importInput.value = ""; // allow re-import of same file
  }
});

// ---------- Google Drive Backup (Sunday reminder + on-demand) ----------
// The only feature in this app that talks to the network, and only when the
// user actually engages with it (the Sunday modal or the Settings button) --
// everything else stays fully offline-capable. A browser-app OAuth Client ID
// is a public value (not a secret), so it's safe to hardcode here.
//
// REPLACE GOOGLE_DRIVE_CLIENT_ID before this feature can work — see
// README.md / CLAUDE.md for setup (create or reuse a Google Cloud OAuth
// Client ID, add this app's origins as Authorized JavaScript origins, and
// add each sadhak's Gmail as a Test User while the app is in OAuth Testing
// status — Google's own consent screen blocks anyone not on that list).
const GOOGLE_DRIVE_CLIENT_ID = "579557768188-cnt9lvkrf96bglng9hv8vqno8e2h7s3n.apps.googleusercontent.com";
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SUNDAY_BACKUP_FILENAME = "sumiran-lite-backup.json";

let googleIdentityScriptPromise = null;

// Lazily injects the Google Identity Services script (idempotent) — only
// called when a backup is actually attempted, so users who never touch this
// feature never load it.
function loadGoogleIdentityScript() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    return Promise.resolve();
  }
  if (googleIdentityScriptPromise) return googleIdentityScriptPromise;

  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-google-identity]");
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(t("backupErrLoadGis"))));
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(t("backupErrLoadGis")));
    document.head.appendChild(script);
  });

  return googleIdentityScriptPromise;
}

// Wraps the Google Identity Services token client (callback-based) in a
// Promise. Rejects if the user closes the popup or sign-in otherwise fails.
function requestGoogleDriveAccessToken() {
  return new Promise((resolve, reject) => {
    try {
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_DRIVE_CLIENT_ID,
        scope: GOOGLE_DRIVE_SCOPE,
        callback: (tokenResponse) => {
          if (tokenResponse && tokenResponse.access_token) {
            resolve(tokenResponse.access_token);
          } else {
            reject(new Error(t("backupErrTokenIncomplete")));
          }
        },
        error_callback: () => {
          reject(new Error(t("backupErrCancelled")));
        },
      });
      tokenClient.requestAccessToken();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(t("backupErrStartFailed")));
    }
  });
}

// Pure: decides the shape of the Drive upload request (method/URL/body)
// given whether a backup file already exists — no network I/O of its own,
// so this is directly unit-testable without mocking fetch at all.
function buildDriveUploadRequest(existingFileId, payloadJSON) {
  if (existingFileId) {
    return {
      method: "PATCH",
      url: `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=media`,
      headers: { "Content-Type": "application/json" },
      body: payloadJSON,
    };
  }

  const boundary = "sumiran-lite-backup-boundary";
  const metadata = JSON.stringify({ name: SUNDAY_BACKUP_FILENAME, mimeType: "application/json" });
  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${payloadJSON}\r\n` +
    `--${boundary}--`;

  return {
    method: "POST",
    url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipartBody,
  };
}

// Searches for an existing sumiran-lite-backup.json (the drive.file scope
// only ever sees files this app itself created, so a name match is enough).
async function findExistingDriveBackupFileId(accessToken) {
  const query = encodeURIComponent(`name='${SUNDAY_BACKUP_FILENAME}' and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(t("backupErrCheckExisting"));
  }
  const data = await res.json();
  const match = data.files && data.files[0];
  return match ? match.id : null;
}

async function uploadLedgerBackupToDrive(accessToken) {
  const payloadJSON = JSON.stringify(buildLedgerExportPayload(await getSankalpa()), null, 2);
  const existingFileId = await findExistingDriveBackupFileId(accessToken);
  const request = buildDriveUploadRequest(existingFileId, payloadJSON);

  const res = await fetch(request.url, {
    method: request.method,
    headers: { ...request.headers, Authorization: `Bearer ${accessToken}` },
    body: request.body,
  });

  if (!res.ok) {
    throw new Error(t("backupErrUploadRejected"));
  }
}

// Records that the Sunday *prompt* has been dealt with for today — written
// by a successful upload AND by every dismiss path, so it deliberately
// cannot tell you whether a backup actually happened. That's what
// recordSuccessfulDriveBackup() below is for; don't conflate the two.
function markSundayBackupHandled() {
  localStorage.setItem("lastSundayBackupPromptDate", todayISO);
}

// Written ONLY on a genuinely successful upload. Display-state tier (like
// backgroundChoice), so it's deliberately excluded from Export/Import and
// the backup payload. Guarded because localStorage can throw when the
// shared origin quota is full (see setCustomSplashImage()) — a failed
// status write must never turn a successful backup into an error.
function recordSuccessfulDriveBackup() {
  try {
    localStorage.setItem("lastDriveBackupAt", new Date().toISOString());
  } catch (e) {
    console.warn("Could not record the Drive backup timestamp:", e);
  }
}

function openSundayBackupModal() {
  const modal = document.getElementById("sunday-backup-modal");
  if (!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

function closeSundayBackupModal() {
  const modal = document.getElementById("sunday-backup-modal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

// "Remind me next Sunday", "✕", and backdrop click all funnel here — mark
// today handled (so the modal won't reappear until next Sunday) without
// uploading anything.
function dismissSundayBackupReminder() {
  markSundayBackupHandled();
  closeSundayBackupModal();
}

// The primary action, wired to both the modal's "Back Up to Google Drive"
// button and the on-demand Settings button. Every failure mode (network
// down, popup closed, Drive API error) surfaces via showToast() with an
// actionable message rather than failing silently.
async function backupToGoogleDrive() {
  try {
    await loadGoogleIdentityScript();
    const accessToken = await requestGoogleDriveAccessToken();
    await uploadLedgerBackupToDrive(accessToken);
    markSundayBackupHandled();
    recordSuccessfulDriveBackup();
    renderDataSafetyStatus();
    closeSundayBackupModal();
    showToast(t("backupToastSuccess"));
  } catch (err) {
    console.error("Google Drive backup failed:", err);
    showToast(err && err.message ? err.message : t("backupToastFailFallback"));
  }
}

document.getElementById("sunday-backup-primary-btn")?.addEventListener("click", backupToGoogleDrive);
document.getElementById("sunday-backup-dismiss-btn")?.addEventListener("click", dismissSundayBackupReminder);
document.getElementById("sunday-backup-close-btn")?.addEventListener("click", dismissSundayBackupReminder);
document.getElementById("sunday-backup-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "sunday-backup-modal") dismissSundayBackupReminder();
});
document.getElementById("drive-backup-btn")?.addEventListener("click", backupToGoogleDrive);


