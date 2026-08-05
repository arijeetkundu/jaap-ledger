# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sumiran Lite is an offline-first Progressive Web App for logging daily "jaap" (mantra repetition count). Single-page vanilla JavaScript, no framework, no build step — `index.html`, `app.js`, `styles.css` are served as static files as-is. Live at https://arijeetkundu.github.io/jaap-ledger/, deployed via GitHub Pages from the `main` branch root.

## Commands

```bash
# Run locally (serve over HTTP — IndexedDB/PWA installability are unreliable on file://)
python -m http.server 3333
# open http://localhost:3333

# Test on a phone on the same Wi-Fi: http://<LAN-IP>:3333 (different origin from localhost — no shared IndexedDB/localStorage)

# Install test tooling
npm install

# Run the full test suite (requires the server above running in another terminal)
npm test

# Run a single suite
node tests/test.js              # structural smoke tests
node tests/test-unit.js         # pure-logic unit tests
node tests/test-e2e.js          # full user-flow E2E tests
node tests/test-redesign.js     # design tokens, milestone celebration, motion
node tests/test-splash-custom.js # custom splash image upload/rotation/delete
```

There is no build step, linter, or CI pipeline — `npm test` must be run locally before pushing. 184 assertions across the 5 suites as of this writing.

## Architecture

**No modules.** All functions in `app.js` are top-level, global, and hoisted — execution order in the file matters (later code assumes earlier functions/constants already exist). There's no import/export boundary; naming collisions are prevented only by convention.

**Two-tier storage, strictly separated by purpose:**
- **IndexedDB** (`jaap-ledger-db`, `DB_VERSION` in `app.js`) holds practice data only, across 4 object stores: `ledger` (live entries), `ledger-backups` (latest auto-backup, overwritten each save), `meta` (currently unused — was a one-time data.json seeding guard, now dead schema kept per the never-destroy-stores rule below), `sankalpa` (single vow record). The upgrade handler is additive-only — bump `DB_VERSION` and add a store only if needed; never destroy existing stores.
- **localStorage** holds display preferences and device-local assets only, never practice data: `malaViewEnabled`, `backgroundChoice`, `lastSplashImage`, `splashImage:custom0`..`custom3`. Export/Import and the automatic backup cover the IndexedDB ledger only — localStorage content is deliberately excluded and never round-trips through backup/restore.

**Splash screen rotation runs synchronously before first paint.** A `chooseSplashImage()` IIFE at the top of `app.js` resolves the image pool and sets `#splash-img`/`#splash-source` before the async `initApp()` bootstrap even starts. Hanuman (`splash/hanuman-splash.*`) is a fixed constant, always in the pool, never stored, never replaceable. Up to 4 additional slots are user-uploaded photos; a slot's filled/empty state is simply whether `localStorage["splashImage:customN"]` holds a valid `data:image/` URL — there's no separate metadata array. Never repeats the immediately-preceding image (tracked via `lastSplashImage`).

**The `<picture>` `<source>`-vs-`<img>` trap:** `#splash-screen` uses `<picture><source srcset="...webp"><img src="...png"></picture>`. A `<source srcset>` wins over `<img src>` — when showing a custom (data URL) image, `source.removeAttribute("srcset")` must be called explicitly or the bundled webp silently keeps showing.

**Upload pipeline (`processSplashImage` in `app.js`) is client-side only**, tuned for two distinct constraints, not one: stored size (target ~100–150KB via downscale-then-encode, so storage is unaffected by input size) vs. decode-time RAM (a 5MB cap and a ~40 megapixel guard, since a browser must materialize a full raw bitmap before it can downscale — file size alone is an imperfect proxy for that). Prefers `createImageBitmap(file, {resizeWidth, resizeQuality})` to downsample during decode; falls back to a plain `<img>` decode guarded by the megapixel check.

