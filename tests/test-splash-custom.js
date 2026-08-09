// Tests for user-customizable splash screen images: Hanuman is a fixed,
// always-present default that can never be changed; up to 4 additional
// slots hold the user's own pictures and rotate alongside Hanuman. Covers
// the upload pipeline's size/decode-memory guards, the <picture> "source
// wins over img" trap, the adaptive gold frame, rotation behavior, per-slot
// and remove-all deletion, the locked default tile, and corrupt-data
// resilience.
//
// Run with the app already being served (e.g. `python -m http.server 3333`).

const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");
const sharp = require("sharp");

const BASE = "http://localhost:3333";
const SPLASH_WAIT_MS = 300; // steady display window, safely before the ~2s fade

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

  // ── Section A: default rotation, upload pipeline, deletes, guards ────
  const page = await browser.newPage();
  // Survives every localStorage.clear() + reload() in this file — re-runs
  // before app.js on each navigation, so the first-run language picker
  // never appears and intercepts these tests' clicks.
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
  await page.setViewport({ width: 390, height: 844 });
  trackErrors(page);
  page.on("dialog", async (dialog) => { await dialog.accept(); });

  // ── No-op default: Hanuman is the fixed default, always shown ───────
  console.log("\n=== No-op default (no custom images uploaded) ===");
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));

  const defaults = await page.evaluate(() => {
    const img = document.getElementById("splash-img");
    return {
      lastId: localStorage.getItem("lastSplashImage"),
      srcIsHanuman: img.src.includes("hanuman-splash.png"),
    };
  });
  assert("with no custom images, rotation always resolves to Hanuman", defaults.lastId === "hanuman");
  assert("splash image src is the bundled Hanuman file, not a data URL", defaults.srcIsHanuman);

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
    const dataUrl = localStorage.getItem("splashImage:custom0");
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
      dataUrlIsImage: !!dataUrl && dataUrl.indexOf("data:image/") === 0,
      approxBytes: dataUrl ? Math.round(dataUrl.length * 0.75) : null,
      width,
      height,
    };
  });
  assert("uploading into custom slot 0 stores a data URL image", uploadResult.dataUrlIsImage);
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

  // ── Locked default tile ───────────────────────────────────────────────
  console.log("\n=== Locked default (Hanuman) tile ===");
  // The splash screen (z-index 9999) sits above the Settings toggle
  // (z-index 9100) until its 2000ms display + 500ms fade finishes.
  await new Promise(r => setTimeout(r, 2600));
  await page.click("#maintenance-toggle");
  await page.waitForSelector("#maintenance-drawer.open");
  await new Promise(r => setTimeout(r, 400));

  const lockedTile = await page.$(".splash-slot-locked");
  assert("a locked Hanuman tile is rendered", !!lockedTile);
  if (lockedTile) {
    await lockedTile.click();
    await new Promise(r => setTimeout(r, 300));
  }
  const afterLockedTap = await page.evaluate(() => ({
    toastText: document.getElementById("toast")?.textContent || "",
    pendingSlot: typeof pendingSplashSlot !== "undefined" ? pendingSplashSlot : "undefined",
  }));
  assert(
    "tapping the locked tile shows an informational toast, not a file picker",
    afterLockedTap.toastText.includes("can't be changed")
  );
  assert("tapping the locked tile never sets a pending upload slot", afterLockedTap.pendingSlot === null);

  // ── Deletes: per-slot and remove-all ─────────────────────────────────
  console.log("\n=== Deletes ===");
  const slot0RemoveBadge = await page.$('.splash-slot[data-slot="0"] .splash-slot-reset');
  assert("custom slot 0 shows a remove badge in the UI", !!slot0RemoveBadge);
  if (slot0RemoveBadge) {
    await slot0RemoveBadge.click();
    await new Promise(r => setTimeout(r, 300));
  }
  const afterSlotDelete = await page.evaluate(() => {
    const tile = document.querySelector('.splash-slot[data-slot="0"]');
    return {
      imageGone: localStorage.getItem("splashImage:custom0") === null,
      tileIsEmpty: !!tile && tile.classList.contains("splash-slot-empty"),
    };
  });
  assert("per-slot delete removes the stored custom image data", afterSlotDelete.imageGone);
  assert("per-slot delete reverts that tile to the empty '+' state", afterSlotDelete.tileIsEmpty);

  const squareFixture = path.join(os.tmpdir(), `splash-fixture-square-${Date.now()}.jpg`);
  await sharp({ create: { width: 500, height: 500, channels: 3, background: { r: 40, g: 120, b: 200 } } })
    .jpeg({ quality: 85 })
    .toFile(squareFixture);

  await page.evaluate(() => { pendingSplashSlot = 1; });
  await splashInput.uploadFile(squareFixture);
  await new Promise(r => setTimeout(r, 800));

  await page.click("#splash-images-reset-btn");
  await new Promise(r => setTimeout(r, 300));

  const afterRemoveAll = await page.evaluate(() => ({
    slot0ImageGone: localStorage.getItem("splashImage:custom0") === null,
    slot1ImageGone: localStorage.getItem("splashImage:custom1") === null,
  }));
  assert(
    "Remove All Custom Images clears every stored custom image",
    afterRemoveAll.slot0ImageGone && afterRemoveAll.slot1ImageGone
  );

  fs.unlinkSync(squareFixture);

  // Tapping Remove All again with nothing to remove is a harmless no-op.
  await page.click("#splash-images-reset-btn");
  await new Promise(r => setTimeout(r, 300));
  const noopToast = await page.evaluate(() => document.getElementById("toast")?.textContent || "");
  assert("Remove All with nothing to remove shows a clear no-op message", noopToast.includes("No custom images"));

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
  const afterOversized = await page.evaluate(() => localStorage.getItem("splashImage:custom2") === null);
  assert("a file over the 5MB cap is rejected without changing slot state", afterOversized);

  await page.evaluate(() => { pendingSplashSlot = 2; });
  await splashInput.uploadFile(nonImageFixture);
  await new Promise(r => setTimeout(r, 500));
  const afterNonImage = await page.evaluate(() => localStorage.getItem("splashImage:custom2") === null);
  assert("a non-image file is rejected without changing slot state", afterNonImage);

  fs.unlinkSync(oversizedFixture);
  fs.unlinkSync(nonImageFixture);

  // ── Quota-exceeded rollback ───────────────────────────────────────────
  // Exercises setCustomSplashImage() directly (rather than through the full
  // upload UI) to simulate a localStorage.setItem quota error on the first
  // write and confirm the previous value is restored, not left half-written.
  console.log("\n=== Quota-exceeded rollback ===");
  const quotaRollbackResult = await page.evaluate(() => {
    const key = "splashImage:custom3";
    const previousValue = "data:image/png;base64,PREVIOUS";
    localStorage.setItem(key, previousValue);

    const originalSetItem = localStorage.setItem.bind(localStorage);
    let callCount = 0;
    localStorage.setItem = (k, v) => {
      callCount++;
      if (k === key && callCount === 1) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return originalSetItem(k, v);
    };

    let threw = false;
    let errorMessage = "";
    try {
      setCustomSplashImage(3, "data:image/png;base64,NEWVALUE");
    } catch (e) {
      threw = true;
      errorMessage = e.message;
    }

    localStorage.setItem = originalSetItem;

    return { threw, errorMessage, valueAfter: localStorage.getItem(key) };
  });
  assert("a quota error during setCustomSplashImage throws", quotaRollbackResult.threw);
  assert(
    "the thrown error has an actionable message",
    quotaRollbackResult.errorMessage.toLowerCase().includes("storage")
  );
  assert(
    "the previous value is rolled back after a quota error, not left half-written",
    quotaRollbackResult.valueAfter === "data:image/png;base64,PREVIOUS"
  );
  await page.evaluate(() => localStorage.removeItem("splashImage:custom3"));

  await page.click("#maintenance-toggle"); // close drawer

  // ── Section B: deterministic selection (Math.random mocked) ─────────
  // Isolated browser context so the Math.random override and localStorage
  // here never bleed into other sections.
  console.log("\n=== <picture> trap & adaptive frame (custom image) ===");
  const contextB = await browser.createBrowserContext();
  const pageB = await contextB.newPage();
  await pageB.evaluateOnNewDocument(() => localStorage.setItem("appLanguage", "en"));
  await pageB.evaluateOnNewDocument(() => {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    localStorage.setItem("lastSundayBackupPromptDate", iso);
  });
  await pageB.setViewport({ width: 390, height: 844 });
  trackErrors(pageB);
  // With the pool [hanuman, custom0] (length 2), floor(0.99 * 2) = 1 picks
  // the custom image; with a corrupted/empty custom slot the pool shrinks
  // to length 1 and the same mock deterministically falls back to Hanuman.
  await pageB.evaluateOnNewDocument(() => { Math.random = () => 0.99; });
  await pageB.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await pageB.evaluate(() => localStorage.clear());

  const customDataUrl = await pageB.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 400; // deliberately odd 2:1 ratio, distinct from Hanuman's art
    canvas.height = 200;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#663399";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  });

  await pageB.evaluate((dataUrl) => {
    localStorage.setItem("splashImage:custom0", dataUrl);
  }, customDataUrl);

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
    localStorage.setItem("splashImage:custom0", "not-a-real-data-url");
    localStorage.removeItem("lastSplashImage");
  });
  await pageB.reload({ waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
  const corruptFallback = await pageB.evaluate(() => {
    const img = document.getElementById("splash-img");
    return { src: img.src, isDataUrl: img.src.startsWith("data:") };
  });
  assert(
    "corrupt custom image data is excluded from the pool, falling back to Hanuman",
    !corruptFallback.isDataUrl && corruptFallback.src.includes("hanuman-splash")
  );

  await contextB.close();

  // ── Section C: rotation invariant with custom images mixed in ────────
  console.log("\n=== Rotation invariant (Hanuman + custom images mixed in) ===");
  const contextC = await browser.createBrowserContext();
  const pageC = await contextC.newPage();
  await pageC.evaluateOnNewDocument(() => localStorage.setItem("appLanguage", "en"));
  await pageC.evaluateOnNewDocument(() => {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    localStorage.setItem("lastSundayBackupPromptDate", iso);
  });
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
    localStorage.setItem("splashImage:custom0", dataUrl);
    localStorage.setItem("splashImage:custom2", dataUrl);
  }, mixedDataUrl);

  const picks = [];
  for (let i = 0; i < 15; i++) {
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
    "rotation never repeats the same image twice in a row, even with custom images mixed in",
    !hasConsecutiveRepeat
  );
  assert(
    "Hanuman and both custom slots each appear across the rotation sample",
    picks.includes("hanuman") && picks.includes("custom0") && picks.includes("custom2")
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
