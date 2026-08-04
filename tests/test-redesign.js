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

  // ── Milestone celebration: falling petals ──────────────────────────
  console.log("\n=== Milestone celebration (falling petals) ===");
  const expandedMilestone = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".ledger-row"));
    const target = rows.find(r => r.querySelector(".ledger-date")?.textContent.includes("🏵"));
    if (!target) return { found: false };
    target.querySelector(".ledger-chevron").click();
    return { found: true };
  });
  assert("a Crore-crossing ledger row exists in the seed data (🏵️ marker)", expandedMilestone.found);

  if (expandedMilestone.found) {
    await new Promise(r => setTimeout(r, 300));
    const milestoneInfo = await page.evaluate(() => {
      const el = document.querySelector(".milestone");
      if (!el) return null;
      const petals = el.querySelectorAll(".petal");
      const roses = el.querySelectorAll(".petal-rose").length;
      const marigolds = el.querySelectorAll(".petal-marigold").length;
      const anyOverlappingText = Array.from(petals).every(p => getComputedStyle(p).pointerEvents === "none");
      return {
        bannerText: el.textContent.trim().startsWith("◈"),
        totalPetals: petals.length,
        roses,
        marigolds,
        allPetalsIgnorePointerEvents: anyOverlappingText,
      };
    });
    assert("milestone banner renders with its Crore text", !!milestoneInfo && milestoneInfo.bannerText);
    assert("milestone banner renders exactly 28 petals", !!milestoneInfo && milestoneInfo.totalPetals === 28);
    assert("petals are evenly split rose/marigold (14/14)", !!milestoneInfo && milestoneInfo.roses === 14 && milestoneInfo.marigolds === 14);
    assert("petals never intercept taps (pointer-events: none)", !!milestoneInfo && milestoneInfo.allPetalsIgnorePointerEvents);
  }

  // A non-milestone row's notes must NOT contain any petals.
  const nonMilestoneClean = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".ledger-row"));
    const plain = rows.find(r => !r.querySelector(".ledger-date")?.textContent.includes("🏵"));
    if (!plain) return null;
    plain.querySelector(".ledger-chevron").click();
    return true;
  });
  await new Promise(r => setTimeout(r, 300));
  if (nonMilestoneClean) {
    const strayPetals = await page.evaluate(() => document.querySelectorAll(".ledger-row.expanded:not(:has(.milestone)) .petal").length);
    assert("a non-milestone row never renders petals", strayPetals === 0);
  }

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
