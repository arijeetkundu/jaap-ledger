// Tests for Digital Mala Mode — the full-screen bead counter.
//
// The load-bearing behaviour here is not the dial, it is what reaches disk.
// Mala Mode deliberately has no session store of its own: each completed mala
// commits straight into today's ledger entry, and the remainder on exit. That
// keeps the export payload and DB schema untouched (so existing backups keep
// importing) and bounds what an app kill can lose to one incomplete mala.
//
// Consequently most of what is asserted below is about the ledger, the draft,
// and failure handling — not about pixels.
//
// Run with the app already being served (e.g. `python -m http.server 3333`).

const puppeteer = require("puppeteer");
const { seedAppState } = require("./test-helpers");

const BASE = "http://localhost:3333";
const SPLASH_WAIT_MS = 4200; // outlasts the 3200ms display + 800ms fade

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

// Tap the counting surface n times. Each tap is a pointerdown on the tap area,
// which is what the app listens for.
async function tap(page, n = 1) {
  for (let i = 0; i < n; i++) await page.click("#mala-tap-area");
}

const todayJaap = (page) => page.evaluate(() => {
  const e = ledgerData.find((x) => x.date === todayISO);
  return e ? e.jaap : null;
});

const beadCount = (page) => page.evaluate(() =>
  Number(document.getElementById("mala-bead-count").textContent));

