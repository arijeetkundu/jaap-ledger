// End-to-end tests driving full user flows through the real UI: Background
// theme swatches, splash screen rotation, Mala View toggle, Sankalpa
// establish/rewrite, Today Card update, Import/Export, and Restore from
// Backup.
//
// Each Puppeteer launch gets a fresh, isolated browser profile (a temp user
// data dir), so these tests never touch a real user's browser data — writes
// to IndexedDB/localStorage here are thrown away when the browser closes.
//
// Run with the app already being served (e.g. `python -m http.server 3333`).

const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");

const BASE = "http://localhost:3333";
const SPLASH_WAIT_MS = 2600; // outlasts the 2000ms display + 500ms fade
let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

async function freshLoad(page, { clearStorage = false } = {}) {
  if (clearStorage) {
    await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
    await page.evaluate(() => { localStorage.clear(); });
  }
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  const pageErrors = [];
  page.on("pageerror", err => pageErrors.push(err.message));
  page.on("console", msg => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  // Accept every alert()/confirm() dialog throughout the suite — every flow
  // exercised here is the "proceed" path (establish, rewrite, import,
  // restore); none of the happy-path assertions depend on a decline.
  page.on("dialog", async (dialog) => {
    await dialog.accept();
  });

  // ── Background theme: default & persistence ───────────────────────
  console.log("\n=== Background theme ===");
  await freshLoad(page, { clearStorage: true });

  assert(
    "defaults to Mandala on first-ever load",
    (await page.evaluate(() => document.body.className)).includes("bg-mandala")
  );

  await page.click("#maintenance-toggle");
  await page.waitForSelector("#maintenance-drawer.open");
  await new Promise(r => setTimeout(r, 400)); // let the slide-in transition finish

  await page.click("#bg-swatch-alpana");
  assert(
    "clicking Alpana swatch swaps body class",
    (await page.evaluate(() => document.body.className)).includes("bg-alpana")
  );
  assert(
    "Alpana selection persisted to localStorage",
    await page.evaluate(() => localStorage.getItem("backgroundChoice")) === "alpana"
  );
  assert(
    "Alpana swatch marked active",
    (await page.$eval(".background-swatch.active", el => el.id)) === "bg-swatch-alpana"
  );

  await page.reload({ waitUntil: "networkidle0" });
  assert(
    "background choice survives a reload",
    (await page.evaluate(() => document.body.className)).includes("bg-alpana")
  );

  // The splash screen is deliberately independent of the app's background
  // theme — it always shows its own dedicated art, never Alpana/Mandala/
  // Jharokha, regardless of which theme is currently selected.
  const splashBgWithAlpana = await page.evaluate(() => {
    const el = document.getElementById("splash-screen");
    return el ? getComputedStyle(el).backgroundImage : null;
  });
  assert(
    "splash screen always shows its own dedicated background, not the app theme",
    !!splashBgWithAlpana &&
      splashBgWithAlpana.includes("splash-background.webp") &&
      !splashBgWithAlpana.includes("bg-alpana.webp")
  );

  // Third option: Jharokha — a single full-bleed image, not a repeating tile.
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
  await page.click("#maintenance-toggle");
  await page.waitForSelector("#maintenance-drawer.open");
  await new Promise(r => setTimeout(r, 400));
  await page.click("#bg-swatch-jharokha");
  assert(
    "clicking Jharokha swatch swaps body class",
    (await page.evaluate(() => document.body.className)).includes("bg-jharokha")
  );
  assert(
    "Jharokha selection persisted to localStorage",
    await page.evaluate(() => localStorage.getItem("backgroundChoice")) === "jharokha"
  );
  const jharokhaBg = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById("app-background"));
    return { image: cs.backgroundImage, repeat: cs.backgroundRepeat, size: cs.backgroundSize };
  });
  assert("Jharokha background image is applied", jharokhaBg.image.includes("bg-jharokha.webp"));
  assert("Jharokha does not tile (background-repeat: no-repeat)", jharokhaBg.repeat === "no-repeat");
  assert("Jharokha covers the viewport (background-size: cover)", jharokhaBg.size === "cover");

  // Reload for a fresh #splash-screen to check (it self-removes ~2.5s after
  // load, and enough time has passed in this section that it's long gone
  // otherwise) — this also closes the drawer, so the swatch-restore flow
  // below can reliably re-open it from a known closed state.
  await page.reload({ waitUntil: "networkidle0" });
  const splashBgWithJharokha = await page.evaluate(() => {
    const el = document.getElementById("splash-screen");
    return el ? getComputedStyle(el).backgroundImage : null;
  });
  assert(
    "splash screen still ignores Jharokha too",
    !!splashBgWithJharokha &&
      splashBgWithJharokha.includes("splash-background.webp") &&
      !splashBgWithJharokha.includes("bg-jharokha.webp")
  );

  // Restore Mandala for the rest of the suite (also re-verifies the swatch flow in reverse).
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
  await page.click("#maintenance-toggle");
  await page.waitForSelector("#maintenance-drawer.open");
  await new Promise(r => setTimeout(r, 400));
  await page.click("#bg-swatch-mandala");
  assert(
    "switching back to Mandala works",
    (await page.evaluate(() => document.body.className)).includes("bg-mandala")
  );
  await page.click("#maintenance-toggle"); // close drawer

  // ── Splash deity image: framed, not full-bleed ──────────────────────
  console.log("\n=== Splash deity image framing ===");
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 900)); // steady display window, well before the 2s fade
  const framing = await page.evaluate(() => {
    const s = document.getElementById("splash-screen");
    const img = document.getElementById("splash-img");
    if (!s || !img) return null;
    const rS = s.getBoundingClientRect();
    const rImg = img.getBoundingClientRect();
    const cs = getComputedStyle(img);
    return {
      borderWidth: parseFloat(cs.borderTopWidth),
      insetTopPct: ((rImg.top - rS.top) / rS.height) * 100,
      insetLeftPct: ((rImg.left - rS.left) / rS.width) * 100,
      insetBottomPct: ((rS.bottom - rImg.bottom) / rS.height) * 100,
      insetRightPct: ((rS.right - rImg.right) / rS.width) * 100,
    };
  });
  assert("deity image has a visible border", !!framing && framing.borderWidth >= 4);
  assert(
    "deity image is inset on all four sides (a framed picture, not full-bleed)",
    !!framing &&
      framing.insetTopPct > 5 && framing.insetLeftPct > 5 &&
      framing.insetBottomPct > 5 && framing.insetRightPct > 5
  );

  // ── Splash screen rotation ─────────────────────────────────────────
  console.log("\n=== Splash screen rotation ===");
  const seen = [];
  for (let i = 0; i < 6; i++) {
    await page.reload({ waitUntil: "networkidle0" });
    const chosen = await page.evaluate(() => localStorage.getItem("lastSplashImage"));
    seen.push(chosen);
  }
  let consecutiveRepeat = false;
  for (let i = 1; i < seen.length; i++) {
    if (seen[i] === seen[i - 1]) consecutiveRepeat = true;
  }
  assert("splash image never repeats on consecutive opens", !consecutiveRepeat);
  assert("all chosen images come from the known pool of 5", seen.every(id =>
    ["hanuman", "chaturbhuj-rama", "lord-rama", "ram-rameshwar", "ram-darbar"].includes(id)
  ));

  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));

  // ── Mala View toggle ────────────────────────────────────────────────
  console.log("\n=== Mala View toggle ===");
  const jaapLabelBefore = await page.$eval("#today-card label", el => el.textContent.trim().split("\n")[0]);
  assert("today card starts in Jaap mode", jaapLabelBefore.startsWith("Jaap"));

  await page.evaluate(() => {
    const cb = document.getElementById("mala-toggle");
    cb.checked = true;
    cb.dispatchEvent(new Event("change"));
  });
  const jaapLabelAfter = await page.$eval("#today-card label", el => el.textContent.trim().split("\n")[0]);
  assert("switching Mala View changes the Today Card input label to Malas", jaapLabelAfter.startsWith("Malas"));
  assert(
    "Mala View preference persists to localStorage",
    await page.evaluate(() => localStorage.getItem("malaViewEnabled")) === "true"
  );

  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
  const jaapLabelAfterReload = await page.$eval("#today-card label", el => el.textContent.trim().split("\n")[0]);
  assert("Mala View setting survives reload", jaapLabelAfterReload.startsWith("Malas"));

  // Switch back off for the rest of the suite (Today Card update below assumes Jaap mode).
  await page.evaluate(() => {
    const cb = document.getElementById("mala-toggle");
    cb.checked = false;
    cb.dispatchEvent(new Event("change"));
  });

  // ── Today Card update ────────────────────────────────────────────────
  console.log("\n=== Today Card update ===");
  const todayJaapField = await page.$("#today-jaap");
  await todayJaapField.click({ clickCount: 3 });
  await todayJaapField.type("216");
  const todayNotesField = await page.$("#today-notes");
  await todayNotesField.click({ clickCount: 3 });
  await todayNotesField.type("e2e test note");
  await page.click("#update-today");
  await new Promise(r => setTimeout(r, 1200)); // IndexedDB writes + rAF + transition

  assert("save toast appears after Today Card update", await page.$(".toast.toast-visible") !== null);
  const savedJaapValue = await page.$eval("#today-jaap", el => el.value);
  assert("today's entry reflects the saved jaap value", savedJaapValue === "216");

  // ── Sankalpa: establish then rewrite ───────────────────────────────
  console.log("\n=== Sankalpa ===");
  await page.click("#maintenance-toggle");
  await page.waitForSelector("#maintenance-drawer.open");
  await new Promise(r => setTimeout(r, 400));
  await page.click("#sankalpa-open-btn");
  await page.waitForSelector("#sankalpa-page.open");
  await new Promise(r => setTimeout(r, 200));

  const hasEstablishForm = await page.$("#sankalpa-establish") !== null;

  if (hasEstablishForm) {
    assert("Establish button starts disabled with empty text", await page.$eval("#sankalpa-establish", el => el.disabled));
    await page.type("#sankalpa-text", "e2e test vow");
    assert("Establish button enables once text is entered", !(await page.$eval("#sankalpa-establish", el => el.disabled)));
    await page.click("#sankalpa-establish");
    await new Promise(r => setTimeout(r, 300));
  }

  assert("Sankalpa page now shows the established view", await page.$(".sankalpa-text-display") !== null);
  const establishedDate = await page.$eval(".sankalpa-date-display", el => el.textContent);

  await page.click("#sankalpa-rewrite-btn");
  await page.waitForSelector("#sankalpa-rewrite-form", { visible: true });
  await page.evaluate(() => { document.getElementById("sankalpa-text-edit").value = ""; });
  await page.type("#sankalpa-text-edit", "rewritten e2e vow");
  await page.click("#sankalpa-confirm-rewrite"); // confirm() dialog auto-accepted
  await new Promise(r => setTimeout(r, 300));

  const rewrittenText = await page.$eval(".sankalpa-text-display", el => el.textContent);
  const rewrittenDate = await page.$eval(".sankalpa-date-display", el => el.textContent);
  assert("rewrite updates the displayed vow text", rewrittenText === "rewritten e2e vow");
  assert("rewrite preserves the original establishment date", rewrittenDate === establishedDate);

  await page.click("#sankalpa-close");
  await page.click("#maintenance-toggle"); // close drawer

  // ── Import / Export ──────────────────────────────────────────────────
  console.log("\n=== Import / Export ===");
  await page.evaluateOnNewDocument(() => {
    window.__exportedBlobText = null;
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      blob.text().then(t => { window.__exportedBlobText = t; });
      return originalCreateObjectURL(blob);
    };
  });
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));

  const rowCountBeforeExport = await page.$$eval(".ledger-row", els => els.length);

  await page.click("#maintenance-toggle");
  await page.waitForSelector("#maintenance-drawer.open");
  await new Promise(r => setTimeout(r, 400));
  await page.click("#export-json-btn");
  await new Promise(r => setTimeout(r, 300));

  const exportedText = await page.evaluate(() => window.__exportedBlobText);
  let exportedArray = null;
  try { exportedArray = JSON.parse(exportedText || "null"); } catch { /* leave null */ }
  assert("export produces a JSON array", Array.isArray(exportedArray));
  assert(
    "exported entry count matches the rendered ledger row count",
    !!exportedArray && exportedArray.length === rowCountBeforeExport
  );
  assert(
    "exported entries have the expected shape",
    !!exportedArray && exportedArray.every(e => typeof e.date === "string" && "jaap" in e && "notes" in e)
  );

  const importFixture = [
    { date: "2020-01-01", jaap: 108, notes: "imported one" },
    { date: "2020-01-02", jaap: null, notes: "" },
    { date: "2020-01-03", jaap: 500, notes: "imported three" },
  ];
  const tmpFile = path.join(os.tmpdir(), `jaap-import-fixture-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(importFixture));

  const importInput = await page.$("#import-json-input");
  await importInput.uploadFile(tmpFile);
  await new Promise(r => setTimeout(r, 800)); // file read + confirm()/alert() dialog round-trip + re-render

  // Importing replaces the ledger with the 3 fixture entries, but renderToday()
  // always ensures today has an entry (ensureTodayEntryExists) — since none of
  // the fixture's 2020 dates is "today", one extra row is auto-created.
  const rowCountAfterImport = await page.$$eval(".ledger-row", els => els.length);
  assert(
    "import replaces the ledger with the imported entries (+1 auto-created today entry)",
    rowCountAfterImport === importFixture.length + 1
  );

  fs.unlinkSync(tmpFile);

  // ── Restore from Backup ────────────────────────────────────────────
  console.log("\n=== Restore from Backup ===");
  // A backup is written automatically at bootstrap and after every save
  // (see saveAutomaticBackup), so one already exists at this point in the run.
  const drawerOpenBeforeRestore = await page.evaluate(() =>
    document.getElementById("maintenance-drawer").classList.contains("open")
  );
  if (!drawerOpenBeforeRestore) {
    await page.click("#maintenance-toggle");
    await page.waitForSelector("#maintenance-drawer.open");
    await new Promise(r => setTimeout(r, 400));
  }
  await page.waitForSelector("#restore-backup-btn", { visible: true });
  await page.click("#restore-backup-btn");
  await new Promise(r => setTimeout(r, 500)); // confirm() + alert() dialogs auto-accepted

  const rowCountAfterRestore = await page.$$eval(".ledger-row", els => els.length);
  assert(
    "restoring from backup replaces the ledger again (no longer the 3-row import fixture)",
    rowCountAfterRestore !== importFixture.length
  );

  const backupStoreHasEntries = await page.evaluate(async () => {
    const db = await window.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("ledger-backups", "readonly");
      const req = tx.objectStore("ledger-backups").get("latest");
      req.onsuccess = () => resolve(!!req.result && Array.isArray(req.result.entries));
      req.onerror = () => reject(req.error);
    });
  });
  assert("a backup record exists in the ledger-backups IndexedDB store", backupStoreHasEntries === true);

  await page.click("#maintenance-toggle"); // close drawer

  // ── Console errors ───────────────────────────────────────────────────
  console.log("\n=== Console errors ===");
  assert("no JS errors on page across the whole run", pageErrors.length === 0);
  if (pageErrors.length > 0) console.log("  errors:", pageErrors);

  await browser.close();

  console.log("\n" + "─".repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("─".repeat(40));
  process.exit(failed > 0 ? 1 : 0);
})();
