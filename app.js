console.log("Jaap Ledger app.js loaded successfully");

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

// ---------- Utilities ----------

// Format YYYY-MM-DD → "D MMM YYYY" (e.g. "12 Apr 2026")
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function formatDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
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

function getCroreMilestoneHistory() {
  const milestones = [];

  // Sort entries chronologically
  const sorted = [...ledgerData].sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  let lastCrore = 0;
  let lastMilestoneDate = null;

  sorted.forEach(entry => {
    const total = getCumulativeJaapUpTo(entry.date);
    const currentCrore = Math.floor(total / 10000000);

    if (currentCrore > lastCrore) {
      let daysTaken = null;

      if (lastMilestoneDate) {
        const prev = new Date(lastMilestoneDate);
        const curr = new Date(entry.date);
        const diffMs = curr - prev;
        daysTaken = Math.round(diffMs / (1000 * 60 * 60 * 24));
      }

      milestones.push({
        crore: currentCrore,
        date: entry.date,
        daysTaken
      });

      lastCrore = currentCrore;
      lastMilestoneDate = entry.date;
    }
  });

  return milestones;
}


function isStandalonePWA() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

async function hasEverSeededLedger() {
  const db = await openDB();
  const tx = db.transaction(META_STORE, "readonly");
  const store = tx.objectStore(META_STORE);

  return new Promise(resolve => {
    const req = store.get("ledgerSeeded");
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = () => resolve(false);
  });
}

async function markLedgerSeeded() {
  const db = await openDB();
  const tx = db.transaction(META_STORE, "readwrite");
  const store = tx.objectStore(META_STORE);

  store.put(true, "ledgerSeeded");
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

// TEMP: Poornima check for today (stub)
function isTodayPoornima() {
  return poornimaDates.includes(getTodayISO());
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

function getNextCroreProgress() {
  const total = getCumulativeTotal();

  const currentCrore = Math.floor(total / 10000000);
  const nextCroreTarget = (currentCrore + 1) * 10000000;

  const progress = total - currentCrore * 10000000;
  const percent = Math.floor((progress / 10000000) * 100);

  return {
    currentCrore,
    nextCroreTarget,
    progress,
    percent
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
const DB_VERSION = 3;                 // 👈 BUMP version


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
let poornimaDates = [];
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
 
    // Load Poornima calendar (static metadata is OK)
    // Optional: preloaded calendar dates (only covers up to 2027).
    // The app now derives 🌕 from notes keywords — this is just a fallback.
    try {
      const poornimaRes = await fetch("poornima.json");
      if (poornimaRes.ok) {
        poornimaDates = await poornimaRes.json();
        console.log("Poornima calendar loaded:", poornimaDates.length);
      }
    } catch {
      console.log("poornima.json not available — relying on notes keywords");
    }

    // Load ledger ONLY from IndexedDB
    const existingLedger = await loadLedgerFromDB();

const everSeeded = await hasEverSeededLedger();

if (!existingLedger || existingLedger.length === 0) {
  console.log("Ledger empty");

  if (!everSeeded) {
    console.log("First-ever seed — loading data.json");

    const fallbackRes = await fetch("data.json");
    const fallbackData = await fallbackRes.json();

    ledgerData = fallbackData;

    await saveLedger(ledgerData);
    await saveAutomaticBackup(ledgerData);
    await markLedgerSeeded();
  } else {
    console.log("Ledger empty but already seeded earlier — starting empty");
    ledgerData = [];
  }
} else {
  ledgerData = existingLedger;
}
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


// ---------- Local Storage ----------
function loadFromLocalStorage(baseData) {
  const saved = localStorage.getItem("jaap-ledger");
  if (saved) {
    console.log("Loaded ledger from localStorage");
    return JSON.parse(saved);
  }
  return baseData;
}

function saveToLocalStorage(data) {
  localStorage.setItem("jaap-ledger", JSON.stringify(data));
  console.log("Ledger saved to localStorage");
}

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
  const progress = getNextCroreProgress();

  const milestoneHistory = getCroreMilestoneHistory();

  container.innerHTML = `
    <div class="reflection-box">
	
	<div class="reflection-line">
  <strong>${CURRENT_YEAR} Total:</strong>
  ${currentYearTotal.toLocaleString()}
</div>

      <div class="reflection-line">
        <strong>Total Jaap:</strong>
        ${cumulative.toLocaleString()}
      </div>

      <div class="reflection-line">
        <strong>Next Milestone:</strong> ${progress.currentCrore + 1} Crore
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width: ${progress.percent}%"></div>
      </div>
      <div class="progress-label">
        ${progress.percent}% &nbsp;·&nbsp; ${progress.progress.toLocaleString()} / 10,000,000
      </div>
	  
	  ${milestoneHistory.length > 0 ? `
  <div class="reflection-milestones">
    <div class="reflection-subtitle">Milestones</div>
    ${milestoneHistory.map(m => `
      <div class="milestone-line">
        ${m.crore} Crore — ${formatDate(m.date)}
        ${m.daysTaken !== null
          ? `<span class="milestone-gap">(+${m.daysTaken} days)</span>`
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
  <span class="year-chevron">${isCurrentYear ? "▾" : "▸"}</span>
  <span class="year-label">${year}</span>
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

      row.innerHTML = `
        <div class="ledger-main">
          <span class="ledger-chevron">▸</span>

          <span class="ledger-date">
            ${formatDate(entry.date)}
            ${getCroreMilestone(entry.date) ? " 🏵️" : ""}
            ${hasExplicitPoornima(entry.notes) ? " 🌕" : ""}
          </span>

          <span class="ledger-jaap">${entry.jaap ?? "—"}</span>
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
                <label>
                  Jaap<br>
                  <input type="number" class="edit-jaap" value="${entry.jaap ?? ""}">
                </label>

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

          entry.jaap = jaapInput === "" ? null : Number(jaapInput);
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

  if (!entry) {
    container.innerHTML = `
      <h2>
  Today
  ${isTodayPoornima() ? " 🌕" : ""}
</h2>
      <p>No entry yet for today.</p>
      <button disabled>Save</button>
    `;
    return;
  }

  container.innerHTML = `
    <h2>Today${hasExplicitPoornima(entry.notes) ? " 🌕" : ""}</h2>

    <p><strong>Date:</strong> ${formatDate(entry.date)}</p>

    <label>
      Jaap<br>
      <input
        type="number"
        id="today-jaap"
        value="${entry.jaap ?? ""}"
        placeholder="Enter jaap count"
      >
    </label>

    <br><br>

    <label>
      Notes<br>
      <textarea
        id="today-notes"
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

  const jaapValue = jaapInput === "" ? null : Number(jaapInput);

const entry = ledgerData.find(e => e.date === todayISO);
if (!entry) return;

if (!isWithinLastNDays(entry.date, 7)) {
  console.warn("Edit blocked: entry older than 7 days");
  return;
}

  entry.jaap = jaapValue;
  entry.notes = notesInput;

  await saveLedger(ledgerData);
  await saveAutomaticBackup(ledgerData);
  renderToday();
  showToast("Saved ✓");
}
document.getElementById("restore-backup-btn")
  ?.addEventListener("click", restoreFromBackup);
  
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

