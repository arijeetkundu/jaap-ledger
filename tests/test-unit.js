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
  await page.evaluateOnNewDocument(() => localStorage.setItem("appLanguage", "en"));

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
  assert("Bangla পূর্ণিমা", await page.evaluate(() => hasExplicitPoornima("আজ পূর্ণিমা")) === true);
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

  // ── isValidJaapValue (NaN/negative guard) ───────────────────────────
  console.log("\n=== isValidJaapValue ===");
  assert("null (no entry) is valid", await page.evaluate(() => isValidJaapValue(null)) === true);
  assert("zero is valid", await page.evaluate(() => isValidJaapValue(0)) === true);
  assert("a positive integer is valid", await page.evaluate(() => isValidJaapValue(10000000)) === true);
  assert("NaN is invalid", await page.evaluate(() => isValidJaapValue(NaN)) === false);
  assert("a negative number is invalid", await page.evaluate(() => isValidJaapValue(-5)) === false);
  assert("Infinity is invalid", await page.evaluate(() => isValidJaapValue(Infinity)) === false);
  assert(
    "computeJaapFromInput() on garbage input feeds isValidJaapValue() a rejectable NaN",
    await page.evaluate(() => isValidJaapValue(computeJaapFromInput("not-a-number", 500))) === false
  );

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

  // ── searchLedgerNotes ────────────────────────────────────────────────
  console.log("\n=== searchLedgerNotes ===");
  const searchFixture = [
    { date: "2024-01-01", jaap: 108, notes: "Morning Satsang with Guruji" },
    { date: "2025-06-06", jaap: 216, notes: "quiet satsang" },
    { date: "2026-02-02", jaap: 324, notes: "" },
    { date: "2026-03-03", jaap: 432 }, // no notes key at all
  ];
  const hits = await page.evaluate((f) => searchLedgerNotes(f, "satsang"), searchFixture);
  assert("matches notes case-insensitively", hits.length === 2);
  assert("results are newest-first", hits[0].date === "2025-06-06" && hits[1].date === "2024-01-01");
  assert(
    "entries with empty or missing notes never match",
    hits.every(h => h.date !== "2026-02-02" && h.date !== "2026-03-03")
  );
  assert(
    "an empty query matches nothing rather than everything",
    (await page.evaluate((f) => searchLedgerNotes(f, ""), searchFixture)).length === 0
  );
  assert(
    "a whitespace-only query is treated as empty",
    (await page.evaluate((f) => searchLedgerNotes(f, "   "), searchFixture)).length === 0
  );
  assert(
    "surrounding whitespace in a real query is ignored",
    (await page.evaluate((f) => searchLedgerNotes(f, "  guruji "), searchFixture)).length === 1
  );

  // ── getOnThisDayEntry ────────────────────────────────────────────────
  console.log("\n=== getOnThisDayEntry ===");
  const onThisDay = await page.evaluate(() => {
    ledgerData = [
      { date: "2023-08-12", jaap: 500, notes: "" },
      { date: "2024-08-12", jaap: 650, notes: "" },
      { date: "2025-08-12", jaap: 0, notes: "" },     // a zero day, not a memory
      { date: "2025-08-13", jaap: 900, notes: "" },   // different day
      { date: "2026-08-12", jaap: 216, notes: "" },   // today itself
    ];
    return {
      twoYearGap: getOnThisDayEntry("2026-08-12"),
      noMatch: getOnThisDayEntry("2026-12-25"),
      leapDay: getOnThisDayEntry("2026-02-29"),
    };
  });
  // 2025 is the same calendar day but was logged as 0, so the nearest
  // *real* memory is 2024 — two years back.
  assert("skips zero-jaap days and finds the nearest real memory", onThisDay.twoYearGap.jaap === 650);
  assert("reports how many years back that memory is", onThisDay.twoYearGap.yearsAgo === 2);
  assert("never returns today's own entry", onThisDay.twoYearGap.date === "2024-08-12");
  assert("returns null when no earlier year has this calendar day", onThisDay.noMatch === null);
  assert("a 29 Feb lookup simply finds nothing rather than throwing", onThisDay.leapDay === null);

  const onThisDayOneYear = await page.evaluate(() => {
    ledgerData = [
      { date: "2025-08-12", jaap: 650, notes: "" },
      { date: "2024-08-12", jaap: 500, notes: "" },
    ];
    return getOnThisDayEntry("2026-08-12");
  });
  assert("the nearest year wins over older ones", onThisDayOneYear.yearsAgo === 1 && onThisDayOneYear.jaap === 650);

  assert(
    "an empty ledger yields no memory",
    (await page.evaluate(() => { ledgerData = []; return getOnThisDayEntry("2026-08-12"); })) === null
  );

  // ── buildLedgerExportPayload ────────────────────────────────────────
  console.log("\n=== buildLedgerExportPayload ===");
  const exportPayload = await page.evaluate(() => {
    ledgerData = [
      { date: "2026-01-01", jaap: 500, notes: "hello" },
      { date: "2026-01-02", jaap: null, notes: "" },
      { date: "2026-01-03" }, // missing jaap/notes entirely
    ];
    return buildLedgerExportPayload({ id: "primary", text: "My vow", context: "Guru's blessing", date: "2023-04-01" });
  });
  assert("export payload is versioned", exportPayload.version === 2);
  assert("export payload has one entry per ledger entry", exportPayload.entries.length === 3);
  assert(
    "export payload preserves date/jaap/notes for a normal entry",
    exportPayload.entries[0].date === "2026-01-01" && exportPayload.entries[0].jaap === 500 && exportPayload.entries[0].notes === "hello"
  );
  assert("export payload preserves an explicit null jaap", exportPayload.entries[1].jaap === null);
  assert(
    "export payload defaults missing jaap/notes to null/empty string rather than undefined",
    exportPayload.entries[2].jaap === null && exportPayload.entries[2].notes === ""
  );
  assert(
    "export payload carries the Sankalpa (previously it had no export path at all)",
    exportPayload.sankalpa.text === "My vow" &&
      exportPayload.sankalpa.context === "Guru's blessing" &&
      exportPayload.sankalpa.date === "2023-04-01"
  );
  assert(
    "export payload drops the Sankalpa's internal storage key",
    !("id" in exportPayload.sankalpa)
  );

  const exportNoSankalpa = await page.evaluate(() => buildLedgerExportPayload(null));
  assert("a missing Sankalpa exports as null, not undefined", exportNoSankalpa.sankalpa === null);
  const exportBlankSankalpa = await page.evaluate(() => buildLedgerExportPayload({ text: "   ", context: "", date: "" }));
  assert("a blank-text Sankalpa is treated as absent", exportBlankSankalpa.sankalpa === null);

  // ── parseImportedLedgerFile (legacy + current formats) ───────────────
  console.log("\n=== parseImportedLedgerFile ===");
  // Every export produced before v2 was a bare JSON array. If that stopped
  // importing, every file a user already has on disk would be dead.
  const legacyParsed = await page.evaluate(() =>
    parseImportedLedgerFile([{ date: "2026-01-01", jaap: 108, notes: "" }])
  );
  assert("a legacy bare-array export still parses", legacyParsed !== null && legacyParsed.entries.length === 1);
  assert("a legacy export yields no Sankalpa (it never carried one)", legacyParsed.sankalpa === null);

  const currentParsed = await page.evaluate(() =>
    parseImportedLedgerFile({
      version: 2,
      entries: [{ date: "2026-01-01", jaap: 108, notes: "" }],
      sankalpa: { text: "vow", context: "", date: "2023-04-01" },
    })
  );
  assert("a v2 object export parses its entries", currentParsed.entries.length === 1);
  assert("a v2 object export parses its Sankalpa", currentParsed.sankalpa.text === "vow");

  assert(
    "a non-ledger object is rejected",
    (await page.evaluate(() => parseImportedLedgerFile({ foo: "bar" }))) === null
  );
  assert(
    "a bare string is rejected",
    (await page.evaluate(() => parseImportedLedgerFile("nope"))) === null
  );
  assert(
    "null is rejected",
    (await page.evaluate(() => parseImportedLedgerFile(null))) === null
  );
  assert(
    "a v2 payload with a malformed Sankalpa still imports its entries, dropping the bad vow",
    (await page.evaluate(() =>
      parseImportedLedgerFile({ version: 2, entries: [], sankalpa: { text: 123 } })
    )).sankalpa === null
  );

  // ── describeLastDriveBackup / daysSinceDateISO ───────────────────────
  console.log("\n=== Drive backup status text ===");
  assert(
    "no recorded backup reads as 'never'",
    (await page.evaluate(() => describeLastDriveBackup(null, "2026-08-11"))) === "Not yet backed up to Google Drive."
  );
  assert(
    "same-day backup reads as 'today'",
    (await page.evaluate(() => describeLastDriveBackup("2026-08-11T09:00:00.000Z", "2026-08-11"))) === "Last backed up today."
  );
  assert(
    "one day old reads as 'yesterday', not '1 days ago'",
    (await page.evaluate(() => describeLastDriveBackup("2026-08-10T09:00:00.000Z", "2026-08-11"))) === "Last backed up yesterday."
  );
  assert(
    "older backups report the day count",
    (await page.evaluate(() => describeLastDriveBackup("2026-07-30T09:00:00.000Z", "2026-08-11"))) === "Last backed up 12 days ago."
  );
  assert(
    "daysSinceDateISO counts whole days across a month boundary",
    (await page.evaluate(() => daysSinceDateISO("2026-07-30", "2026-08-11"))) === 12
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

  // ── i18n: t() lookup, fallback, and interpolation ────────────────────
  console.log("\n=== i18n: t() ===");
  assert("TRANSLATIONS loaded by bootstrap", await page.evaluate(() => !!TRANSLATIONS && Object.keys(TRANSLATIONS).length > 0));
  assert("t() returns English by default", await page.evaluate(() => t("todayHeading")) === "Today");
  assert("t() with a missing key falls back to returning the key itself", await page.evaluate(() => t("thisKeyDoesNotExist")) === "thisKeyDoesNotExist");
  assert("t() interpolates a single {param}", await page.evaluate(() => t("sankalpaEstablishedDate", { date: "1 Jan 2026" })) === "Established 1 Jan 2026");
  const restoreConfirmText = await page.evaluate(() => t("ledgerRestoreConfirm", { date: "1 Jan 2026", count: 5 }));
  assert("t() interpolates multiple {params} in one template", restoreConfirmText.includes("1 Jan 2026") && restoreConfirmText.includes("5"));

  await page.evaluate(() => applyAppLanguage("hi"));
  assert("switching to Hindi changes t() output", await page.evaluate(() => t("todayHeading")) === "आज");
  assert("switching to Hindi re-renders the Today Card heading live", await page.evaluate(() => document.querySelector("#today-card h2").textContent.includes("आज")));
  assert("a missing key still falls back to the key itself in Hindi", await page.evaluate(() => t("thisKeyDoesNotExist")) === "thisKeyDoesNotExist");
  assert("localStorage persists the chosen language", await page.evaluate(() => localStorage.getItem("appLanguage")) === "hi");

  await page.evaluate(() => applyAppLanguage("bn"));
  assert("switching to Bangla changes t() output", await page.evaluate(() => t("todayHeading")) === "আজ");

  // Simulate a translations.json entry missing one language (e.g. a string
  // added after Bangla review) — must fall back to English, not crash/blank.
  const partialFallback = await page.evaluate(() => {
    const saved = TRANSLATIONS.commonCancelBtn;
    TRANSLATIONS.commonCancelBtn = { en: "Cancel" }; // no hi/bn
    const result = t("commonCancelBtn");
    TRANSLATIONS.commonCancelBtn = saved; // restore
    return result;
  });
  assert("a key missing the active language falls back to English", partialFallback === "Cancel");

  // A dictionary entry missing BOTH the active language and "en" must not
  // crash t()'s params interpolation (previously: undefined.split() threw).
  const totallyMissingResult = await page.evaluate(() => {
    const saved = TRANSLATIONS.commonCancelBtn;
    TRANSLATIONS.commonCancelBtn = {}; // no en, no hi, no bn
    let result, threw = false;
    try {
      result = t("commonCancelBtn", { x: 1 }); // params force the interpolation code path
    } catch (e) {
      threw = true;
    }
    TRANSLATIONS.commonCancelBtn = saved; // restore
    return { result, threw };
  });
  assert("a fully-empty dictionary entry does not crash t() even with params", !totallyMissingResult.threw);
  assert("a fully-empty dictionary entry falls back to the key itself", totallyMissingResult.result === "commonCancelBtn");

  // Dictionary integrity: every key must have complete en/hi/bn, and any
  // {placeholder} tokens must match exactly across all three languages —
  // guards the hand-maintained i18n/translations.json going forward.
  const dictionaryIssues = await page.evaluate(() => {
    const issues = [];
    const tokenPattern = /\{(\w+)\}/g;
    Object.keys(TRANSLATIONS).forEach((key) => {
      const entry = TRANSLATIONS[key];
      ["en", "hi", "bn"].forEach((lang) => {
        const value = entry[lang];
        const isEmptyString = typeof value === "string" && value.trim() === "";
        const isEmptyArray = Array.isArray(value) && value.length === 0;
        if (value === undefined || value === null || isEmptyString || isEmptyArray) {
          issues.push(`${key}.${lang} is missing/empty`);
        }
      });
      if (typeof entry.en === "string") {
        const enTokens = [...entry.en.matchAll(tokenPattern)].map((m) => m[1]).sort().join(",");
        ["hi", "bn"].forEach((lang) => {
          if (typeof entry[lang] === "string") {
            const langTokens = [...entry[lang].matchAll(tokenPattern)].map((m) => m[1]).sort().join(",");
            if (enTokens !== langTokens) {
              issues.push(`${key}: {placeholder} mismatch en=[${enTokens}] ${lang}=[${langTokens}]`);
            }
          }
        });
      }
    });
    return issues;
  });
  assert("every dictionary key has complete en/hi/bn with matching {placeholder} tokens", dictionaryIssues.length === 0);
  if (dictionaryIssues.length > 0) console.log("  dictionary issues:", dictionaryIssues);

  // applyStaticTranslations() must leave already-correct baked-in HTML text
  // alone when a key has no real translation, rather than overwriting it
  // with t()'s raw-key fallback (the fix for the fetch-failure regression).
  const staticFallbackResult = await page.evaluate(() => {
    const heading = document.querySelector('#maintenance-drawer h3[data-i18n="settingsHeading"]');
    const before = heading.textContent;
    const saved = TRANSLATIONS.settingsHeading;
    delete TRANSLATIONS.settingsHeading;
    applyStaticTranslations();
    const during = heading.textContent;
    TRANSLATIONS.settingsHeading = saved;
    applyStaticTranslations();
    const after = heading.textContent;
    return { before, during, after };
  });
  assert(
    "a static element's baked-in text survives a missing translation instead of showing the raw key",
    staticFallbackResult.during === staticFallbackResult.before && staticFallbackResult.during !== "settingsHeading"
  );
  assert("static text is correctly restored once the translation is available again", staticFallbackResult.after === staticFallbackResult.before);

  await page.evaluate(() => applyAppLanguage("en")); // reset for any later suites sharing this origin

  console.log("\n=== Console errors ===");
  assert("no JS errors on page", pageErrors.length === 0);
  if (pageErrors.length > 0) console.log("  errors:", pageErrors);

  await browser.close();

  console.log("\n" + "─".repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("─".repeat(40));
  process.exit(failed > 0 ? 1 : 0);
})();