async function openMala(page) {
  await page.click("#mala-mode-fab");
  await page.waitForSelector("#mala-page.open");
  await new Promise((r) => setTimeout(r, 300));
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox"],
    timeout: 90000,
  });
  const errors = [];

  async function freshPage() {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 390, height: 844 });
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("dialog", async (d) => { await d.accept(); });
    await seedAppState(page);
    await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
    await new Promise((r) => setTimeout(r, SPLASH_WAIT_MS));
    return { context, page };
  }

  // ── Opening, counting, undo ────────────────────────────────────────
  {
    console.log("\n=== Opening and counting ===");
    const { context, page } = await freshPage();

    assert("the Mala Mode button is present on the main screen",
      await page.$("#mala-mode-fab") !== null);

    await openMala(page);
    assert("tapping it opens the full-screen page",
      await page.evaluate(() => document.getElementById("mala-page").classList.contains("open")));
    assert("the Exit button exists as static markup, so a failure can never strand the user",
      await page.$("#mala-exit-btn") !== null);

    await tap(page, 5);
    assert("five taps count five beads", await beadCount(page) === 5);

    const dial = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById("mala-ring"));
      return { offset: parseFloat(cs.strokeDashoffset), array: parseFloat(cs.strokeDasharray) };
    });
    // The arc is drawn by dashoffset: full circumference means empty.
    const expected = dial.array - (5 / 108) * dial.array;
    assert("the progress arc tracks the bead count",
      Math.abs(dial.offset - expected) < 1);

    await page.click("#mala-undo-btn");
    assert("undo steps one bead back", await beadCount(page) === 4);

    assert("nothing has reached the ledger before a mala completes",
      await todayJaap(page) === null);

    await context.close();
  }

  // ── A completed mala commits, additively ───────────────────────────
  {
    console.log("\n=== A completed mala commits to today's entry ===");
    const { context, page } = await freshPage();

    // Pre-existing count saved through the Today Card, which must survive.
    await page.type("#today-jaap", "500");
    await page.click("#update-today");
    await new Promise((r) => setTimeout(r, 500));
    assert("a Today Card count is saved first", await todayJaap(page) === 500);

    await openMala(page);
    await tap(page, 108);
    await new Promise((r) => setTimeout(r, 1600)); // commit + Guru Manka turn

    assert("the bead count resets after 108", await beadCount(page) === 0);
    assert("108 is ADDED to the existing entry, not written over it",
      await todayJaap(page) === 608);
    // The counter shows the malas completed TODAY, derived from the ledger —
    // not a per-visit session count. 608 jaap is 5 completed malas.
    assert("the mala counter reflects today's completed malas",
      await page.evaluate(() => document.getElementById("mala-count").textContent) === "5");

    await tap(page, 7);
    await page.click("#mala-exit-btn");
    await new Promise((r) => setTimeout(r, 900));
    assert("exiting commits the partial remainder",
      await todayJaap(page) === 615);
    assert("the page closes on exit",
      await page.evaluate(() => !document.getElementById("mala-page").classList.contains("open")));

    // Reopening must NOT start from zero: the malas are the day's, not this
    // visit's. This was reported from a real sitting — the count had reset.
    await openMala(page);
    assert("reopening shows the malas already completed today, not 0",
      await page.evaluate(() => document.getElementById("mala-count").textContent) === "5");
    assert("reopening shows today's running jaap total",
      await page.evaluate(() => document.getElementById("mala-today-total").textContent) === "615");

    await context.close();
  }

  // ── The todayDraft hazard ──────────────────────────────────────────
  {
    console.log("\n=== An unsaved Today Card draft cannot overwrite a session ===");
    const { context, page } = await freshPage();

    // Type but do NOT save — this is what lives in todayDraft.
    await page.type("#today-jaap", "200");
    assert("a draft is captured", await page.evaluate(() => todayDraft !== null));

    // Dialogs auto-accept, so this proceeds past the discard warning.
    await openMala(page);
    await tap(page, 108);
    await new Promise((r) => setTimeout(r, 1600));

    assert("the stale draft is cleared once the entry changes underneath it",
      await page.evaluate(() => todayDraft === null));

    // Singular/plural. Only English inflects — Hindi and Bangla use one word
    // for both — but the label must never read "1 malas".
    assert("the label reads the singular at exactly one mala",
      await page.evaluate(() => document.getElementById("mala-count-label").textContent) === "mala");

    await page.click("#mala-exit-btn");
    await new Promise((r) => setTimeout(r, 900));

    // Without clearing the draft, the card would still show 200 and the next
    // Save would write 200 over the 108 — silently losing the whole session.
    assert("the Today Card shows the true committed total, not the stale draft",
      await page.evaluate(() => document.getElementById("today-jaap").value) === "108");
    assert("the ledger holds the mala total", await todayJaap(page) === 108);

    await context.close();
  }

  // ── A failed write must not silently swallow counted beads ─────────
  {
    console.log("\n=== A failed save keeps the beads, and says so ===");
    const { context, page } = await freshPage();
    await openMala(page);

    await page.evaluate(() => {
      window.saveLedger = () => Promise.reject(new Error("disk full"));
    });

    await tap(page, 108);
    await new Promise((r) => setTimeout(r, 800));

    assert("nothing is written when the save fails", await todayJaap(page) === null);
    assert("the counted beads are NOT discarded — they stay on the dial for a retry",
      await beadCount(page) === 108);
    assert("the failure is reported to the user",
      await page.evaluate(() => !!document.querySelector(".toast, #toast")));

    // Exiting with a failing save must also refuse to close, rather than
    // dropping the session on the floor.
    await page.click("#mala-exit-btn");
    await new Promise((r) => setTimeout(r, 600));
    assert("exit is refused while the write is still failing",
      await page.evaluate(() => document.getElementById("mala-page").classList.contains("open")));

    // Restore the real writer: the session should now commit.
    await page.evaluate(() => { delete window.saveLedger; });
    await page.reload({ waitUntil: "networkidle0" });
    await context.close();
  }

  // ── A session running across local midnight ────────────────────────
  {
    console.log("\n=== A session spanning midnight writes to the new day ===");
    const { context, page } = await freshPage();
    await openMala(page);
    await tap(page, 50);

    // Roll the clock over, exactly as a real sitting past midnight would.
    const tomorrow = await page.evaluate(() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      window.getTodayISO = () => iso;
      return iso;
    });

    await page.click("#mala-exit-btn");
    await new Promise((r) => setTimeout(r, 900));

    const landed = await page.evaluate((iso) => {
      const e = ledgerData.find((x) => x.date === iso);
      return e ? e.jaap : null;
    }, tomorrow);
    assert("the beads land on the new day, not the day the sitting began", landed === 50);

    await context.close();
  }

  // ── Backup compatibility: the payload must not have changed ────────
  {
    console.log("\n=== Existing backups still import, and exports gain no new fields ===");
    const { context, page } = await freshPage();

    // Exactly the shape a Drive backup taken before Mala Mode has.
    const legacy = await page.evaluate(() => {
      const payload = {
        version: 2,
        entries: [
          { date: "2026-08-01", jaap: 10800, notes: "before mala mode" },
          { date: "2026-08-02", jaap: 5400, notes: "" },
        ],
        sankalpa: null,
      };
      const parsed = parseImportedLedgerFile(payload);
      return {
        accepted: !!parsed,
        valid: !!parsed && areLedgerEntriesValid(parsed.entries),
        count: parsed ? parsed.entries.length : 0,
      };
    });
    assert("a pre-Mala-Mode v2 backup is still accepted by the importer", legacy.accepted);
    assert("its entries still pass validation", legacy.valid);
    assert("all of its entries survive parsing", legacy.count === 2);

    // And an export from this build carries no new keys, so a backup taken
    // now still imports into an older build.
    const exported = await page.evaluate(() => {
      const payload = buildLedgerExportPayload(null);
      const entryKeys = payload.entries.length
        ? Object.keys(payload.entries[0]).sort()
        : [];
      return { topLevel: Object.keys(payload).sort(), entryKeys };
    });
    assert("the export payload still has exactly {version, entries, sankalpa}",
      exported.topLevel.join(",") === "entries,sankalpa,version");
    assert("entries still carry exactly {date, jaap, notes} — no mala fields added",
      exported.entryKeys.length === 0 || exported.entryKeys.join(",") === "date,jaap,notes");

    await context.close();
  }

  // ── Console hygiene ────────────────────────────────────────────────
  console.log("\n=== Console errors ===");
  // The deliberate save-failure section logs its own console.error; that is
  // the app reporting correctly, not a defect.
  const unexpected = errors.filter((e) =>
    !e.includes("disk full") && !e.includes("Failed to add jaap"));
  assert("no unexpected JS errors across the whole run", unexpected.length === 0);
  if (unexpected.length) console.error(unexpected);

  await browser.close();

  console.log("\n────────────────────────────────────────");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("────────────────────────────────────────");
  process.exit(failed > 0 ? 1 : 0);
})();
