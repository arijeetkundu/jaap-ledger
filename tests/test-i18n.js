// E2E tests for the Hindi/Bangla i18n mechanism: the first-run language
// picker, the Settings drawer switcher, and that switching actually
// re-renders already-visible UI. Word-choice correctness itself was
// reviewed and locked as i18n/translations.json (see CLAUDE.md); these
// tests only exercise the *mechanism* (picker timing, click-to-apply,
// persistence, live re-render), matching this suite's existing split
// between unit tests (test-unit.js, t() itself) and e2e tests (here).
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

// Fresh isolated context per scenario, no appLanguage pre-seeded — mirrors a
// genuinely new install, unlike every other test file's "en"-seeded pages.
async function newFreshPage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  // Orthogonal to the deliberate no-appLanguage-seed above — without this,
  // the Sunday Backup Reminder modal (a real position:fixed, inset:0
  // backdrop, opened unconditionally in initApp() regardless of language
  // choice) would sit just below the language picker's own overlay and
  // become the topmost interactive layer the moment a language is picked,
  // silently swallowing whatever this suite clicks next whenever it
  // actually runs on a Sunday.
  await page.evaluateOnNewDocument(() => {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    localStorage.setItem("lastSundayBackupPromptDate", iso);
  });
  await page.setViewport({ width: 390, height: 844 });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
  await new Promise((r) => setTimeout(r, 2600)); // outlast splash
  return { context, page, errors };
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const allErrors = [];

  // ── First-run picker: shows once, immediate apply, doesn't reappear ──
  console.log("\n=== First-run language picker ===");
  {
    const { context, page, errors } = await newFreshPage(browser);

    const pickerOpen = await page.$eval("#language-picker", (el) => el.classList.contains("open"));
    assert("picker is open on a genuinely fresh install (no language chosen)", pickerOpen);

    const englishPreselected = await page.$eval(
      '#lang-picker-options .lang-option[data-lang="en"]',
      (el) => el.classList.contains("selected")
    );
    assert("English shows pre-selected by default (the effective fallback language)", englishPreselected);

    await page.click('#lang-picker-options .lang-option[data-lang="hi"]');
    await new Promise((r) => setTimeout(r, 300));

    const afterPick = await page.evaluate(() => ({
      pickerOpen: document.getElementById("language-picker").classList.contains("open"),
      storedLang: localStorage.getItem("appLanguage"),
      todayHeading: document.querySelector("#today-card h2")?.textContent,
    }));
    assert("picking a language immediately dismisses the picker (no Continue button)", !afterPick.pickerOpen);
    assert("the choice is persisted to localStorage", afterPick.storedLang === "hi");
    assert("already-rendered UI (Today Card) updates immediately, no reload needed", afterPick.todayHeading.includes("आज"));

    await page.reload({ waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 2600));
    const afterReload = await page.evaluate(() => ({
      pickerOpen: document.getElementById("language-picker").classList.contains("open"),
      todayHeading: document.querySelector("#today-card h2")?.textContent,
    }));
    assert("picker does not reappear on a later load once a language is chosen", !afterReload.pickerOpen);
    assert("the chosen language persists across reload", afterReload.todayHeading.includes("आज"));

    allErrors.push(...errors);
    await context.close();
  }

  // ── Explicitly choosing English also counts as "chosen" ─────────────
  console.log("\n=== Explicit English choice still suppresses the picker ===");
  {
    const { context, page, errors } = await newFreshPage(browser);
    await page.click('#lang-picker-options .lang-option[data-lang="en"]');
    await new Promise((r) => setTimeout(r, 300));

    const storedLang = await page.evaluate(() => localStorage.getItem("appLanguage"));
    assert("choosing English explicitly still writes appLanguage to localStorage", storedLang === "en");

    await page.reload({ waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 2600));
    const pickerOpen = await page.$eval("#language-picker", (el) => el.classList.contains("open"));
    assert("picker stays suppressed on reload after an explicit English choice", !pickerOpen);

    allErrors.push(...errors);
    await context.close();
  }

  // ── Settings drawer switcher ─────────────────────────────────────────
  console.log("\n=== Settings drawer language switcher ===");
  {
    const { context, page, errors } = await newFreshPage(browser);
    // Dismiss the first-run picker via English so it's out of the way.
    await page.click('#lang-picker-options .lang-option[data-lang="en"]');
    await new Promise((r) => setTimeout(r, 300));

    await page.click("#maintenance-toggle");
    await page.waitForSelector("#maintenance-drawer.open");
    await new Promise((r) => setTimeout(r, 300)); // let the drawer's slide-open transition settle

    const enActiveInitially = await page.$eval(
      '#lang-settings-wrap .lang-settings-btn[data-lang="en"]',
      (el) => el.classList.contains("active")
    );
    assert("Settings switcher highlights English as active initially", enActiveInitially);

    await page.click('#lang-settings-wrap .lang-settings-btn[data-lang="bn"]');
    await new Promise((r) => setTimeout(r, 300));

    const afterSwitch = await page.evaluate(() => ({
      storedLang: localStorage.getItem("appLanguage"),
      todayHeading: document.querySelector("#today-card h2")?.textContent,
      settingsHeading: document.querySelector("#maintenance-drawer h3")?.textContent,
      bnActive: document.querySelector('#lang-settings-wrap .lang-settings-btn[data-lang="bn"]').classList.contains("active"),
      enStillActive: document.querySelector('#lang-settings-wrap .lang-settings-btn[data-lang="en"]').classList.contains("active"),
    }));
    assert("switching in Settings persists the new language", afterSwitch.storedLang === "bn");
    assert("switching in Settings re-renders the Today Card behind the drawer", afterSwitch.todayHeading.includes("আজ"));
    assert("switching in Settings updates the drawer's own static heading text live", afterSwitch.settingsHeading.includes("সেটিংস"));
    assert("the Bangla pill becomes active", afterSwitch.bnActive);
    assert("the previously-active English pill is no longer marked active", !afterSwitch.enStillActive);

    // Reload and confirm the Settings-switcher pill state survives it too
    // (previously only the first-run-picker path was reload-tested).
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 2600));
    await page.click("#maintenance-toggle");
    await page.waitForSelector("#maintenance-drawer.open");
    await new Promise((r) => setTimeout(r, 300));
    const afterReload = await page.evaluate(() => ({
      bnActive: document.querySelector('#lang-settings-wrap .lang-settings-btn[data-lang="bn"]').classList.contains("active"),
      bnPressed: document.querySelector('#lang-settings-wrap .lang-settings-btn[data-lang="bn"]').getAttribute("aria-pressed"),
      enActive: document.querySelector('#lang-settings-wrap .lang-settings-btn[data-lang="en"]').classList.contains("active"),
    }));
    assert("the Bangla pill is still active after a reload", afterReload.bnActive);
    assert("aria-pressed reflects the active pill after reload", afterReload.bnPressed === "true");
    assert("the English pill is not active after reload", !afterReload.enActive);

    allErrors.push(...errors);
    await context.close();
  }

  // ── Sankalpa page (open at time of switch) re-renders too ───────────
  console.log("\n=== Switching language re-renders an already-open Sankalpa page ===");
  {
    const { context, page, errors } = await newFreshPage(browser);
    await page.click('#lang-picker-options .lang-option[data-lang="en"]');
    await new Promise((r) => setTimeout(r, 300));

    await page.click("#maintenance-toggle");
    await page.waitForSelector("#maintenance-drawer.open");
    await page.click("#sankalpa-open-btn");
    await new Promise((r) => setTimeout(r, 300));

    const beforeSwitch = await page.$eval("#sankalpa-page h2", (el) => el.textContent);
    assert("Sankalpa heading starts in English", beforeSwitch === "Sankalpa");

    // The Sankalpa page (fullscreen, higher z-index) now visually covers the
    // still-open Settings drawer underneath it, so a real click on the
    // switcher pill would land on the wrong element — call the same
    // applyAppLanguage() a real switcher click invokes instead, to test
    // the re-render behavior without fighting Puppeteer's hit-testing.
    await page.evaluate(() => applyAppLanguage("hi"));
    await new Promise((r) => setTimeout(r, 300));

    const afterSwitch = await page.$eval("#sankalpa-page h2", (el) => el.textContent);
    assert("the already-open Sankalpa page's heading updates without closing/reopening it", afterSwitch === "संकल्प");

    allErrors.push(...errors);
    await context.close();
  }

  // ── translations.json fetch failure degrades to English, not raw keys ──
  console.log("\n=== translations.json fetch failure falls back to English ===");
  {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      const text = msg.text();
      // Everything below is an expected/deliberate consequence of the
      // aborted request this test triggers on purpose — not a bug —
      // mirroring the filtering pattern used elsewhere in this suite
      // (e.g. test-splash-custom.js, test-sunday-backup.js).
      const isExpected =
        text.includes("Failed to load translations.json") ||
        text.includes("Retry failed, falling back to baked-in English") ||
        text.includes("Failed to load resource");
      if (msg.type() === "error" && !isExpected) {
        errors.push(text);
      }
    });

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.url().endsWith("/i18n/translations.json")) {
        req.abort("failed"); // simulate every attempt (including the one retry) failing
      } else {
        req.continue();
      }
    });

    await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
    // Splash (2.6s) + loadTranslations()'s own ~500ms retry delay.
    await new Promise((r) => setTimeout(r, 3300));

    const result = await page.evaluate(() => ({
      translationsIsEmpty: TRANSLATIONS && Object.keys(TRANSLATIONS).length === 0,
      settingsHeading: document.querySelector('#maintenance-drawer h3[data-i18n="settingsHeading"]')?.textContent,
      todayHeading: document.querySelector("#today-card h2")?.textContent,
      pickerTitle: document.querySelector("#lang-picker-title")?.textContent,
    }));
    assert("TRANSLATIONS ends up empty after both fetch attempts fail", result.translationsIsEmpty);
    assert("static Settings heading stays readable English, not the raw key", result.settingsHeading === "Settings");
    // Honest, non-tautological assertion of the documented residual risk:
    // dynamic sections (rebuilt from scratch every render, no prior DOM to
    // preserve) DO show the raw key while TRANSLATIONS is genuinely empty —
    // this locks in that known, accepted behavior rather than a vacuous
    // truthy check that would also pass if this regressed to showing blank
    // or some other placeholder.
    assert("the dynamic Today Card heading shows the raw key while translations are unavailable (documented residual risk)", result.todayHeading === "todayHeading");
    assert("the language picker's own title stays readable English", result.pickerTitle === "Select Language");

    allErrors.push(...errors);
    await context.close();
  }

  // ── translations.json recovers once reachable again (background retry) ──
  console.log("\n=== translations.json background retry recovers once reachable again ===");
  {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      const text = msg.text();
      const isExpected =
        text.includes("Failed to load translations.json") ||
        text.includes("Retry failed") ||
        text.includes("Failed to load resource");
      if (msg.type() === "error" && !isExpected) {
        errors.push(text);
      }
    });

    let shouldFail = true;
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.url().endsWith("/i18n/translations.json") && shouldFail) {
        req.abort("failed");
      } else {
        req.continue();
      }
    });

    await page.goto(BASE, { waitUntil: "networkidle0", timeout: 15000 });
    // Outlast the splash + loadTranslations()'s own immediate retry — both
    // attempts fail, so the background retry loop (every 5s) takes over.
    await new Promise((r) => setTimeout(r, 3300));

    const beforeRecovery = await page.evaluate(() => document.querySelector("#today-card h2")?.textContent);
    assert("before recovery, the dynamic heading shows the raw key (sanity check on this test's setup)", beforeRecovery === "todayHeading");

    // Let the file "become reachable" again, then wait for the background
    // retry's ~5s interval to fire and pick it up.
    shouldFail = false;
    await new Promise((r) => setTimeout(r, 6000));

    const afterRecovery = await page.evaluate(() => ({
      translationsPopulated: !!TRANSLATIONS && Object.keys(TRANSLATIONS).length > 0,
      todayHeading: document.querySelector("#today-card h2")?.textContent,
    }));
    assert("the background retry eventually repopulates TRANSLATIONS once the file is reachable again", afterRecovery.translationsPopulated);
    assert("the dynamic Today Card heading self-corrects to real English without a reload", afterRecovery.todayHeading === "Today");

    allErrors.push(...errors);
    await context.close();
  }

  console.log("\n=== Console errors ===");
  assert("no JS errors across the whole run", allErrors.length === 0);
  if (allErrors.length > 0) console.log("  errors:", allErrors);

  await browser.close();

  console.log("\n" + "─".repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("─".repeat(40));
  process.exit(failed > 0 ? 1 : 0);
})();
