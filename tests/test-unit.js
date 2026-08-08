// Unit tests for pure/near-pure logic functions in app.js.
//
// app.js has no module system — top-level `function` declarations attach to
// `window` in a plain <script>, so they're callable directly from a Puppeteer
// page context via page.evaluate(() => fnName(...)). Top-level `let`/`const`
// state (ledgerData, malaViewEnabled, todayISO, ...) does NOT attach to
// `window`, so functions depending on that state are driven through real UI
// interaction (e.g. toggling the actual #mala-toggle checkbox) rather than by
// injecting state directly.
//
// Run with the app already being served (e.g. `python -m http.server 3333`).

const puppeteer = require("puppeteer");

const BASE = "http://localhost:3333";
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

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  const pageErrors = [];
  page.on("pageerror", err => pageErrors.push(err.message));
  page.on("console", msg => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  // Outlast the splash screen (2000ms display + 500ms fade).
  await new Promise(r => setTimeout(r, 2600));

  // ── formatIndianNumber ──────────────────────────────────────────
  console.log("\n=== formatIndianNumber ===");
  assert("basic grouping", await page.evaluate(() => formatIndianNumber(6500000)) === "65,00,000");
  assert("small number, no comma", await page.evaluate(() => formatIndianNumber(500)) === "500");
  assert("zero", await page.evaluate(() => formatIndianNumber(0)) === "0");
  assert("null -> '0'", await page.evaluate(() => formatIndianNumber(null)) === "0");
  assert("undefined -> '0'", await page.evaluate(() => formatIndianNumber(undefined)) === "0");
  assert("NaN -> '0'", await page.evaluate(() => formatIndianNumber(NaN)) === "0");
  assert("negative number", await page.evaluate(() => formatIndianNumber(-1234)) === "-1,234");

  // ── jaapToMala / malaToJaap / formatAsMala ──────────────────────
  console.log("\n=== jaapToMala / malaToJaap ===");
  assert("108 jaap = 1 mala", await page.evaluate(() => jaapToMala(108)) === 1);
  assert("floors, never rounds up (215 -> 1)", await page.evaluate(() => jaapToMala(215)) === 1);
  assert("0 jaap = 0 mala", await page.evaluate(() => jaapToMala(0)) === 0);
  assert("malaToJaap(1) = 108", await page.evaluate(() => malaToJaap(1)) === 108);
  assert("malaToJaap(0) = 0", await page.evaluate(() => malaToJaap(0)) === 0);
  assert("formatAsMala renders suffix", await page.evaluate(() => formatAsMala(216)) === "2 mala");

  // ── addDaysISO ───────────────────────────────────────────────────
  console.log("\n=== addDaysISO ===");
  assert("simple +1 day", await page.evaluate(() => addDaysISO("2026-01-01", 1)) === "2026-01-02");
  assert("month rollover", await page.evaluate(() => addDaysISO("2026-01-31", 1)) === "2026-02-01");
  assert("year rollover", await page.evaluate(() => addDaysISO("2025-12-31", 1)) === "2026-01-01");
  assert("negative delta", await page.evaluate(() => addDaysISO("2026-03-01", -1)) === "2026-02-28");
  assert("leap year Feb 29", await page.evaluate(() => addDaysISO("2024-02-28", 1)) === "2024-02-29");
  assert("delta 0 is a no-op", await page.evaluate(() => addDaysISO("2026-05-15", 0)) === "2026-05-15");

  // ── isSunday ─────────────────────────────────────────────────────
  console.log("\n=== isSunday ===");
  assert("known Sunday", await page.evaluate(() => isSunday("2026-08-02")) === true);
  assert("known non-Sunday", await page.evaluate(() => isSunday("2026-08-03")) === false);

  // ── escapeHTML ───────────────────────────────────────────────────
  console.log("\n=== escapeHTML ===");
  assert("escapes tags", await page.evaluate(() => escapeHTML("<b>hi</b>")) === "&lt;b&gt;hi&lt;/b&gt;");
  assert("escapes ampersand", await page.evaluate(() => escapeHTML("A & B")) === "A &amp; B");
  assert("null -> empty string", await page.evaluate(() => escapeHTML(null)) === "");
  assert("undefined -> empty string", await page.evaluate(() => escapeHTML(undefined)) === "");

  // ── getCurrentMilestone / getMilestoneProgress ──────────────────
  console.log("\n=== Milestones ===");
  assert("0 total -> 0th crore", await page.evaluate(() => getCurrentMilestone(0)) === 0);
  assert("exactly 1 crore -> bracket 1", await page.evaluate(() => getCurrentMilestone(10000000)) === 1);
  assert("halfway through a crore -> 50%", await page.evaluate(() => getMilestoneProgress(5000000)) === 50);
  assert("exact crore multiple -> 0% (start of next bracket)", await page.evaluate(() => getMilestoneProgress(10000000)) === 0);

  const milestoneHistoryEmpty = await page.evaluate(() => getMilestoneHistory([]));
  assert("empty entries -> empty history", Array.isArray(milestoneHistoryEmpty) && milestoneHistoryEmpty.length === 0);

  const outOfOrderHistory = await page.evaluate(() => getMilestoneHistory([
    { date: "2026-01-02", jaap: 4000000 },
    { date: "2026-01-01", jaap: 6000000 },
  ]));
  assert(
    "sorts entries by date before computing crossings",
    outOfOrderHistory.length === 1 && outOfOrderHistory[0].date === "2026-01-02"
  );
  assert("first milestone has null daysSincePrevious", outOfOrderHistory[0].daysSincePrevious === null);

  const multiCroreJump = await page.evaluate(() => getMilestoneHistory([
    { date: "2026-01-01", jaap: 25000000 },
  ]));
  assert(
    "a single entry crossing multiple crores only records the final bracket reached",
    multiCroreJump.length === 1 && multiCroreJump[0].crore === 2
  );

  // ── getCroreMilestone ────────────────────────────────────────────
  // Reads the global ledgerData directly (unlike getMilestoneHistory, which
  // takes entries as a parameter) — set it per-case, since no other test in
  // this file depends on it.
  console.log("\n=== getCroreMilestone ===");
  const noCrossing = await page.evaluate(() => {
    ledgerData = [
      { date: "2026-01-01", jaap: 1000000, notes: "" },
      { date: "2026-01-02", jaap: 1000000, notes: "" },
    ];
    return getCroreMilestone("2026-01-02");
  });
  assert("a date that doesn't cross a Crore boundary returns null", noCrossing === null);

  const singleCrossing = await page.evaluate(() => {
    ledgerData = [
      { date: "2026-01-01", jaap: 9000000, notes: "" },
      { date: "2026-01-02", jaap: 2000000, notes: "" },
    ];
    return getCroreMilestone("2026-01-02");
  });
  assert("a date crossing exactly one Crore boundary returns that crore number", singleCrossing === 1);

  const multiCrossing = await page.evaluate(() => {
    ledgerData = [
      { date: "2026-01-01", jaap: 25000000, notes: "" },
    ];
    return getCroreMilestone("2026-01-01");
  });
  assert(
    "a date crossing multiple Crore boundaries at once returns the final bracket reached (consistent with getMilestoneHistory)",
    multiCrossing === 2
  );

  const noMatchingEntry = await page.evaluate(() => {
    ledgerData = [
      { date: "2026-01-01", jaap: 5000000, notes: "" },
    ];
    return getCroreMilestone("2026-01-05");
  });
  assert("a date with no matching ledger entry returns null", noMatchingEntry === null);

  // ── sumJaapInRange ───────────────────────────────────────────────
  console.log("\n=== sumJaapInRange ===");
  const rangeResult = await page.evaluate(() => sumJaapInRange(
    [
      { date: "2026-01-01", jaap: 100 },
      { date: "2026-01-02", jaap: null },
      { date: "2026-01-03", jaap: 200 },
      { date: "2026-01-10", jaap: 500 },
    ],
    "2026-01-01",
    "2026-01-03"
  ));
  assert("sums only in-range, non-null entries", rangeResult.sum === 300);
  assert("counts only in-range, non-null entries (null excluded)", rangeResult.count === 2);

  const emptyRange = await page.evaluate(() => sumJaapInRange([], "2026-01-01", "2026-01-31"));
  assert("empty entries -> sum 0, count 0", emptyRange.sum === 0 && emptyRange.count === 0);

  const boundaryRange = await page.evaluate(() => sumJaapInRange(
    [{ date: "2026-01-05", jaap: 50 }], "2026-01-05", "2026-01-05"
  ));
  assert("start === end boundary is inclusive", boundaryRange.sum === 50 && boundaryRange.count === 1);

  // ── projectMilestoneFromPace ─────────────────────────────────────
  console.log("\n=== projectMilestoneFromPace ===");
  assert("falsy pace -> null", await page.evaluate(() => projectMilestoneFromPace([], 0)) === null);
  assert("negative pace -> null", await page.evaluate(() => projectMilestoneFromPace([], -5)) === null);
  const paceResult = await page.evaluate(() => projectMilestoneFromPace([{ date: "2026-01-01", jaap: 5000000 }], 100000));
  assert("positive pace returns a predictedDate and echoes dailyPace", !!paceResult && paceResult.dailyPace === 100000 && /^\d{4}-\d{2}-\d{2}$/.test(paceResult.predictedDate));

  // ── buildDateJaapMap / getRollingWindow ──────────────────────────
  console.log("\n=== Sparkline data helpers ===");
  const mapSize = await page.evaluate(() => buildDateJaapMap([
    { date: "2026-01-01", jaap: 100 },
    { date: "2026-01-02", jaap: null },
    { date: "2026-01-03", jaap: 200 },
  ]).size);
  assert("buildDateJaapMap skips null-jaap entries", mapSize === 2);

  const windowMissingDays = await page.evaluate(() => getRollingWindow(
    [{ date: "2026-01-07", jaap: 300 }], "2026-01-07"
  ));
  assert("missing days in window are skipped, not zero-filled", windowMissingDays.length === 1 && windowMissingDays[0].jaap === 300);

  const windowEmpty = await page.evaluate(() => getRollingWindow([], "2026-01-07"));
  assert("window with zero plottable points -> empty array", windowEmpty.length === 0);

  // ── renderSparklineSVG ────────────────────────────────────────────
  console.log("\n=== renderSparklineSVG ===");
  assert("empty points -> empty string", await page.evaluate(() => renderSparklineSVG([])) === "");
  assert("null points -> empty string", await page.evaluate(() => renderSparklineSVG(null)) === "");
  const singlePointSVG = await page.evaluate(() => renderSparklineSVG([{ date: "2026-01-01", jaap: 100 }]));
  assert("single point renders a dot with no polyline", singlePointSVG.includes("<circle") && !singlePointSVG.includes("<polyline"));
  const flatLineSVG = await page.evaluate(() => renderSparklineSVG([
    { date: "2026-01-01", jaap: 100 }, { date: "2026-01-02", jaap: 100 },
  ]));
  assert("all-equal values render without divide-by-zero (valid SVG)", flatLineSVG.includes("<polyline") && !flatLineSVG.includes("NaN"));

  // ── hasExplicitPoornima ───────────────────────────────────────────
  console.log("\n=== hasExplicitPoornima ===");
  assert("lowercase 'poornima'", await page.evaluate(() => hasExplicitPoornima("poornima today")) === true);
  assert("mixed case 'Purnima'", await page.evaluate(() => hasExplicitPoornima("Purnima vrat")) === true);
  assert("Devanagari पूर्णिमा", await page.evaluate(() => hasExplicitPoornima("आज पूर्णिमा है")) === true);
  assert("no keyword -> false", await page.evaluate(() => hasExplicitPoornima("regular practice day")) === false);
  assert("null notes -> false", await page.evaluate(() => hasExplicitPoornima(null)) === false);
  assert("empty string notes -> false", await page.evaluate(() => hasExplicitPoornima("")) === false);

  // ── isWithinLastNDays / isEditableEntry ───────────────────────────
  console.log("\n=== isWithinLastNDays / isEditableEntry ===");
  const today = await page.evaluate(() => getTodayISO());
  assert("today is within last 7 days", await page.evaluate((t) => isWithinLastNDays(t, 7), today) === true);
  const eightDaysAgo = await page.evaluate((t) => addDaysISO(t, -8), today);
  assert("8 days ago is NOT within last 7 days", await page.evaluate((d) => isWithinLastNDays(d, 7), eightDaysAgo) === false);
  const sevenDaysAgo = await page.evaluate((t) => addDaysISO(t, -7), today);
  assert("exactly 7 days ago IS within last 7 days (inclusive boundary)", await page.evaluate((d) => isWithinLastNDays(d, 7), sevenDaysAgo) === true);
  const tomorrow = await page.evaluate((t) => addDaysISO(t, 1), today);
  assert("a future date is not within N days", await page.evaluate((d) => isWithinLastNDays(d, 7), tomorrow) === false);
  assert("today's own entry is editable", await page.evaluate((t) => isEditableEntry(t), today) === true);

  // ── computeJaapFromInput (precision guard) ────────────────────────
  console.log("\n=== computeJaapFromInput ===");
  assert("empty string input -> null", await page.evaluate(() => computeJaapFromInput("", 500)) === null);
  assert("null input -> null", await page.evaluate(() => computeJaapFromInput(null, 500)) === null);

  // Ensure Mala View is OFF for the plain-jaap-mode case.
  await page.evaluate(() => {
    const cb = document.getElementById("mala-toggle");
    if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event("change")); }
  });
  assert("mala view off -> returns raw Number(rawValue)", await page.evaluate(() => computeJaapFromInput("250", 100)) === 250);

  // Switch Mala View ON via the real UI control so the closure-scoped
  // malaViewEnabled flips (it isn't reachable via window directly).
  await page.evaluate(() => {
    const cb = document.getElementById("mala-toggle");
    if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event("change")); }
  });
  assert(
    "mala view on, unchanged legacy fractional value -> preserves exact original jaap",
    await page.evaluate(() => computeJaapFromInput(String(jaapToMala(650)), 650)) === 650 // 650 = 6 malas (648) + 2 leftover, floored input unchanged
  );
  assert(
    "mala view on, unchanged NON-fractional original -> recomputes to malaToJaap(input)",
    await page.evaluate(() => computeJaapFromInput(String(jaapToMala(648)), 648)) === 648
  );
  assert(
    "mala view on, value actually changed -> recomputes from the new mala input, ignoring legacy original",
    await page.evaluate(() => computeJaapFromInput("10", 650)) === 1080
  );

  // Restore Mala View to off so this test file doesn't leak UI state into other suites.
  await page.evaluate(() => {
    const cb = document.getElementById("mala-toggle");
    if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event("change")); }
  });

  // ── shouldShowSundayBackupReminder ─────────────────────────────────
  console.log("\n=== shouldShowSundayBackupReminder ===");
  // 2026-08-09 is a Sunday; 2026-08-10 (Monday) and 2026-08-16 (next Sunday) anchor the rest.
  assert(
    "a Sunday with no prior prompt date shows the reminder",
    await page.evaluate(() => shouldShowSundayBackupReminder("2026-08-09", null)) === true
  );
  assert(
    "a Sunday with an older prompt date still shows the reminder",
    await page.evaluate(() => shouldShowSundayBackupReminder("2026-08-09", "2026-08-02")) === true
  );
  assert(
    "a non-Sunday never shows the reminder, prompt date or not",
    await page.evaluate(() => shouldShowSundayBackupReminder("2026-08-10", null)) === false
  );
  assert(
    "a Sunday whose prompt date already matches it does not show again the same day",
    await page.evaluate(() => shouldShowSundayBackupReminder("2026-08-09", "2026-08-09")) === false
  );
  assert(
    "the next Sunday shows again even though last week's Sunday is stored",
    await page.evaluate(() => shouldShowSundayBackupReminder("2026-08-16", "2026-08-09")) === true
  );

  // ── buildLedgerExportPayload ────────────────────────────────────────
  console.log("\n=== buildLedgerExportPayload ===");
  const exportPayload = await page.evaluate(() => {
    ledgerData = [
      { date: "2026-01-01", jaap: 500, notes: "hello" },
      { date: "2026-01-02", jaap: null, notes: "" },
      { date: "2026-01-03" }, // missing jaap/notes entirely
    ];
    return buildLedgerExportPayload();
  });
  assert("export payload has one entry per ledger entry", exportPayload.length === 3);
  assert(
    "export payload preserves date/jaap/notes for a normal entry",
    exportPayload[0].date === "2026-01-01" && exportPayload[0].jaap === 500 && exportPayload[0].notes === "hello"
  );
  assert("export payload preserves an explicit null jaap", exportPayload[1].jaap === null);
  assert(
    "export payload defaults missing jaap/notes to null/empty string rather than undefined",
    exportPayload[2].jaap === null && exportPayload[2].notes === ""
  );

  // ── buildDriveUploadRequest ──────────────────────────────────────────
  console.log("\n=== buildDriveUploadRequest ===");
  const createRequest = await page.evaluate(() => buildDriveUploadRequest(null, '{"a":1}'));
  assert("no existing file -> POST to the multipart create endpoint", createRequest.method === "POST");
  assert("create request targets uploadType=multipart", createRequest.url.includes("uploadType=multipart"));
  assert("create request body embeds the payload JSON", createRequest.body.includes('{"a":1}'));
  assert("create request body embeds the fixed backup filename", createRequest.body.includes("sumiran-lite-backup.json"));

  const updateRequest = await page.evaluate(() => buildDriveUploadRequest("existing-file-id-123", '{"b":2}'));
  assert("an existing file id -> PATCH to the media update endpoint", updateRequest.method === "PATCH");
  assert("update request URL embeds the existing file id", updateRequest.url.includes("existing-file-id-123"));
  assert("update request URL targets uploadType=media", updateRequest.url.includes("uploadType=media"));
  assert("update request body is the payload JSON directly (no multipart wrapping)", updateRequest.body === '{"b":2}');

  console.log("\n=== Console errors ===");
  assert("no JS errors on page", pageErrors.length === 0);
  if (pageErrors.length > 0) console.log("  errors:", pageErrors);

  await browser.close();

  console.log("\n" + "─".repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("─".repeat(40));
  process.exit(failed > 0 ? 1 : 0);
})();
