console.log("Jaap Ledger app.js loaded successfully");

// ---------- Utilities ----------

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


// Check if Poornima is explicitly mentioned in notes
function hasExplicitPoornima(notes) {
  if (!notes) return false;
  return notes.includes("पूर्णिमा") || notes.toLowerCase().includes("poornima");
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



const todayISO = getTodayISO();
console.log("Today (ISO):", todayISO);

// ---------- IndexedDB Storage ----------

const DB_NAME = "jaap-ledger-db";
const STORE_NAME = "ledger";
const BACKUP_STORE = "ledger-backups";
const DB_VERSION = 2; // bump version ONCE

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
    const poornimaRes = await fetch("poornima.json");
    if (!poornimaRes.ok) throw new Error("Failed to load poornima.json");
    poornimaDates = await poornimaRes.json();
    console.log("Poornima calendar loaded:", poornimaDates.length);

    // Load ledger ONLY from IndexedDB
    ledgerData = await loadLedgerFromDB();

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
  const cumulative = getCumulativeTotal();
  const progress = getNextCroreProgress();

  const years = Object.keys(yearlyTotals).sort((a, b) => b - a);

  container.innerHTML = `
    <div class="reflection-box">
      <div class="reflection-line">
        <strong>Total Jaap:</strong>
        ${cumulative.toLocaleString()}
      </div>

      <div class="reflection-line">
        <strong>Next Milestone:</strong>
        ${progress.currentCrore + 1} Crore
        (${progress.percent}%)
      </div>

      <div class="yearly-totals">
        ${years.map(year => `
          <div class="year-line">
            ${year}: ${yearlyTotals[year].toLocaleString()}
          </div>
        `).join("")}
      </div>
	  
	  <div class="legend">
  🏵️ Crore Milestone &nbsp;&nbsp; 🌕 Poornima &nbsp;&nbsp; 🔴 Sunday &nbsp;&nbsp; ▸ Notes
</div>

	  
    </div>
  `;
}


function renderLedgerList() {
  const container = document.getElementById("ledger-list");

  const todayISO = getTodayISO();

  const filtered = ledgerData
    .filter(entry => entry.date <= todayISO)
    .sort((a, b) => b.date.localeCompare(a.date));

  container.innerHTML = "";

  filtered.forEach(entry => {
    const row = document.createElement("div");
    row.className = "ledger-row";
	if (isSunday(entry.date)) {
  row.classList.add("sunday");
}

    row.innerHTML = `
  <div class="ledger-main">
    <span class="ledger-chevron">▸</span>

    <span class="ledger-date">
  ${entry.date}
  ${getCroreMilestone(entry.date) ? " 🏵️" : ""}
  ${hasExplicitPoornima(entry.notes) ? " 🌕" : ""}
</span>

    <span class="ledger-jaap">${entry.jaap ?? "—"}</span>
  </div>
  <div class="ledger-notes">
  ${getCroreMilestone(entry.date)
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
          <input
            type="number"
            class="edit-jaap"
            value="${entry.jaap ?? ""}"
          >
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

  });
}
const chevron = row.querySelector(".ledger-chevron");

chevron.addEventListener("click", (e) => {
  e.stopPropagation();

  const expanded = row.classList.contains("expanded");

  // Collapse all rows and reset chevrons
  document.querySelectorAll(".ledger-row").forEach(r => {
    r.classList.remove("expanded");
    const ch = r.querySelector(".ledger-chevron");
    if (ch) ch.textContent = "▸";
  });

  // Expand this row if it was not already expanded
  if (!expanded) {
    row.classList.add("expanded");
    chevron.textContent = "▾";
  }
});

    container.appendChild(row);
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
    <h2>Today</h2>

    <p><strong>Date:</strong> ${entry.date}</p>

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

}
document.getElementById("restore-backup-btn")
  ?.addEventListener("click", restoreFromBackup);
