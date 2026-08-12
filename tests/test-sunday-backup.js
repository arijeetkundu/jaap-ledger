// Tests for the Sunday Backup Reminder (Google Drive): the once-per-Sunday
// modal, its three dismiss paths, the on-demand Settings button, and the
// upload flow's success/failure handling. Real Google sign-in can't run in
// a headless suite, so `window.google` and `fetch` are stubbed — the pure
// request-building/predicate logic (buildDriveUploadRequest,
// shouldShowSundayBackupReminder) is covered directly in test-unit.js
// instead, since neither needs any of this DOM/network machinery.
//
// Run with the app already being served (e.g. `python -m http.server 3333`).

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

// Freezes `new Date()` (no-arg construction) to the given ISO instant, while
// leaving explicit-argument construction (new Date(y, m, d), used all over
// app.js's own date math) working normally — installed before navigation so
// getTodayISO()'s `new Date()` call sees the mocked "now".
async function mockPageDate(page, isoInstant) {
  await page.evaluateOnNewDocument((fixedISO) => {
    const RealDate = Date;
    class MockDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) {
          return new RealDate(fixedISO);
        }
        return new RealDate(...args);
      }
      static now() {
        return new RealDate(fixedISO).getTime();
      }
    }
    window.Date = MockDate;
  }, isoInstant);
}

// Stubs window.google's token client and window.fetch so the upload flow
// can be driven end-to-end without any real network/Google dependency.
// Controlled at runtime via window.__mockTokenShouldFail / __mockFetchShouldFail.
async function mockGoogleDriveApis(page) {
  await page.evaluateOnNewDocument(() => {
    window.__fetchCalls = [];
    window.__mockTokenShouldFail = false;
    window.__mockFetchShouldFail = false;
    window.__mockExistingFile = null;

    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: (config) => ({
            requestAccessToken: () => {
              setTimeout(() => {
                if (window.__mockTokenShouldFail) {
                  config.error_callback && config.error_callback({ type: "popup_closed" });
                } else {
                  config.callback({ access_token: "mock-access-token" });
                }
              }, 5);
            },
          }),
        },
      },
    };

    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      // Only intercept Google/Drive calls — everything else (notably this
      // app's own same-origin i18n/translations.json load) must reach the
      // real network, or TRANSLATIONS ends up populated with mock Drive
      // JSON instead of the actual dictionary.
      if (!String(url).includes("googleapis.com")) {
        return realFetch(url, opts);
      }

      const method = (opts && opts.method) || "GET";
      // Body is captured too so tests can assert what actually gets uploaded
      // to Drive, not merely that a request was made.
      window.__fetchCalls.push({ url: String(url), method, body: opts && typeof opts.body === "string" ? opts.body : null });

      if (window.__mockFetchShouldFail) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (String(url).includes("/drive/v3/files?q=")) {
        return {
          ok: true,
          json: async () => ({
            files: window.__mockExistingFile ? [{ id: window.__mockExistingFile, name: "sumiran-lite-backup.json" }] : [],
          }),
        };
      }
      return { ok: true, json: async () => ({ id: "new-file-id" }) };
    };
  });
}

