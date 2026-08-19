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
const { seedAppState } = require("./test-helpers");

const BASE = "http://localhost:3333";
const SPLASH_WAIT_MS = 4200; // outlasts the 3200ms display + 800ms fade
const SPLASH_FADE_MS = 800;  // keep in step with app.js / styles.css
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
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox"],
    // Puppeteer's 30s default is not enough on a loaded machine: by the
    // time the later suites in `npm test` start, seven browsers have
    // already been launched and torn down, and the launch itself timed
    // out -- a capacity limit, not a failing assertion. Costs nothing
    // when the machine is idle.
    timeout: 90000,
  });
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

  await seedAppState(page);
  // This app is a phone PWA; Puppeteer's 800x600 default is a desktop-ish
  // shape that doesn't reflect real usage and breaks viewport-relative
  // layout assertions (e.g. the splash screen's portrait-framed deity
  // image). Use a representative phone viewport for the whole suite.
  await page.setViewport({ width: 390, height: 844 });

  const pageErrors = [];
  // The save-failure tests below deliberately force IndexedDB writes to
  // abort, and the app correctly reports that with console.error. Those are
  // the expected, *desired* output of those tests — collecting them would
  // make the end-of-run "no JS errors" assertion fail for the wrong reason.
  // Fragments are pushed only for the duration of the test that expects
  // them, so an unexpected error anywhere else is still caught.
  const expectedErrorFragments = [];
  const isExpectedError = (text) => expectedErrorFragments.some(f => text.includes(f));

  // err can be null — an unhandled promise rejection whose reason is a
  // DOMException surfaces here with no Error object at all, which is exactly
  // what an unguarded failed IndexedDB write produces.
  page.on("pageerror", err => {
    const message = err && err.message ? err.message : String(err);
    if (!isExpectedError(message)) pageErrors.push(message);
  });
  page.on("console", msg => {
    if (msg.type() === "error" && !isExpectedError(msg.text())) pageErrors.push(msg.text());
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

  // ── Text size ────────────────────────────────────────────────────────
  // Every size in styles.css is in rem, so this scales the whole app off
  // the root font-size. Existing installs must be untouched by default.
  console.log("\n=== Text size ===");
  const textSizeDefault = await page.evaluate(() => ({
    cls: document.documentElement.className,
    root: parseFloat(getComputedStyle(document.documentElement).fontSize),
    stored: localStorage.getItem("textSize"),
  }));
  assert("defaults to medium, with no marker class on <html>", !textSizeDefault.cls.includes("text-"));
  assert("default root size is the browser's own 16px", Math.abs(textSizeDefault.root - 16) < 0.5);
  assert("nothing is persisted until the user actually chooses", textSizeDefault.stored === null);

  await page.click("#maintenance-toggle");
  await page.waitForSelector("#maintenance-drawer.open");
  await new Promise(r => setTimeout(r, 400));

  await page.click('.text-size-btn[data-size="large"]');
  await new Promise(r => setTimeout(r, 300));
  const afterLarge = await page.evaluate(() => ({
    cls: document.documentElement.className,
    root: parseFloat(getComputedStyle(document.documentElement).fontSize),
    stored: localStorage.getItem("textSize"),
    pressed: document.querySelector('.text-size-btn[data-size="large"]').getAttribute("aria-pressed"),
    ledgerRowFont: parseFloat(getComputedStyle(document.querySelector(".ledger-row")).fontSize),
  }));
  assert("choosing Large marks <html>", afterLarge.cls.includes("text-large"));
  assert("Large genuinely increases the root font size", afterLarge.root > 16);
  assert("Large is persisted", afterLarge.stored === "large");
  assert("the active button reports aria-pressed", afterLarge.pressed === "true");
  // The point of the whole feature: content actually gets bigger, not just
  // the setting. Ledger rows are 0.95rem, i.e. below the 16px default.
  assert("ledger row text scales up with the setting", afterLarge.ledgerRowFont > 15.2);

  // Regression guard: at Large the date grows wide enough that a count
  // anchored to the row's true centre overlaps it. .ledger-jaap is handed
  // back to the grid's spacer column at this size specifically to prevent
  // that; without the override these boxes intersect.
  //
  // The row must carry a genuinely wide value for this to mean anything —
  // today's entry is still null at this point in the run and renders as a
  // narrow "—", which cannot overlap anything. 118800 is the 6-digit value
  // from the original overlap report, restored immediately afterwards so
  // later sections see the ledger they expect.
  const largeGeometry = await page.evaluate(async () => {
    const iso = getTodayISO();
    const entry = ledgerData.find(e => e.date === iso);
    const previousJaap = entry.jaap;
    entry.jaap = 118800;
    renderToday();

    const row = document.querySelector(".ledger-row");
    const date = row.querySelector(".ledger-date").getBoundingClientRect();
    const jaap = row.querySelector(".ledger-jaap").getBoundingClientRect();
    const spark = row.querySelector(".ledger-sparkline").getBoundingClientRect();
    const result = {
      countRendered: row.querySelector(".ledger-jaap").textContent.trim(),
      dateOverlapsJaap: date.right > jaap.left,
      jaapOverlapsSpark: jaap.right > spark.left,
      pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };

    entry.jaap = previousJaap;
    renderToday();
    return result;
  });
  assert("the overlap check is measuring a genuinely wide count", largeGeometry.countRendered.includes("118800"));
  assert("at Large, the date does not overlap the jaap count", !largeGeometry.dateOverlapsJaap);
  assert("at Large, the jaap count does not overlap the sparkline", !largeGeometry.jaapOverlapsSpark);
  assert("at Large, the page still does not scroll horizontally", !largeGeometry.pageOverflows);

  await page.click('.text-size-btn[data-size="small"]');
  await new Promise(r => setTimeout(r, 300));
  const afterSmall = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  assert("Small reduces the root font size below the default", afterSmall < 16);

  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
  const afterReload = await page.evaluate(() => ({
    cls: document.documentElement.className,
    root: parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  assert("the choice survives a reload", afterReload.cls.includes("text-small"));
  assert("and is applied before first paint, not after", afterReload.root < 16);

  // Content the user wrote must be copyable, while the chrome around it
  // stays non-selectable so taps still feel app-like rather than web-like.
  const selectability = await page.evaluate(() => {
    const sel = el => el ? getComputedStyle(el).webkitUserSelect || getComputedStyle(el).userSelect : null;
    return {
      body: sel(document.body),
      heading: sel(document.querySelector("h1")),
      notes: sel(document.querySelector(".ledger-notes")),
      reflectionLine: sel(document.querySelector(".reflection-line")),
    };
  });
  assert("app chrome stays non-selectable", selectability.body === "none" && selectability.heading === "none");
  assert("ledger notes are selectable so they can be copied", selectability.notes === "text");
  assert("reflection totals are selectable", selectability.reflectionLine === "text");

  // Reset to the default so later geometry assertions in this file measure
  // the app at its normal size.
  await page.evaluate(() => {
    applyTextSize("medium");
    localStorage.removeItem("textSize");
  });
  await new Promise(r => setTimeout(r, 200));
  assert(
    "resetting to Medium removes the marker class again",
    !(await page.evaluate(() => document.documentElement.className)).includes("text-")
  );

  // ── Splash deity image: framed, not full-bleed ──────────────────────
  console.log("\n=== Splash deity image framing ===");
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 300)); // steady display window, safely inside the 3200ms hold (900ms was occasionally flaky under system load)
  const measureFraming = () => page.evaluate(() => {
    const s = document.getElementById("splash-screen");
    // #splash-panel is the rectangle the background artwork actually
    // renders into (background-size: contain), so measuring against it
    // gives percentages OF THE ARTWORK rather than of the viewport —
    // which is what the cream panel's measured bounds are expressed in.
    const panel = document.getElementById("splash-panel");
    const img = document.getElementById("splash-img");
    if (!s || !panel || !img) return null;
    const rS = s.getBoundingClientRect();
    const rP = panel.getBoundingClientRect();
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
      panelTopPct: ((rImg.top - rP.top) / rP.height) * 100,
      panelBottomPct: ((rImg.bottom - rP.top) / rP.height) * 100,
      panelLeftPct: ((rImg.left - rP.left) / rP.width) * 100,
      panelRightPct: ((rImg.right - rP.left) / rP.width) * 100,
    };
  });

  // The background artwork's plain cream panel, measured from the art's own
  // pixels: straight-walled section x 15.5%-84.3%, y 48%-98.5%, narrowing
  // above that as the arch curves in. The gold frame must land inside these
  // bounds so it reads as a picture hung on that wall, clear of the painted
  // arch and columns. Its top edge is pinned to the 44.5% line where the
  // columns' capitals meet the arch, so every image — whatever its shape —
  // hangs from the same height; that pinning is asserted, not just the
  // containment, since a frame that merely fits could still drift.
  const assertInsideCreamPanel = (label, f) => assert(
    `${label} hangs from the capital line, inside the artwork's cream panel`,
    !!f &&
      f.panelTopPct >= 43 && f.panelTopPct <= 46 && f.panelBottomPct <= 92 &&
      f.panelLeftPct >= 17 && f.panelRightPct <= 83
  );

  const framing = await measureFraming();
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
  assertInsideCreamPanel("the deity image's frame", framing);

  // Regression guard for a bug that shipped: the wide-viewport fallback's
  // threshold was originally the artwork's own ratio (37/80 = 0.4625), which
  // is a hair BELOW an ordinary phone's once its browser chrome is taken out
  // of the viewport — an installed PWA's status bar and gesture bar leave the
  // page shorter than the screen. Real phones were therefore handed the
  // tablet fallback and their frame dropped from the capital line to
  // mid-viewport, while every test here passed, because a nominal 390x844 is
  // 0.4621 and squeaked under the line. These three are the same device at
  // full screen, minus a status bar, and minus both bars; all must hang from
  // the capital line. Don't reduce this to one viewport — the whole point is
  // that ratios straddling 0.4625 have to behave identically.
  for (const [label, width, height] of [
    ["at full screen", 731, 1600],
    ["minus a status bar", 731, 1520],
    ["minus status and gesture bars", 731, 1420],
  ]) {
    await page.setViewport({ width, height });
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise(r => setTimeout(r, 300));
    const f = await measureFraming();
    assertInsideCreamPanel(`the frame on a tall phone ${label}`, f);
  }

  // The background stays full-bleed (`cover`), so on a genuinely wide
  // viewport the art's top and bottom — and with them most of the cream
  // panel — are cropped away, and an art-anchored frame would hang below the
  // fold. A min-aspect-ratio rule collapses the anchor to the viewport
  // there. A tablet shape is far enough from a phone to catch a regression
  // in either half of that arrangement.
  await page.setViewport({ width: 820, height: 1180 });
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 300));
  const wide = await page.evaluate(() => {
    const img = document.getElementById("splash-img");
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const cs = getComputedStyle(img);
    const border = parseFloat(cs.borderTopWidth) * 2;
    const naturalRatio = img.naturalWidth / img.naturalHeight;
    return {
      fullyOnScreen: r.top >= 0 && r.left >= 0 &&
        r.bottom <= window.innerHeight && r.right <= window.innerWidth,
      // Below the viewport's midline is below the arch at every ratio in
      // this range, so this is also the check that it sits on cream.
      belowTheArch: r.top >= window.innerHeight * 0.45,
      contentRatio: (r.width - border) / (r.height - border),
      naturalRatio,
    };
  });
  assert("on a tablet-shaped viewport the frame is fully on screen", !!wide && wide.fullyOnScreen);
  assert("on a tablet-shaped viewport the frame sits below the arch, on the cream", !!wide && wide.belowTheArch);
  assert(
    "frame still hugs the image's own aspect ratio on a tablet-shaped viewport",
    !!wide && Math.abs(wide.contentRatio - wide.naturalRatio) < 0.01
  );
  // Restore the phone viewport the rest of the suite is written against.
  await page.setViewport({ width: 390, height: 844 });

  // ── Splash: darshan timing and "tap anywhere to continue" ───────────
  console.log("\n=== Splash timing and tap-to-continue ===");
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 300));
  const hint = await page.evaluate(() => {
    const el = document.getElementById("splash-hint");
    const img = document.getElementById("splash-img");
    const panel = document.getElementById("splash-panel");
    if (!el || !img || !panel) return null;
    const rH = el.getBoundingClientRect();
    const rI = img.getBoundingClientRect();
    const rP = panel.getBoundingClientRect();
    return {
      text: el.textContent.trim(),
      // The hint must sit on the cream BELOW the picture. It must never
      // overlap the deity's image.
      belowThePicture: rH.top >= rI.bottom,
      insidePanel: ((rH.bottom - rP.top) / rP.height) * 100 < 98.5,
      onScreen: rH.bottom <= window.innerHeight,
    };
  });
  assert("splash shows a hint that tapping continues", !!hint && hint.text === "Tap anywhere to continue");
  assert("the hint sits below the picture, never over the deity's image", !!hint && hint.belowThePicture);
  assert("the hint stays on the artwork's cream panel", !!hint && hint.insidePanel);
  assert("the hint is on screen", !!hint && hint.onScreen);

  // Measure the hold from the `load` event, which is where app.js starts the
  // timer — NOT from when page.reload() resolves. waitUntil: "networkidle0"
  // returns a good half-second after load (it waits for 500ms of network
  // quiet on top), so timing from there silently under-measures the hold and
  // makes a correct 3200ms look like a failure.
  const heldMs = await page.evaluate(() => new Promise((resolve) => {
    const nav = performance.getEntriesByType("navigation")[0];
    const loadEnd = nav ? nav.loadEventEnd : 0;
    const started = performance.now();
    const poll = setInterval(() => {
      const el = document.getElementById("splash-screen");
      const fading = !el || getComputedStyle(el).opacity !== "1";
      if (fading) {
        clearInterval(poll);
        resolve(performance.now() - loadEnd);
      } else if (performance.now() - started > 8000) {
        clearInterval(poll);
        resolve(-1);
      }
    }, 50);
  }));
  // Allow scheduler slack below the nominal 3200, but it must clear the old
  // 2000ms hold decisively or the extension has silently regressed.
  assert(
    `splash holds for ~3.2s before dissolving (measured ${Math.round(heldMs)}ms)`,
    heldMs >= 3000 && heldMs < 4500
  );

  // A tap starts the dissolve immediately rather than waiting out the hold.
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 300));
  await page.mouse.click(195, 700);
  await new Promise(r => setTimeout(r, 120));
  assert(
    "tapping the splash begins the dissolve at once",
    await page.evaluate(() => {
      const el = document.getElementById("splash-screen");
      return !el || getComputedStyle(el).opacity !== "1";
    })
  );
  // …and it is gone once the fade completes, well before the full hold.
  await new Promise(r => setTimeout(r, SPLASH_FADE_MS + 200));
  assert(
    "the splash is fully gone after a tap, long before the hold would end",
    await page.evaluate(() => !document.getElementById("splash-screen") &&
      !document.body.classList.contains("loading"))
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
  let exported = null;
  try { exported = JSON.parse(exportedText || "null"); } catch { /* leave null */ }
  assert("export produces a versioned object payload", !!exported && exported.version === 2);
  assert("export payload carries an entries array", !!exported && Array.isArray(exported.entries));
  assert(
    "exported entry count matches the rendered ledger row count",
    !!exported && exported.entries.length === rowCountBeforeExport
  );
  assert(
    "exported entries have the expected shape",
    !!exported && exported.entries.every(e => typeof e.date === "string" && "jaap" in e && "notes" in e)
  );
  // The Sankalpa section above established (then rewrote) a vow, so one
  // exists by now. Before this batch it was excluded from every persistence
  // path — export, import, backup and Drive — and could only ever live on
  // the single device it was written on.
  assert(
    "export payload carries the Sankalpa established earlier in this run",
    !!exported && !!exported.sankalpa && typeof exported.sankalpa.text === "string" && exported.sankalpa.text.length > 0
  );

  // Deliberately a bare array — the pre-v2 export format. Every file a user
  // exported before this change looks like this, so importing one must keep
  // working; this fixture is that regression guard.
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

  assert(
    "a legacy bare-array export still imports successfully",
    (await page.evaluate(() => ledgerData.length)) === importFixture.length + 1 // +1 auto-created today entry
  );
  // A legacy file carries no Sankalpa. Importing one must leave the vow
  // already on this device alone rather than silently wiping it.
  assert(
    "importing a legacy file does not wipe the existing Sankalpa",
    (await page.evaluate(async () => {
      const s = await getSankalpa();
      return !!(s && s.text);
    })) === true
  );

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

  // ── Notes search & "On this day" ─────────────────────────────────────
  console.log("\n=== Notes search & On this day ===");
  {
    // Seed a small multi-year history: two searchable notes, plus an entry
    // on this same calendar day last year for the memory line.
    await page.evaluate(async () => {
      const iso = getTodayISO();
      const md = iso.slice(5);
      const y = Number(iso.slice(0, 4));
      ledgerData = [
        { date: `${y - 1}-${md}`, jaap: 65000, notes: "kirtan at the temple" },
        { date: `${y}-01-15`, jaap: 1080, notes: "morning satsang with Guruji" },
        { date: `${y}-02-20`, jaap: 2160, notes: "quiet day" },
        { date: iso, jaap: 324, notes: "" },
      ];
      await saveLedger(ledgerData);
      renderToday();
    });
    await new Promise(r => setTimeout(r, 400));

    const memory = await page.$eval(".on-this-day", el => el.textContent.trim());
    assert("the Today Card shows what was logged on this day a year ago", memory.includes("year ago"));
    assert("the memory reports the actual count from that day", memory.includes("65,000"));

    await page.type("#ledger-search", "satsang");
    await new Promise(r => setTimeout(r, 500)); // outlast the 200ms debounce

    const searching = await page.evaluate(() => ({
      count: document.querySelector(".ledger-search-count")?.textContent.trim(),
      notes: Array.from(document.querySelectorAll(".ledger-search-result-note")).map(n => n.textContent.trim()),
      yearHeaders: document.querySelectorAll(".ledger-year-header").length,
      jumpBar: !!document.querySelector(".jump-bar"),
      focused: document.activeElement?.id,
    }));
    assert("searching shows only the matching entry", searching.notes.length === 1);
    assert("the match is the entry whose note contains the term", searching.notes[0].includes("satsang"));
    assert("a result count is shown", searching.count === "1 matching entry");
    assert("the year accordions are replaced while searching", searching.yearHeaders === 0);
    assert("the jump-to-year bar is hidden while searching", !searching.jumpBar);
    // The input is destroyed and rebuilt on every keystroke's re-render, so
    // without deliberate focus restoration the user would be typing into a
    // dead field after the first character.
    assert("focus stays in the search box while typing", searching.focused === "ledger-search");

    // A save rebuilds the whole ledger list; the query must survive it, or
    // saving an entry mid-search would silently dump the user back to the
    // full ledger.
    await page.evaluate(async () => { await saveLedger(ledgerData); renderToday(); });
    await new Promise(r => setTimeout(r, 300));
    const afterRerender = await page.evaluate(() => ({
      value: document.getElementById("ledger-search").value,
      results: document.querySelectorAll(".ledger-search-result").length,
    }));
    assert("the query survives an unrelated re-render", afterRerender.value === "satsang");
    assert("and the filtered view survives with it", afterRerender.results === 1);

    // Searching finds entries in years whose rows were never built — the
    // lazy year build means matching by DOM would miss them entirely.
    await page.evaluate(() => {
      const i = document.getElementById("ledger-search");
      i.value = "kirtan";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 500));
    assert(
      "matches are found in past years that were never expanded",
      (await page.$$eval(".ledger-search-result-note", els => els.map(e => e.textContent))).some(x => x.includes("kirtan"))
    );

    await page.evaluate(() => {
      const i = document.getElementById("ledger-search");
      i.value = "zzzznomatch";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 500));
    assert(
      "a search with no matches says so plainly",
      (await page.$eval(".ledger-search-empty", el => el.textContent)).length > 0
    );

    await page.evaluate(() => {
      const i = document.getElementById("ledger-search");
      i.value = "";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 500));
    const cleared = await page.evaluate(() => ({
      yearHeaders: document.querySelectorAll(".ledger-year-header").length,
      jumpBar: !!document.querySelector(".jump-bar"),
      results: document.querySelectorAll(".ledger-search-result").length,
    }));
    assert("clearing the search restores the year accordions", cleared.yearHeaders > 0);
    assert("clearing the search restores the jump-to-year bar", cleared.jumpBar);
    assert("clearing the search removes the result list", cleared.results === 0);
  }

  // ── Data safety: Sankalpa round-trip, restore-undoes-import, status ──
  console.log("\n=== Data safety ===");

  // Put the app into a known state: a distinctive vow plus a one-entry ledger.
  await page.evaluate(async () => {
    await saveSankalpa({ text: "Round-trip vow", context: "round-trip ctx", date: "2023-04-01" });
    ledgerData = [{ date: "2026-01-05", jaap: 216, notes: "before import" }];
    await saveLedger(ledgerData);
    await saveAutomaticBackup(ledgerData);
    renderToday();
  });
  await new Promise(r => setTimeout(r, 400));

  // Build a v2 export file from the same function the Export button uses.
  const v2Payload = await page.evaluate(async () => buildLedgerExportPayload(await getSankalpa()));
  const v2File = path.join(os.tmpdir(), `jaap-v2-export-${Date.now()}.json`);
  fs.writeFileSync(v2File, JSON.stringify(v2Payload));

  // Now clobber both the vow and the ledger, so a successful import has to
  // genuinely restore them rather than coincidentally matching.
  await page.evaluate(async () => {
    await saveSankalpa({ text: "REPLACED vow", context: "", date: "2024-01-01" });
    ledgerData = [{ date: "2026-02-02", jaap: 999, notes: "clobbered" }];
    await saveLedger(ledgerData);
    renderToday();
  });
  await new Promise(r => setTimeout(r, 400));

  const drawerOpenForDataSafety = await page.evaluate(() =>
    document.getElementById("maintenance-drawer").classList.contains("open")
  );
  if (!drawerOpenForDataSafety) {
    await page.click("#maintenance-toggle");
    await page.waitForSelector("#maintenance-drawer.open");
    await new Promise(r => setTimeout(r, 400));
  }

  const importInputV2 = await page.$("#import-json-input");
  await importInputV2.uploadFile(v2File);
  await new Promise(r => setTimeout(r, 900));
  fs.unlinkSync(v2File);

  assert(
    "a v2 export round-trips its Sankalpa back into the app",
    (await page.evaluate(async () => (await getSankalpa()).text)) === "Round-trip vow"
  );
  assert(
    "a v2 export round-trips the Sankalpa's context and original date too",
    (await page.evaluate(async () => {
      const s = await getSankalpa();
      return s.context === "round-trip ctx" && s.date === "2023-04-01";
    })) === true
  );
  assert(
    "a v2 export round-trips its ledger entries",
    (await page.evaluate(() => ledgerData.some(e => e.date === "2026-01-05" && e.jaap === 216))) === true
  );

  // 1.2: the import above snapshotted the pre-import ledger ("clobbered"),
  // so Restore must be able to walk the import back. Previously the backup
  // was overwritten *with* the imported data, making a mistaken import
  // permanent and unrecoverable.
  //
  // Be clear about the scope of what this proves: nothing has been saved
  // between the import and the restore below. There is only ONE backup slot
  // (keyed "latest", rewritten by every save), so a single save here would
  // overwrite the pre-import snapshot and this recovery would no longer be
  // possible. That limitation is deliberate and documented; this assertion
  // covers the ordering fix, not a general "imports are always undoable"
  // guarantee — the app no longer claims one.
  await page.click("#restore-backup-btn");
  await new Promise(r => setTimeout(r, 700));
  assert(
    "Restore from Backup undoes an import when nothing has been saved since",
    (await page.evaluate(() => ledgerData.some(e => e.date === "2026-02-02" && e.jaap === 999))) === true
  );
  assert(
    "the undone import's entries are gone after restore",
    (await page.evaluate(() => ledgerData.some(e => e.date === "2026-01-05"))) === false
  );
  assert(
    "restoring also brings back the Sankalpa captured in that backup",
    (await page.evaluate(async () => (await getSankalpa()).text)) === "REPLACED vow"
  );

  // Status lines in Settings
  const statusLines = await page.evaluate(() => {
    localStorage.setItem("lastDriveBackupAt", "2020-01-01T00:00:00.000Z");
    renderDataSafetyStatus();
    return {
      drive: document.getElementById("drive-backup-status").textContent,
      storagePresent: !!document.getElementById("storage-status"),
    };
  });
  assert("the Drive status line reports a stale backup in days", /\d+ days ago/.test(statusLines.drive));
  assert("a storage-status element exists in Settings", statusLines.storagePresent);

  const neverStatus = await page.evaluate(() => {
    localStorage.removeItem("lastDriveBackupAt");
    renderDataSafetyStatus();
    return document.getElementById("drive-backup-status").textContent;
  });
  assert("with no recorded backup the Drive status says so plainly", neverStatus.includes("Not yet backed up"));

  await page.click("#maintenance-toggle"); // close drawer

  // ── Save failure is reported, not swallowed ──────────────────────────
  // Regression cover for the audit's two data-loss findings: saveLedger()
  // used to `await store.put(...)` — an IDBRequest is not a thenable, so it
  // resolved before the transaction committed and no write error could ever
  // surface — and no save path had a try/catch, so a failed write showed no
  // toast at all while ledgerData kept the value that never reached disk.
  //
  // Both are forced here by making every IndexedDB put() abort its own
  // transaction. Verified to fail without their fixes: with the old
  // saveLedger, the first assertion below reports "resolved".
  console.log("\n=== Save failure is reported, not swallowed ===");

  const forceWriteFailure = () => page.evaluate(() => {
    window.__origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const req = window.__origPut.apply(this, args);
      try { this.transaction.abort(); } catch (e) { /* already aborting */ }
      return req;
    };
  });
  const restoreWrites = () => page.evaluate(() => {
    if (window.__origPut) {
      IDBObjectStore.prototype.put = window.__origPut;
      delete window.__origPut;
    }
  });

  await freshLoad(page);
  expectedErrorFragments.push("Failed to save today's entry:", "Backup transaction");

  await forceWriteFailure();
  const saveOutcome = await page.evaluate(async () => {
    try {
      await saveLedger(ledgerData);
      return "resolved";
    } catch (e) {
      return "rejected";
    }
  });
  assert(
    "saveLedger rejects when its transaction aborts (it used to resolve before commit)",
    saveOutcome === "rejected"
  );

  const jaapBeforeFailedSave = await page.evaluate(() => {
    const e = ledgerData.find(x => x.date === todayISO);
    return e ? e.jaap : null;
  });

  await page.evaluate(() => {
    const input = document.getElementById("today-jaap");
    input.value = "77777";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("#update-today");
  await new Promise(r => setTimeout(r, 500));

  const failToast = await page.evaluate(() => {
    const el = document.getElementById("toast");
    return el ? el.textContent : "";
  });
  assert("a failed save tells the user it could not save", failToast.includes("Could not save"));
  assert("a failed save does not claim success", !failToast.includes("Saved"));

  const jaapAfterFailedSave = await page.evaluate(() => {
    const e = ledgerData.find(x => x.date === todayISO);
    return e ? e.jaap : null;
  });
  assert(
    "a failed save rolls ledgerData back, so memory never runs ahead of disk",
    jaapAfterFailedSave === jaapBeforeFailedSave
  );

  await restoreWrites();
  expectedErrorFragments.length = 0;

  // ── Unsaved Today Card input survives unrelated re-renders ───────────
  // The card is rebuilt via innerHTML by any renderToday(), so anything held
  // only in the DOM was destroyed by a Mala View toggle, a language switch,
  // or the translations background retry firing ~100s after launch. Verified
  // to fail without its fix: both fields come back empty.
  console.log("\n=== Unsaved Today Card input survives re-renders ===");

  await freshLoad(page);
  await page.evaluate(() => {
    const j = document.getElementById("today-jaap");
    const n = document.getElementById("today-notes");
    j.value = "540";
    j.dispatchEvent(new Event("input", { bubbles: true }));
    n.value = "half-written note";
    n.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await page.evaluate(() => {
    const cb = document.getElementById("mala-toggle");
    cb.checked = true;
    cb.dispatchEvent(new Event("change"));
  });
  await new Promise(r => setTimeout(r, 200));

  const afterToggle = await page.evaluate(() => ({
    jaap: document.getElementById("today-jaap").value,
    notes: document.getElementById("today-notes").value,
  }));
  assert("an in-progress note survives a Mala View toggle", afterToggle.notes === "half-written note");
  // 540 jaap is 5 mala. The count must be CONVERTED, not reinterpreted —
  // leaving "540" would silently turn 540 jaap into 540 mala (58,320 jaap).
  assert("the in-progress count is converted into the new unit", afterToggle.jaap === "5");

  await page.evaluate(() => {
    const cb = document.getElementById("mala-toggle");
    cb.checked = false;
    cb.dispatchEvent(new Event("change"));
  });
  await new Promise(r => setTimeout(r, 200));
  const afterToggleBack = await page.evaluate(() => document.getElementById("today-jaap").value);
  assert("toggling back converts the count to the original jaap figure", afterToggleBack === "540");

  await page.evaluate(() => applyAppLanguage("hi"));
  await new Promise(r => setTimeout(r, 300));
  const afterLangSwitch = await page.evaluate(() => ({
    jaap: document.getElementById("today-jaap").value,
    notes: document.getElementById("today-notes").value,
  }));
  assert("an in-progress count survives a language switch", afterLangSwitch.jaap === "540");
  assert("an in-progress note survives a language switch", afterLangSwitch.notes === "half-written note");
  await page.evaluate(() => applyAppLanguage("en"));
  await new Promise(r => setTimeout(r, 200));

  // A successful save must clear the draft, or the next render would keep
  // replaying stale typed text over the saved entry forever.
  await page.click("#update-today");
  await new Promise(r => setTimeout(r, 500));
  assert(
    "a successful save clears the draft",
    await page.evaluate(() => todayDraft === null)
  );

  // ── A corrupt backup is refused, not loaded ──────────────────────────
  // Restore applied only an Array.isArray check while Import validated
  // thoroughly, so the exact render crash Import's guard exists to prevent
  // was reachable through Restore. Verified to fail without its fix: the
  // restore proceeds and the next render throws on notes.toLowerCase().
  console.log("\n=== A corrupt backup is refused, not loaded ===");
  await freshLoad(page);
  {
    const before = await page.evaluate(() => ledgerData.length);

    // Write a structurally invalid backup directly into the backup store:
    // notes as a number is the case that crashes hasExplicitPoornima().
    await page.evaluate(async () => {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("ledger-backups", "readwrite");
        tx.objectStore("ledger-backups").put({
          backedUpAt: new Date().toISOString(),
          entries: [{ date: "2026-01-05", jaap: 108, notes: 12345 }],
          sankalpa: null,
        }, "latest");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    });

    expectedErrorFragments.push("Refusing to restore a structurally invalid backup");
    // The button lives in the Settings drawer, which slides in via transform
    // — let the transition finish or Puppeteer hit-tests it mid-slide.
    await page.click("#maintenance-toggle");
    await page.waitForSelector("#maintenance-drawer.open");
    await new Promise(r => setTimeout(r, 400));
    await page.click("#restore-backup-btn");
    await new Promise(r => setTimeout(r, 700));

    assert(
      "a corrupt backup leaves the live ledger untouched",
      await page.evaluate(() => ledgerData.length) === before
    );
    // Assert on ledger ROWS specifically. Two weaker versions of this check
    // passed even with the fix reverted, and both were rejected: the Today
    // Card is written before the crash point, and so is the year header —
    // the corrupt entry's non-string notes only blows up inside
    // buildYearRows(), via hasExplicitPoornima(). Rows are the first thing
    // that genuinely doesn't exist when this render dies.
    assert(
      "the Ledger List still renders its rows after refusing the corrupt backup",
      await page.evaluate(() => document.querySelectorAll("#ledger-list .ledger-row").length > 0)
    );
    expectedErrorFragments.length = 0;

    // Put a valid backup back so later sections aren't affected, and close
    // the drawer so it can't swallow a later click.
    await page.evaluate(async () => { await saveAutomaticBackup(ledgerData); });
    await page.click("#maintenance-toggle");
    await new Promise(r => setTimeout(r, 400));
  }

  // ── The milestone celebration fires once, not on every re-save ───────
  // getCroreMilestone() reports that a crossing EXISTS, not that this save
  // created it, so re-saving an unchanged milestone entry re-fired all 96
  // petals. Verified to fail without its fix: petals appear both times.
  console.log("\n=== The milestone celebration fires once, not on every re-save ===");
  await freshLoad(page);
  {
    const countPetals = () => page.evaluate(() =>
      document.querySelectorAll("#petal-overlay .petal-fly").length
    );

    // A single entry that crosses the first Crore outright.
    await page.evaluate(async () => {
      document.getElementById("petal-overlay").innerHTML = "";
      const today = getTodayISO();
      ledgerData = [{ date: today, jaap: null, notes: "" }];
      await saveLedger(ledgerData);
      renderToday();
    });

    await page.evaluate(() => {
      const input = document.getElementById("today-jaap");
      input.value = "10000000";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.click("#update-today");
    await new Promise(r => setTimeout(r, 700));
    assert("crossing a Crore for the first time celebrates", (await countPetals()) > 0);

    // Re-save the very same value — no new crossing is created.
    await page.evaluate(() => { document.getElementById("petal-overlay").innerHTML = ""; });
    await page.click("#update-today");
    await new Promise(r => setTimeout(r, 700));
    assert("re-saving the same milestone entry does not celebrate again", (await countPetals()) === 0);
  }

  // ── Milestones list: newest first ────────────────────────────────────
  console.log("\n=== The Milestones list reads newest first ===");
  {
    const milestones = await page.evaluate(async () => {
      ledgerData = [
        { date: "2024-03-01", jaap: 10000000, notes: "" },
        { date: "2025-06-15", jaap: 10000000, notes: "" },
        { date: "2026-02-20", jaap: 10000000, notes: "" },
      ];
      renderToday();
      await new Promise(r => setTimeout(r, 150));
      return {
        lines: [...document.querySelectorAll(".milestone-line")]
          .map(el => el.textContent.replace(/\s+/g, " ").trim()),
        // getMilestoneHistory() must still hand back ASCENDING order: it walks
        // the ledger forward to compute each crossing's daysSincePrevious, and
        // renderToday() passes the same array on to renderLedgerList(). The
        // reversal is display-only, on a copy.
        sourceOrder: getMilestoneHistory(ledgerData).map(m => m.date),
      };
    });

    assert(
      "the newest milestone is listed first",
      milestones.lines.length === 3 &&
        milestones.lines[0].includes("3 Crore") &&
        milestones.lines[1].includes("2 Crore") &&
        milestones.lines[2].includes("1 Crore")
    );
    assert(
      "getMilestoneHistory() itself is untouched and still ascending",
      milestones.sourceOrder.join(",") === "2024-03-01,2025-06-15,2026-02-20"
    );
    // The gap belongs to the milestone before it in TIME, not in display
    // order, so reversing the list must not re-attach it to the wrong line.
    assert(
      "each milestone keeps its own days-since-previous",
      milestones.lines[0].includes("+250") &&
        milestones.lines[1].includes("+471") &&
        !milestones.lines[2].includes("+")
    );
  }

  // ── A hostile storage environment must not kill the app ──────────────
  // app.js is a classic script, so a throw at top-level scope aborts the
  // ENTIRE remaining file — no initApp(), no listeners, no service worker,
  // and a splash screen that never clears. Several unguarded localStorage
  // calls sat at top-level scope, the most exposed being the
  // lastSplashImage write in chooseSplashImage(), which runs before first
  // paint. Verified to fail without its fix: the Today Card never renders
  // and app.js's later functions are undefined.
  console.log("\n=== A hostile storage environment must not kill the app ===");
  {
    const hostileContext = await browser.createBrowserContext();
    const hostilePage = await hostileContext.newPage();
    await hostilePage.setViewport({ width: 390, height: 844 });
    await hostilePage.evaluateOnNewDocument(() => {
      Storage.prototype.setItem = function () {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      };
    });
    await hostilePage.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));

    const booted = await hostilePage.evaluate(() => ({
      todayCard: !!document.querySelector("#today-card h2"),
      ledger: !!document.querySelector("#ledger-list .ledger-year-header"),
      // Must be a late `const`, NOT a late function: function declarations
      // are hoisted, so they exist even when execution aborted on line 282
      // and never reached them. (This assertion originally checked a
      // function and passed even with the fix reverted — vacuous.) A const
      // sits in the temporal dead zone until its initializer actually runs,
      // so touching it throws unless execution genuinely got that far.
      lateConstInitialized: (() => {
        try {
          return typeof GOOGLE_DRIVE_CLIENT_ID === "string";
        } catch (e) {
          return false;
        }
      })(),
      splashGone: !document.getElementById("splash-screen"),
    }));
    assert("the Today Card still renders when every localStorage write throws", booted.todayCard);
    assert("the Ledger List still renders when every localStorage write throws", booted.ledger);
    assert("app.js executed all the way to the end of the file", booted.lateConstInitialized);
    assert("the splash screen still clears", booted.splashGone);

    await hostileContext.close();
  }

  // ── A blocked Sankalpa read must not strand the user ─────────────────
  // renderSankalpaPage() writes the page's markup — close button included —
  // only after its first await. A rejection there left the user sealed
  // inside an empty full-screen overlay with nothing to tap. Verified to
  // fail without its fix: the page stays open with no close button.
  console.log("\n=== A blocked Sankalpa read must not strand the user ===");
  {
    const strandContext = await browser.createBrowserContext();
    const strandPage = await strandContext.newPage();
    await strandPage.setViewport({ width: 390, height: 844 });
    await seedAppState(strandPage);
    const strandErrors = [];
    strandPage.on("console", msg => {
      if (msg.type() === "error") strandErrors.push(msg.text());
    });
    await strandPage.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));

    // Top-level function declarations land on window, so this replaces the
    // real read with a failing one — the same shape as IndexedDB being
    // unavailable or blocked.
    await strandPage.evaluate(() => {
      window.getSankalpa = () => Promise.reject(new Error("IndexedDB unavailable"));
    });

    await strandPage.click("#maintenance-toggle");
    await strandPage.waitForSelector("#maintenance-drawer.open");
    await new Promise(r => setTimeout(r, 400));
    await strandPage.click("#sankalpa-open-btn");
    await new Promise(r => setTimeout(r, 600));

    const strandState = await strandPage.evaluate(() => {
      const page = document.getElementById("sankalpa-page");
      return {
        stillOpen: page.classList.contains("open"),
        hasCloseButton: !!page.querySelector("#sankalpa-close"),
        toast: document.getElementById("toast") ? document.getElementById("toast").textContent : "",
      };
    });
    assert("a failed Sankalpa read closes the page instead of stranding the user", !strandState.stillOpen);
    assert("the user is told the Sankalpa could not be opened", strandState.toast.includes("Could not open"));
    assert(
      "the failure is reported rather than left as an unhandled rejection",
      strandErrors.some(e => e.includes("Could not render the Sankalpa page"))
    );

    await strandContext.close();
  }

  // ── Sync: dormant until asked for ────────────────────────────────────
  // The app's second network dependency. What matters is not that sign-in
  // works — that needs a real Google account and cannot run headless — but
  // that its mere existence costs a normal launch nothing, since the app's
  // central promise is working offline.
  console.log("\n=== Sync stays dormant until used ===");
  {
    const syncContext = await browser.createBrowserContext();
    const syncPage = await syncContext.newPage();
    await syncPage.setViewport({ width: 390, height: 844 });
    await seedAppState(syncPage);

    const crossOrigin = [];
    syncPage.on("request", (req) => {
      if (new URL(req.url()).origin !== new URL(BASE).origin) crossOrigin.push(req.url());
    });

    await syncPage.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));

    assert(
      "a normal launch makes no cross-origin request at all",
      crossOrigin.length === 0
    );
    assert(
      "the Firebase SDK is not loaded on launch",
      await syncPage.evaluate(() => firebaseAuthPromise === null)
    );

    // Opening Settings warms the SDK, which is what lets the sign-in popup
    // open synchronously from the later tap. Stubbed rather than fetched, so
    // the suite keeps working with no internet — the app tolerates that fetch
    // failing, and a test suite that needs gstatic.com would be worse than
    // one that does not.
    await syncPage.evaluate(() => {
      window.loadFirebaseAuth = () => {
        firebaseAuthReady = { instance: {}, auth: {} };
        return Promise.resolve(firebaseAuthReady);
      };
    });
    await syncPage.click("#maintenance-toggle");
    await syncPage.waitForSelector("#maintenance-drawer.open");
    await new Promise(r => setTimeout(r, 400));

    assert(
      "opening Settings warms the SDK, rather than waiting for the tap",
      await syncPage.evaluate(() => firebaseAuthReady !== null)
    );

    const syncUi = await syncPage.evaluate(() => ({
      btn: document.getElementById("sync-signin-btn")?.textContent.trim(),
      status: document.getElementById("sync-status")?.textContent.trim(),
      enabled: document.getElementById("sync-signin-btn")?.disabled === false,
    }));
    assert("Settings offers a sign-in control", syncUi.btn === "Sign in with Google");
    assert("it is tappable once the SDK is warm", syncUi.enabled);
    assert(
      "and states plainly that nothing is being synced yet",
      !!syncUi.status && syncUi.status.includes("Not signed in")
    );

    // A sadhak who has never signed in must not pay for the feature on
    // launch — restoreSyncSession() is gated on a flag, so it returns
    // without touching the network.
    assert(
      "restoring a session is a no-op for someone who never signed in",
      await syncPage.evaluate(async () => {
        await restoreSyncSession();
        return firebaseAuthPromise === null;
      })
    );

    // Signing in when the SDK cannot be fetched (offline, blocked CDN) must
    // report and leave the app entirely usable, never half-initialised.
    const offlineFailure = await syncPage.evaluate(async () => {
      window.loadFirebaseAuth = () => Promise.reject(new Error("offline"));
      document.getElementById("sync-signin-btn").click();
      await new Promise(r => setTimeout(r, 400));
      return {
        toast: document.querySelector(".toast, #toast")?.textContent || "",
        stillUsable: !!document.getElementById("today-jaap"),
        buttonReenabled: document.getElementById("sync-signin-btn").disabled === false,
      };
    });
    assert("a sign-in that cannot reach the network is reported", offlineFailure.toast.includes("Could not sign in"));
    assert("the app remains fully usable after a failed sign-in", offlineFailure.stillUsable);
    assert("the sign-in button is re-enabled rather than left stuck", offlineFailure.buttonReenabled);

    // The failure that actually shipped in v3.3.0. On an installed iOS PWA
    // the popup never opened AND never rejected, so the sign-in promise hung
    // forever: the button stayed disabled and the user got no error and no
    // retry. A promise that never settles is the case a plain try/catch
    // cannot see, so it is worth pinning explicitly.
    // The SDK load can no longer hang the sign-in — it is awaited before the
    // tap, never during it — so the only remaining source is the popup, which
    // is exactly what hung on the phone. Stub one that never settles.
    const hung = await syncPage.evaluate(async () => {
      firebaseAuthReady = {
        instance: {},
        auth: {
          GoogleAuthProvider: function () {},
          signInWithPopup: () => new Promise(() => {}),
        },
      };
      document.getElementById("sync-signin-btn").click();
      await new Promise(r => setTimeout(r, 250));
      const state = {
        disabledWhileWorking: document.getElementById("sync-signin-btn").disabled,
        statusWhileWorking: document.getElementById("sync-status").textContent.trim(),
      };
      // The click leaves a 60s timer running; nothing after this should
      // inherit a permanently pending sign-in.
      firebaseAuthReady = null;
      return state;
    });
    assert("the button is disabled while a sign-in is in flight", hung.disabledWhileWorking);
    assert("and the status says something is happening", hung.statusWhileWorking.includes("Working"));

    // The real timeout is 60s, far too long for a test to wait, so drive
    // withTimeout() directly rather than through the click handler. What is
    // being asserted is that a never-settling promise becomes a rejection at
    // all — which is the property the stuck button lacked.
    const timedOut = await syncPage.evaluate(async () => {
      try {
        await withTimeout(new Promise(() => {}), 120, "timeout");
        return "resolved";
      } catch (err) {
        return err.message;
      }
    });
    assert("a sign-in that never settles is turned into a failure, not a hang", timedOut === "timeout");

    // v3.3.1 reported a bare "timeout", which proved the attempt never
    // settled but not which step hung — and "the SDK never loaded" and "the
    // popup never came back" have completely different fixes. Each stage now
    // fails under its own name.
    const staged = await syncPage.evaluate(async () => {
      const label = async (l) => {
        try { await withTimeout(new Promise(() => {}), 60, l); return "resolved"; }
        catch (e) { return describeSyncError(e); }
      };
      return { sdk: await label("sdk-load-timeout"), popup: await label("popup-timeout") };
    });
    assert("a stalled SDK load is named as such", staged.sdk === "sdk-load-timeout");
    assert("a stalled popup is named separately", staged.popup === "popup-timeout");

    // ── The bug that sank the first attempt ──────────────────────────
    // Browsers only permit window.open() synchronously inside a user gesture.
    // The original click handler awaited the SDK's network fetch first and
    // only then called signInWithPopup — by which point the gesture was spent,
    // Safari silently refused the window, and Firebase hung forever. No error,
    // no popup, a dead button.
    //
    // This asserts the property directly: signInWithPopup must have been
    // called by the time signInForSync() returns, with no await in between.
    const synchronous = await syncPage.evaluate(() => {
      let calledSynchronously = false;
      firebaseAuthReady = {
        instance: {},
        auth: {
          GoogleAuthProvider: function () {},
          // Never settles, exactly like the real hung popup did.
          signInWithPopup: () => { calledSynchronously = true; return new Promise(() => {}); },
        },
      };
      signInForSync();
      // Read IMMEDIATELY: nothing has yielded to the event loop yet, so this
      // is only true if the popup call happened inside the same task.
      const result = calledSynchronously;
      firebaseAuthReady = null;
      return result;
    });
    assert(
      "signInWithPopup is called synchronously, so the user gesture is still live",
      synchronous
    );

    // And with the SDK not yet loaded it must refuse by name rather than
    // awaiting a fetch and losing the gesture the way the first attempt did.
    const notReady = await syncPage.evaluate(async () => {
      firebaseAuthReady = null;
      try { await signInForSync(); return "resolved"; }
      catch (e) { return describeSyncError(e); }
    });
    assert("sign-in refuses outright when the SDK is not in memory", notReady === "sdk-not-ready");

    // Which is why the button must not be tappable until it is ready.
    const gating = await syncPage.evaluate(() => {
      firebaseAuthReady = null;
      renderSyncStatus();
      const notReady = {
        disabled: document.getElementById("sync-signin-btn").disabled,
        status: document.getElementById("sync-status").textContent.trim(),
      };
      firebaseAuthReady = { instance: {}, auth: {} };
      renderSyncStatus();
      const ready = {
        disabled: document.getElementById("sync-signin-btn").disabled,
        status: document.getElementById("sync-status").textContent.trim(),
      };
      firebaseAuthReady = null;
      renderSyncStatus();
      return { notReady, ready };
    });
    assert("the button is unavailable until the SDK is loaded", gating.notReady.disabled === true);
    assert("and says so rather than looking broken", gating.notReady.status.includes("Preparing"));
    assert("it becomes available once the SDK is in memory", gating.ready.disabled === false);

    // And the error code reaches the screen, since a phone has no console.
    const detail = await syncPage.evaluate(() => {
      const el = document.getElementById("sync-status");
      el.textContent = t("syncSignInFailedDetail", { detail: describeSyncError({ code: "auth/popup-blocked" }) });
      return el.textContent;
    });
    assert(
      "the underlying Firebase error code is shown on screen, not just logged",
      detail.includes("popup-blocked")
    );

    // Both the status line and the button are rendered from t() rather than
    // data-i18n, because their text depends on the signed-in state. That put
    // them outside applyStaticTranslations() and they were left behind on a
    // language switch: the status kept whatever language it was last rendered
    // in, and the button — which DID carry data-i18n — was reset to "Sign in
    // with Google" while still signed in, reading as an expired session.
    // A real sign-in can't run headless, so fake the user object.
    const acrossLanguages = await syncPage.evaluate(async () => {
      syncUser = { email: "sadhak@example.com" };
      const seen = {};
      for (const lang of ["hi", "bn", "en"]) {
        applyAppLanguage(lang);
        await new Promise(r => setTimeout(r, 120));
        seen[lang] = {
          status: document.getElementById("sync-status").textContent.trim(),
          btn: document.getElementById("sync-signin-btn").textContent.trim(),
        };
      }
      syncUser = null;
      applyAppLanguage("en");
      return seen;
    });

    assert(
      "the status line follows the chosen language, not the one it was rendered in",
      acrossLanguages.hi.status.includes("साइन इन") &&
      acrossLanguages.bn.status.includes("সাইন ইন") &&
      acrossLanguages.en.status.includes("Signed in as")
    );
    assert(
      "the signed-in email survives every language switch",
      ["hi", "bn", "en"].every(l => acrossLanguages[l].status.includes("sadhak@example.com"))
    );
    assert(
      "the button keeps saying Sign out while signed in, in each language",
      acrossLanguages.en.btn === "Sign out" &&
      acrossLanguages.hi.btn === "साइन आउट करें" &&
      acrossLanguages.bn.btn === "সাইন আউট করুন"
    );

    // ── Push and pull ────────────────────────────────────────────────
    // The whole model: a save pushes, opening the app pulls. Firestore is
    // stubbed rather than reached, for the same reason the auth SDK is —
    // the suite must run with no internet and must not write to a real
    // project. What is being tested is this app's logic, not Google's.
    await syncPage.evaluate(() => {
      window.__remote = null;   // what the fake Firestore holds
      window.__pushes = [];     // every payload this device uploaded
      window.__gets = 0;

      window.loadFirestore = () => Promise.resolve({
        db: {},
        store: {
          doc: (_db, ...segments) => ({ path: segments.join("/") }),
          setDoc: (ref, payload) => {
            window.__pushes.push({ path: ref.path, payload });
            window.__remote = JSON.parse(JSON.stringify(payload));
            return Promise.resolve();
          },
          getDoc: () => {
            window.__gets += 1;
            return Promise.resolve({
              exists: () => window.__remote !== null,
              data: () => JSON.parse(JSON.stringify(window.__remote)),
            });
          },
        },
      });
    });

    // Nothing may leave the device for someone who has not signed in — the
    // same promise the dormant-launch assertions above make, but for the
    // path that now runs after every single save.
    const signedOutSave = await syncPage.evaluate(async () => {
      syncUser = null;
      window.__pushes = [];
      await saveLedger(ledgerData);
      await new Promise(r => setTimeout(r, 200));
      return window.__pushes.length;
    });
    assert("a save uploads nothing when nobody is signed in", signedOutSave === 0);

    const firstSync = await syncPage.evaluate(async () => {
      syncUser = { uid: "sadhak-1", email: "sadhak@example.com" };
      window.__remote = null;
      window.__pushes = [];
      await syncNow();
      await new Promise(r => setTimeout(r, 200));
      return {
        pushes: window.__pushes.length,
        path: window.__pushes[0]?.path,
        version: window.__remote?.version,
        hasEntries: Array.isArray(window.__remote?.entries),
      };
    });
    assert("the first device to sync seeds the stored ledger", firstSync.pushes >= 1);
    assert("it is stored per sadhak, under their own uid", firstSync.path === "users/sadhak-1/ledger/current");
    assert("and in the same format Export and Drive backup already use", firstSync.version === 2 && firstSync.hasEntries);

    // A save pushes. This is hooked into saveLedger() — the sole writer of
    // the ledger store — so every save path is covered by construction
    // rather than by remembering to call it in each one.
    const savePushes = await syncPage.evaluate(async () => {
      window.__pushes = [];
      const entry = ledgerData.find(e => e.date === todayISO) || ledgerData[0];
      entry.jaap = 1188;
      stampEntryEdited(entry);
      await saveLedger(ledgerData);
      await new Promise(r => setTimeout(r, 300));
      const pushed = window.__remote.entries.find(e => e.date === entry.date);
      return { pushes: window.__pushes.length, jaap: pushed?.jaap, stamped: typeof pushed?.updatedAt === "string" };
    });
    assert("saving pushes the ledger", savePushes.pushes === 1);
    assert("and the pushed ledger carries the saved count", savePushes.jaap === 1188);
    assert("the edit stamp travels with it, so the later edit can win", savePushes.stamped);

    // Opening the app pulls. A day logged on the other device arrives here.
    const pulled = await syncPage.evaluate(async () => {
      const otherDay = "2020-03-11";
      window.__remote = {
        version: 2,
        entries: [{ date: otherDay, jaap: 5400, notes: "logged elsewhere", updatedAt: "2020-03-11T10:00:00.000Z" }],
        sankalpa: null,
      };
      window.__pushes = [];
      await syncNow();
      await new Promise(r => setTimeout(r, 300));
      return {
        present: ledgerData.some(e => e.date === otherDay && e.jaap === 5400),
        notes: ledgerData.find(e => e.date === otherDay)?.notes,
        // The pulled ledger held one day; the last week must still exist
        // afterwards, or the Today Card would have no entry to render.
        hasToday: ledgerData.some(e => e.date === todayISO),
        echoes: window.__pushes.length,
        toast: document.querySelector(".toast, #toast")?.textContent || "",
      };
    });
    assert("opening the app pulls the other device's day", pulled.present);
    assert("with its notes intact", pulled.notes === "logged elsewhere");
    assert("and the recent days are backfilled, so Today still renders", pulled.hasToday);
    assert("the sadhak is told their ledger changed", pulled.toast.includes("other device"));
    // Applying a pull writes to IndexedDB, which is where the push hook
    // lives — without the guard, every launch would bounce the freshly
    // pulled ledger straight back up again.
    assert("applying a pull does not echo back to the store", pulled.echoes === 0);

    // Most opens follow no edit anywhere, so the common case must be silent —
    // and this is where the first version was wrong in a way the phone found
    // immediately. It compared JSON.stringify() of the two payloads, but
    // Firestore hands a document's keys back in ALPHABETICAL order rather than
    // the order they were written, so an identical ledger compared unequal and
    // the app announced "updated from your other device" on every single
    // return to the foreground. Reproduce that faithfully: re-spell the
    // payload the way Firestore would.
    const alphabetise = (v) => {
      if (Array.isArray(v)) return v.map(alphabetise);
      if (v && typeof v === "object") {
        return Object.keys(v).sort().reduce((acc, k) => { acc[k] = alphabetise(v[k]); return acc; }, {});
      }
      return v;
    };
    const unchangedReordered = await syncPage.evaluate(async (remote) => {
      return await applyPulledLedger(remote);
    }, alphabetise(await syncPage.evaluate(async () => buildLedgerExportPayload(await getSankalpa()))));
    assert(
      "an unchanged ledger stays silent even though Firestore reorders its keys",
      unchangedReordered === false
    );

    // The second cause, which would have kept the toast coming even with key
    // order fixed. A pull backfills the last seven days, so the local ledger
    // legitimately ends up holding placeholder days the stored one has never
    // heard of — permanently. Comparing the raw pull against local would
    // report a difference on every open forever.
    const unchangedAfterBackfill = await syncPage.evaluate(async () => {
      // A stored ledger from a device last opened well before today: real
      // practice, but nothing for the recent days.
      const stored = {
        entries: ledgerData
          .filter(e => e.jaap !== null && e.jaap !== undefined)
          .map(e => ({ date: e.date, jaap: e.jaap, notes: e.notes || "" })),
        sankalpa: null,
        version: 2,
      };
      const first = await applyPulledLedger(JSON.parse(JSON.stringify(stored)));
      const second = await applyPulledLedger(JSON.parse(JSON.stringify(stored)));
      const third = await applyPulledLedger(JSON.parse(JSON.stringify(stored)));
      return { first, second, third };
    });
    assert(
      "re-pulling the same ledger settles after the first apply, rather than announcing itself forever",
      unchangedAfterBackfill.second === false && unchangedAfterBackfill.third === false
    );

    // A pulled ledger is foreign data arriving over a network — the fourth
    // door into ledgerData, and the only one not opened by the user. It goes
    // through the same guard as Import and Restore.
    const rejected = await syncPage.evaluate(async () => {
      const before = ledgerData.length;
      const applied = await applyPulledLedger({
        version: 2,
        entries: [{ date: "2021-01-01", jaap: 108, notes: null }], // notes must be a string
        sankalpa: null,
      });
      return { applied, unchanged: ledgerData.length === before };
    });
    // A pull replaces the ledger, so the ledger it replaces must be snapshotted
    // FIRST — the ordering Import already learned the hard way, where backing
    // up afterwards overwrote the only backup with the incoming data in the
    // same breath and the replaced ledger was gone immediately.
    const backupBeforeReplace = await syncPage.evaluate(async () => {
      const marker = "2019-07-07";
      ledgerData.push({ date: marker, jaap: 4321, notes: "about to be replaced" });
      await saveLedger(ledgerData);
      await new Promise(r => setTimeout(r, 200));

      await applyPulledLedger({
        version: 2,
        entries: [{ date: "2019-01-01", jaap: 108, notes: "the incoming ledger" }],
        sankalpa: null,
      });

      const backup = await loadLatestBackup();
      const entries = Array.isArray(backup) ? backup : (backup && backup.entries) || [];
      return {
        replaced: !ledgerData.some(e => e.date === marker),
        recoverable: entries.some(e => e.date === marker && e.jaap === 4321),
      };
    });
    assert("a pull does replace the local ledger", backupBeforeReplace.replaced);
    assert(
      "and the replaced ledger is snapshotted first, so it is still recoverable",
      backupBeforeReplace.recoverable
    );

    assert("a malformed synced ledger is refused", rejected.applied === false);
    assert("and the local ledger is left exactly as it was", rejected.unchanged);

    // The offline case. A save with no network cannot push, so it is flagged;
    // the next open must send it up BEFORE pulling, or the pull would
    // overwrite practice that was never uploaded.
    const offlineSave = await syncPage.evaluate(async () => {
      const day = "2020-04-02";
      ledgerData.push({ date: day, jaap: 2160, notes: "logged offline", updatedAt: "2020-04-02T09:00:00.000Z" });
      setPendingSyncPush(true);
      // The stored ledger meanwhile knows nothing about that day.
      window.__remote = { version: 2, entries: [{ date: "2020-04-01", jaap: 108, notes: "" }], sankalpa: null };
      window.__pushes = [];

      await syncNow();
      await new Promise(r => setTimeout(r, 300));
      return {
        survivedLocally: ledgerData.some(e => e.date === day && e.jaap === 2160),
        reachedTheStore: (window.__remote.entries || []).some(e => e.date === day),
        pending: hasPendingSyncPush(),
      };
    });
    assert("a save made offline is not overwritten by the next pull", offlineSave.survivedLocally);
    assert("it is uploaded before that pull happens", offlineSave.reachedTheStore);
    assert("and the device stops considering itself behind", offlineSave.pending === false);

    // A failed push must never cost the sadhak their save — the write already
    // succeeded in IndexedDB, which is the source of truth.
    const pushFailure = await syncPage.evaluate(async () => {
      const original = window.loadFirestore;
      window.loadFirestore = () => Promise.reject(new Error("offline"));
      const entry = ledgerData.find(e => e.date === todayISO);
      entry.jaap = 2700;
      await saveLedger(ledgerData);
      await new Promise(r => setTimeout(r, 300));
      window.loadFirestore = original;
      return { saved: ledgerData.find(e => e.date === todayISO).jaap === 2700, pending: hasPendingSyncPush() };
    });
    assert("a save whose upload fails still saves locally", pushFailure.saved);
    assert("and is remembered as owed to the store", pushFailure.pending === true);

    // The "Last synced" line is the thing a sadhak would check before trusting
    // their practice is safe on another device, so it must never run ahead of
    // reality — written only where a sync genuinely completed, never on an
    // attempt and never on a failure.
    const lastSynced = await syncPage.evaluate(async () => {
      const read = () => document.getElementById("sync-last-synced").textContent.trim();

      writeStoredPreference("lastSyncAt", "");
      renderSyncStatus();
      const beforeAnySync = read();

      // A sync that fails outright must leave the line exactly as it was.
      const original = window.loadFirestore;
      window.loadFirestore = () => Promise.reject(new Error("offline"));
      setPendingSyncPush(false);
      await syncNow();
      const afterFailure = read();
      window.loadFirestore = original;

      window.__remote = { version: 2, entries: [{ date: "2020-05-05", jaap: 108, notes: "" }], sankalpa: null };
      await syncNow();
      await new Promise(r => setTimeout(r, 200));
      const afterSuccess = read();

      return { beforeAnySync, afterFailure, afterSuccess };
    });
    assert("the line is empty before anything has synced, not 'never'", lastSynced.beforeAnySync === "");
    assert("a failed sync does not stamp a time it never achieved", lastSynced.afterFailure === "");
    assert(
      "a completed sync stamps the local date and time",
      /^Last synced: \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2} (AM|PM)$/.test(lastSynced.afterSuccess)
    );

    // Sync failures reach the screen for the same reason sign-in failures do:
    // there is no console on a phone.
    const syncFailureShown = await syncPage.evaluate(async () => {
      const original = window.loadFirestore;
      window.loadFirestore = () => Promise.reject(Object.assign(new Error("x"), { code: "permission-denied" }));
      setPendingSyncPush(false);
      await syncNow();
      window.loadFirestore = original;
      setPendingSyncPush(false);
      syncUser = null;
      return document.getElementById("sync-status").textContent.trim();
    });
    assert("a failed sync says so, with its reason", syncFailureShown.includes("permission-denied"));

    await syncContext.close();
  }

  // ── Console errors ───────────────────────────────────────────────────
  console.log("\n=== Console errors ===");
  // The deliberate offline sign-in failure above logs its own console.error;
  // that is the app reporting correctly, not a defect.
  const unexpectedErrors = pageErrors.filter(e => !e.includes("Sync sign-in failed"));
  assert("no JS errors on page across the whole run", unexpectedErrors.length === 0);
  if (unexpectedErrors.length > 0) console.log("  errors:", unexpectedErrors);
  if (pageErrors.length > 0) console.log("  errors:", pageErrors);

  await browser.close();
  fs.rmSync(downloadDir, { recursive: true, force: true });

  console.log("\n" + "─".repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("─".repeat(40));
  process.exit(failed > 0 ? 1 : 0);
})();
