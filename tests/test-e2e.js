// End-to-end tests driving full user flows through the real UI: Background
// theme swatches, splash screen rotation, Mala View toggle, Sankalpa
// establish/rewrite, Today Card update, Import/Export, and Restore from
// Backup.
//
// Each Puppeteer launch gets a fresh, isolated browser profile (a temp user
// data dir), so these tests never touch a real user's browser data — writes
// to IndexedDB/localStorage here are thrown away when the browser closes.
// Real file downloads (triggered by the Export test) are separately routed
// to a scratch temp dir via Page.setDownloadBehavior, for the same reason.
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

  // The Import/Export test below clicks the real Export button, which
  // triggers a real browser download (app.js's `a.download = ...` +
  // a.click()). Puppeteer's isolated temp profile keeps IndexedDB/
  // localStorage from touching a real user's browser data, but it does NOT
  // by itself redirect Chrome's download directory — that's a separate
  // Page.setDownloadBehavior setting, and without it downloads land in the
  // OS's real Downloads folder even from a "throwaway" profile. Route them
  // into a scratch temp dir instead so repeated local test runs never leave
  // jaap-ledger-export-*.json files in a developer's actual Downloads folder.
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaap-ledger-test-downloads-"));
  const cdpSession = await page.createCDPSession();
  await cdpSession.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });

  await page.evaluateOnNewDocument(() => localStorage.setItem("appLanguage", "en"));
  // Also pre-seed today's date as the last Sunday-backup prompt date, so
  // the Sunday Backup Reminder modal (a real position:fixed, inset:0
  // backdrop) never opens and silently swallows a click meant for
  // something underneath it whenever this suite actually runs on a Sunday.
  await page.evaluateOnNewDocument(() => {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    localStorage.setItem("lastSundayBackupPromptDate", iso);
  });
  // This app is a phone PWA; Puppeteer's 800x600 default is a desktop-ish
  // shape that doesn't reflect real usage and breaks viewport-relative
  // layout assertions (e.g. the splash screen's portrait-framed deity
  // image). Use a representative phone viewport for the whole suite.
  await page.setViewport({ width: 390, height: 844 });

  const pageErrors = [];
  page.on("pageerror", err => pageErrors.push(err.message));
  page.on("console", msg => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  // Most flows here are the "proceed" path (establish, rewrite, import,
  // restore), so dialogs are accepted by default. A shared flag lets one
  // test flip to "decline" temporarily (see Restore from Backup below)
  // without needing a second, competing dialog listener.
  let shouldAcceptDialogs = true;
  page.on("dialog", async (dialog) => {
    if (shouldAcceptDialogs) {
      await dialog.accept();
    } else {
      await dialog.dismiss();
    }
  });

  // ── Accessibility: pinch-to-zoom is not disabled ─────────────────────
  console.log("\n=== Accessibility ===");
  await freshLoad(page, { clearStorage: true });
  const viewportContent = await page.$eval('meta[name="viewport"]', el => el.getAttribute("content"));
  assert("viewport meta does not disable user scaling", !viewportContent.includes("user-scalable=no"));
  assert("viewport meta does not cap maximum-scale", !viewportContent.includes("maximum-scale"));

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
  await new Promise(r => setTimeout(r, 300)); // steady display window, safely before the ~2s fade (900ms was occasionally flaky under system load)
  const framing = await page.evaluate(() => {
    const s = document.getElementById("splash-screen");
    const img = document.getElementById("splash-img");
    if (!s || !img) return null;
    const rS = s.getBoundingClientRect();
    const rImg = img.getBoundingClientRect();
    const cs = getComputedStyle(img);
    // Compare against the CONTENT box (border-box minus the border on each
    // side), since that's the area the image actually renders into.
    const border = parseFloat(cs.borderTopWidth) * 2;
    const contentW = rImg.width - border;
    const contentH = rImg.height - border;
    const naturalRatio = img.naturalWidth / img.naturalHeight;
    return {
      borderWidth: parseFloat(cs.borderTopWidth),
      objectFit: cs.objectFit,
      contentRatio: contentW / contentH,
      naturalRatio,
      // How much empty band (letterbox) exists above+below the image
      // inside its own frame. 0 means the frame hugs the image exactly.
      letterboxPx: contentH - contentW / naturalRatio,
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
  assert("deity image uses object-fit: contain (never distorts or crops)", !!framing && framing.objectFit === "contain");
  // Regression guard for the reported white-band bug: the frame must take
  // each image's OWN aspect ratio, so no letterbox appears above/below it.
  // A previous fixed aspect-ratio: 2/3 left a measured 15px band on Ram
  // Darbar (0.690 natural ratio vs the frame's 0.667).
  assert(
    "frame hugs the image's own aspect ratio (no letterbox band)",
    !!framing && Math.abs(framing.contentRatio - framing.naturalRatio) < 0.01
  );
  assert(
    "no white space above/below the deity image",
    !!framing && Math.abs(framing.letterboxPx) < 1.5
  );

  // ── Reflection card progress bar contrast ───────────────────────────
  console.log("\n=== Progress bar contrast ===");
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS)); // let the splash clear
  const progress = await page.evaluate(() => {
    const track = document.querySelector(".progress-track");
    const fill = document.querySelector(".progress-fill");
    if (!track || !fill) return null;
    return {
      trackBg: getComputedStyle(track).backgroundColor,
      fillImage: getComputedStyle(fill).backgroundImage,
    };
  });
  assert("progress bar renders", !!progress);
  // The fill must carry the deep maroon token (108, 28, 39) so it reads
  // clearly darker than the light track -- previously both were golds,
  // with the fill's leading edge actually lighter than the empty track.
  assert(
    "progress fill uses the deep maroon->gold gradient",
    !!progress && progress.fillImage.includes("108, 28, 39")
  );
  assert(
    "progress track is no longer the old flat mid-gold",
    !!progress && !progress.trackBg.includes("220, 184, 101")
  );

  // ── Splash screen default (Hanuman, no custom images configured) ────
  // Full rotation behavior with custom images mixed in (never-repeat
  // invariant across a multi-image pool) is covered in
  // tests/test-splash-custom.js; here we just confirm the no-customs
  // default is stable, since Hanuman is the sole fixed default image.
  console.log("\n=== Splash screen default ===");
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await page.reload({ waitUntil: "networkidle0" });
    const chosen = await page.evaluate(() => localStorage.getItem("lastSplashImage"));
    seen.push(chosen);
  }
  assert("with no custom images configured, splash always shows the Hanuman default", seen.every(id => id === "hanuman"));

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
  assert("switching Mala View changes the Today Card input label to Mala Count", jaapLabelAfter.startsWith("Mala"));
  assert(
    "Mala View preference persists to localStorage",
    await page.evaluate(() => localStorage.getItem("malaViewEnabled")) === "true"
  );

  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
  const jaapLabelAfterReload = await page.$eval("#today-card label", el => el.textContent.trim().split("\n")[0]);
  assert("Mala View setting survives reload", jaapLabelAfterReload.startsWith("Mala"));

  // Switch back off for the rest of the suite (Today Card update below assumes Jaap mode).
  await page.evaluate(() => {
    const cb = document.getElementById("mala-toggle");
    cb.checked = false;
    cb.dispatchEvent(new Event("change"));
  });

  // ── Today Card update ────────────────────────────────────────────────
  console.log("\n=== Today Card update ===");
  const todayCardWidths = await page.evaluate(() => ({
    jaap: document.getElementById("today-jaap").getBoundingClientRect().width,
    notes: document.getElementById("today-notes").getBoundingClientRect().width,
  }));
  assert(
    "Notes textarea spans the same width as the Jaap input",
    Math.abs(todayCardWidths.jaap - todayCardWidths.notes) < 1
  );

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

  // ── todayISO staleness: refreshed when the app returns to the foreground ──
  console.log("\n=== todayISO staleness (visibilitychange refresh) ===");
  const staleRefresh = await page.evaluate(() => {
    todayISO = "2000-01-01"; // force a stale value, as if the tab sat open across midnight
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    return { after: todayISO, realToday: getTodayISO() };
  });
  assert("becoming visible again refreshes a stale todayISO to the real current date", staleRefresh.after === staleRefresh.realToday);
  assert("the refresh actually corrected staleness, not a no-op", staleRefresh.after !== "2000-01-01");

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

  // ── Lazy year build: a non-current year's rows aren't built until expanded ──
  console.log("\n=== Ledger List lazy year build (performance) ===");
  const yearStateBeforeExpand = await page.evaluate(() => {
    const header = document.querySelector('.ledger-year-header[data-year="2020"]');
    const container = header.nextElementSibling;
    return {
      built: container.dataset.built,
      rowCount: container.querySelectorAll(".ledger-row").length,
      hidden: container.style.display === "none",
    };
  });
  assert("a non-current year's container starts marked not-built", yearStateBeforeExpand.built === "false");
  assert("a non-current year's container has no row DOM until expanded", yearStateBeforeExpand.rowCount === 0);
  assert("a non-current year's container starts collapsed", yearStateBeforeExpand.hidden === true);

  // Importing replaces the ledger with the 3 fixture entries, but renderToday()
  // always ensures today has an entry (ensureTodayEntryExists) — since none of
  // the fixture's 2020 dates is "today", one extra row is auto-created.
  // 2020 isn't the current year, so its rows are lazily un-built until
  // expanded (see renderLedgerList()'s lazy year-build) — expand it via its
  // year header (additive, unlike jump-to-year which collapses everything
  // else) so both the imported rows and the auto-created today row count.
  await page.click('.ledger-year-header[data-year="2020"]');
  await new Promise(r => setTimeout(r, 300));

  const yearStateAfterExpand = await page.evaluate(() => {
    const header = document.querySelector('.ledger-year-header[data-year="2020"]');
    const container = header.nextElementSibling;
    return { built: container.dataset.built, rowCount: container.querySelectorAll(".ledger-row").length };
  });
  assert("expanding a year builds and marks it built", yearStateAfterExpand.built === "true");
  assert("expanding 2020 builds exactly its 3 imported rows", yearStateAfterExpand.rowCount === 3);

  const rowCountAfterImport = await page.$$eval(".ledger-row", els => els.length);
  assert(
    "import replaces the ledger with the imported entries (+1 auto-created today entry)",
    rowCountAfterImport === importFixture.length + 1
  );

  // A regression that only wires buildYearRows()'s chevron/save handlers
  // correctly for the eager (current-year) path — not the lazy path this
  // section built via a header click above — would pass every assertion so
  // far (DOM/row-count checks only) while leaving a lazily-built row's
  // controls silently non-functional. Actually click a chevron and a save
  // button inside the already-expanded 2020 container to rule that out.
  // 2020-01-01 is far outside the real 7-day editable window, so it renders
  // locked (no .edit-jaap/.save-entry at all) — temporarily stub
  // isEditableEntry (a plain top-level `function`, so reachable/overridable
  // via `window.`) to force it editable for this one row, then re-render and
  // restore the real function afterward.
  // (This save re-renders the whole Ledger List — 2020 collapses/unbuilds
  // again afterward, same as any other save — so this must run after the
  // row-count assertion above, not before it.)
  await page.evaluate(() => {
    window.__realIsEditableEntry = isEditableEntry;
    window.isEditableEntry = () => true;
    renderToday();
  });
  await page.click('.ledger-year-header[data-year="2020"]');
  await new Promise(r => setTimeout(r, 300));

  // Rows within a year render most-recent-first, so the first .ledger-row
  // here is 2020-01-03, not 2020-01-01 — read its own displayed date back
  // rather than assuming which fixture entry it is.
  const lazyRow2020 = await page.evaluateHandle(() => {
    const header = document.querySelector('.ledger-year-header[data-year="2020"]');
    return header.nextElementSibling.querySelector(".ledger-row");
  });
  const lazyRowDate = await lazyRow2020.asElement().$eval(".ledger-date", el => el.textContent.trim());
  await lazyRow2020.asElement().$eval(".ledger-chevron", (el) => el.click());
  await new Promise(r => setTimeout(r, 300));
  const lazyRowExpandedClass = await lazyRow2020.asElement().evaluate((el) => el.classList.contains("expanded"));
  assert("a lazily-built row's chevron expands it just like an eagerly-built row's", lazyRowExpandedClass);

  const lazyJaapInput = await lazyRow2020.asElement().$(".edit-jaap");
  await lazyJaapInput.click({ clickCount: 3 });
  await lazyJaapInput.type("999");
  await lazyRow2020.asElement().$eval(".save-entry", (el) => el.click());
  await new Promise(r => setTimeout(r, 1200)); // IndexedDB writes + rAF + transition

  const lazyRowSavedJaap = await page.evaluate((dateText) => {
    const entry = ledgerData.find((e) => dateText.includes(formatDate(e.date)));
    return entry ? entry.jaap : null;
  }, lazyRowDate);
  assert("a lazily-built row's save button actually persists the edit", lazyRowSavedJaap === 999);

  await page.evaluate(() => {
    window.isEditableEntry = window.__realIsEditableEntry;
    delete window.__realIsEditableEntry;
    renderToday();
  });

  fs.unlinkSync(tmpFile);

  // ── Import validation: malformed input is rejected, ledger untouched ──
  console.log("\n=== Import validation ===");
  const rowCountBeforeBadImports = await page.$$eval(".ledger-row", els => els.length);

  const badShapeFile = path.join(os.tmpdir(), `jaap-import-badshape-${Date.now()}.json`);
  fs.writeFileSync(badShapeFile, JSON.stringify({ not: "an array" }));
  await importInput.uploadFile(badShapeFile);
  await new Promise(r => setTimeout(r, 500));
  assert(
    "a non-array import file is rejected without changing the ledger",
    (await page.$$eval(".ledger-row", els => els.length)) === rowCountBeforeBadImports
  );
  fs.unlinkSync(badShapeFile);

  const badEntryFile = path.join(os.tmpdir(), `jaap-import-badentry-${Date.now()}.json`);
  fs.writeFileSync(badEntryFile, JSON.stringify([
    { date: "2020-01-01", jaap: "not-a-number", notes: "" },
  ]));
  await importInput.uploadFile(badEntryFile);
  await new Promise(r => setTimeout(r, 500));
  assert(
    "an entry with a non-numeric jaap value is rejected without changing the ledger",
    (await page.$$eval(".ledger-row", els => els.length)) === rowCountBeforeBadImports
  );
  fs.unlinkSync(badEntryFile);

  const badDateFile = path.join(os.tmpdir(), `jaap-import-baddate-${Date.now()}.json`);
  fs.writeFileSync(badDateFile, JSON.stringify([
    { date: "01-01-2020", jaap: 100, notes: "" },
  ]));
  await importInput.uploadFile(badDateFile);
  await new Promise(r => setTimeout(r, 500));
  assert(
    "an entry with a malformed date is rejected without changing the ledger",
    (await page.$$eval(".ledger-row", els => els.length)) === rowCountBeforeBadImports
  );
  fs.unlinkSync(badDateFile);

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

  // Declining the confirm() dialog must leave the ledger untouched.
  const rowCountBeforeDeclinedRestore = await page.$$eval(".ledger-row", els => els.length);
  shouldAcceptDialogs = false;
  await page.click("#restore-backup-btn");
  await new Promise(r => setTimeout(r, 500));
  shouldAcceptDialogs = true;
  assert(
    "declining the Restore from Backup confirmation leaves the ledger unchanged",
    (await page.$$eval(".ledger-row", els => els.length)) === rowCountBeforeDeclinedRestore
  );

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
  fs.rmSync(downloadDir, { recursive: true, force: true });

  console.log("\n" + "─".repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("─".repeat(40));
  process.exit(failed > 0 ? 1 : 0);
})();
