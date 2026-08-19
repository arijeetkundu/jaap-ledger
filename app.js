// ---------- Guarded localStorage access ----------
// app.js is a classic script, not a module: a throw at top-level scope
// aborts the ENTIRE remaining file. Nothing below the throw is ever
// defined — no initApp(), no render, no event listeners, no service worker
// registration — so the user is left staring at a splash screen that never
// clears, with no way to recover short of clearing site data. That is the
// single worst failure this file can have, and several unguarded
// localStorage calls at top-level scope could cause it:
//
//   - setItem throws QuotaExceededError when the origin's storage is full,
//     which four ~250KB custom splash images get genuinely close to. The
//     lastSplashImage write in chooseSplashImage() below runs before first
//     paint, making it the most exposed line in the file.
//   - Merely *reading* localStorage throws SecurityError when the platform
//     blocks all site data (Safari's "Block All Cookies", some embedded
//     webviews). That kills the app on line one, before anything at all.
//
// These accessors degrade to the in-memory default instead. The pattern was
// already understood in this file — resolveSplashCustomSlots() and
// setCustomSplashImage() both guard — it just wasn't applied consistently.
// Function declarations hoist, so these are safe to call from the
// module-level initializers immediately below.
function readStoredPreference(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    console.warn("Could not read localStorage key:", key, e);
    return null;
  }
}

// Returns whether the value was actually persisted, so callers that care
// (the ones showing a quota toast) can tell, and callers that don't can
// ignore it — but neither can be aborted by a throw.
function writeStoredPreference(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn("Could not persist localStorage key:", key, e);
    return false;
  }
}

// ---------- Background Theme ----------
let backgroundChoice = readStoredPreference("backgroundChoice") || "mandala";

// ---------- Text Size ----------
// Display preference, same tier as backgroundChoice. Applied to <html>
// (not <body>) because every size in styles.css is in rem, so the root
// font-size is the single lever that scales the whole app coherently.
// Applied immediately below rather than in initApp() so it lands before
// first paint — a late switch would visibly reflow the app under the
// splash screen.
const TEXT_SIZES = ["small", "medium", "large"];
let textSizeChoice = readStoredPreference("textSize");
if (!TEXT_SIZES.includes(textSizeChoice)) textSizeChoice = "medium";

function applyTextSize(size) {
  if (!TEXT_SIZES.includes(size)) size = "medium";
  textSizeChoice = size;
  const root = document.documentElement;
  TEXT_SIZES.forEach(s => root.classList.remove("text-" + s));
  // "medium" is the stylesheet's own 100% default — no class needed, which
  // also means an untouched install carries no marker at all.
  if (size !== "medium") root.classList.add("text-" + size);
}

applyTextSize(textSizeChoice);

// ---------- i18n: language state ----------
// null until the user has explicitly chosen (via the first-run picker or the
// Settings switcher) — that's what gates the first-run picker from showing.
// Lookups always fall back to "en" via t() below, so the app renders in
// English before a choice is made.
let currentAppLanguage = readStoredPreference("appLanguage") || null;

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
        renderSankalpaPageSafely();
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
  // A throw here would abort the rest of this function, so the language
  // would apply for this session but silently fail to persist — and the
  // first-run picker would incorrectly reappear next load even though the
  // user already chose. writeStoredPreference() can't throw; it reports.
  if (!writeStoredPreference("appLanguage", lang)) {
    showToast(t("langErrQuota"));
  }
  applyStaticTranslations();
  updateMalaToggleButton();
  renderSplashSlotUI();
  renderToday();
  renderDataSafetyStatus();
  // Both the sync status line and the sign-in button are rendered from t()
  // rather than data-i18n, because their text depends on whether anyone is
  // signed in. Without this call they kept whichever language was active when
  // renderSyncStatus() last ran — so the status could sit in Bangla under an
  // otherwise English UI, and the button reverted to "Sign in with Google"
  // while still signed in, which read as the session having expired.
  renderSyncStatus();
  if (document.getElementById("sankalpa-page")?.classList.contains("open")) {
    renderSankalpaPageSafely();
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

  const lastId = readStoredPreference("lastSplashImage");
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

  writeStoredPreference("lastSplashImage", chosen.id);
})();

// ---------- Splash Screen Logic ----------
// The splash is darshan, not a loading indicator: it is purely cosmetic and
// entirely independent of initApp()'s bootstrap, which finishes well before
// this timer does. SPLASH_HOLD_MS is the fully-opaque window; the picture's
// own entrance animation takes the first 0.9s of it, so the settled viewing
// time is roughly SPLASH_HOLD_MS minus that.
//
// SPLASH_FADE_MS must stay in step with #splash-screen's opacity transition
// in styles.css — it times the removal from the DOM, so if it were shorter
// the element would vanish mid-dissolve. The test suites' own SPLASH_WAIT_MS
// constants must outlast HOLD + FADE.
const SPLASH_HOLD_MS = 3200;
const SPLASH_FADE_MS = 800;

let splashDismissTimer = null;
let splashClosing = false;

// A sadhak takes darshan for as long as they wish; a tap anywhere continues
// into the ledger without waiting out the rest of the hold. Guarded so a
// second tap during the dissolve can't remove the element twice.
function continueFromSplash() {
  if (splashClosing) return;
  splashClosing = true;
  if (splashDismissTimer !== null) {
    clearTimeout(splashDismissTimer);
    splashDismissTimer = null;
  }
  const splash = document.getElementById("splash-screen");
  if (!splash) {
    document.body.classList.remove("loading");
    return;
  }
  splash.style.opacity = "0";
  setTimeout(() => {
    splash.remove();
    document.body.classList.remove("loading");
  }, SPLASH_FADE_MS);
}

// Wired immediately rather than on `load`, so an early tap is honoured on a
// slow first visit instead of being silently ignored.
(function wireSplashTap() {
  const splash = document.getElementById("splash-screen");
  if (!splash) return;
  splash.addEventListener("pointerdown", continueFromSplash);
})();

