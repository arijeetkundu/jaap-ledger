// Tests for the service worker: registration and scope, what gets
// precached, a GENUINELY offline launch (the app's whole stated premise),
// and — the risk that matters most in a repo with no build step and
// therefore no content-hashed filenames — that a deploy is actually picked
// up rather than the user being pinned to the build they first loaded.
//
// Uses its own browser context per scenario so service worker registrations
// and caches never leak between tests or into the other suites.
//
// Run with the app already being served (e.g. `python -m http.server 3333`).

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const BASE = "http://localhost:3333";
const SPLASH_WAIT_MS = 4200;
const SW_SETTLE_MS = 3000; // registration + install precache
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

async function newPage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluateOnNewDocument(() => localStorage.setItem("appLanguage", "en"));
  await page.evaluateOnNewDocument(() => {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    localStorage.setItem("lastSundayBackupPromptDate", iso);
  });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return { context, page, errors };
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
  const allErrors = [];

  // ── Registration, scope, and precache contents ───────────────────────
  console.log("\n=== Registration & precache ===");
  {
    const { context, page, errors } = await newPage(browser);
    await page.goto(BASE + "/", { waitUntil: "networkidle0", timeout: 15000 });
    await new Promise(r => setTimeout(r, SW_SETTLE_MS));

    const reg = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return { registered: !!r, scope: r ? r.scope : null, hasActive: !!(r && r.active) };
    });
    assert("a service worker registers", reg.registered);
    assert("the worker becomes active", reg.hasActive);
    // Registered with a relative "./sw.js" so the scope follows wherever the
    // app is served from — "/" locally, "/jaap-ledger/" on GitHub Pages.
    assert("its scope covers the app's own directory", !!reg.scope && BASE.startsWith(new URL(reg.scope).origin));

    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const ours = names.filter(n => n.startsWith("sumiran-lite-"));
      if (ours.length === 0) return { names, paths: [] };
      const cache = await caches.open(ours[0]);
      const keys = await cache.keys();
      return { names: ours, paths: keys.map(k => new URL(k.url).pathname).sort() };
    });
    assert("exactly one versioned cache is created", cached.names.length === 1);

    // The critical path for a correct offline first paint and first render.
    for (const required of [
      "/index.html",
      "/app.js",
      "/styles.css",
      "/i18n/translations.json",
      "/fonts/Inter-Variable.woff2",
      "/fonts/PlayfairDisplay-Variable.woff2",
      "/splash/hanuman-splash.webp",
    ]) {
      assert(`precached: ${required}`, cached.paths.includes(required));
    }

    allErrors.push(...errors);
    await context.close();
  }

  // ── A genuinely offline launch ───────────────────────────────────────
  // Before the worker existed this was the app's central false claim: the
  // data was offline but the shell was not, so a cold launch with no network
  // simply failed.
  console.log("\n=== Offline launch ===");
  {
    const { context, page, errors } = await newPage(browser);
    await page.goto(BASE + "/", { waitUntil: "networkidle0", timeout: 15000 });
    await new Promise(r => setTimeout(r, SW_SETTLE_MS));

    // Launch offline on a SECOND page in the same context rather than
    // reloading this one. Same context means the worker registration and its
    // caches are shared, so this is still a genuine cold offline launch —
    // and it is closer to what a user actually does (open the app again)
    // than a reload is. The reload it replaces intermittently threw
    // "Attempted to use detached Frame": Chrome can swap the frame on a
    // navigation and Puppeteer is left holding the old one. That took the
    // whole suite down rather than failing an assertion, and it is a race in
    // the harness, not a defect in the worker.
    await page.close();
    const offlinePage = await context.newPage();
    await offlinePage.setViewport({ width: 390, height: 844 });
    offlinePage.on("pageerror", (err) => errors.push(err.message));
    offlinePage.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await offlinePage.setOfflineMode(true);
    await offlinePage.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS + 700));

    const offline = await offlinePage.evaluate(() => ({
      heading: document.querySelector("h1")?.textContent || "",
      todayCardRendered: (document.getElementById("today-card")?.innerHTML || "").trim().length > 0,
      ledgerRendered: (document.getElementById("ledger-list")?.innerHTML || "").trim().length > 0,
      reflectionRendered: (document.getElementById("reflection-summary")?.innerHTML || "").trim().length > 0,
      translationsLoaded: !!(typeof TRANSLATIONS !== "undefined" && TRANSLATIONS && Object.keys(TRANSLATIONS).length > 0),
      todayHeading: (document.querySelector("#today-card h2")?.textContent || "").trim(),
    }));

    assert("the app shell loads with no network at all", offline.heading.includes("Sumiran Lite"));
    assert("the Today Card renders offline", offline.todayCardRendered);
    assert("the Ledger List renders offline", offline.ledgerRendered);
    assert("the Reflection Card renders offline", offline.reflectionRendered);
    // translations.json is fetched at runtime on every launch, so before the
    // worker this was the first thing to break offline — leaving raw
    // dictionary keys on screen until a retry happened to succeed.
    assert("translations are available offline (not raw keys)", offline.translationsLoaded);
    assert("offline UI shows real English, not a raw dictionary key", offline.todayHeading === "Today");

    await offlinePage.setOfflineMode(false);
    allErrors.push(...errors);
    await context.close();
  }

  // ── A deploy is picked up, not pinned forever ────────────────────────
  // The worker serves cache-first for speed and offline support, so a user
  // is expected to be at most ONE launch behind after a deploy. What must
  // never happen is being stuck on the old build indefinitely: that is what
  // a naive stale-while-revalidate does here, because the worker's own
  // revalidation fetch is served by the browser's HTTP cache unless it
  // explicitly opts out.
  console.log("\n=== Deploy pickup (no permanent staleness) ===");
  {
    const TARGET = path.join(__dirname, "..", "styles.css");
    const MARKER = "/* sw-deploy-pickup-probe */";
    const original = fs.readFileSync(TARGET, "utf8");

    // Replace the file ATOMICALLY (write a temp file, then rename over the
    // target). fs.writeFileSync truncates before it writes, which leaves a
    // window where the served file is 0 bytes — and this test is racing a
    // service worker that fetches it. Losing that race poisons the run
    // permanently, not transiently: the worker caches a 0-byte 200 OK, and
    // every later revalidation gets a 304 Not Modified, so the empty copy
    // sticks and the marker can never appear no matter how long we poll.
    //
    // That is what was behind this test's long history of "fails in the full
    // suite, passes standalone" — more load, wider truncation window. It was
    // misdiagnosed twice before instrumentation showed the cached entry was
    // simply empty (servedLength: 0, cachedLength: 0).
    const writeAtomically = (contents) => {
      const tmp = TARGET + ".deploy-probe.tmp";
      fs.writeFileSync(tmp, contents);
      fs.renameSync(tmp, TARGET); // replaces in one step, no empty window
    };

    const { context, page, errors } = await newPage(browser);

    try {
      await page.goto(BASE + "/", { waitUntil: "networkidle0", timeout: 15000 });
      await new Promise(r => setTimeout(r, SW_SETTLE_MS));

      const beforeDeploy = await page.evaluate(async () => {
        const res = await fetch("./styles.css");
        return (await res.text()).includes("sw-deploy-pickup-probe");
      });
      assert("the probe marker is absent before the simulated deploy", beforeDeploy === false);

      // Simulate a deploy by changing the served file.
      writeAtomically(original + "\n" + MARKER + "\n");

      // Smoke check only (see the structural guard below for the actual
      // regression detection).
      //
      // This polls the CACHE, not page reloads. The earlier version reloaded
      // the page a fixed number of times and hoped the background
      // revalidation happened to land in one of the gaps -- which is a race,
      // not a condition, so it failed intermittently (and in different
      // suites' company) while the worker was behaving correctly. Raising
      // the reload count from 4 to 8 did not fix it, and neither did
      // returning cache.put() in sw.js: the write can simply land later than
      // any fixed number of reloads, because stale-while-revalidate makes no
      // promise about WHEN.
      //
      // What the worker actually guarantees is that the cached entry is
      // eventually replaced. So: reload once to trigger a revalidation, then
      // wait for that to become true, reading Cache Storage directly. It
      // still fails loudly if the answer is genuinely "never", which is the
      // regression being guarded, but it no longer fails merely because the
      // machine was busy.
      // 20s was still not enough in the full `npm test` run specifically —
      // it passed standalone every time and failed in company three times,
      // across two different implementations of this check. Rather than keep
      // raising a number blindly, this now also reports WHY it gave up, so a
      // future failure is diagnosable instead of merely annoying: whether the
      // page was controlled by a worker at all, what the worker answered, and
      // what was actually in the cache.
      const DEPLOY_PICKUP_TIMEOUT_MS = 45000;
      await page.reload({ waitUntil: "networkidle0", timeout: 15000 });
      const pickup = await page.evaluate(async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        let polls = 0;
        while (Date.now() < deadline) {
          polls++;
          // Read what the worker has actually stored, rather than what a
          // fetch() happens to be answered with this instant.
          const keys = await caches.keys();
          for (const key of keys) {
            const cache = await caches.open(key);
            const hit = await cache.match("./styles.css");
            if (hit && (await hit.clone().text()).includes("sw-deploy-pickup-probe")) {
              return { ok: true, polls };
            }
          }
          // Keep asking through the worker too — that's what drives the
          // stale-while-revalidate refresh in the first place.
          await fetch("./styles.css");
          await new Promise(r => setTimeout(r, 500));
        }

        // Timed out: gather evidence before giving up.
        const served = await (await fetch("./styles.css")).text();
        const cacheNames = await caches.keys();
        let cachedLen = null;
        for (const key of cacheNames) {
          const hit = await (await caches.open(key)).match("./styles.css");
          if (hit) cachedLen = (await hit.clone().text()).length;
        }
        return {
          ok: false,
          polls,
          controlled: !!navigator.serviceWorker.controller,
          cacheNames,
          servedHasMarker: served.includes("sw-deploy-pickup-probe"),
          servedLength: served.length,
          cachedLength: cachedLen,
        };
      }, DEPLOY_PICKUP_TIMEOUT_MS);
      assert("a deployed change is eventually picked up, not cached forever", pickup.ok === true);
      if (!pickup.ok) console.log("  deploy-pickup diagnostics:", JSON.stringify(pickup));

      // Structural guard, and labelled as such: the assertion above is a
      // real end-to-end smoke check but it CANNOT distinguish the fixed
      // worker from the buggy one in this environment, so it must not be
      // mistaken for a regression test.
      //
      // The cache-forever bug only bites when the cached copy has an old
      // Last-Modified, because Chrome's heuristic freshness is a fraction of
      // the document's age. This test rewrites styles.css to simulate a
      // deploy, which makes its Last-Modified "now", which makes Chrome
      // revalidate anyway -- masking the defect. Verified directly: with the
      // bypass deliberately removed from sw.js, every behavioural variant
      // tried here (two reloads, five reloads, a fresh navigation, reading
      // Cache Storage) still passed. Reproducing it faithfully would need a
      // server that sends production-like caching headers, which is out of
      // proportion for one line.
      //
      // So assert the line itself is present. It is deliberate, load-bearing
      // and easy to "tidy away" while everything still appears to work --
      // exactly the kind of thing worth pinning down explicitly.
      const swSource = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
      assert(
        "the worker's revalidation explicitly bypasses the HTTP cache",
        /fetch\(\s*new Request\([^)]*cache:\s*"no-cache"/.test(swSource)
      );
      assert(
        "the install precache explicitly bypasses the HTTP cache too",
        /new Request\([^)]*cache:\s*"reload"/.test(swSource)
      );
    } finally {
      // Atomic here too — the restore races the same worker, and leaving a
      // truncated styles.css behind would corrupt the working tree.
      writeAtomically(original);
    }

    allErrors.push(...errors);
    await context.close();
  }

  // ── Never interferes with Google Drive / cross-origin requests ───────
  console.log("\n=== Cross-origin requests pass through ===");
  {
    const { context, page, errors } = await newPage(browser);
    await page.goto(BASE + "/", { waitUntil: "networkidle0", timeout: 15000 });
    await new Promise(r => setTimeout(r, SW_SETTLE_MS));

    // The Drive backup is authenticated and one-shot; caching any of it, or
    // replaying a cached response, would be a genuine correctness bug.
    const cachedForeign = await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names[0]);
      const keys = await cache.keys();
      return keys.map(k => new URL(k.url).origin).filter(o => o !== location.origin);
    });
    assert("no cross-origin responses are ever cached", cachedForeign.length === 0);

    allErrors.push(...errors);
    await context.close();
  }

  // ── Home-screen shortcut target ──────────────────────────────────────
  console.log("\n=== Manifest shortcut target (?action=log) ===");
  {
    const { context, page, errors } = await newPage(browser);
    await page.goto(BASE + "/index.html?action=log", { waitUntil: "networkidle0", timeout: 15000 });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS + 500));

    const focused = await page.evaluate(() => document.activeElement?.id);
    assert("the shortcut URL focuses today's jaap input", focused === "today-jaap");

    allErrors.push(...errors);
    await context.close();
  }
  {
    // ...and a normal launch must NOT steal focus into the input, which
    // would pop the keyboard open every time the app is opened.
    const { context, page, errors } = await newPage(browser);
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle0", timeout: 15000 });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS + 500));

    const focused = await page.evaluate(() => document.activeElement?.id);
    assert("a normal launch does not focus the input", focused !== "today-jaap");

    allErrors.push(...errors);
    await context.close();
  }

  // ── Console errors ───────────────────────────────────────────────────
  console.log("\n=== Console errors ===");
  assert("no JS errors across the whole run", allErrors.length === 0);
  if (allErrors.length > 0) console.log("  errors:", allErrors);

  await browser.close();

  console.log("\n" + "─".repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("─".repeat(40));
  process.exit(failed > 0 ? 1 : 0);
})();
