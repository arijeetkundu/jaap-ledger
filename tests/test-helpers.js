// Shared test setup.
//
// Deliberately the ONLY shared module across the suites — each suite is
// otherwise standalone, and that is worth keeping. What justifies an
// exception here is that the setup below is a cross-cutting *correctness*
// requirement rather than convenience: every browser context in every suite
// needs it, and a context that silently omits it produces a test run whose
// result depends on the day of the week.
//
// That is not hypothetical. Two contexts had drifted without it — the
// isolated `strandPage` in test-e2e.js and the whole of test-unit.js — and
// the suite failed on a Sunday and only on a Sunday, having passed every day
// it was actually run before that.

/**
 * Seed the localStorage state every browser context needs before the app
 * boots. Must be called on a fresh page BEFORE the first navigation, since
 * it installs an evaluateOnNewDocument hook.
 *
 * @param {import("puppeteer").Page} page
 * @param {{ lang?: string|null }} [options]
 *   lang — language to pre-seed, or null to leave unset (test-i18n.js
 *   deliberately does not seed one, so it can exercise the first-run picker).
 */
async function seedAppState(page, options = {}) {
  const lang = "lang" in options ? options.lang : "en";

  if (lang !== null) {
    await page.evaluateOnNewDocument((l) => {
      try { localStorage.setItem("appLanguage", l); } catch { /* hostile storage tests */ }
    }, lang);
  }

  // Mark today's Sunday Backup Reminder as already handled.
  //
  // The modal is a real position:fixed, inset:0 backdrop at z-index 9800. On
  // a Sunday it opens over the whole app and silently swallows any click
  // meant for something underneath — #maintenance-toggle in particular — so
  // without this a suite passes six days a week and fails on the seventh,
  // with a timeout that points at the element it *couldn't* reach rather than
  // at the modal that was covering it.
  //
  // The date is computed from local time, matching how the app derives its
  // own "today" (getTodayISO), not from toISOString() which is UTC and would
  // seed the wrong day either side of midnight.
  await page.evaluateOnNewDocument(() => {
    try {
      const today = new Date();
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      localStorage.setItem("lastSundayBackupPromptDate", iso);
    } catch { /* hostile storage tests */ }
  });
}

module.exports = { seedAppState };
