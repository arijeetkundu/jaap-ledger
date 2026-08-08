// Tests for the Temple Gold & Maroon premium redesign: confirms the new
// design tokens are actually applied (not just present in the stylesheet),
// that the milestone celebration renders correctly for a Crore-crossing
// entry, and that the splash entrance animation is wired up — all without
// touching any existing behavior, IDs, or data.
//
// Run with the app already being served (e.g. `python -m http.server 3333`).

const puppeteer = require("puppeteer");

const BASE = "http://localhost:3333";
const SPLASH_WAIT_MS = 2600;
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
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));

  // ── Design tokens applied to real elements ─────────────────────────
  console.log("\n=== Design tokens ===");
  const tokens = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const h1 = getComputedStyle(document.querySelector("h1"));
    const card = getComputedStyle(document.getElementById("today-card"));
    const updateBtn = getComputedStyle(document.getElementById("update-today"));
    return {
      maroonToken: rootStyle.getPropertyValue("--maroon").trim(),
      h1Color: h1.color,
      h1FontFamily: h1.fontFamily,
      cardBackgroundImage: card.backgroundImage,
      cardBorderColor: card.borderColor,
      updateBtnBackgroundImage: updateBtn.backgroundImage,
    };
  });
  assert("--maroon token is defined on :root", tokens.maroonToken === "#6c1c27");
  assert("h1 uses the maroon color token", tokens.h1Color === "rgb(108, 28, 39)");
  assert("h1 uses the serif heading font stack", tokens.h1FontFamily.includes("Georgia"));
  assert("#today-card has a gradient surface (not a flat color)", tokens.cardBackgroundImage.startsWith("linear-gradient"));
  assert("#today-card has the gold hairline border", tokens.cardBorderColor === "rgb(220, 184, 101)");
  assert("#update-today has the maroon gradient background", updateBtnHasMaroonGradient(tokens.updateBtnBackgroundImage));

  function updateBtnHasMaroonGradient(bg) {
    return bg.startsWith("linear-gradient") && bg.includes("108, 28, 39") && bg.includes("74, 17, 25");
  }

  // ── Ledger row geometry: date left / count true-center / sparkline right ──
  // Reproduces the exact overlap bug from the user's annotated screenshot:
  // a wide (6-digit) raw jaap value must never visually collide with the
  // date or the sparkline, and the count must sit at the true horizontal
  // center of the whole row — not just "somewhere between" its neighbors.
  console.log("\n=== Ledger row geometry (no overlap, true centering) ===");
  const geomJaapField = await page.$("#today-jaap");
  await geomJaapField.click({ clickCount: 3 });
  await geomJaapField.type("118800"); // the exact value from the reported bug; doesn't cross a Crore boundary
  await page.click("#update-today");
  await new Promise(r => setTimeout(r, 500));

  const geometry = await page.evaluate(() => {
    const row = document.querySelector(".ledger-row");
    const main = row.querySelector(".ledger-main");
    const date = row.querySelector(".ledger-date");
    const jaap = row.querySelector(".ledger-jaap");
    const spark = row.querySelector(".ledger-sparkline");
    const rMain = main.getBoundingClientRect();
    const rDate = date.getBoundingClientRect();
    const rJaap = jaap.getBoundingClientRect();
    const rSpark = spark.getBoundingClientRect();
    return {
      jaapText: jaap.textContent.trim(),
      mainWidth: rMain.width,
      overlapsDate: rJaap.left < rDate.right,
      overlapsSparkline: rJaap.right > rSpark.left,
      sparklineFlushRight: Math.abs(rSpark.right - rMain.right) < 1,
      centerDelta: Math.abs((rJaap.left + rJaap.width / 2) - (rMain.left + rMain.width / 2)),
    };
  });
  assert("today's row shows the entered wide value", geometry.jaapText === "118800");
  assert("row spans its full container width (not shrunk by a flex sibling)", geometry.mainWidth > 300);
  assert("jaap count never overlaps the date", !geometry.overlapsDate);
  assert("jaap count never overlaps the sparkline", !geometry.overlapsSparkline);
  assert("sparkline sits flush against the row's right edge", geometry.sparklineFlushRight);
  assert("jaap count is centered on the true row width (within 1px)", geometry.centerDelta < 1);

  // ── Milestone celebration: page-wide falling petals ─────────────────
  // Reproduces the exact repro used to diagnose the original "nothing
  // happened" report: type a Crore-crossing value into Today's jaap field
  // and click Update — the petal shower must appear immediately in
  // #petal-overlay, with no manual row-expansion involved.
  console.log("\n=== Milestone celebration (page-wide falling petals) ===");

  const preExisting = await page.evaluate(() => document.querySelectorAll("#petal-overlay .petal-fly").length);
  assert("no petals present before any crossing update", preExisting === 0);

  const todayJaapField = await page.$("#today-jaap");
  await todayJaapField.click({ clickCount: 3 });
  await todayJaapField.type("10000000"); // guaranteed to cross a Crore boundary
  await page.click("#update-today");
  await new Promise(r => setTimeout(r, 400)); // IndexedDB write + re-render

  const celebration = await page.evaluate(() => {
    const petals = Array.from(document.querySelectorAll("#petal-overlay .petal-fly"));
    const roses = petals.filter(p => p.classList.contains("petal-rose")).length;
    const marigolds = petals.filter(p => p.classList.contains("petal-marigold")).length;
    const allIgnorePointerEvents = petals.every(p => getComputedStyle(p).pointerEvents === "none");
    const overlay = getComputedStyle(document.getElementById("petal-overlay"));
    // Regression guard: each petal's 5 sway waypoints must be independently
    // randomized, not one shared value mirrored left/right (which is what
    // produced the "clusters following the same zigzag" look previously).
    const distinctSwayCombos = new Set(
      petals.map(p => ["--sway1", "--sway2", "--sway3", "--sway4", "--sway5"]
        .map(prop => p.style.getPropertyValue(prop)).join("|"))
    ).size;
    return {
      totalPetals: petals.length,
      roses,
      marigolds,
      allIgnorePointerEvents,
      overlayPosition: overlay.position,
      distinctSwayCombos,
    };
  });
  assert("crossing update immediately populates #petal-overlay with 96 petals (no row expansion needed)", celebration.totalPetals === 96);
  assert("petals are evenly split rose/marigold (48/48)", celebration.roses === 48 && celebration.marigolds === 48);
  assert("petals never intercept taps (pointer-events: none)", celebration.allIgnorePointerEvents);
  assert("#petal-overlay is a fixed, page-level layer", celebration.overlayPosition === "fixed");
  assert("petal fall paths are independently randomized, not a shared shape", celebration.distinctSwayCombos > 90);

  // A save that does NOT cross a new Crore boundary must not trigger any petals.
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
  const nonCrossingField = await page.$("#today-jaap");
  await nonCrossingField.click({ clickCount: 3 });
  await nonCrossingField.type("50"); // far from any Crore boundary
  await page.click("#update-today");
  await new Promise(r => setTimeout(r, 400));
  const noPetalsOnPlainSave = await page.evaluate(() => document.querySelectorAll("#petal-overlay .petal-fly").length);
  assert("a non-crossing save triggers no petals", noPetalsOnPlainSave === 0);

  // ── Splash entrance animation ───────────────────────────────────────
  console.log("\n=== Splash entrance animation ===");
  await page.reload({ waitUntil: "domcontentloaded" });
  const splashAnimation = await page.evaluate(() => {
    const img = document.getElementById("splash-img");
    if (!img) return null;
    const cs = getComputedStyle(img);
    return { animationName: cs.animationName, animationDuration: cs.animationDuration };
  });
  assert("splash image has the entrance keyframe animation applied", !!splashAnimation && splashAnimation.animationName === "splash-entrance");
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));

  // ── Smooth motion polish ─────────────────────────────────────────────
  console.log("\n=== Smooth scrolling & motion ===");
  const motionChecks = await page.evaluate(() => {
    const htmlScroll = getComputedStyle(document.documentElement).scrollBehavior;
    const notes = document.querySelector(".ledger-notes");
    const notesTransition = notes ? getComputedStyle(notes).transitionProperty : "";
    return { htmlScroll, notesTransition };
  });
  assert("page has smooth scroll-behavior for Jump-to-year", motionChecks.htmlScroll === "smooth");
  assert("ledger row notes have an animated (non-instant) expand/collapse transition", motionChecks.notesTransition.includes("max-height"));

  // ── No regressions ────────────────────────────────────────────────────
  console.log("\n=== Console errors ===");
  assert("no JS errors on page across the whole run", pageErrors.length === 0);
  if (pageErrors.length > 0) console.log("  errors:", pageErrors);

  await browser.close();

  console.log("\n" + "─".repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("─".repeat(40));
  process.exit(failed > 0 ? 1 : 0);
})();