window.addEventListener("load", () => {
  splashDismissTimer = setTimeout(continueFromSplash, SPLASH_HOLD_MS);
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
// Returns "" rather than garbage for anything unparseable. It used to
// produce "undefined undefined NaN" for a malformed string and to THROW
// outright on undefined — reachable in practice via a Sankalpa whose date
// sanitizeSankalpaForExport() defaults to "", which then renders inside the
// Sankalpa page's date line. An empty string simply omits the date; a throw
// there would take the whole page render down.
function isParsableISODate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatDate(isoDate) {
  if (!isParsableISODate(isoDate)) return "";
  const [year, month, day] = isoDate.split("-").map(Number);
  if (month < 1 || month > 12) return "";
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

// Format YYYY-MM-DD → "Weekday, D Month YYYY" (e.g. "Thursday, 6 August 2026")
// Today Card only — every other date display keeps the shorter formatDate().
// Hand-rolled (not toLocaleDateString) to stay deterministic across devices/locales.
const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function formatDateLong(isoDate) {
  // Same guard as formatDate() — this one renders the Today Card's date
  // line, so a throw here would take the entire card down.
  if (!isParsableISODate(isoDate)) return "";
  const [year, month, day] = isoDate.split("-").map(Number);
  if (month < 1 || month > 12) return "";
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

// Escape for use inside a DOUBLE-QUOTED HTML attribute value. escapeHTML()
// deliberately doesn't escape `"` (it's unnecessary for text nodes, its only
// use case), so it must never be used to build an attribute — see its own
// comment and the sankalpa-context-edit note in renderSankalpaPage().
//
// Currently every attribute built this way interpolates a translated string,
// and no entry in the reviewed dictionary contains a `"` — verified across
// all keys. That is a property of today's content, not of the code, and a
// future translation adding a quotation mark would silently break out of the
// attribute. tAttr() removes the dependency on that holding.
function escapeAttr(str) {
  return escapeHTML(str).split('"').join("&quot;");
}

// t(), escaped for attribute context. Use wherever a translated string lands
// inside quotes in a template string.
function tAttr(key, params) {
  return escapeAttr(t(key, params));
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

// Did THIS save create a Crore crossing, as opposed to merely sitting on one
// that already existed? getCroreMilestone() answers "does a crossing exist on
// this date", not "did I just cause it" — so without this check, re-saving an
// unchanged milestone entry (or simply tapping Save twice) re-fired all 96
// petals. Callers capture getCroreMilestone(entry.date) before mutating and
// again after, then pass both.
//
// Deliberately duplicated across the two save paths until now, and documented
// as such. A third caller (Mala Mode) is past the point where that holds —
// the same trajectory the 7-day window took before it became
// EDITABLE_WINDOW_DAYS.
function didCrossNewMilestone(before, after) {
  return after !== null && after !== before;
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

// "On this day": the most recent earlier year in which the user actually
// logged practice on this same calendar day. Returns { date, jaap, yearsAgo }
// or null when there's nothing to say — the Today Card omits the line
// entirely rather than showing an empty prompt, so a newer sadhak never
// sees a hole where a memory should be.
//
// Matched on MM-DD, so 29 February finds nothing in non-leap years. That's
// correct rather than unfortunate: there was no "this day" in those years.
// Zero and null days are skipped too — "0 jaap a year ago today" is not a
// memory worth surfacing.
function getOnThisDayEntry(referenceISO) {
  if (!referenceISO || ledgerData.length === 0) return null;

  const year = Number(referenceISO.slice(0, 4));
  const monthDay = referenceISO.slice(5); // "MM-DD"

  const candidates = ledgerData.filter(e =>
    typeof e.date === "string" &&
    e.date.slice(5) === monthDay &&
    Number(e.date.slice(0, 4)) < year &&
    isValidJaapValue(e.jaap) &&
    e.jaap > 0
  );

  if (candidates.length === 0) return null;

  // Nearest year wins over older ones.
  const match = candidates.reduce((best, e) => (e.date > best.date ? e : best), candidates[0]);
  return {
    date: match.date,
    jaap: match.jaap,
    yearsAgo: year - Number(match.date.slice(0, 4)),
  };
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

// The window the app documents and the User Guide promises: today plus the
// six days before it. It used to be `isWithinLastNDays(dateISO, 7)`, whose
// `<= days` is inclusive, so it actually accepted offsets 0-7 — eight days,
// one more than advertised, and one more than ensureRecentEntriesExist(7)
// ever materialises.
//
// isWithinLastNDays() itself is deliberately left alone: its inclusive
// reading of "within the last N days" is defensible, and it is asserted
// directly by tests/test-unit.js. Fixing the caller keeps that test honest
// and puts the window in exactly one place.
const EDITABLE_WINDOW_DAYS = 7;

// The old `dateISO === todayISO ||` prefix is gone as redundant, not as a
// behaviour change: today's offset is 0, which already passes.
function isEditableEntry(dateISO) {
  return isWithinLastNDays(dateISO, EDITABLE_WINDOW_DAYS - 1);
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

  // Validated, not merely array-checked: a structurally broken live store
  // would otherwise crash the first render and leave the app dead, when
  // falling through to the backup below is exactly the recovery this
  // function exists to perform.
  if (ledger && areLedgerEntriesValid(ledger)) {
    return ledger;
  }
  if (ledger && Array.isArray(ledger)) {
    console.warn("Live ledger failed validation — falling back to the latest backup");
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

  if (backup && areLedgerEntriesValid(backup.entries)) {
    await saveLedger(backup.entries);
    return backup.entries;
  }
  if (backup && Array.isArray(backup.entries)) {
    console.warn("Backup failed validation — refusing to load it");
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
// Inert by design: this store was a one-time data.json seeding guard and is
// no longer read or written anywhere. It is kept, not dropped, because the
// upgrade handler is additive-only — destroying a store would be
// irreversible for anyone whose browser still holds one.
const META_STORE = "meta";
const SANKALPA_STORE = "sankalpa";
const DB_VERSION = 4;

// One connection, reused. openDB() used to open a brand-new connection on
// every call and never close any of them — a single Today Card save opens
// three (ledger, sankalpa, backup). Leaked connections are not merely
// untidy: an open connection BLOCKS a future version upgrade, so the next
// time DB_VERSION is bumped the upgrade would hang behind the leaks with no
// onblocked handler anywhere to notice.
let dbConnectionPromise = null;

function openDB() {
  if (dbConnectionPromise) return dbConnectionPromise;

  dbConnectionPromise = new Promise((resolve, reject) => {
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

    request.onsuccess = () => {
      const db = request.result;

      // Another tab running a newer build wants to upgrade: close this
      // connection so its upgrade isn't blocked, and drop the memo so the
      // next call reconnects rather than handing out a dead handle.
      db.onversionchange = () => {
        db.close();
        dbConnectionPromise = null;
      };

      // An unexpected close (eviction, corruption, the user clearing site
      // data) must also invalidate the memo, or every later call would keep
      // resolving to a connection that can no longer open a transaction.
      db.onclose = () => {
        dbConnectionPromise = null;
      };

      resolve(db);
    };

    request.onerror = () => {
      // Clear on failure too, so a transient error isn't cached for the
      // rest of the session — the app would otherwise never recover.
      dbConnectionPromise = null;
      reject(request.error);
    };

    request.onblocked = () => {
      console.warn("IndexedDB upgrade is blocked by another open connection.");
    };
  });

  return dbConnectionPromise;
}

// Resolves only once the transaction has actually COMMITTED, and rejects if
// it fails. This used to be `await store.put(...)` — but an IDBRequest is not
// a thenable, so that await resolved on the next microtask, before the write
// landed, and there was no error handler at all. Since this is the sole
// writer of the primary ledger store, every "Saved ✓" the app has ever shown
// was unverified, and a failed write (quota exhausted, corrupt DB) was
// silently swallowed. saveSankalpa() and saveAutomaticBackup() below already
// do it this way — saveLedger was simply the odd one out.
//
// A synchronous throw from put() (e.g. DataCloneError) rejects this promise
// too, since it happens inside the executor.
async function saveLedger(data) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    store.put(data, "entries");

    tx.oncomplete = () => {
      // Sync's single push point. Fires only on a genuinely committed write,
      // so a failed save is never uploaded, and it is not awaited — see
      // pushLedgerAfterSave(). Declared later in the file, which is fine: by
      // the time any write completes, the whole script has run.
      pushLedgerAfterSave();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
    // A transaction can also abort without onerror firing (most commonly
    // QuotaExceededError) — without this the promise would hang forever and
    // the caller's await would never settle.
    tx.onabort = () => reject(tx.error || new Error("Ledger transaction aborted"));
  });
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
let malaViewEnabled = readStoredPreference("malaViewEnabled") === "true";

// What the user has typed into the Today Card but not yet saved, as raw
// input strings: { jaap, notes } or null when there's nothing in progress.
//
// Module-level for exactly the reason ledgerSearchQuery is (see its comment):
// renderTodayCard() rebuilds the card's innerHTML from scratch, so anything
// living only in the DOM is destroyed by any unrelated re-render. And plenty
// of things re-render — flipping Mala View, switching language, and the
// translations background retry, which can fire ~100s after launch with no
// user action at all. Typing a count and a note, then toggling Mala View,
// used to silently wipe both.
//
// Deliberately holds raw strings rather than a parsed jaap value: this is
// what the user typed, in whatever unit was active, and it is not ledger
// data until a save actually commits. Cleared only on a genuinely successful
// write (see updateTodayEntry) and on a date rollover (see renderToday).
let todayDraft = null;

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
    // See saveLedger() — an abort (typically QuotaExceededError) doesn't
    // fire onerror, and without this the promise never settles, so a
    // caller's try/catch would wait forever instead of reporting failure.
    tx.onabort = () => reject(tx.error || new Error("Sankalpa transaction aborted"));
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
        <input type="number" step="1"${idAttr} class="${className}" value="${malaValue}" placeholder="${tAttr("todayMalaPlaceholder")}">
      </label>
    `;
  }

  return `
    <label>
      ${t("todayJaapLabel")}<br>
      <input type="number"${idAttr} class="${className}" value="${entry.jaap ?? ""}" placeholder="${tAttr("todayJaapPlaceholder")}">
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

// Marks an entry as edited now. This is the only thing that decides which
// device wins when the same day has been edited in two places, so it must be
// called at EVERY site that changes an entry's jaap or notes — currently the
// Today Card save, the Ledger row save, and Mala Mode's commit.
//
// ISO strings rather than epoch numbers: they sort correctly under plain
// string comparison (so conflict resolution needs no parsing), and they stay
// readable in an exported JSON file, which matters for a format a sadhak may
// open and inspect.
//
// Deliberately NOT applied on import or restore. Those replace the whole
// ledger with entries from a file, and stamping them all "now" would make an
// old backup look freshly edited and let it overwrite newer data on the next
// sync. Entries with no stamp — every entry written before this existed, and
// everything in an older backup — are treated as the oldest possible, so a
// synced version wins over them.
function stampEntryEdited(entry) {
  if (entry) entry.updatedAt = new Date().toISOString();
}

// Missing/malformed stamps sort as oldest. Kept as a named function so the
// "no stamp means oldest" rule lives in one place rather than being spelled
// out at each comparison.
function entryEditedAt(entry) {
  const stamp = entry && entry.updatedAt;
  return typeof stamp === "string" ? stamp : "";
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
    renderSyncStatus();

    // The splash screen's own <img alt> was set synchronously by the
    // chooseSplashImage() IIFE at the very top of this file, long before
    // translations could have loaded — correct it now, in the (typical)
    // case where the splash is still on screen. lastSplashImage records
    // which image was actually chosen ("hanuman" or "customN").
    const splashImgEl = document.getElementById("splash-img");
    if (splashImgEl) {
      const lastSplashId = readStoredPreference("lastSplashImage");
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
    if (shouldShowSundayBackupReminder(todayISO, readStoredPreference("lastSundayBackupPromptDate"))) {
      openSundayBackupModal();
    }

    // First-run only — once a language is chosen (even explicitly English),
    // this is skipped on every subsequent load.
    if (!currentAppLanguage) {
      showLanguagePicker();
    }

    focusTodayInputIfRequested();

    // Deliberately NOT awaited: this may fetch the Firebase SDK over the
    // network, and the app must be usable the instant the ledger has
    // rendered. It is also a no-op for anyone who has never signed in, so
    // the common case costs nothing at all.
    restoreSyncSession();

  } catch (err) {
    console.error("Initialization failed:", err);
  }
})();

// Target of the manifest's "Log Today's Jaap" home-screen shortcut
// (?action=log). Scrolls the Today Card into view and focuses its count
// field, so the one thing a sadhak does every day is reachable in a single
// long-press from the home screen instead of a launch-and-scroll.
//
// The query string is deliberately left in place rather than cleaned up: on
// a standalone PWA launch it isn't visible anywhere, and rewriting the URL
// here would change start_url matching for no user-visible benefit.
function focusTodayInputIfRequested() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("action") !== "log") return;

  const input = document.getElementById("today-jaap");
  if (!input) return;

  input.scrollIntoView({ block: "center", behavior: "auto" });
  input.focus();
}

// todayISO is only refreshed at the top of renderToday() — a tab left open
// (or a backgrounded PWA left running) across midnight with no save/toggle/
// language-switch action in between would keep showing yesterday's date on
// the Today Card until some other action happened to trigger a re-render.
// Catch that by refreshing whenever the app is brought back to the
// foreground, which is exactly when a phone user re-opening the app across
// a day boundary would notice the staleness.
// Shared by both rollover paths below. The Sunday check has to happen here
// and not only in initApp(): a PWA left open across Saturday midnight never
// re-launches, so it would silently skip that week's reminder entirely —
// exactly the habitual user who leaves the app open is the one who'd never
// be prompted. shouldShowSundayBackupReminder() is already idempotent for a
// given day (lastSundayBackupPromptDate), so re-checking on every rollover
// cannot double-prompt.
function handleDateRollover() {
  renderToday();
  if (shouldShowSundayBackupReminder(todayISO, readStoredPreference("lastSundayBackupPromptDate"))) {
    openSundayBackupModal();
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;

  if (getTodayISO() !== todayISO) handleDateRollover();

  // "Opening the app" is mostly this, not a cold launch: an installed PWA is
  // resumed far more often than it is started, so a device left on the home
  // screen for a day would otherwise never see the other device's entries.
  // A no-op for anyone not signed in.
  syncNow();
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
    handleDateRollover();
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

    // See saveLedger() — an abort doesn't fire onerror, and an unsettled
    // promise here would hang the save path that awaits it.
    tx.onabort = () => {
      console.error("Backup transaction aborted", tx.error);
      reject(tx.error || new Error("Backup transaction aborted"));
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

  // A corrupt backup must be refused, not loaded. Restoring one with a
  // non-string `notes` used to crash the very next render (see
  // areLedgerEntriesValid) — and because renderToday() is the single render
  // entry point, that takes the entire app down, leaving the user no way
  // back even though their live ledger was still fine a moment earlier.
  if (!areLedgerEntriesValid(backup.entries)) {
    console.error("Refusing to restore a structurally invalid backup.");
    alert(t("ledgerBackupCorrupt"));
    return;
  }

  const confirmRestore = confirm(
    t("ledgerRestoreConfirm", {
      date: new Date(backup.backedUpAt).toLocaleString(),
      count: backup.entries.length,
    })
  );

  if (!confirmRestore) return;

  // Held so a failed write can put the live ledger back — otherwise a
  // restore that fails to persist leaves the user looking at the backup's
  // contents while the store still holds their real data, and the mismatch
  // only reveals itself on the next launch.
  const previousLedger = ledgerData;
  ledgerData = backup.entries;

  try {
    await saveLedger(ledgerData);

    // Older backups (taken before the Sankalpa was covered) have no sankalpa
    // field — restoring one must leave the user's current vow alone rather
    // than wiping it.
    if (backup.sankalpa) {
      await saveSankalpa(backup.sankalpa);
    }
  } catch (err) {
    ledgerData = previousLedger;
    console.error("Failed to restore from backup:", err);
    alert(t("ledgerRestoreFailed"));
    return;
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
      readStoredPreference("lastDriveBackupAt"),
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
  const previousToday = todayISO;
  todayISO = getTodayISO();
  // A draft belongs to the day it was typed on. If the date rolled over
  // underneath a card left open mid-edit, carrying it forward would drop
  // yesterday's half-written text into today's entry.
  if (todayISO !== previousToday) todayDraft = null;

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
    <!-- Newest milestone first. getMilestoneHistory() must return ascending
         order — it walks the ledger forward to compute each crossing's
         daysSincePrevious — so the reversal belongs here, at the point of
         display. Copy, never reverse() in place: this same array is handed to
         renderLedgerList() by renderToday(). That builds a Map from it, so a
         mutation would not visibly break anything today, which is exactly what
         would make it a nasty surprise later. Each line's daysSincePrevious
         still refers to the milestone before it chronologically, which is what
         the gap means regardless of display order. -->
    ${[...milestoneHistory].reverse().map(m => `
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

        <span class="ledger-jaap">${entry.jaap == null ? "—" : (malaViewEnabled ? formatAsMala(entry.jaap) : escapeHTML(String(entry.jaap)))}</span>

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

        // Re-check at SAVE time, not just at render time. The button was
        // rendered when this row was still inside the window, but a row
        // opened at 23:59 and saved at 00:01 is editing a day that has since
        // aged out — the render-time check alone can't see that.
        if (!isEditableEntry(entry.date)) {
          showToast(t("ledgerListEntryLocked"));
          renderToday();
          return;
        }

        const jaapInput = row.querySelector(".edit-jaap").value;
        const notesInput = row.querySelector(".edit-notes").value;

        const newJaap = computeJaapFromInput(jaapInput, entry.jaap);
        if (!isValidJaapValue(newJaap)) {
          showToast(t("commonInvalidNumber"));
          return;
        }

        // Same rollback capture as updateTodayEntry() — see its comment.
        const previousJaap = entry.jaap;
        const previousNotes = entry.notes;

        // Milestone state BEFORE this save, so a crossing that already
        // existed isn't celebrated again — see updateTodayEntry().
        const milestoneBefore = getCroreMilestone(entry.date);

        const previousStamp = entry.updatedAt;
        entry.jaap = newJaap;
        entry.notes = notesInput;
        stampEntryEdited(entry);

        // Editing a backdated (within-7-day) entry can cross a Crore boundary
        // just as saving today's entry can — previously only the Today Card
        // path checked this, so the same milestone crossing via a Ledger row
        // silently skipped the petal celebration.
        const crossedNewMilestone = didCrossNewMilestone(milestoneBefore, getCroreMilestone(entry.date));

        try {
          await saveLedger(ledgerData);
          await saveAutomaticBackup(ledgerData);
        } catch (err) {
          entry.jaap = previousJaap;
          entry.notes = previousNotes;
          // The stamp is part of the entry's state, so it rolls back too —
          // otherwise a failed write would leave the entry looking edited and
          // it would win a later sync conflict on the strength of a change
          // that never reached disk.
          entry.updatedAt = previousStamp;
          console.error("Failed to save ledger entry:", err);
          showToast(t("commonSaveFailed"));
          return;
        }

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
// ---------- Ledger notes search ----------
// Module-level so it survives renderLedgerList() rebuilds, which happen on
// every save/toggle/language switch — the same reason the Settings drawer's
// other stateful bits are kept out here. Without it, saving an entry while
// searching would silently drop the user back to the full ledger.
let ledgerSearchQuery = "";
let ledgerSearchDebounce = null;

// Pure: entries whose notes contain `query` (case-insensitive), newest
// first. Factored out so the matching rule is unit-testable without any
// DOM — entries with no notes can never match, which is why an empty query
// is treated as "no search" by the caller rather than "match everything".
function searchLedgerNotes(entries, query) {
  const needle = (query || "").trim().toLowerCase();
  if (!needle) return [];
  return entries
    .filter(e => typeof e.notes === "string" && e.notes.toLowerCase().includes(needle))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function wireLedgerSearchInput(input) {
  if (!input) return;

  input.addEventListener("input", (e) => {
    ledgerSearchQuery = e.target.value;
    clearTimeout(ledgerSearchDebounce);
    ledgerSearchDebounce = setTimeout(() => {
      // Re-render only the ledger, not the whole app: nothing above it
      // depends on the query, and a full renderToday() would rebuild the
      // Today Card the user might be mid-edit in.
      renderLedgerList(getMilestoneHistory(ledgerData));
      // The input above was just destroyed and rebuilt, so put the caret
      // back where the user left it or they'd be typing into a dead field.
      const fresh = document.getElementById("ledger-search");
      if (fresh) {
        fresh.focus();
        fresh.setSelectionRange(fresh.value.length, fresh.value.length);
      }
    }, 200);
  });
}

// Flat, newest-first list of matches, rendered straight from ledgerData.
// Deliberately read-only: this view answers "what did I write about X",
// and keeping the editable row machinery (and its save handlers, 7-day
// window, milestone re-checks) out of it avoids duplicating that logic in
// a second place. Clearing the search returns to the normal ledger, where
// anything still editable can be edited as usual.
function renderLedgerSearchResults(container, entries) {
  const matches = searchLedgerNotes(entries, ledgerSearchQuery);

  const results = document.createElement("div");
  results.className = "ledger-search-results";

  if (matches.length === 0) {
    results.innerHTML = `<p class="ledger-search-empty">${t("ledgerSearchNoResults")}</p>`;
    container.appendChild(results);
    return;
  }

  results.innerHTML = `
    <p class="ledger-search-count">${
      matches.length === 1
        ? t("ledgerSearchOneResult")
        : t("ledgerSearchResultCount", { count: matches.length })
    }</p>
    ${matches.map(entry => `
      <div class="ledger-search-result">
        <div class="ledger-search-result-head">
          <span class="ledger-date">
            ${formatDate(entry.date)}${hasExplicitPoornima(entry.notes) ? " 🌕" : ""}
          </span>
          <span class="ledger-jaap-static">${entry.jaap == null ? "—" : formatTotal(entry.jaap)}</span>
        </div>
        <div class="ledger-search-result-note">${escapeHTML(entry.notes)}</div>
      </div>
    `).join("")}
  `;

  container.appendChild(results);
}

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

  // Notes search box. Always present; when it holds a query the year
  // accordions below are replaced by a flat result list (see the early
  // return further down). Built from ledgerData rather than by filtering
  // rendered rows, which matters because non-current years have no row DOM
  // at all until expanded (see the lazy-build note on this function).
  const searchBar = document.createElement("div");
  searchBar.className = "ledger-search-bar";
  searchBar.innerHTML = `
    <input
      type="search"
      id="ledger-search"
      class="ledger-search-input"
      placeholder="${tAttr("ledgerSearchPlaceholder")}"
      aria-label="${tAttr("ledgerSearchPlaceholder")}"
    >
  `;
  container.appendChild(searchBar);

  // Set via the property, never interpolated into the markup above:
  // escapeHTML() deliberately doesn't escape quotes (see its own comment),
  // so a query containing one would break out of a value="" attribute.
  const searchInput = searchBar.querySelector("#ledger-search");
  searchInput.value = ledgerSearchQuery;
  wireLedgerSearchInput(searchInput);

  if (ledgerSearchQuery.trim()) {
    renderLedgerSearchResults(container, filtered);
    return;
  }

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

  // Which field the user was in, and where their caret sat, before this
  // rebuild destroys it — restored at the end, the same way
  // wireLedgerSearchInput() already does for the search box. Without it, a
  // re-render mid-typing drops focus and the user carries on typing into
  // nothing. selectionStart is null on <input type="number">, which is what
  // the null check below accounts for.
  const active = document.activeElement;
  const focusedId =
    active && (active.id === "today-jaap" || active.id === "today-notes") ? active.id : null;
  const caret =
    focusedId && typeof active.selectionStart === "number" ? active.selectionStart : null;

  // Only rendered when there's a real memory to show (see getOnThisDayEntry).
  const onThisDay = getOnThisDayEntry(entry.date);

  container.innerHTML = `
    <h2>${t("todayHeading")}${hasExplicitPoornima(entry.notes) ? " 🌕" : ""}</h2>

    <p><strong>${formatDateLong(entry.date)}</strong></p>

    ${onThisDay ? `
      <p class="on-this-day">${
        onThisDay.yearsAgo === 1
          ? t("todayOnThisDayOneYear", { count: formatTotal(onThisDay.jaap) })
          : t("todayOnThisDayYears", { years: onThisDay.yearsAgo, count: formatTotal(onThisDay.jaap) })
      }</p>
    ` : ""}

    ${renderJaapInputField(entry, { id: "today-jaap" })}

    <br><br>

    <label>
      ${t("commonNotesLabel")}<br>
      <textarea
        id="today-notes"
        class="edit-notes"
        rows="3"
        placeholder="${tAttr("commonNotesPlaceholder")}"
      >${escapeHTML(entry.notes || "")}</textarea>
    </label>

    <br>

    <!-- Always a save button, never a "locked" message. This entry comes
         from ensureTodayEntryExists(), so entry.date === todayISO always
         holds and the locked branch that used to live here could never
         render. It was worse than merely dead: had it ever rendered,
         #update-today would not exist and the unguarded addEventListener
         below would have thrown mid-render, taking the Reflection Summary
         and the whole Ledger List down with it. The 7-day window still
         governs the *ledger rows*, via isEditableEntry() in
         buildYearRows(). -->
    <button id="update-today">${t("todaySaveBtn")}</button>


  `;

  const jaapEl = document.getElementById("today-jaap");
  const notesEl = document.getElementById("today-notes");

  // An in-progress draft wins over the stored entry — the markup above was
  // built from what's saved, which is precisely what we must not show the
  // user back while they're still mid-edit. Set as properties, never
  // interpolated into the template: escapeHTML() doesn't escape quotes.
  if (todayDraft) {
    if (jaapEl) jaapEl.value = todayDraft.jaap;
    if (notesEl) notesEl.value = todayDraft.notes;
  }

  const captureDraft = () => {
    todayDraft = {
      jaap: jaapEl ? jaapEl.value : "",
      notes: notesEl ? notesEl.value : "",
    };
  };
  jaapEl?.addEventListener("input", captureDraft);
  notesEl?.addEventListener("input", captureDraft);

  if (focusedId) {
    const refocus = document.getElementById(focusedId);
    if (refocus) {
      refocus.focus();
      if (caret !== null && typeof refocus.setSelectionRange === "function") {
        refocus.setSelectionRange(caret, caret);
      }
    }
  }

  // Null-guarded even though the button is now unconditional — matching the
  // `if (saveBtn)` guard buildYearRows() already uses. A render function
  // should degrade, not take the entire page down, if its own markup ever
  // changes underneath it.
  const saveTodayBtn = document.getElementById("update-today");
  if (saveTodayBtn) saveTodayBtn.addEventListener("click", updateTodayEntry);
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

  // Captured before the mutation so a failed write can put memory back the
  // way it was. Without this, entry.jaap/entry.notes are assigned before the
  // await and simply stay assigned when the write fails — leaving ledgerData
  // ahead of what's actually on disk, so every total on screen reflects a
  // value that was never persisted and vanishes on the next launch.
  const previousJaap = entry.jaap;
  const previousNotes = entry.notes;
  const previousStamp = entry.updatedAt;

  // Milestone state BEFORE the mutation. Without this, re-saving an entry
  // that had ALREADY crossed a Crore boundary — changing only the note, or
  // just tapping Save twice — re-fired the whole 96-petal celebration, since
  // getCroreMilestone() reports that the crossing exists, not that this save
  // created it. Keep in step with the Ledger row handler in buildYearRows().
  const milestoneBefore = getCroreMilestone(entry.date);

  entry.jaap = newJaap;
  entry.notes = notesInput;
  stampEntryEdited(entry);

  const crossedNewMilestone = didCrossNewMilestone(milestoneBefore, getCroreMilestone(entry.date));

  try {
    await saveLedger(ledgerData);
    await saveAutomaticBackup(ledgerData);
  } catch (err) {
    // Roll back, then tell the user plainly. Deliberately no re-render: the
    // card still shows what they typed (and todayDraft still holds it), so
    // they can correct or retry without losing the entry they just wrote.
    entry.jaap = previousJaap;
    entry.notes = previousNotes;
    entry.updatedAt = previousStamp;
    console.error("Failed to save today's entry:", err);
    showToast(t("commonSaveFailed"));
    return;
  }

  // Only once the write has genuinely committed: drop the draft, confirm,
  // and celebrate. Previously all three ran regardless of whether the save
  // succeeded, because nothing could report that it hadn't.
  todayDraft = null;
  renderToday();
  showToast(t("commonSavedToast"));

  if (crossedNewMilestone) {
    celebrateMilestone();
  }
}

// Add n jaap to today's entry, without touching its notes. Used by Mala Mode,
// which commits each completed mala as it happens and the remainder on exit.
//
// ADDITIVE, never replacing: a sadhak may already have saved a count through
// the Today Card before sitting down with the mala, and that must survive.
//
// Honours the same contract as updateTodayEntry() — read its comments for the
// reasoning behind each step; the notes below cover only what differs here.
//
// Returns true if the write committed, false if it failed and was rolled back.
// Callers must treat false as "those beads are still uncounted" and keep them,
// rather than assuming the total is banked.
async function addJaapToToday(n) {
  if (!Number.isFinite(n) || n <= 0) return false;

  // Refreshed immediately before the write, exactly as updateTodayEntry()
  // does. This matters more here than anywhere else in the app: a practice
  // session can easily run across local midnight, and without this the beads
  // counted after midnight would be added to yesterday's entry.
  todayISO = getTodayISO();
  const entry = ensureTodayEntryExists();

  const previousJaap = entry.jaap;
  const previousStamp = entry.updatedAt;
  const milestoneBefore = getCroreMilestone(entry.date);

  // entry.jaap is null on a day nothing has been logged yet.
  const newJaap = (entry.jaap || 0) + n;
  if (!isValidJaapValue(newJaap)) {
    showToast(t("commonInvalidNumber"));
    return false;
  }
  entry.jaap = newJaap;
  stampEntryEdited(entry);

  const crossedNewMilestone = didCrossNewMilestone(milestoneBefore, getCroreMilestone(entry.date));

  try {
    await saveLedger(ledgerData);
    await saveAutomaticBackup(ledgerData);
  } catch (err) {
    entry.jaap = previousJaap;
    entry.updatedAt = previousStamp;
    console.error("Failed to add jaap to today's entry:", err);
    showToast(t("commonSaveFailed"));
    return false;
  }

  // The entry has changed underneath any half-typed Today Card input, so the
  // draft is now stale and must go: computeJaapFromInput("") returns null and
  // null is a VALID jaap, so a later Save from a stale draft would not merely
  // overwrite the session — it could blank the day entirely. Mala Mode warns
  // before opening if a draft exists, precisely because clearing it here also
  // discards unsaved notes.
  todayDraft = null;

  if (crossedNewMilestone) {
    celebrateMilestone();
  }
  return true;
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
  // Warm the Firebase SDK here rather than at the sign-in tap. See
  // prepareSyncSdk() for why that distinction decides whether sign-in works
  // at all. Opening Settings is a deliberate act, so the launch path stays
  // free of any cross-origin request.
  if (isOpen) prepareSyncSdk();
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

  // An unsaved draft holds what the user typed in the unit that was active
  // when they typed it. Now that the unit has changed, the same digits would
  // mean a completely different quantity — 500 jaap silently becoming 500
  // mala (54,000 jaap) — so convert rather than reinterpret. Non-numeric or
  // empty input is left exactly as typed; it isn't a quantity yet.
  if (todayDraft && todayDraft.jaap !== "") {
    const typed = Number(todayDraft.jaap);
    if (Number.isFinite(typed)) {
      todayDraft = {
        ...todayDraft,
        jaap: String(malaViewEnabled ? jaapToMala(typed) : malaToJaap(typed)),
      };
    }
  }

  writeStoredPreference("malaViewEnabled", String(malaViewEnabled));
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
    writeStoredPreference("backgroundChoice", backgroundChoice);
    updateBackgroundSwatchButtons();
  });
});

updateBackgroundSwatchButtons();

// ---------- Text size buttons ----------

function updateTextSizeButtons() {
  document.querySelectorAll(".text-size-btn").forEach((btn) => {
    const isActive = btn.dataset.size === textSizeChoice;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

document.querySelectorAll(".text-size-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const choice = btn.dataset.size;
    if (choice === textSizeChoice) return;
    applyTextSize(choice);
    // Guarded like appLanguage — a throw would abort the rest of this
    // handler, leaving the buttons out of sync with the size actually
    // applied.
    if (!writeStoredPreference("textSize", textSizeChoice)) {
      showToast(t("langErrQuota"));
    }
    updateTextSizeButtons();
  });
});

updateTextSizeButtons();

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
  renderSankalpaPageSafely();
}

function closeSankalpaPage() {
  const page = document.getElementById("sankalpa-page");
  if (!page) return;
  page.classList.remove("open");
  page.setAttribute("aria-hidden", "true");
}

// ---------- Sumiran-Lite: Mala Mode ----------
//
// A full-screen bead counter for sitting practice. Distinct from "Mala View"
// (the header toggle, malaViewEnabled), which only changes how counts are
// DISPLAYED — this is an input method.
//
// Persistence deliberately has no session store of its own. Each completed
// mala is committed straight into today's ledger entry via addJaapToToday(),
// and the remainder on exit. That keeps the tap path free of any I/O, leaves
// the export payload and DB schema untouched (so existing backups keep
// importing), and bounds what an app kill can lose to a single incomplete
// mala — the same thing that happens when you lose your place on a real mala.

const MALA_DIAL_R = 112;
const MALA_DIAL_CX = 140;
const MALA_DIAL_CY = 140;
const MALA_DIAL_CIRCUMFERENCE = 2 * Math.PI * MALA_DIAL_R;
const MALA_GURU_TURN_MS = 950;

// Beads counted since the last commit (0..MALA_SIZE-1). Malas completed this
// sitting, for display only. `malaBusy` blocks taps while a commit or the Guru
// Manka turn is in flight.
let malaBeadCount = 0;
let malaSessionMalas = 0;
let malaBusy = false;
let malaWakeLock = null;

function beadToDotPos(bead) {
  const angle = (bead / MALA_SIZE) * 2 * Math.PI - Math.PI / 2;
  return {
    cx: MALA_DIAL_CX + MALA_DIAL_R * Math.cos(angle),
    cy: MALA_DIAL_CY + MALA_DIAL_R * Math.sin(angle),
  };
}

function beadToOffset(bead) {
  return MALA_DIAL_CIRCUMFERENCE - (bead / MALA_SIZE) * MALA_DIAL_CIRCUMFERENCE;
}

// Paints the dial directly rather than going through renderToday(), which
// rebuilds the entire app beneath this overlay.
function paintMalaDial(bead) {
  const ring = document.getElementById("mala-ring");
  const dot = document.getElementById("mala-dot");
  const label = document.getElementById("mala-bead-count");
  if (ring) {
    ring.style.strokeDasharray = MALA_DIAL_CIRCUMFERENCE;
    ring.style.strokeDashoffset = beadToOffset(bead);
  }
  if (dot) {
    const pos = beadToDotPos(bead);
    dot.setAttribute("cx", pos.cx);
    dot.setAttribute("cy", pos.cy);
  }
  if (label) label.textContent = String(bead);
}

// Both numbers derive from the ledger plus the uncommitted beads, never from
// a session counter. Reopening Mala Mode after a completed sitting therefore
// shows the malas already done today rather than starting from zero — the
// count belongs to the day's practice, not to this visit to the screen.
function paintMalaStats() {
  const entry = ledgerData.find((e) => e.date === todayISO);
  const banked = entry && entry.jaap ? entry.jaap : 0;
  const total = banked + malaBeadCount;
  const malasToday = jaapToMala(total);

  const malas = document.getElementById("mala-count");
  const malasLabel = document.getElementById("mala-count-label");
  const todayTotal = document.getElementById("mala-today-total");

  if (malas) malas.textContent = formatIndianNumber(malasToday);
  if (malasLabel) {
    malasLabel.textContent = t(malasToday === 1 ? "malaModeMalaLabelOne" : "malaModeMalasLabel");
  }
  // Deliberately raw jaap even in Mala View: the malas are already shown
  // beside it, so repeating them here would say the same thing twice.
  if (todayTotal) todayTotal.textContent = formatIndianNumber(total);

  const undoBtn = document.getElementById("mala-undo-btn");
  if (undoBtn) undoBtn.disabled = malaBeadCount === 0;
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// The lead dot travels the full circle back to the Guru Manka at 12 o'clock.
function animateGuruTurn() {
  return new Promise((resolve) => {
    const dot = document.getElementById("mala-dot");
    if (!dot || prefersReducedMotion()) {
      paintMalaDial(0);
      resolve();
      return;
    }
    paintMalaDial(MALA_SIZE);
    const start = performance.now();
    const from = 3 * Math.PI / 2;
    const to = -Math.PI / 2;
    function step(now) {
      const t = Math.min((now - start) / MALA_GURU_TURN_MS, 1);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const angle = from + (to - from) * eased;
      dot.setAttribute("cx", MALA_DIAL_CX + MALA_DIAL_R * Math.cos(angle));
      dot.setAttribute("cy", MALA_DIAL_CY + MALA_DIAL_R * Math.sin(angle));
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        paintMalaDial(0);
        resolve();
      }
    }
    requestAnimationFrame(step);
  });
}

// Commit a full mala. Kept separate from counting so a failed write can be
// retried by tapping again, without that tap also counting a further bead.
async function commitCompletedMala() {
  malaBusy = true;
  const committed = await addJaapToToday(MALA_SIZE);
  if (!committed) {
    // The beads stay counted and the dial stays full: the sadhak can tap to
    // retry, or exit (which re-attempts the same commit). Nothing is lost to
    // a failed write.
    malaBusy = false;
    return;
  }

  malaBeadCount = 0;
  malaSessionMalas++;
  paintMalaStats();

  const counter = document.getElementById("mala-count");
  if (counter) {
    counter.classList.add("mala-tick");
    setTimeout(() => counter.classList.remove("mala-tick"), 320);
  }

  await animateGuruTurn();
  malaBusy = false;
}

async function countMalaBead() {
  if (malaBusy) return;

  // A previous commit failed and left a full mala pending. Retry it rather
  // than counting a 109th bead — otherwise the dial and the counter drift
  // apart, and the next commit would bank 108 for a mala that had been
  // tapped more times than that.
  if (malaBeadCount >= MALA_SIZE) {
    await commitCompletedMala();
    return;
  }

  malaBeadCount++;
  paintMalaDial(malaBeadCount);
  paintMalaStats();

  if (malaBeadCount >= MALA_SIZE) {
    await commitCompletedMala();
  }
}

// Correcting a mis-tap. Only ever walks back beads that have NOT been
// committed — a completed mala is already in the ledger, and silently
// subtracting from a saved entry is a different and more dangerous operation
// than undoing an uncommitted tap.
function undoMalaBead() {
  if (malaBusy || malaBeadCount === 0) return;
  malaBeadCount--;
  paintMalaDial(malaBeadCount);
  paintMalaStats();
}

async function requestMalaWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    malaWakeLock = await navigator.wakeLock.request("screen");
  } catch {
    malaWakeLock = null; // denied, or unavailable in this context
  }
}

// The browser drops a screen wake lock whenever the page is hidden, and never
// restores it. Without re-requesting, the screen starts sleeping again mid-
// practice after any interruption.
async function handleMalaVisibilityChange() {
  const page = document.getElementById("mala-page");
  if (!page || !page.classList.contains("open")) return;
  if (document.visibilityState === "visible") await requestMalaWakeLock();
}

async function releaseMalaWakeLock() {
  if (!malaWakeLock) return;
  try {
    await malaWakeLock.release();
  } catch {
    /* already released by the browser */
  }
  malaWakeLock = null;
}

async function openMalaPage() {
  // Clearing the draft on commit also discards unsaved notes, so ask first
  // rather than silently dropping words the sadhak has typed.
  if (todayDraft && (todayDraft.jaap !== "" || todayDraft.notes !== "")) {
    if (!confirm(t("malaModeDraftWarning"))) return;
  }

  const page = document.getElementById("mala-page");
  if (!page) return;

  malaBeadCount = 0;
  malaSessionMalas = 0;
  malaBusy = false;

  // Reuse the splash rotation pool so the practice screen shows the deity the
  // sadhak chose. Same never-repeat rule as chooseSplashImage(): exclude the
  // last image shown here, so opening Mala Mode repeatedly actually rotates
  // rather than landing on the same picture again and again. Tracked under
  // its own key, so Mala Mode and the splash rotate independently.
  const pool = resolveSplashRotationPool();
  const lastId = readStoredPreference("lastMalaImage");
  const candidates = pool.filter((r) => r.id !== lastId);
  const chosenFrom = candidates.length > 0 ? candidates : pool;
  const chosen = chosenFrom[Math.floor(Math.random() * chosenFrom.length)];

  const source = document.getElementById("mala-deity-source");
  const img = document.getElementById("mala-deity-img");
  if (chosen && chosen.custom) {
    // <source srcset> beats <img src> in a <picture>, so a custom (data URL)
    // pick must clear it or the bundled webp silently wins.
    if (source) source.removeAttribute("srcset");
    if (img) img.src = chosen.dataUrl;
  } else if (chosen) {
    if (source) source.srcset = chosen.webp;
    if (img) img.src = chosen.png;
  }
  if (chosen) writeStoredPreference("lastMalaImage", chosen.id);

  page.classList.add("open");
  page.setAttribute("aria-hidden", "false");
  document.body.classList.add("loading"); // reuse the existing scroll lock

  paintMalaDial(0);
  paintMalaStats();
  await requestMalaWakeLock();
}

async function closeMalaPage() {
  const page = document.getElementById("mala-page");

  // Commit the partial mala. If it fails, keep the page open and the beads
  // counted — exiting would silently discard them.
  if (malaBeadCount > 0) {
    const committed = await addJaapToToday(malaBeadCount);
    if (!committed) return;
    malaBeadCount = 0;
  }

  await releaseMalaWakeLock();

  if (page) {
    page.classList.remove("open");
    page.setAttribute("aria-hidden", "true");
  }
  document.body.classList.remove("loading");

  // One re-render for the whole sitting, rather than one per mala.
  renderToday();
  if (malaSessionMalas > 0) {
    showToast(t("malaModeSavedToast", { malas: formatIndianNumber(malaSessionMalas) }));
  }
  malaSessionMalas = 0;
}

document.getElementById("mala-mode-fab")?.addEventListener("click", () => {
  openMalaPage().catch((err) => {
    console.error("Could not open Mala Mode:", err);
    showToast(t("commonSaveFailed"));
  });
});
document.getElementById("mala-tap-area")?.addEventListener("pointerdown", () => {
  countMalaBead().catch((err) => {
    console.error("Mala bead count failed:", err);
    malaBusy = false;
  });
});
document.getElementById("mala-undo-btn")?.addEventListener("click", undoMalaBead);
document.getElementById("mala-exit-btn")?.addEventListener("click", () => {
  closeMalaPage().catch((err) => {
    console.error("Could not close Mala Mode:", err);
    showToast(t("commonSaveFailed"));
  });
});
document.addEventListener("visibilitychange", handleMalaVisibilityChange);

// renderSankalpaPage() is async and writes ALL of the page's markup — close
// button included — only after its first await on getSankalpa(). Called bare,
// a rejection there (IndexedDB blocked or unavailable) left the user sealed
// inside an empty full-screen overlay with nothing to tap, and the only
// trace an unhandled rejection in the console. Every call site goes through
// this instead: report, and close the page rather than stranding anyone in it.
function renderSankalpaPageSafely() {
  return renderSankalpaPage().catch((err) => {
    console.error("Could not render the Sankalpa page:", err);
    showToast(t("sankalpaLoadFailed"));
    closeSankalpaPage();
  });
}

async function renderSankalpaPage() {
  const page = document.getElementById("sankalpa-page");
  if (!page) return;

  const sankalpa = await getSankalpa();

  if (!sankalpa) {
    page.innerHTML = `
      <div class="fullscreen-header">
        <h2>${t("sankalpaHeading")}</h2>
        <button id="sankalpa-close" class="fullscreen-close" aria-label="${tAttr("commonCloseAria")}">✕</button>
      </div>
      <div class="sankalpa-body">
        <p class="sankalpa-intro">${t("sankalpaIntro")}</p>

        <label>
          ${t("sankalpaHeading")}<br>
          <textarea id="sankalpa-text" class="edit-notes" rows="4" placeholder="${tAttr("sankalpaVowPlaceholder")}"></textarea>
        </label>

        <br><br>

        <label>
          ${t("sankalpaContextLabel")}<br>
          <input type="text" id="sankalpa-context" class="edit-jaap" placeholder="${tAttr("sankalpaContextPlaceholder")}">
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
      // Same reasoning as the ledger save paths: an unguarded await in a
      // click handler turns a failed write into an unhandled rejection with
      // no user feedback at all — the vow would appear to vanish. Confirm
      // only after the write has genuinely committed.
      try {
        await saveSankalpa({ text, context, date: getTodayISO() });
      } catch (err) {
        console.error("Failed to establish the Sankalpa:", err);
        showToast(t("commonSaveFailed"));
        return;
      }
      showToast(t("sankalpaEstablishedToast"));
      renderSankalpaPageSafely();
    });

    page.querySelector("#sankalpa-close").addEventListener("click", closeSankalpaPage);
    return;
  }

  page.innerHTML = `
    <div class="fullscreen-header">
      <h2>${t("sankalpaHeading")}</h2>
      <button id="sankalpa-close" class="fullscreen-close" aria-label="${tAttr("commonCloseAria")}">✕</button>
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
    // Guarded like the establish path above: a failed rewrite must say so,
    // not silently leave the old vow in place while looking like it worked.
    try {
      await saveSankalpa({ text, context, date: sankalpa.date });
    } catch (err) {
      console.error("Failed to rewrite the Sankalpa:", err);
      showToast(t("commonSaveFailed"));
      return;
    }
    showToast(t("sankalpaRewrittenToast"));
    renderSankalpaPageSafely();
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
      notes: e.notes || "",
      // Carried only when it exists, so entries written before stamping was
      // added stay byte-for-byte what they were and no `updatedAt: undefined`
      // appears in an exported file. Sync needs the stamp to travel with the
      // data; a Drive backup benefits too, since restoring one onto a new
      // device would otherwise present every entry as never-edited.
      ...(typeof e.updatedAt === "string" ? { updatedAt: e.updatedAt } : {})
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
    // Only a genuinely parseable date survives. A hand-edited or truncated
    // one used to be passed through as "", which formatDate() then rendered
    // as "undefined undefined NaN" on the Sankalpa page. Dropping it to ""
    // here is safe now that formatDate() returns "" for unparseable input —
    // the date line simply renders empty rather than wrong.
    date: isParsableISODate(sankalpa.date) ? sankalpa.date : ""
  };
}

// Normalizes a parsed import file into { entries, sankalpa }, accepting BOTH
// the current object payload and the legacy bare-array format that every
// export before v2 produced. Without the legacy branch, every file a user
// exported previously would become unimportable — so this compatibility is
// not optional. Returns null for anything that isn't a recognizable ledger
// file; per-entry validation is the caller's job.
// True only if every entry is structurally sound. Pure, so it's directly
// unit-testable, and shared by all three paths that can put foreign data
// into ledgerData: Import, Restore from Backup, and the backup-recovery
// branch of loadLedgerFromDB().
//
// Only Import validated before. The other two applied nothing but an
// Array.isArray check, so the exact crash this guard exists to prevent — a
// non-string `notes` blowing up hasExplicitPoornima()'s notes.toLowerCase()
// on the very next render, taking the whole app down since renderToday() is
// the single render entry point — was reachable through a different door.
//
// Deliberately NOT checked here: `entry.date <= todayISO`. Import enforces
// that separately, because accepting a future-dated entry from a file the
// user chose is a different question from rejecting one already sitting in
// their own backup, where dropping it would mean silent data loss on a
// device whose clock has since been corrected.
function areLedgerEntriesValid(entries) {
  if (!Array.isArray(entries)) return false;

  const seenDates = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") return false;
    if (typeof entry.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return false;
    if (!("jaap" in entry) || !isValidJaapValue(entry.jaap)) return false;
    if (typeof entry.notes !== "string") return false;
    if (seenDates.has(entry.date)) return false;
    seenDates.add(entry.date);
  }
  return true;
}

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

  // Held for the same reason as restoreFromBackup()'s: the catch below
  // already reported failures, but it left ledgerData holding the imported
  // entries even when they never reached disk. Harmless no-op when the
  // failure happened before the swap (a parse error, say).
  const previousLedger = ledgerData;

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

    // Shared structural validation (see areLedgerEntriesValid), plus the one
    // rule that is specific to importing a file the user chose: no future
    // dates. Restore and backup-recovery deliberately don't apply that part
    // — see the note on areLedgerEntriesValid.
    if (
      !areLedgerEntriesValid(importedData) ||
      importedData.some(entry => entry.date > todayISO)
    ) {
      alert(t("ledgerInvalidEntryFormat"));
      return;
    }

    const confirmReplace = confirm(t("ledgerImportConfirm", { count: importedData.length }));

    if (!confirmReplace) {
      importInput.value = ""; // reset
      return;
    }

    // Snapshot the CURRENT ledger before overwriting it. This used to run
    // after the replace, which overwrote the backup with the imported data in
    // the same breath, so the replaced data was gone immediately. Taking it
    // first is strictly better and is the best protection available at this
    // moment.
    //
    // But be precise about what it buys, because an earlier version of this
    // comment claimed a guarantee the code does not provide: there is exactly
    // ONE backup slot (saveAutomaticBackup writes the same "latest" key on
    // every single save), so this snapshot survives only until the next save.
    // Restore can therefore undo a mistaken import only if nothing has been
    // saved since. Once the user saves an entry, the pre-import ledger is
    // unrecoverable from here. Export remains the only durable escape hatch.
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
    ledgerData = previousLedger;
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
//
// The cached promise is cleared on failure. It used to be kept forever, so a
// single failed load — a tunnel, a dropped connection, airplane mode — made
// every backup attempt for the rest of the session fail instantly from the
// cached rejection, without ever retrying. That is precisely backwards for a
// feature whose whole purpose is to work once the network comes back, and
// the user's only recourse was to relaunch the app.
//
// The old `existing` branch is gone with it: it attached load/error
// listeners to a script that had already finished loading, so those events
// had fired long before and the promise would simply hang forever. It was
// also unreachable in practice, since the only way a tagged script exists is
// if this function put it there, in which case the memo above already
// returned. A stale tag CAN survive a cleared memo now, so remove it before
// injecting a fresh one rather than accumulating dead tags.
function loadGoogleIdentityScript() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    return Promise.resolve();
  }
  if (googleIdentityScriptPromise) return googleIdentityScriptPromise;

  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const stale = document.querySelector("script[data-google-identity]");
    if (stale) stale.remove();

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(t("backupErrLoadGis")));
    document.head.appendChild(script);
  }).catch((err) => {
    googleIdentityScriptPromise = null; // let the next attempt genuinely retry
    throw err;
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
//
// Guarded, like recordSuccessfulDriveBackup() below already was. It matters
// more here, not less, because of where this is called from: every dismiss
// route (✕, "Remind me next Sunday", backdrop click) ran this BEFORE
// closing the modal, so a quota throw meant the modal could not be closed
// at all — a full-screen backdrop with no way past it, on a device whose
// storage is already full. It also runs after a successful upload, where a
// throw would have reported a backup failure that had in fact succeeded.
function markSundayBackupHandled() {
  writeStoredPreference("lastSundayBackupPromptDate", todayISO);
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
  // Close FIRST. markSundayBackupHandled() is guarded and can no longer
  // throw, but dismissing a modal must not depend on a storage write
  // succeeding at all — the user asked to be left alone, and that has to
  // work whatever the state of their storage. Belt and braces, deliberately.
  closeSundayBackupModal();
  markSundayBackupHandled();
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


// ---------- Service Worker registration ----------
// Registered with a RELATIVE url on purpose: this app is served from
// https://arijeetkundu.github.io/jaap-ledger/ in production but from / when
// served locally, and an absolute "/sw.js" would 404 (and take the wrong
// scope) on GitHub Pages. "./sw.js" resolves against the document, giving
// the correct scope in both places.
//
// Deferred to the load event so registration — and the install-time
// precache fetches it kicks off — never competes with the app's own first
// paint and bootstrap for bandwidth.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      // Non-fatal by design: without a service worker the app still works
      // exactly as it did before, just without offline launch capability.
      console.warn("Service worker registration failed:", err);
    });
  });
}



// ---------- Sumiran-Lite: Sync Across Devices (Firebase) ----------
//
// The app's SECOND network dependency, after Google Drive backup — and, like
// it, entirely dormant until a sadhak signs in. Nothing here loads, runs or
// reaches the network on a normal launch.
//
// This slice deliberately does sign-in ONLY. No ledger data moves yet: the
// point is to prove the sign-in survives an installed iOS PWA before push,
// pull and merge are built on top of it, because signInWithPopup is known to
// be unreliable in Safari standalone and that would change the design.
//
// The config below is NOT a secret, despite `apiKey`. It identifies the
// project; it authorises nothing. It ships in every client that loads the app
// and Google documents it as public. What actually protects the ledger is the
// Firestore security rule (a request must carry a signed-in uid matching the
// document path) and the authorized-domain list — both server-side, neither
// bypassable by editing this file. Sumiran keeps the same values in Vite env
// vars, which only looks more private: Vite inlines them into the bundle.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBuDaio69MbWQ_Nkt1ezP20WlIQsI90O_U",
  authDomain: "sumiran-lite-83668.firebaseapp.com",
  projectId: "sumiran-lite-83668",
  storageBucket: "sumiran-lite-83668.firebasestorage.app",
  messagingSenderId: "407718825196",
  appId: "1:407718825196:web:f0481811df6aac192529c9",
};

const FIREBASE_SDK_VERSION = "12.4.0";
const FIREBASE_SDK_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;

let firebaseAuthPromise = null;
let syncUser = null;

// The RESOLVED SDK, not a promise. Its existence is what lets the click
// handler reach signInWithPopup() without awaiting anything first — see
// signInForSync() for why that is the difference between working and not.
let firebaseAuthReady = null;

// Lazily pulls in the Firebase SDK, mirroring loadGoogleIdentityScript().
// Two reasons this must stay lazy rather than a <script> in index.html:
// the auth module alone is ~159KB, and sw.js deliberately never caches
// cross-origin requests — so a bundle loaded up front would be fetched from
// the network on every launch and would fail outright when offline, breaking
// the app's central promise for a feature most launches never use.
//
// app.js is a classic script, but dynamic import() works in one, which is
// what lets an ES-module SDK be used here at all.
function loadFirebaseAuth() {
  if (firebaseAuthPromise) return firebaseAuthPromise;

  firebaseAuthPromise = (async () => {
    const [{ initializeApp }, auth] = await Promise.all([
      import(`${FIREBASE_SDK_BASE}/firebase-app.js`),
      import(`${FIREBASE_SDK_BASE}/firebase-auth.js`),
    ]);
    const app = initializeApp(FIREBASE_CONFIG);
    firebaseAuthReady = { app, auth, instance: auth.getAuth(app) };
    return firebaseAuthReady;
  })().catch((err) => {
    firebaseAuthPromise = null; // so the next attempt genuinely retries
    throw err;
  });

  return firebaseAuthPromise;
}

// Warms the SDK ahead of the sign-in tap, and reflects readiness in the
// button. Called when the Settings drawer opens.
//
// This exists because of the bug that sank the first attempt. Browsers only
// permit window.open() synchronously inside a user gesture. The old click
// handler awaited the SDK's network fetch FIRST and only then called
// signInWithPopup() — by which point the gesture was spent, Safari silently
// refused the window, and Firebase hung forever waiting for a popup that was
// never going to appear. No error, no popup, just a dead button.
//
// The full Sumiran app bundles Firebase, so its popup call is already
// synchronous with the tap; that is the entire difference between the two
// apps, not anything about iOS.
//
// Failure is silent on purpose: being offline is normal for this app, and
// Settings must open regardless. The button simply stays unavailable.
function prepareSyncSdk() {
  if (firebaseAuthReady) {
    renderSyncStatus();
    return;
  }
  renderSyncStatus();
  loadFirebaseAuth()
    .then(() => renderSyncStatus())
    .catch(() => renderSyncStatus());
}

function renderSyncStatus() {
  const statusEl = document.getElementById("sync-status");
  const btn = document.getElementById("sync-signin-btn");
  if (!statusEl || !btn) return;

  if (syncUser) {
    statusEl.textContent = t("syncSignedInAs", { email: syncUser.email || "" });
    btn.textContent = t("syncSignOutBtn");
    btn.disabled = false;
    return;
  }

  btn.textContent = t("syncSignInBtn");
  // Signing in is unavailable until the SDK is in memory, because the popup
  // must open synchronously from the tap. Saying so is better than letting
  // someone tap into the exact failure this was built to avoid.
  const ready = firebaseAuthReady !== null;
  btn.disabled = !ready;
  statusEl.textContent = ready ? t("syncSignedOut") : t("syncPreparing");
}

// Staged deliberately. v3.3.1 reported a bare "timeout", which proved the
// attempt never settled but not WHICH step hung — and "the SDK never loaded"
// and "the popup never came back" have completely different fixes. Each stage
// now fails under its own name.
//
// The SDK budget is short because a module fetch either arrives quickly or is
// not coming; the sign-in budget is long because a real one involves a human
// picking an account.
const SYNC_SDK_TIMEOUT_MS = 20000;

// NOT async, and that is the whole point. Everything up to and including
// signInWithPopup() runs synchronously, so window.open() happens while the
// click's user gesture is still live. Adding an `await` anywhere above that
// call — including awaiting the SDK, as the first attempt did — spends the
// gesture, and Safari then refuses the popup without reporting anything.
//
// The SDK must therefore already be resolved; prepareSyncSdk() sees to that
// when the Settings drawer opens, and the button stays unavailable until it is.
function signInForSync() {
  if (!firebaseAuthReady) return Promise.reject(new Error("sdk-not-ready"));

  const { auth, instance } = firebaseAuthReady;
  const provider = new auth.GoogleAuthProvider();

  return withTimeout(
    auth.signInWithPopup(instance, provider), SYNC_SIGNIN_TIMEOUT_MS, "popup-timeout"
  ).then((result) => {
    syncUser = result.user;
    renderSyncStatus();
  });
}

// Sign-out opens no window, so awaiting the SDK here is harmless.
async function signOutFromSync() {
  const { auth, instance } = await loadFirebaseAuth();
  await auth.signOut(instance);
  syncUser = null;
  renderSyncStatus();
}

// Restores an existing session without any user action — but ONLY if one
// already exists. Firebase persists the session in IndexedDB, so a sadhak who
// signed in yesterday is still signed in today. Deliberately gated on a flag
// we set ourselves at sign-in: without it, this would pull ~159KB of SDK over
// the network on every launch of an app whose whole point is working offline.
async function restoreSyncSession() {
  if (readStoredPreference("syncEverSignedIn") !== "true") return;
  try {
    const { auth, instance } = await loadFirebaseAuth();
    await new Promise((resolve) => {
      const stop = auth.onAuthStateChanged(instance, (user) => {
        syncUser = user;
        stop();
        resolve();
      });
    });
    renderSyncStatus();
    // Opening the app is the "pull" half of the model, and this is where an
    // already-signed-in launch learns it has a session at all.
    if (syncUser) await syncNow();
  } catch (err) {
    // Offline, or the CDN is unreachable. The app is fully usable without
    // sync, so this must never surface as an error.
    console.warn("Could not restore the sync session:", err);
  }
}

// How long to wait before declaring a sign-in attempt stuck. Generous, since
// a genuine sign-in involves picking an account and possibly typing a
// password — but finite, because the alternative is what shipped in v3.3.0:
// on an installed iOS PWA the popup never opened AND never rejected, so this
// promise hung forever, the button stayed disabled, and the user was left
// with no error and no way to retry. A hang is a failure; it just doesn't
// announce itself.
const SYNC_SIGNIN_TIMEOUT_MS = 60000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Firebase reports why a sign-in failed in err.code, and on a phone there is
// no console to read it in. Surfacing it in the status line is the difference
// between "nothing happens" and knowing whether the popup was blocked, closed,
// superseded, or never reached the network at all — which is what decides
// whether the fix is a redirect flow, a different provider, or something else
// entirely.
function describeSyncError(err) {
  const code = (err && err.code) || (err && err.message) || "unknown";
  return String(code).replace(/^auth\//, "");
}

document.getElementById("sync-signin-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("sync-signin-btn");
  const statusEl = document.getElementById("sync-status");

  // Deliberately nothing between the tap and signInForSync() below: no probe,
  // no await, no network. An earlier version opened a throwaway window here
  // to test whether popups were available at all, which was worse than
  // useless — browsers allow roughly one window.open per gesture, so the
  // probe could consume the very allowance the real popup needed.
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = t("syncWorking");

  try {
    if (syncUser) {
      await withTimeout(signOutFromSync(), SYNC_SIGNIN_TIMEOUT_MS, "timeout");
      showToast(t("syncSignedOutToast"));
    } else {
      await withTimeout(signInForSync(), SYNC_SIGNIN_TIMEOUT_MS, "timeout");
      writeStoredPreference("syncEverSignedIn", "true");
      showToast(t("syncSignedInToast"));
    }
    renderSyncStatus();
  } catch (err) {
    console.error("Sync sign-in failed:", err);
    const detail = describeSyncError(err);
    showToast(t("syncSignInFailed"));
    // Deliberately overwrites the status line rather than only toasting: a
    // toast is gone in seconds, and this is the one piece of information
    // worth still being on screen when someone reports what happened.
    if (statusEl) statusEl.textContent = t("syncSignInFailedDetail", { detail });
  } finally {
    // Unconditional, so the control can never again be left dead.
    if (btn) btn.disabled = false;
  }

  // A fresh sign-in is the first chance this device has had to see the other
  // device's ledger, so pull immediately rather than waiting for the next
  // launch. Not awaited: the button must free up as soon as sign-in lands.
  if (syncUser) syncNow();
});

// ---------- Sumiran-Lite: Sync push & pull ----------
//
// The model, deliberately kept to one sentence: a save pushes the ledger to
// Firestore, and opening the app pulls it back down.
//
// One document per sadhak — users/{uid}/ledger/current — holding exactly the
// payload buildLedgerExportPayload() already produces. That reuse is the point:
// export, Drive backup and sync all speak one format, so parseImportedLedgerFile()
// and areLedgerEntriesValid() already know how to read and vet what comes back,
// and a pulled document is validated by the same guard that protects Import and
// Restore. Entries are a few dozen bytes each, so years of practice sit well
// inside Firestore's 1MB document limit.
//
// The *lite* Firestore build is used on purpose: it does one-shot get/set and
// nothing else. The full build's value is realtime listeners and offline
// persistence, neither of which this model wants — offline is already handled,
// by IndexedDB, which is the app's source of truth.

let firestorePromise = null;
let firestoreReady = null;

// True while a pulled ledger is being written to IndexedDB. saveLedger() pushes
// on every write, so without this the act of applying a pull would immediately
// push the same data back — an echo on every launch.
let syncApplyingRemote = false;

// A push that never reached Firestore. Persisted, because the case it exists
// for is a save made offline: the app is very likely closed before the network
// returns, so a flag living only in memory would forget precisely when it
// mattered. The next open pushes before it pulls, so the unsynced save is
// uploaded rather than overwritten.
function hasPendingSyncPush() {
  return readStoredPreference("syncPushPending") === "true";
}

function setPendingSyncPush(pending) {
  writeStoredPreference("syncPushPending", pending ? "true" : "false");
}

const SYNC_IO_TIMEOUT_MS = 20000;

// Loads the Firestore SDK on top of the already-resolved auth SDK. Unlike
// sign-in, nothing here opens a window, so awaiting is safe — there is no user
// gesture to spend.
function loadFirestore() {
  if (firestorePromise) return firestorePromise;

  firestorePromise = (async () => {
    const { app } = await loadFirebaseAuth();
    const store = await import(`${FIREBASE_SDK_BASE}/firebase-firestore-lite.js`);
    firestoreReady = { store, db: store.getFirestore(app) };
    return firestoreReady;
  })().catch((err) => {
    firestorePromise = null; // so the next attempt genuinely retries
    throw err;
  });

  return firestorePromise;
}

function syncLedgerDoc({ store, db }, uid) {
  return store.doc(db, "users", uid, "ledger", "current");
}

// Uploads the whole ledger. Whole rather than incremental because the payload
// is small, one write is atomic, and an incremental protocol would need change
// tracking that nothing else in this app has any use for.
async function pushLedgerToSync() {
  if (!syncUser) return false;

  const ready = await withTimeout(loadFirestore(), SYNC_IO_TIMEOUT_MS, "sync-sdk-timeout");
  const payload = buildLedgerExportPayload(await getSankalpa());

  await withTimeout(
    ready.store.setDoc(syncLedgerDoc(ready, syncUser.uid), payload),
    SYNC_IO_TIMEOUT_MS,
    "sync-push-timeout"
  );

  setPendingSyncPush(false);
  return true;
}

// Fetches the stored ledger and hands back the parsed payload, or null when
// this sadhak has never synced from any device. A null is NOT an error: it is
// the first-run case, and the caller answers it by pushing.
async function pullLedgerFromSync() {
  if (!syncUser) return null;

  const ready = await withTimeout(loadFirestore(), SYNC_IO_TIMEOUT_MS, "sync-sdk-timeout");
  const snapshot = await withTimeout(
    ready.store.getDoc(syncLedgerDoc(ready, syncUser.uid)),
    SYNC_IO_TIMEOUT_MS,
    "sync-pull-timeout"
  );

  return snapshot.exists() ? snapshot.data() : null;
}

// A stable fingerprint of a ledger's CONTENT, immune to how the two sides
// happen to be spelled. Comparing JSON.stringify() of the payloads directly
// does not work, and shipped a real bug: Firestore returns a document's keys
// in alphabetical order, not the order the app wrote them, so every pull
// looked different from the identical local ledger — and the app re-applied
// and re-announced "updated from your other device" on every single return to
// the foreground.
//
// Arrays rather than objects at every level, so nothing depends on key order,
// and sorted by date, so nothing depends on row order either.
function ledgerSignature(entries, sankalpa) {
  return JSON.stringify({
    entries: entries
      .map(e => [
        e.date,
        e.jaap ?? null,
        e.notes || "",
        typeof e.updatedAt === "string" ? e.updatedAt : ""
      ])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    sankalpa: sankalpa ? [sankalpa.text, sankalpa.context || "", sankalpa.date || ""] : null
  });
}

// Replaces the local ledger with a pulled one. Returns whether anything
// actually changed, so an unchanged pull — the common case, since most opens
// follow no edit anywhere — stays completely silent.
//
// Validation is not optional here. This is a fourth door into ledgerData
// alongside Import, Restore and the backup-recovery branch of
// loadLedgerFromDB(), and it is the only one whose data arrives over a network,
// so it goes through the same areLedgerEntriesValid() guard they do.
async function applyPulledLedger(payload) {
  if (!appReady) return false;

  const parsed = parseImportedLedgerFile(payload);
  if (!parsed || !areLedgerEntriesValid(parsed.entries)) {
    console.warn("Ignoring a synced ledger that failed validation.");
    return false;
  }

  // The comparison happens AFTER backfilling, not before, and that ordering
  // is load-bearing. The pulled ledger was written by a device that may not
  // have been opened today, so it can be missing the last few days entirely —
  // which means the local ledger legitimately holds placeholder days the
  // stored one does not, forever. Comparing the raw pull against local would
  // therefore report a difference on every open for the rest of time. What
  // matters is whether the ledger this pull would PRODUCE differs from the one
  // already here.
  //
  // A Sankalpa is excluded from both sides when the pull carries none, for the
  // same reason it isn't written in that case: a device that predates the vow
  // must not look like a change, nor erase it.
  const remoteSankalpa = parsed.sankalpa;
  const previous = ledgerData;
  const previousSignature = ledgerSignature(previous, remoteSankalpa ? await getSankalpa() : null);

  ledgerData = parsed.entries;
  ensureRecentEntriesExist(7);

  if (ledgerSignature(ledgerData, remoteSankalpa) === previousSignature) {
    ledgerData = previous; // nothing to do, and nothing to say
    return false;
  }

  syncApplyingRemote = true;
  try {
    await saveLedger(ledgerData);
    await saveAutomaticBackup(ledgerData);
  } catch (err) {
    // Same discipline as every other save path: leave nothing in memory that
    // is not on disk, or every total on screen reflects a value that vanishes
    // on the next launch.
    ledgerData = previous;
    throw err;
  } finally {
    syncApplyingRemote = false;
  }

  // Only written when the file actually carries one, so syncing from a device
  // that predates the vow cannot silently erase it — the same rule Import and
  // restoreFromBackup() follow.
  if (parsed.sankalpa) {
    try {
      await saveSankalpa(parsed.sankalpa);
    } catch (err) {
      console.warn("Synced ledger applied, but its Sankalpa could not be saved:", err);
    }
  }

  todayDraft = null; // the pulled day may differ from what is half-typed
  renderToday();
  return true;
}

// The whole feature, in the order that matters: a save that never reached
// Firestore goes up FIRST, so pulling cannot overwrite it.
async function syncNow() {
  if (!syncUser) return;

  try {
    if (hasPendingSyncPush()) await pushLedgerToSync();

    const remote = await pullLedgerFromSync();
    if (remote === null) {
      // Nothing stored yet — this device is the first. Seed it.
      await pushLedgerToSync();
      return;
    }

    if (await applyPulledLedger(remote)) showToast(t("syncPulledToast"));
  } catch (err) {
    console.warn("Sync failed:", err);
    const statusEl = document.getElementById("sync-status");
    if (statusEl) statusEl.textContent = t("syncFailedDetail", { detail: describeSyncError(err) });
  }
}

// Called from saveLedger(), the sole writer of the ledger store — which makes
// it the one place every save path already converges on, rather than five
// call sites that a sixth save path could silently fail to join.
//
// Deliberately not awaited by the caller: a save must feel instant and must
// work with no network at all, so the upload rides along behind it. A failure
// is therefore recorded rather than surfaced — the sadhak's write already
// succeeded where it counts, in IndexedDB.
function pushLedgerAfterSave() {
  if (!syncUser || syncApplyingRemote) return;

  pushLedgerToSync().catch((err) => {
    console.warn("Could not push this save to sync:", err);
    setPendingSyncPush(true);
  });
}
