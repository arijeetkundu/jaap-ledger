console.log("Sumiran Lite app.js loaded successfully");

// ---------- Background Theme ----------
let backgroundChoice = localStorage.getItem("backgroundChoice") || "mandala";
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
function celebrateMilestone() {
  const overlay = document.getElementById("petal-overlay");
  if (!overlay) return;

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
    overlay.innerHTML = "";
  }, maxDurationMs + 200);
}

// ---------- Utilities ----------

// Format YYYY-MM-DD → "D MMM YYYY" (e.g. "12 Apr 2026")
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function formatDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
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

// Pure formatting — never mutates stored data.
function formatAsMala(jaap) {
  return `${formatIndianNumber(jaapToMala(jaap))} mala`;
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

  const prevCrore = Math.floor(prevTotal / 10000000);
  const currentCrore = Math.floor(currentTotal / 10000000);

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
  const n = points.length;
  const values = points.map(p => p.jaap);
  const lo = Math.min(...values);
  const hi = Math.max(...values);

  const coords = points.map((p, i) => {
    const x = n === 1 ? 36 : 2 + i * (68 / (n - 1));
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
  return notes.includes("पूर्णिमा") || lower.includes("poornima") || lower.includes("purnima");
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
    // ❌ DO NOT save to localStorage here
  }

  return entry;
}

function ensureRecentEntriesExist(days = 7) {
	const existingDates = new Set(ledgerData.map(e => e.date));
	
	for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);

    const iso =
      d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");

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
    console.log("Ledger loaded from IndexedDB");
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
    console.log("Ledger restored from automatic backup");
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


const todayISO = getTodayISO();
console.log("Today (ISO):", todayISO);

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
        Malas<br>
        <input type="number" step="1"${idAttr} class="${className}" value="${malaValue}" placeholder="Enter malas">
      </label>
    `;
  }

  return `
    <label>
      Jaap<br>
      <input type="number"${idAttr} class="${className}" value="${entry.jaap ?? ""}" placeholder="Enter jaap count">
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

function updateMalaToggleButton() {
  const input = document.getElementById("mala-toggle");
  if (!input) return;
  input.checked = malaViewEnabled;
  input.title = malaViewEnabled ? "Mala View: On" : "Mala View: Off";

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
	  
	if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().then(granted => {
    console.log(
      granted
        ? "Persistent storage granted"
        : "Persistent storage not granted"
    );
  });
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

    renderToday();

  } catch (err) {
    console.error("Initialization failed:", err);
  }
})();


async function saveAutomaticBackup(data) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_STORE, "readwrite");
    const store = tx.objectStore(BACKUP_STORE);

    const payload = {
      backedUpAt: new Date().toISOString(),
      entries: data
    };

    store.put(payload, "latest");

    tx.oncomplete = () => {
      console.log("Automatic backup saved");
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
  const backup = await loadLatestBackup();

  if (!backup || !backup.entries) {
    alert("No backup found to restore.");
    return;
  }

  const confirmRestore = confirm(
    `Restore ledger from backup?\n\n` +
    `Backup date: ${new Date(backup.backedUpAt).toLocaleString()}\n` +
    `Entries: ${backup.entries.length}\n\n` +
    `This will replace current ledger data.`
  );

  if (!confirmRestore) return;

  ledgerData = backup.entries;

  await saveLedger(ledgerData);

  alert("Ledger restored successfully from backup.");

  renderToday();
}


// ---------- Rendering ----------
function renderToday() {
  const entry = ensureTodayEntryExists();
  renderTodayCard(entry);
  renderReflectionSummary();   // ← add this
  renderLedgerList();
}


function renderReflectionSummary() {
  const container = document.getElementById("reflection-summary");

  const yearlyTotals = getYearlyTotals();
  const CURRENT_YEAR = getTodayISO().slice(0, 4);
  const currentYearTotal = yearlyTotals[CURRENT_YEAR] || 0;
  const cumulative = getCumulativeTotal();

  const currentCrore = getCurrentMilestone(cumulative);
  const progressInCrore = cumulative - currentCrore * CRORE;
  const percent = Math.floor(getMilestoneProgress(cumulative));

  const milestoneHistory = getMilestoneHistory(ledgerData);
  const pred30 = predictNextMilestone(ledgerData);
  const predYTD = predictNextMilestoneYTD(ledgerData);

  // Lifetime/yearly totals respect Mala View; Crore/progress numbers stay in jaap terms
  // (Crore is the domain unit for milestones, not malas — per spec §4.5).
  const formatTotal = n => malaViewEnabled ? formatAsMala(n) : formatIndianNumber(n);

  container.innerHTML = `
    <div class="reflection-box">

	<div class="reflection-line">
  <strong>${CURRENT_YEAR} Total:</strong>
  ${formatTotal(currentYearTotal)}
</div>

      <div class="reflection-line">
        <strong>Total Jaap:</strong>
        ${formatTotal(cumulative)}
      </div>

      <div class="reflection-line">
        <strong>Next Milestone:</strong> ${currentCrore + 1} Crore
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
        <strong>30-Day Pace:</strong> ${formatDate(pred30.predictedDate)}
        <span class="prediction-pace">(${formatTotal(Math.round(pred30.dailyPace))}/day)</span>
      </div>
    ` : ""}
    ${predYTD ? `
      <div class="reflection-line prediction-line">
        <strong>YTD Pace:</strong> ${formatDate(predYTD.predictedDate)}
        <span class="prediction-pace">(${formatTotal(Math.round(predYTD.dailyPace))}/day)</span>
      </div>
    ` : ""}
  </div>