async function newMockedPage(browser, { dateISO, mockGoogle = true }) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const errors = [];
  page.on("pageerror", err => errors.push(err.message));
  page.on("console", msg => {
    // "Google Drive backup failed" is app.js's own console.error for a
    // deliberately-simulated failure (the failure-path tests below trigger
    // this on purpose) — expected output, not a bug.
    if (msg.type() === "error" && !msg.text().includes("Google Drive backup failed")) {
      errors.push(msg.text());
    }
  });
  await mockPageDate(page, `${dateISO}T10:00:00`);
  if (mockGoogle) await mockGoogleDriveApis(page);
  // Pre-seed a chosen language (persists across reload, like the Date/Google
  // mocks above) so the first-run language picker never appears on top of
  // — and steals clicks from — the Sunday Backup modal under test here.
  await page.evaluateOnNewDocument(() => localStorage.setItem("appLanguage", "en"));
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await page.evaluate(() => localStorage.clear());
  return { context, page, errors };
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const allErrors = [];

  // ── Modal visibility: Sunday vs. non-Sunday, once-per-day ────────────
  console.log("\n=== Modal appears only on Sunday, once per day ===");
  {
    const { context, page, errors } = await newMockedPage(browser, { dateISO: "2026-08-09" }); // a Sunday
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
    const isOpenOnSunday = await page.evaluate(() =>
      document.getElementById("sunday-backup-modal").classList.contains("open")
    );
    assert("modal opens automatically on a fresh Sunday", isOpenOnSunday);
    allErrors.push(...errors);
    await context.close();
  }
  {
    const { context, page, errors } = await newMockedPage(browser, { dateISO: "2026-08-10" }); // a Monday
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
    const isOpenOnMonday = await page.evaluate(() =>
      document.getElementById("sunday-backup-modal").classList.contains("open")
    );
    assert("modal does not appear on a non-Sunday", !isOpenOnMonday);
    allErrors.push(...errors);
    await context.close();
  }

  // ── Dismiss paths: ✕, "Remind me next Sunday", backdrop click ───────
  console.log("\n=== Dismiss paths all suppress the modal for the rest of that Sunday ===");
  const dismissCases = [
    { label: "✕ close button", click: page => page.click("#sunday-backup-close-btn") },
    { label: "\"Remind me next Sunday\"", click: page => page.click("#sunday-backup-dismiss-btn") },
    { label: "backdrop click", click: page => page.click("#sunday-backup-modal", { offset: { x: 5, y: 5 } }) },
  ];
  for (const { label, click } of dismissCases) {
    const { context, page, errors } = await newMockedPage(browser, { dateISO: "2026-08-09" });
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
    await click(page);
    await new Promise(r => setTimeout(r, 300));
    const closedAfterDismiss = await page.evaluate(() =>
      !document.getElementById("sunday-backup-modal").classList.contains("open")
    );
    assert(`${label} closes the modal`, closedAfterDismiss);

    await page.reload({ waitUntil: "networkidle0" });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
    const staysClosedSameSunday = await page.evaluate(() =>
      !document.getElementById("sunday-backup-modal").classList.contains("open")
    );
    assert(`${label}: modal does not reappear later the same Sunday`, staysClosedSameSunday);

    // The whole reason lastDriveBackupAt exists as a separate key: dismissing
    // the prompt marks it *handled* for the day, but nothing was actually
    // backed up. lastSundayBackupPromptDate alone can't tell those apart, so
    // it must never be mistaken for evidence of a backup.
    const dismissRecordedNoBackup = await page.evaluate(() =>
      localStorage.getItem("lastDriveBackupAt") === null &&
      localStorage.getItem("lastSundayBackupPromptDate") !== null
    );
    assert(`${label}: dismissing marks the prompt handled but records no backup`, dismissRecordedNoBackup);

    const statusStillSaysNever = await page.evaluate(() =>
      document.getElementById("drive-backup-status")?.textContent || ""
    );
    assert(`${label}: the Settings status line still reports no backup`, statusStillSaysNever.includes("Not yet backed up"));

    allErrors.push(...errors);
    await context.close();
  }

  // ── Reappears on the next Sunday ─────────────────────────────────────
  console.log("\n=== Modal reappears on the next Sunday ===");
  {
    const { context, page, errors } = await newMockedPage(browser, { dateISO: "2026-08-09" });
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
    await page.click("#sunday-backup-dismiss-btn");
    await new Promise(r => setTimeout(r, 300));

    // Jump to the following Sunday without clearing localStorage.
    await mockPageDate(page, "2026-08-16T10:00:00");
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
    const reopensNextSunday = await page.evaluate(() =>
      document.getElementById("sunday-backup-modal").classList.contains("open")
    );
    assert("modal reopens on the following Sunday despite last week's dismissal", reopensNextSunday);
    allErrors.push(...errors);
    await context.close();
  }

  // ── Successful backup: modal button and on-demand Settings button ───
  console.log("\n=== Successful backup (mocked Google + Drive) ===");
  {
    const { context, page, errors } = await newMockedPage(browser, { dateISO: "2026-08-09" });
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
    await page.click("#sunday-backup-primary-btn");
    await new Promise(r => setTimeout(r, 500));

    const result = await page.evaluate(() => ({
      toastVisible: !!document.querySelector(".toast.toast-visible"),
      toastText: document.getElementById("toast")?.textContent || "",
      modalOpen: document.getElementById("sunday-backup-modal").classList.contains("open"),
      handled: localStorage.getItem("lastSundayBackupPromptDate") === "2026-08-09",
      lastBackupAt: localStorage.getItem("lastDriveBackupAt"),
      statusLine: document.getElementById("drive-backup-status")?.textContent || "",
      fetchCalls: window.__fetchCalls.map(c => c.method + " " + c.url),
    }));
    assert("a successful backup shows a confirmation toast", result.toastVisible && result.toastText.toLowerCase().includes("drive"));
    assert("a successful backup closes the modal", !result.modalOpen);
    assert("a successful backup marks today as handled", result.handled);
    assert("a successful backup records a real timestamp", !!result.lastBackupAt && !isNaN(Date.parse(result.lastBackupAt)));
    assert("the Settings status line updates immediately after a successful backup", result.statusLine.includes("today"));
    assert("upload flow searched for an existing file before uploading", result.fetchCalls.some(c => c.startsWith("GET") && c.includes("/drive/v3/files?q=")));
    assert("upload flow created the file (none existed) via multipart POST", result.fetchCalls.some(c => c.startsWith("POST") && c.includes("uploadType=multipart")));

    // What actually goes to Drive matters more than that a request happened:
    // the uploaded payload must be the versioned object carrying the
    // Sankalpa, not the old bare entries array.
    const uploadedBody = await page.evaluate(() => {
      const call = window.__fetchCalls.find(c => c.method === "POST" && c.url.includes("uploadType=multipart"));
      return call ? call.body : null;
    });
    assert("the uploaded Drive payload is the versioned object format", !!uploadedBody && uploadedBody.includes('"version"'));
    assert("the uploaded Drive payload includes a sankalpa field", !!uploadedBody && uploadedBody.includes('"sankalpa"'));

    allErrors.push(...errors);
    await context.close();
  }
  {
    // On-demand Settings button, on a non-Sunday — should still work.
    const { context, page, errors } = await newMockedPage(browser, { dateISO: "2026-08-10" });
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
    await page.click("#maintenance-toggle");
    await page.waitForSelector("#maintenance-drawer.open");
    await new Promise(r => setTimeout(r, 400));
    await page.click("#drive-backup-btn");
    await new Promise(r => setTimeout(r, 500));

    const toastText = await page.evaluate(() => document.getElementById("toast")?.textContent || "");
    assert("the on-demand Settings button triggers a backup outside of Sunday", toastText.toLowerCase().includes("drive"));
    allErrors.push(...errors);
    await context.close();
  }

  // ── Failure paths: cancelled sign-in, failed upload ──────────────────
  console.log("\n=== Failure paths surface a toast and don't mark the reminder handled ===");
  {
    const { context, page, errors } = await newMockedPage(browser, { dateISO: "2026-08-09" });
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
    // Set after the reload — evaluateOnNewDocument's setup script re-runs
    // (and resets this flag to false) on every navigation, so it has to be
    // flipped in the current, already-loaded document, not before reloading.
    await page.evaluate(() => { window.__mockTokenShouldFail = true; });
    await page.click("#sunday-backup-primary-btn");
    await new Promise(r => setTimeout(r, 500));

    const result = await page.evaluate(() => ({
      toastVisible: !!document.querySelector(".toast.toast-visible"),
      handled: localStorage.getItem("lastSundayBackupPromptDate") === "2026-08-09",
    }));
    assert("a cancelled Google sign-in shows a failure toast", result.toastVisible);
    assert("a cancelled sign-in does not mark the reminder handled", !result.handled);
    allErrors.push(...errors);
    await context.close();
  }
  {
    const { context, page, errors } = await newMockedPage(browser, { dateISO: "2026-08-09" });
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise(r => setTimeout(r, SPLASH_WAIT_MS));
    await page.evaluate(() => { window.__mockFetchShouldFail = true; });
    await page.click("#sunday-backup-primary-btn");
    await new Promise(r => setTimeout(r, 500));

    const result = await page.evaluate(() => ({
      toastVisible: !!document.querySelector(".toast.toast-visible"),
      handled: localStorage.getItem("lastSundayBackupPromptDate") === "2026-08-09",
    }));
    assert("a failed Drive API call shows a failure toast", result.toastVisible);
    assert("a failed upload does not mark the reminder handled", !result.handled);
    allErrors.push(...errors);
    await context.close();
  }

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
