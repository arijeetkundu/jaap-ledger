# Sumiran Lite

Sumiran Lite is an offline-first Progressive Web App (PWA) for logging daily "jaap" (mantra repetition count) as part of a personal spiritual practice. It's a single-page vanilla JavaScript app with no framework and no build step — it runs directly from static files served over HTTP, styled in a "Temple Gold & Maroon" visual theme with self-hosted Playfair Display (headings) and Inter (body/UI) fonts.

Live app: https://arijeetkundu.github.io/jaap-ledger/

## Features

- **Daily ledger** — log a jaap (or mala) count and notes for each day, editable within a 7-day window.
- **Lifetime & yearly totals**, with progress toward "Crore" (10,000,000 jaap) milestones and pace-based completion predictions.
- **Milestone celebration** — crossing a new Crore triggers a page-wide falling-petal animation.
- **Mala View** — toggle the whole app between raw jaap counts and mala (108-count) units.
- **Ledger row sparklines** — a rolling 7-day trend line per row.
- **Notes search** — find past entries by what you wrote in them, across every year.
- **On this day** — the Today Card quietly recalls what you logged on this same date in an earlier year.
- **Sankalpa** — a single, persistent record of your vow of intent.
- **Poornima (full moon) detection** from notes keywords.
- **Automatic backups** plus manual JSON import/export, covering your ledger **and your Sankalpa** (splash images and display preferences are device-local and not included). Exports made by earlier versions still import.
- **Google Drive backup** — a once-per-Sunday reminder modal (plus an on-demand button in Settings) backs up the ledger to your own Google Drive as `sumiran-lite-backup.json`, overwritten in place on each backup (no duplicates). Each user signs into their own Google account; nothing is shared with anyone else. See [Google Drive backup setup](#google-drive-backup-setup) below.
- **Installable PWA that genuinely works offline** — a service worker caches the app shell, so it launches with no network at all; add it to your home screen for a framed, gold-bordered splash screen and an adaptive (maskable) icon. On Android/Chrome, long-pressing the icon also offers a "Log Today's Jaap" shortcut; iOS ignores manifest shortcuts entirely, but the same destination (`index.html?action=log`) can be added to the Home Screen as its own icon.
- **Background themes** — switch the app's tiled/full-bleed background between Alpana, Mandala (default), and Jharokha from Settings.
- **Text size** — Small / Medium / Large from Settings, scaling the whole app. Useful inside an installed PWA, where there's no browser chrome to zoom with. Your own notes, Sankalpa and totals are also selectable, so they can be copied out.
- **Digital Mala Mode** — a full-screen, distraction-free bead counter for sitting practice, opened from the 📿 button. Tap anywhere to count a bead; at 108 the mala completes and is banked straight into today's entry, added to whatever is already there rather than replacing it. The count shown is the day's, so leaving and returning never resets it, and an interruption can cost at most one unfinished mala. Includes an undo for mis-taps, and keeps the screen awake.
- **Customizable splash screen** — Hanuman is a fixed default image; up to 4 additional slots let you add your own pictures, which then rotate alongside Hanuman (never repeating the same image twice in a row). Uploads are validated, downscaled, and compressed client-side, so storage and startup performance stay unaffected by the original photo's size. The picture hangs in a gold frame on the cream wall of a painted arch, resting there about four seconds before dissolving into the ledger — or tap anywhere to continue straight away.
- **Hindi and Bangla support** — a first-run language picker (also reachable anytime from Settings) switches the whole app's text between English, Hindi (हिन्दी), and Bangla (বাংলা). Ledger dates stay in English everywhere for consistency; only the Today Card's long-form date (weekday + month name) translates. See [Localization (i18n)](#localization-i18n) below.
- **Sync across devices** — sign in with Google from Settings and your ledger follows you: saving on one device uploads it, and opening the app on another brings it down. Your practice is stored under your own account, readable by nobody else. Entirely opt-in — until you sign in, nothing leaves the device and the app makes no network requests at all. See [Sync across devices](#sync-across-devices) below.

All practice data lives in the browser's IndexedDB, which remains the source of truth on every device. Nothing is sent anywhere unless you turn on Google Drive backup or Sync — both opt-in, both to your own Google account.

## Tech stack

| Layer | Technology |
|---|---|
| Markup | Static HTML5 (`index.html`) |
| Styling | Plain CSS (`styles.css`) |
| Logic | Vanilla JavaScript (`app.js`), no frameworks or bundler |
| Storage | IndexedDB (practice data, backups, Sankalpa) + localStorage (display preferences only) |
| Sync (opt-in) | Firebase Auth + Cloud Firestore (lite build), loaded on demand from the Google CDN — never on a normal launch |
| PWA shell | `manifest.json` + `icons/` + `sw.js` (offline shell cache) |
| Localization | `i18n/translations.json` (English/Hindi/Bangla dictionary) + a `t()` lookup layer in `app.js` |
| Testing | Puppeteer-driven structural, unit, E2E, redesign, custom-splash-image, Mala Mode, Sunday-backup, i18n, and service-worker tests (`tests/`), run via `npm test` |
| Hosting | GitHub Pages (static) |

## Project structure

```
jaap-ledger/
├── index.html                          Page shell; all containers filled by app.js
├── app.js                              All application logic
├── styles.css                          All styling (Temple Gold & Maroon design tokens)
├── data.json                           Local-testing fixture only — never loaded into a real user's ledger
├── manifest.json                       PWA manifest (icons incl. maskable, home-screen shortcut)
├── sw.js                               Service worker — offline shell cache
├── fonts/                              Self-hosted Playfair Display + Inter (variable .woff2, no CDN)
├── i18n/
│   └── translations.json               English/Hindi/Bangla dictionary, fetched once at bootstrap
├── splash/
│   ├── hanuman-splash.png/.webp        Fixed default splash image (locked, never replaceable)
│   ├── splash-background.webp          Splash backdrop: an ornate arch with a plain cream panel
│   │                                   the splash image hangs on, framed in gold
│   └── launch-neutral.png              Unused spare asset (kept for possible future use)
├── icons/                              App icons (192x192, 512x512) + bg-alpana/bg-mandala/bg-jharokha.webp tile assets
│                                       + bg-mala-mode.jpeg (Mala Mode's arch-niche backdrop)
├── tests/
│   ├── test.js                         Puppeteer structural smoke tests
│   ├── test-unit.js                    Puppeteer-driven unit tests for pure logic functions
│   ├── test-e2e.js                     Puppeteer full user-flow E2E tests
│   ├── test-redesign.js                Premium redesign: design tokens, milestone celebration, motion
│   ├── test-splash-custom.js           Custom splash images: upload pipeline, guards, rotation, deletes
│   ├── test-mala-mode.js               Mala Mode: counting, additive commits, draft safety, backup compatibility
│   ├── test-helpers.js                 Shared browser-context setup (the only module the suites share)
│   ├── test-sunday-backup.js           Sunday backup modal + Google Drive backup flow (mocked network)
│   ├── test-i18n.js                    Language picker, Settings switcher, translations-load-failure fallback
│   └── test-service-worker.js          Offline launch, precache contents, deploy pickup, shortcut target
├── package.json                        devDependencies: puppeteer, sharp; "test" script runs all 9 suites
└── package-lock.json
```

## Running locally

Serve the app over HTTP rather than opening `index.html` directly via a `file://` URL — IndexedDB and PWA installability are unreliable on the `file://` origin in most browsers.

```
python -m http.server 3333
# open http://localhost:3333
```

To test on a phone on the same Wi-Fi network, open `http://<your-machine's-LAN-IP>:3333` from the phone's browser.

## Testing

```
npm install
python -m http.server 3333   # in one terminal
npm test                     # in another
```

`npm test` runs the full suite (577 assertions, as of this revision) against a running instance of the app: `tests/test.js` (structural smoke tests), `tests/test-unit.js` (pure-logic unit tests, calling app.js's global functions directly — including the `t()` lookup/fallback/interpolation logic and a dictionary-integrity check), `tests/test-e2e.js` (full user-flow E2E tests — Sankalpa, Import/Export, Restore from Backup, Background themes, and more), `tests/test-redesign.js` (premium redesign: design tokens, milestone celebration, splash entrance animation, motion polish), `tests/test-splash-custom.js` (custom splash images: upload pipeline guards, adaptive frame, rotation, per-slot/remove-all deletes, corrupt-data resilience), `tests/test-mala-mode.js` (Mala Mode: bead counting and the 108th-bead commit, undo, additive saves that never overwrite an existing entry, clearing a stale Today Card draft, a failed write keeping the counted beads, a sitting spanning midnight, and a regression guard that pre-Mala-Mode backups still import and exports gain no new fields), `tests/test-sunday-backup.js` (Sunday backup modal timing/dismiss paths, and the Google sign-in + Drive upload flow with the network mocked — real Google sign-in can't run headless, so the actual OAuth/Drive calls are verified manually instead, see below), `tests/test-i18n.js` (the first-run language picker, the Settings switcher, live re-rendering on language change, and a simulated `translations.json` fetch failure to confirm the app degrades to readable English rather than raw dictionary keys), and `tests/test-service-worker.js` (registration and scope, what gets precached, a genuinely offline launch, and a simulated deploy to prove users aren't pinned to a stale cached build). Each file can also be run individually, e.g. `node tests/test-unit.js`.

The sync assertions live inside `tests/test-e2e.js`. Firebase is stubbed rather than reached, so the suite runs with no internet and never writes to the real project — what's under test is this app's own logic: that a launch stays free of network requests, that the sign-in popup opens synchronously with the tap, that a save uploads and an open downloads, that an unchanged pull stays silent even though Firestore reorders a document's keys, that a save made offline is uploaded before the next pull rather than overwritten, and that the ledger a pull replaces is snapshotted first.

## Google Drive backup setup

The Sunday reminder modal and the Settings "Back Up to Google Drive" button both need a Google OAuth Client ID before they can sign a user in. The app ships with this wired up for the live site, but if you fork/redeploy it elsewhere, you'll need your own:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or reuse one) and enable the **Google Drive API**.
2. Under **Google Auth Platform**, configure the consent screen: App name, support email, **External** audience, and a developer contact email. Leave **Publishing status** as **Testing** unless you intend to submit for Google verification.
3. Under **Google Auth Platform → Audience → Test users**, add the Gmail address of every person who should be able to sign in — Google blocks sign-in for anyone not on this list while the app is in Testing status.
4. Under **Google Auth Platform → Clients**, create an OAuth client of type **Web application**, and add your deployed origin(s) as **Authorized JavaScript origins** (e.g. `https://arijeetkundu.github.io` and `http://localhost:3333` for local testing). No redirect URI is needed.
5. Copy the resulting **Client ID** (a public value, not a secret) into `GOOGLE_DRIVE_CLIENT_ID` near the top of the "Google Drive Backup" section in `app.js`.

The app only ever requests the `drive.file` scope — it can see and manage only the files it creates itself (`sumiran-lite-backup.json`), never the rest of a user's Drive.

## Sync across devices

Opt-in, and dormant until used: sign in with Google from **Settings → Sync across devices**. A save uploads the ledger; opening the app downloads it. That is the whole model.

- **Where it lives.** One document per sadhak, at `users/{uid}/ledger/current`, holding exactly the payload the Export button and the Drive backup already produce (`{ version: 2, entries, sankalpa }`). That reuse means a synced ledger is read and validated by the same code that vets an imported file. Entries are a few dozen bytes each — a decade of daily practice is well inside Firestore's 1MB document limit.
- **When it runs.** Pull on sign-in, on launch when a session already exists, and on returning to the foreground (the case that matters most, since an installed PWA is resumed far more often than started). Push whenever a save commits.
- **Offline.** IndexedDB remains the source of truth, so saving with no network works exactly as it always did. A push that can't reach the network is remembered, and the next open uploads it *before* pulling, so practice logged offline isn't overwritten.
- **The first device seeds the store.** Whichever device signs in first uploads its ledger; every later device pulls that down, replacing what it had. If you're setting up a second device, sign in on the one holding your real practice first. A pull snapshots the ledger it replaces into the automatic backup, but that is a single slot overwritten by the next save — **Export remains the only durable escape hatch.**
- **Privacy.** The Firestore rule permits reads and writes only where the signed-in account's `uid` matches the document path, so a sadhak can reach their own subtree and nothing else. Nothing is shared with anyone, including the app's author.

### Sync setup (for a fork or redeploy)

The live site ships with this configured. To run your own:

1. In the [Firebase console](https://console.firebase.google.com/), create a project, then enable **Authentication → Sign-in method → Google**.
2. Create a **Cloud Firestore** database (any region; the live app uses `asia-south1`).
3. Under **Authentication → Settings → Authorized domains**, add your deployed origin and `localhost` for local testing.
4. Set the Firestore security rules to:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{userId}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
     }
   }
   ```

   The `{document=**}` matters — without it the rule covers only the `users/{userId}` document itself, not the `ledger` subcollection underneath, and every write is denied.
5. Copy the project's web config into `FIREBASE_CONFIG` in the "Sync Across Devices" section of `app.js`. Despite the name, `apiKey` is not a secret: it identifies the project and authorizes nothing. What protects the data is the security rule and the authorized-domain list, both enforced server-side.

## Localization (i18n)

The app supports **English, Hindi, and Bangla**. On first launch, a full-screen picker asks the user to choose a language (tapping an option applies it immediately — no separate "Continue" step); the choice is remembered in `localStorage` (`appLanguage`) and can be changed anytime from **Settings → Language**.

- `i18n/translations.json` is the single source of truth — a flat dictionary of ~155 keys, each with `{ "en": ..., "hi": ..., "bn": ... }`, covering every label, button, toast, and dialog in the app. It's reviewed and locked content, not meant to be regenerated casually; treat word-choice changes to it the same as any other deliberate content edit.
- `app.js` fetches it once at bootstrap (`loadTranslations()`, with one automatic retry on failure) into a module-level `TRANSLATIONS` object, and looks strings up via `t(key, params)` (`params` fills in `{placeholder}` tokens, e.g. `t("reflectionYearTotal", { year: 2026 })`).
- Static markup in `index.html` (Settings drawer, Sunday Backup modal, language picker) carries `data-i18n`/`data-i18n-aria`/`data-i18n-title`/`data-i18n-placeholder` attributes, applied by `applyStaticTranslations()`. If a translation isn't available for some reason, these elements keep their own correct, baked-in English text rather than being overwritten — the app never shows raw dictionary key names to a user, even if `translations.json` fails to load entirely.
- Dynamic sections (Today Card, Reflection Summary, Ledger List, Sankalpa) call `t()` directly inside their render functions, since they're rebuilt from scratch on every render anyway.
- Ledger dates intentionally stay in English everywhere (Ledger List rows, Pace predictions, Milestones list, Sankalpa date) — only the Today Card's long-form date line (weekday + full month name) translates, via `datesWeekdaysFull`/`datesMonthsFull` in the dictionary. Numerals stay Western (0–9) in every language.
- Adding a language later means adding a new `"xx"` field to every key in `translations.json` and a new option in the picker/switcher markup — no code changes needed to `t()` itself.

## Deployment

The app is deployed as a static site via GitHub Pages, configured to deploy from the `main` branch root. Since it's a static PWA with only relative asset paths, no environment-specific configuration is required — pushing to `main` and letting Pages rebuild is sufficient.

## Documentation

- [Sumiran-Lite-Technical-Documentation.docx](Sumiran-Lite-Technical-Documentation.docx) — the full technical reference (architecture, data model, algorithms, function reference, known limitations).
- [Sumiran-Lite-User-Guide.docx](Sumiran-Lite-User-Guide.docx) — an end-to-end guide to using the app, written for practitioners rather than developers.