` : ""}

	  ${milestoneHistory.length > 0 ? `
  <div class="reflection-milestones">
    <div class="reflection-subtitle">Milestones</div>
    ${milestoneHistory.map(m => `
      <div class="milestone-line">
        ${m.crore} Crore — ${formatDate(m.date)}
        ${m.daysSincePrevious !== null
          ? `<span class="milestone-gap">(+${m.daysSincePrevious} days)</span>`
          : ""}
      </div>
    `).join("")}
  </div>
` : ""}

	  <div class="legend">
  🏵️ Crore Milestone &nbsp;&nbsp; 🌕 Poornima &nbsp;&nbsp; 🔴 Sunday &nbsp;&nbsp; ▸ Notes
</div>
  
    </div>
  `;
}


function renderLedgerList() {
  const container = document.getElementById("ledger-list");
  const todayISO = getTodayISO();
  const CURRENT_YEAR = todayISO.slice(0, 4);

  const filtered = ledgerData.filter(entry => entry.date <= todayISO);
  const groupedByYear = groupEntriesByYear(filtered);
  const years = Object.keys(groupedByYear).sort((a, b) => b - a);

  // Precompute once so each row's sparkline is an O(1) lookup instead of an O(n) scan.
  const sparklineMap = buildDateJaapMap(ledgerData);

  container.innerHTML = "";

  // Jump-to-year selector
  const jumpBar = document.createElement("div");
  jumpBar.className = "jump-bar";
  jumpBar.innerHTML = `
    <label class="jump-label" for="jump-year">Jump to year</label>
    <select id="jump-year" class="jump-select">
      <option value="">— select —</option>
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
      targetContainer.style.display = "block";
      targetHeader.querySelector(".year-chevron").textContent = "▾";
      targetHeader.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // Reset select back to placeholder so it can be re-used
    e.target.value = "";
  });

  Object.keys(groupedByYear)
  .sort((a, b) => b - a)
  .forEach(year => {
    // Year header
    const isCurrentYear = year === CURRENT_YEAR;

// Year header
const yearHeader = document.createElement("div");
yearHeader.className = "ledger-year-header";
yearHeader.dataset.year = year;

const yearTotal = groupedByYear[year]
  .reduce((sum, e) => sum + (e.jaap || 0), 0)
  .toLocaleString();

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

if (!isCurrentYear) {
  yearContainer.style.display = "none";
}

container.appendChild(yearContainer);

yearHeader.addEventListener("click", () => {
  const isHidden = yearContainer.style.display === "none";
  yearContainer.style.display = isHidden ? "block" : "none";

  const chevron = yearHeader.querySelector(".year-chevron");
  chevron.textContent = isHidden ? "▾" : "▸";
});

    groupedByYear[year].forEach(entry => {
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

      row.innerHTML = `
        <div class="ledger-main">
          <span class="ledger-chevron">▸</span>

          <span class="ledger-date">
            ${formatDate(entry.date)}
            ${getCroreMilestone(entry.date) ? " 🏵️" : ""}
            ${hasExplicitPoornima(entry.notes) ? " 🌕" : ""}
          </span>

          <span class="ledger-jaap">${entry.jaap == null ? "—" : (malaViewEnabled ? formatAsMala(entry.jaap) : entry.jaap)}</span>

          <span class="ledger-sparkline">${sparklineHTML}</span>
        </div>

        <div class="ledger-notes">
          ${
            getCroreMilestone(entry.date)
              ? `<div class="milestone">
                   ◈ ${getCroreMilestone(entry.date)} Crore Jaap Completed
                 </div>`
              : ""
          }

          ${
            isEditableEntry(entry.date)
              ? `
                ${renderJaapInputField(entry)}

                <br><br>

                <label>
                  Notes<br>
                  <textarea class="edit-notes" rows="3">${entry.notes || ""}</textarea>
                </label>

                <br>

                <button class="save-entry">Update</button>
              `
              : `
                ${entry.notes ? entry.notes : "<em>No notes</em>"}
                <div class="locked-note">🔒 Entry locked</div>
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

          entry.jaap = computeJaapFromInput(jaapInput, entry.jaap);
          entry.notes = notesInput;

          await saveLedger(ledgerData);
          await saveAutomaticBackup(ledgerData);
          renderToday();
          showToast("Saved ✓");
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
  });
}


function renderTodayCard(entry) {
  const container = document.getElementById("today-card");

  container.innerHTML = `
    <h2>Today${hasExplicitPoornima(entry.notes) ? " 🌕" : ""}</h2>

    <p><strong>Date:</strong> ${formatDate(entry.date)}</p>

    ${renderJaapInputField(entry, { id: "today-jaap" })}

    <br><br>

    <label>
      Notes<br>
      <textarea
        id="today-notes"
        class="edit-notes"
        rows="3"
        placeholder="Notes (optional)"
      >${entry.notes || ""}</textarea>
    </label>

    <br>

    ${entry.date === todayISO || isWithinLastNDays(entry.date, 7)
  ? `<button id="update-today">Update</button>`
  : `<p><em>This entry is locked (older than 7 days).</em></p>`
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

const entry = ledgerData.find(e => e.date === todayISO);
if (!entry) return;

if (!isWithinLastNDays(entry.date, 7)) {
  console.warn("Edit blocked: entry older than 7 days");
  return;
}

  entry.jaap = computeJaapFromInput(jaapInput, entry.jaap);
  entry.notes = notesInput;

  const crossedNewMilestone = getCroreMilestone(entry.date);

  await saveLedger(ledgerData);
  await saveAutomaticBackup(ledgerData);
  renderToday();
  showToast("Saved ✓");

  if (crossedNewMilestone) {
    celebrateMilestone();
  }
}
document.getElementById("restore-backup-btn")
  ?.addEventListener("click", restoreFromBackup);

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

// ---------- Custom splash image upload pipeline ----------
// Two limits matter here: file size protects decode-time RAM (a browser
// must expand an image to a raw width*height*4-byte bitmap before it can
// downscale it), while the megapixel guard catches highly-compressed files
// that are small on disk but huge in pixels. Everything downstream targets
// a small, consistent stored size (~100-150KB) regardless of input size.
const SPLASH_MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const SPLASH_MAX_MEGAPIXELS = 40 * 1000 * 1000; // ~40MP
const SPLASH_MAX_EDGE = 900; // longest stored edge, in px
const SPLASH_TARGET_BYTES = 250 * 1024; // re-encode smaller past this

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode image."));
    img.src = src;
  });
}

