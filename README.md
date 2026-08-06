# Sumiran Lite

Sumiran Lite is an offline-first Progressive Web App (PWA) for logging daily "jaap" (mantra repetition count) as part of a personal spiritual practice. It's a single-page vanilla JavaScript app with no framework and no build step — it runs directly from static files served over HTTP, styled in a "Temple Gold & Maroon" visual theme with self-hosted Playfair Display (headings) and Inter (body/UI) fonts.

Live app: https://arijeetkundu.github.io/jaap-ledger/

## Features

- **Daily ledger** — log a jaap (or mala) count and notes for each day, editable within a 7-day window.
- **Lifetime & yearly totals**, with progress toward "Crore" (10,000,000 jaap) milestones and pace-based completion predictions.
- **Milestone celebration** — crossing a new Crore triggers a page-wide falling-petal animation.
- **Mala View** — toggle the whole app between raw jaap counts and mala (108-count) units.
- **Ledger row sparklines** — a rolling 7-day trend line per row.
- **Sankalpa** — a single, persistent record of your vow of intent.
- **Poornima (full moon) detection** from notes keywords.
- **Automatic backups** plus manual JSON import/export (ledger data only — splash images are device-local and not included).
- **Installable PWA** — add to home screen with a framed, gold-bordered splash screen and icons.
- **Background themes** — switch the app's tiled/full-bleed background between Alpana, Mandala (default), and Jharokha from Settings.
- **Customizable splash screen** — Hanuman is a fixed default image; up to 4 additional slots let you add your own pictures, which then rotate alongside Hanuman (never repeating the same image twice in a row). Uploads are validated, downscaled, and compressed client-side, so storage and startup performance stay unaffected by the original photo's size.

All practice data lives in the browser's IndexedDB — nothing is sent to a server.

## Tech stack

| Layer | Technology |
|---|---|
| Markup | Static HTML5 (`index.html`) |
| Styling | Plain CSS (`styles.css`) |
| Logic | Vanilla JavaScript (`app.js`), no frameworks or bundler |
| Storage | IndexedDB (practice data, backups, Sankalpa) + localStorage (display preferences only) |
| PWA shell | `manifest.json` + `icons/` |
| Testing | Puppeteer-driven structural, unit, E2E, redesign, and custom-splash-image tests (`tests/`), run via `npm test` |
| Hosting | GitHub Pages (static) |

## Project structure

```
jaap-ledger/
├── index.html                          Page shell; all containers filled by app.js
├── app.js                              All application logic
├── styles.css                          All styling (Temple Gold & Maroon design tokens)
├── data.json                           Local-testing fixture only — never loaded into a real user's ledger
├── manifest.json                       PWA manifest
├── fonts/                              Self-hosted Playfair Display + Inter (variable .woff2, no CDN)
├── splash/
│   ├── hanuman-splash.png/.webp        Fixed default splash image (locked, never replaceable)
│   ├── splash-background.webp          Splash screen backdrop art (wall/frame setting)
│   └── launch-neutral.png              Unused spare asset (kept for possible future use)
├── icons/                              App icons (192x192, 512x512) + bg-alpana/bg-mandala/bg-jharokha.webp tile assets
├── tests/
│   ├── test.js                         Puppeteer structural smoke tests
│   ├── test-unit.js                    Puppeteer-driven unit tests for pure logic functions
│   ├── test-e2e.js                     Puppeteer full user-flow E2E tests
│   ├── test-redesign.js                Premium redesign: design tokens, milestone celebration, motion
│   └── test-splash-custom.js           Custom splash images: upload pipeline, guards, rotation, deletes
├── package.json                        devDependencies: puppeteer, sharp; "test" script runs all 5 suites
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

`npm test` runs the full suite (195 assertions, as of this revision) against a running instance of the app: `tests/test.js` (structural smoke tests), `tests/test-unit.js` (pure-logic unit tests, calling app.js's global functions directly), `tests/test-e2e.js` (full user-flow E2E tests — Sankalpa, Import/Export, Restore from Backup, Background themes, and more), `tests/test-redesign.js` (premium redesign: design tokens, milestone celebration, splash entrance animation, motion polish), and `tests/test-splash-custom.js` (custom splash images: upload pipeline guards, adaptive frame, rotation, per-slot/remove-all deletes, corrupt-data resilience). Each file can also be run individually, e.g. `node tests/test-unit.js`.

## Deployment

The app is deployed as a static site via GitHub Pages, configured to deploy from the `main` branch root. Since it's a static PWA with only relative asset paths, no environment-specific configuration is required — pushing to `main` and letting Pages rebuild is sufficient.

## Documentation

- [Sumiran-Lite-Technical-Documentation.docx](Sumiran-Lite-Technical-Documentation.docx) — the full technical reference (architecture, data model, algorithms, function reference, known limitations).
- [Sumiran-Lite-User-Guide.docx](Sumiran-Lite-User-Guide.docx) — an end-to-end guide to using the app, written for practitioners rather than developers.