**Bootstrap sequence** (`initApp()`, async IIFE in `app.js`): request persistent storage (best-effort) → `loadLedgerFromDB()` (live store → latest backup → empty array, never seeded from `data.json` — that file is a local-testing fixture only, deliberately never auto-loaded into a real user's ledger) → `ensureRecentEntriesExist(7)` backfills null placeholders for the last 7 days → persist + fresh backup → `renderToday()`. `renderToday()` is the single entry point that re-renders Today Card + Reflection Summary + Ledger List; call it after every mutation rather than patching the DOM piecemeal. Poornima detection is entirely keyword-based (`hasExplicitPoornima()`) — a previous static-calendar fallback (`poornima.json`) was dead code (its only caller was unreachable) and has been removed.

**7-day editable window** is enforced via `isEditableEntry()` / `isWithinLastNDays()`, checked independently in two places (`app.js`) — keep both in sync when touching this logic, there's no shared constant.

**Mala View is a presentation-layer toggle only** (`computeJaapFromInput()` handles the conversion both ways) — it never mutates stored jaap values. Exports always emit raw jaap regardless of the toggle. Watch the precision guard: if a user leaves a pre-filled floored mala value unchanged but the original stored jaap wasn't an exact multiple of 108 (a legacy fractional entry), the original is preserved exactly rather than being recomputed and silently truncated.

**CSS design tokens** live as custom properties on `:root` in `styles.css` (`--maroon`, `--gold`, `--gold-hairline`, `--cream`, `--surface`, `--font-heading`, `--ease-premium`, etc. — the "Temple Gold & Maroon" theme). New themed UI should draw from these tokens rather than hardcoding colors.

**Background themes** (Alpana/Mandala/Jharokha) render on a dedicated fixed `#app-background` element via `body.bg-*` classes — not `background-attachment: fixed` on `body`, which iOS Safari has historically degraded. The splash screen deliberately never applies the chosen background theme; it always uses its own dedicated backdrop.

## Testing conventions (see existing `tests/*.js` before adding new assertions)

- Puppeteer-driven, run against a real served instance — no mocking of the DOM or storage.
- Fixed phone viewport (390×844) is set explicitly in `test-e2e.js`; Puppeteer's 800×600 default breaks viewport-relative layout assertions (e.g. the splash frame).
- Tests needing deterministic image selection mock `Math.random` via `page.evaluateOnNewDocument` in an isolated `browser.createBrowserContext()`, so the override and localStorage state never leak into other sections sharing the main page.
- `confirm()`/`alert()` dialogs are auto-accepted via `page.on("dialog", ...)` for flows that need it (import, restore, Sankalpa rewrite).
- File uploads use `elementHandle.uploadFile(tmpPath)` against the real (hidden) `<input type="file">`, with fixture images generated at test time via `sharp` (a devDependency, also used for asset prep).
- Top-level `function`/`let` declarations in `app.js` are reachable from `page.evaluate()` even though it's a classic (non-module) script — tests call app.js internals directly (e.g. `pendingSplashSlot`, milestone/formatting functions) rather than only driving the UI.

## Workflow expectations (from project history)

- `data.json` is a local-testing fixture only — the app never fetches or auto-loads it into a real user's ledger (a fresh/empty ledger always starts blank). It also carries an intentional local modification on this machine that must never be staged or committed — always exclude it explicitly (`git add <specific files>`, never `git add -A`/`.`).
- Every feature/fix goes on its own branch; run the full `npm test` suite before considering work done; the user manually verifies on their installed PWA (Safari → Add to Home Screen) before anything merges to `main`; pushes to GitHub only happen on the user's explicit instruction, never automatically.
- The two `.docx` deliverables (`Sumiran-Lite-Technical-Documentation.docx`, `Sumiran-Lite-User-Guide.docx`) cannot be hand-edited as text — they're zip-packaged XML. Regenerate them with a `python-docx` script that opens the existing file as a template, clears the body, and rebuilds content, so theme/fonts/styles are preserved.