async function processSplashImage(file) {
  if (!file || !file.type || file.type.indexOf("image/") !== 0) {
    throw new Error("Please choose an image file.");
  }
  if (file.size > SPLASH_MAX_FILE_BYTES) {
    throw new Error("Image is too large. Please choose a file under 5MB.");
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
      throw new Error("Image resolution is too high. Please choose a smaller image.");
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
    throw new Error("Not enough storage space to save this image.");
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
  lockedBtn.title = "Hanuman is the default image and can't be changed";

  const lockedImg = document.createElement("img");
  lockedImg.src = SPLASH_DEFAULT_IMAGE.webp;
  lockedImg.alt = "";
  lockedBtn.appendChild(lockedImg);

  const lockBadge = document.createElement("span");
  lockBadge.className = "splash-slot-lock";
  lockBadge.textContent = "🔒";
  lockedBtn.appendChild(lockBadge);

  lockedBtn.addEventListener("click", () => {
    showToast("Hanuman is the default image and can't be changed");
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
      btn.title = "Custom image — tap to replace";

      const img = document.createElement("img");
      img.src = slot.dataUrl;
      img.alt = "";
      btn.appendChild(img);

      const removeBadge = document.createElement("span");
      removeBadge.className = "splash-slot-reset";
      removeBadge.textContent = "✕";
      removeBadge.title = "Remove image";
      removeBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        removeCustomSplashImage(i);
        renderSplashSlotUI();
        showToast("Image removed");
      });
      btn.appendChild(removeBadge);
    } else {
      btn.classList.add("splash-slot-empty");
      btn.title = "Add your own picture";
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
    showToast("Splash image updated ✓");
  } catch (err) {
    console.error("Splash image upload failed:", err);
    showToast(err && err.message ? err.message : "Failed to process image.");
  } finally {
    input.value = "";
  }
});

