// Tests for user-customizable splash screen images: replacing any of the 5
// rotation slots with a personal photo, the size/decode-memory guards on
// upload, the <picture> "source wins over img" trap, the adaptive gold
// frame, rotation behavior with custom images mixed in, resets, and
// corrupt-data resilience.
//
// Run with the app already being served (e.g. `python -m http.server 3333`).

const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");
const sharp = require("sharp");

const BASE = "http://localhost:3333";
const SPLASH_WAIT_MS = 300; // steady display window, safely before the ~2s fade
const BUNDLED_IDS = ["hanuman", "chaturbhuj-rama", "lord-rama", "ram-rameshwar", "ram-darbar"];

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

async function measureFraming(page) {
  return page.evaluate(() => {
    const s = document.getElementById("splash-screen");
    const img = document.getElementById("splash-img");
    if (!s || !img) return null;
    const rS = s.getBoundingClientRect();
    const rImg = img.getBoundingClientRect();
    const cs = getComputedStyle(img);
    const border = parseFloat(cs.borderTopWidth) * 2;
    const contentW = rImg.width - border;
    const contentH = rImg.height - border;
    const naturalRatio = img.naturalWidth / img.naturalHeight;
    return {
      objectFit: cs.objectFit,
      contentRatio: contentW / contentH,
      naturalRatio,
      letterboxPx: contentH - contentW / naturalRatio,
    };
  });
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const allErrors = [];

  function trackErrors(page) {
    page.on("pageerror", err => allErrors.push(err.message));
    page.on("console", msg => {
      // "Splash image upload failed" is app.js's own console.error for a
      // deliberately-rejected upload (the guard tests below trigger this on
      // purpose) — expected validation output, not a bug.
      if (msg.type() === "error" && !msg.text().includes("Splash image upload failed")) {
        allErrors.push(msg.text());
      }
    });
  }

  // ── Section A: default rotation, upload pipeline, resets, guards ─────
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  trackErrors(page);
  page.on("dialog", async (dialog) => { await dialog.accept(); });

  // ── No-op default: no splashSlots key, zero regression for existing users ──
  console.log("\n=== No-op default (no splashSlots configured) ===");
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));

  const defaults = await page.evaluate((bundledIds) => {
    const img = document.getElementById("splash-img");
    return {
      slotsAbsent: localStorage.getItem("splashSlots") === null,
      lastIdIsBundled: bundledIds.includes(localStorage.getItem("lastSplashImage")),
      srcIsBundled: img.src.includes("splash/") && !img.src.startsWith("data:"),
    };
  }, BUNDLED_IDS);
  assert("no splashSlots key exists for a fresh install", defaults.slotsAbsent);
  assert("rotation still picks one of the 5 bundled ids with no custom slots configured", defaults.lastIdIsBundled);
  assert("splash image src is a bundled file, not a data URL", defaults.srcIsBundled);

  // ── Upload pipeline: validate → downscale → encode ──────────────────
  console.log("\n=== Upload pipeline ===");
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));

  const landscapeFixture = path.join(os.tmpdir(), `splash-fixture-landscape-${Date.now()}.jpg`);
  await sharp({ create: { width: 1400, height: 600, channels: 3, background: { r: 180, g: 90, b: 40 } } })
    .jpeg({ quality: 85 })
    .toFile(landscapeFixture);

  const splashInput = await page.$("#splash-image-input");
  await page.evaluate(() => { pendingSplashSlot = 0; });
  await splashInput.uploadFile(landscapeFixture);
  await new Promise(r => setTimeout(r, 800)); // decode + canvas encode + localStorage write

  const uploadResult = await page.evaluate(async () => {
    let slots = null;
    try { slots = JSON.parse(localStorage.getItem("splashSlots")); } catch (e) {}
    const dataUrl = localStorage.getItem("splashImage:slot0");
    let width = null, height = null;
    if (dataUrl) {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = dataUrl;
      });
      width = img.naturalWidth;
      height = img.naturalHeight;
    }
    return {
      slot0Custom: !!(slots && slots[0] && slots[0].custom),
      slot0Id: slots && slots[0] && slots[0].id,
      dataUrlIsImage: !!dataUrl && dataUrl.indexOf("data:image/") === 0,
      approxBytes: dataUrl ? Math.round(dataUrl.length * 0.75) : null,
      width,
      height,
    };
  });
  assert("uploading into slot 0 marks it custom in splashSlots", uploadResult.slot0Custom);
  assert("custom slot id follows the slotN convention", uploadResult.slot0Id === "slot0");
  assert("stored value is a data URL image", uploadResult.dataUrlIsImage);
  assert(
    "stored image's long edge is capped at 900px",
    Math.max(uploadResult.width || 0, uploadResult.height || 0) <= 900
  );
  assert(
    "stored image stays comfortably under the size budget",
    uploadResult.approxBytes !== null && uploadResult.approxBytes < 400 * 1024
  );

  const sourceRatio = 1400 / 600;
  const storedRatio = (uploadResult.width || 1) / (uploadResult.height || 1);
  assert(
    "downscaled image keeps the original aspect ratio (no stretch/squish)",
    Math.abs(storedRatio - sourceRatio) < 0.02
  );

  fs.unlinkSync(landscapeFixture);

  // ── Resets: per-slot and reset-all ───────────────────────────────────
  console.log("\n=== Resets ===");
  // The splash screen (z-index 9999) sits above the Settings toggle
  // (z-index 9100) until its 2000ms display + 500ms fade finishes.
  await new Promise(r => setTimeout(r, 2600));
  await page.click("#maintenance-toggle");
  await page.waitForSelector("#maintenance-drawer.open");
  await new Promise(r => setTimeout(r, 400));

  const slot0ResetBadge = await page.$('.splash-slot[data-slot="0"] .splash-slot-reset');
  assert("custom slot 0 shows a reset badge in the UI", !!slot0ResetBadge);
  if (slot0ResetBadge) {
    await slot0ResetBadge.click();
    await new Promise(r => setTimeout(r, 300));
  }
  const afterSlotReset = await page.evaluate(() => {
    let slots = null;
    try { slots = JSON.parse(localStorage.getItem("splashSlots")); } catch (e) {}
    return {
      slot0Custom: !!(slots && slots[0] && slots[0].custom),
      slot0Id: slots && slots[0] && slots[0].id,
      imageGone: localStorage.getItem("splashImage:slot0") === null,
    };
  });
  assert(
    "per-slot reset restores slot 0 to its bundled default",
    !afterSlotReset.slot0Custom && afterSlotReset.slot0Id === "hanuman"
  );
  assert("per-slot reset removes the stored custom image data", afterSlotReset.imageGone);

  const squareFixture = path.join(os.tmpdir(), `splash-fixture-square-${Date.now()}.jpg`);
  await sharp({ create: { width: 500, height: 500, channels: 3, background: { r: 40, g: 120, b: 200 } } })
    .jpeg({ quality: 85 })
    .toFile(squareFixture);

  await page.evaluate(() => { pendingSplashSlot = 1; });
  await splashInput.uploadFile(squareFixture);
  await new Promise(r => setTimeout(r, 800));

  await page.click("#splash-images-reset-btn");
  await new Promise(r => setTimeout(r, 300));

  const afterResetAll = await page.evaluate(() => ({
    slotsKeyGone: localStorage.getItem("splashSlots") === null,
    slot0ImageGone: localStorage.getItem("splashImage:slot0") === null,
    slot1ImageGone: localStorage.getItem("splashImage:slot1") === null,
  }));
  assert("Reset All clears splashSlots entirely", afterResetAll.slotsKeyGone);
  assert(
    "Reset All removes every stored custom image",
    afterResetAll.slot0ImageGone && afterResetAll.slot1ImageGone
  );

  fs.unlinkSync(squareFixture);

  // ── Guards: oversized file and non-image file are rejected gracefully ──
  console.log("\n=== Upload guards ===");
  const oversizedFixture = path.join(os.tmpdir(), `splash-fixture-oversized-${Date.now()}.jpg`);
  // Content doesn't need to decode: the 5MB size check runs before any
  // decoding happens, so a junk buffer with a .jpg extension is enough.
  fs.writeFileSync(oversizedFixture, Buffer.alloc(6 * 1024 * 1024, 1));
  const nonImageFixture = path.join(os.tmpdir(), `splash-fixture-notimage-${Date.now()}.txt`);
  fs.writeFileSync(nonImageFixture, "not an image");

  await page.evaluate(() => { pendingSplashSlot = 2; });
  await splashInput.uploadFile(oversizedFixture);
  await new Promise(r => setTimeout(r, 500));
  const afterOversized = await page.evaluate(() => {
    let slots = null;
    try { slots = JSON.parse(localStorage.getItem("splashSlots")); } catch (e) {}
    return { slot2Custom: !!(slots && slots[2] && slots[2].custom) };
  });
  assert("a file over the 5MB cap is rejected without changing slot state", !afterOversized.slot2Custom);

  await page.evaluate(() => { pendingSplashSlot = 2; });
  await splashInput.uploadFile(nonImageFixture);
  await new Promise(r => setTimeout(r, 500));
  const afterNonImage = await page.evaluate(() => {
    let slots = null;
    try { slots = JSON.parse(localStorage.getItem("splashSlots")); } catch (e) {}
    return { slot2Custom: !!(slots && slots[2] && slots[2].custom) };
  });
  assert("a non-image file is rejected without changing slot state", !afterNonImage.slot2Custom);

  fs.unlinkSync(oversizedFixture);
  fs.unlinkSync(nonImageFixture);

  await page.click("#maintenance-toggle"); // close drawer

  // ── Section B: deterministic selection (Math.random mocked) ─────────
  // Isolated browser context so the Math.random override and localStorage
  // here never bleed into other sections.
  console.log("\n=== <picture> trap & adaptive frame (custom image) ===");
  const contextB = await browser.createBrowserContext();
  const pageB = await contextB.newPage();
  await pageB.setViewport({ width: 390, height: 844 });
  trackErrors(pageB);
  await pageB.evaluateOnNewDocument(() => { Math.random = () => 0; });
  await pageB.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await pageB.evaluate(() => localStorage.clear());

  const customDataUrl = await pageB.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 400; // deliberately odd 2:1 ratio, distinct from bundled art
    canvas.height = 200;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#663399";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  });

  await pageB.evaluate((dataUrl) => {
    const slots = [
      { id: "slot0", custom: true },
      { id: "chaturbhuj-rama", custom: false },
      { id: "lord-rama", custom: false },
      { id: "ram-rameshwar", custom: false },
      { id: "ram-darbar", custom: false },
    ];
    localStorage.setItem("splashSlots", JSON.stringify(slots));
    localStorage.setItem("splashImage:slot0", dataUrl);
    localStorage.removeItem("lastSplashImage"); // ensure slot0 is a valid candidate
  }, customDataUrl);

  // With Math.random mocked to 0 and no lastSplashImage, chooseSplashImage's
  // pool[0] deterministically resolves to slot 0 (the custom image).
  await pageB.reload({ waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));

  const pictureTrap = await pageB.evaluate(() => {
    const source = document.getElementById("splash-source");
    const img = document.getElementById("splash-img");
    return {
      srcHasDataUrl: img.src.startsWith("data:image/"),
      sourceHasSrcset: source.hasAttribute("srcset"),
    };
  });
  assert("custom image sets #splash-img to the data URL", pictureTrap.srcHasDataUrl);
  assert(
    "<source srcset> is cleared so the picture doesn't fall back to the bundled webp",
    !pictureTrap.sourceHasSrcset
  );

  const framing = await measureFraming(pageB);
  assert("custom image uses object-fit: contain (never distorts or crops)", !!framing && framing.objectFit === "contain");
  assert(
    "gold frame hugs the custom image's own aspect ratio (no letterbox band)",
    !!framing && Math.abs(framing.contentRatio - framing.naturalRatio) < 0.01
  );
  assert("no white space above/below the custom image", !!framing && Math.abs(framing.letterboxPx) < 1.5);

  // ── Corrupt-data resilience ───────────────────────────────────────────
  console.log("\n=== Corrupt-data resilience ===");
  await pageB.evaluate(() => {
    localStorage.setItem("splashImage:slot0", "not-a-real-data-url");
    localStorage.removeItem("lastSplashImage");
  });
  await pageB.reload({ waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
  const corruptFallback = await pageB.evaluate(() => {
    const img = document.getElementById("splash-img");
    return { src: img.src, isDataUrl: img.src.startsWith("data:") };
  });
  assert(
    "corrupt custom image data falls back to a bundled image, not a broken src",
    !corruptFallback.isDataUrl && corruptFallback.src.includes("splash/")
  );

  await contextB.close();

  // ── Section C: rotation invariant with custom images mixed in ────────
  console.log("\n=== Rotation invariant (custom images mixed in) ===");
  const contextC = await browser.createBrowserContext();
  const pageC = await contextC.newPage();
  await pageC.setViewport({ width: 390, height: 844 });
  trackErrors(pageC);
  await pageC.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await pageC.evaluate(() => localStorage.clear());

  const mixedDataUrl = await pageC.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#227744";
    ctx.fillRect(0, 0, 300, 300);
    return canvas.toDataURL("image/png");
  });
  await pageC.evaluate((dataUrl) => {
    const slots = [
      { id: "slot0", custom: true },
      { id: "chaturbhuj-rama", custom: false },
      { id: "slot2", custom: true },
      { id: "ram-rameshwar", custom: false },
      { id: "ram-darbar", custom: false },
    ];
    localStorage.setItem("splashSlots", JSON.stringify(slots));
    localStorage.setItem("splashImage:slot0", dataUrl);
    localStorage.setItem("splashImage:slot2", dataUrl);
  }, mixedDataUrl);

  const picks = [];
  for (let i = 0; i < 12; i++) {
    await pageC.reload({ waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
    const id = await pageC.evaluate(() => localStorage.getItem("lastSplashImage"));
    picks.push(id);
  }
  let hasConsecutiveRepeat = false;
  for (let i = 1; i < picks.length; i++) {
    if (picks[i] === picks[i - 1]) hasConsecutiveRepeat = true;
  }
  assert(
    "rotation never repeats the same slot twice in a row, even with custom images mixed in",
    !hasConsecutiveRepeat
  );
  assert(
    "both custom slots appear across the rotation sample",
    picks.includes("slot0") && picks.includes("slot2")
  );

  await contextC.close();

  // ── No regressions ────────────────────────────────────────────────────
  console.log("\n=== Console errors ===");
  assert("no JS errors across the whole run", allErrors.length === 0);
  if (allErrors.length > 0) console.log("  errors:", allErrors);

  await browser.close();

  console.log("\n" + "─".repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("─".repeat(40));
  process.exit(failed > 0 ? 1 : 0);
})();