document.getElementById("splash-images-reset-btn")?.addEventListener("click", () => {
  const anyFilled = resolveSplashCustomSlots().some((slot) => slot.filled);
  if (!anyFilled) {
    showToast("No custom images to remove");
    return;
  }
  removeAllCustomSplashImages();
  renderSplashSlotUI();
  showToast("Custom images removed");
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
        <h2>Sankalpa</h2>
        <button id="sankalpa-close" class="fullscreen-close" aria-label="Close">✕</button>
      </div>
      <div class="sankalpa-body">
        <p class="sankalpa-intro">Establish your Sankalpa — a vow of intent for your practice.</p>

        <label>
          Sankalpa<br>
          <textarea id="sankalpa-text" class="edit-notes" rows="4" placeholder="Your vow..."></textarea>
        </label>

        <br><br>

        <label>
          Context (optional)<br>
          <input type="text" id="sankalpa-context" class="edit-jaap" placeholder="Guru, Devatā, occasion...">
        </label>

        <br><br>

        <button id="sankalpa-establish" class="save-entry" disabled>Establish Sankalpa</button>
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
      showToast("Sankalpa established ✓");
      renderSankalpaPage();
    });

    page.querySelector("#sankalpa-close").addEventListener("click", closeSankalpaPage);
    return;
  }

  page.innerHTML = `
    <div class="fullscreen-header">
      <h2>Sankalpa</h2>
      <button id="sankalpa-close" class="fullscreen-close" aria-label="Close">✕</button>
    </div>
    <div class="sankalpa-body">
      <div class="sankalpa-view">
        <p class="sankalpa-text-display">${escapeHTML(sankalpa.text)}</p>
        ${sankalpa.context ? `<p class="sankalpa-context-display"><em>${escapeHTML(sankalpa.context)}</em></p>` : ""}
        <p class="sankalpa-date-display">Established ${formatDate(sankalpa.date)}</p>
      </div>

      <button id="sankalpa-rewrite-btn" class="maintenance-btn">Rewrite Sankalpa</button>

      <div id="sankalpa-rewrite-form" style="display:none;">
        <br>
        <label>
          Sankalpa<br>
          <textarea id="sankalpa-text-edit" class="edit-notes" rows="4">${escapeHTML(sankalpa.text)}</textarea>
        </label>

        <br><br>

        <label>
          Context (optional)<br>
          <input type="text" id="sankalpa-context-edit" class="edit-jaap" value="${escapeHTML(sankalpa.context || "")}">
        </label>

        <br><br>

        <button id="sankalpa-confirm-rewrite" class="save-entry" disabled>Confirm Rewrite</button>
        <button id="sankalpa-cancel-rewrite" class="maintenance-btn">Cancel</button>
      </div>
    </div>
  `;

  page.querySelector("#sankalpa-close").addEventListener("click", closeSankalpaPage);

  const rewriteBtn = page.querySelector("#sankalpa-rewrite-btn");
  const rewriteForm = page.querySelector("#sankalpa-rewrite-form");
  const textEdit = page.querySelector("#sankalpa-text-edit");
  const confirmBtn = page.querySelector("#sankalpa-confirm-rewrite");

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

    const confirmed = confirm("Rewrite Sankalpa? Your original date will be preserved.");
    if (!confirmed) return;

    const context = page.querySelector("#sankalpa-context-edit").value.trim();
    // date is always preserved from the original record — never reset to today.
    await saveSankalpa({ text, context, date: sankalpa.date });
    showToast("Sankalpa rewritten ✓");
    renderSankalpaPage();
  });
}

document.getElementById("sankalpa-open-btn")
  ?.addEventListener("click", openSankalpaPage);

  // ---------- Export Ledger (JSON) ----------

document.getElementById("export-json-btn")
  ?.addEventListener("click", async () => {
    if (!ledgerData || ledgerData.length === 0) {
      alert("Ledger is empty. Nothing to export.");
      return;
    }

    // Clone & sanitize (future-proof)
    const exportData = ledgerData.map(e => ({
      date: e.date,
      jaap: e.jaap ?? null,
      notes: e.notes || ""
    }));

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

  try {
    const text = await file.text();
    const importedData = JSON.parse(text);

    // ---- Validation ----
    if (!Array.isArray(importedData)) {
      alert("Invalid file format: expected an array.");
      return;
    }

    for (const entry of importedData) {
      if (
        typeof entry.date !== "string" ||
        !("jaap" in entry) ||
        !("notes" in entry)
      ) {
        alert("Invalid ledger entry format detected.");
        return;
      }
    }

    const confirmReplace = confirm(
      `Import ${importedData.length} entries?\n\n` +
      `This will REPLACE your current ledger permanently.`
    );

    if (!confirmReplace) {
      importInput.value = ""; // reset
      return;
    }

    // ---- Replace Ledger ----
    ledgerData = importedData;

    await saveLedger(ledgerData);
    await saveAutomaticBackup(ledgerData);

    alert("Ledger imported successfully.");

    renderToday();

  } catch (err) {
    console.error("Import failed:", err);
    alert("Failed to import file. Please ensure it is a valid JSON ledger.");
  } finally {
    importInput.value = ""; // allow re-import of same file
  }
});

