# Sumiran Lite

Sumiran Lite is an offline-first Progressive Web App (PWA) for logging daily "jaap" (mantra repetition count) as part of a personal spiritual practice. It's a single-page vanilla JavaScript app with no framework and no build step — it runs directly from static files served over HTTP.

Live app: https://arijeetkundu.github.io/jaap-ledger/

## Features

- **Daily ledger** — log a jaap (or mala) count and notes for each day, editable within a 7-day window.
- **Lifetime & yearly totals**, with progress toward "Crore" (10,000,000 jaap) milestones and pace-based completion predictions.
- **Mala View** — toggle the whole app between raw jaap counts and mala (108-count) units.
- **Ledger row sparklines** — a rolling 7-day trend line per row.
- **Sankalpa** — a single, persistent record of your vow of intent.
- **Poornima (full moon) detection** from notes keywords, with a static fallback calendar.
- **Automatic backups** plus manual JSON import/export.
- **Installable PWA** — add to home screen with splash screen and icons.
- **Background themes** — switch the app's tiled background between Alpana and Mandala patterns (default Mandala) from Settings.
- **Rotating splash screen** — 5 images in rotation, never repeating the same one on two consecutive app opens.

All practice data lives in the browser's IndexedDB — nothing is sent to a server.

## Tech stack

| Layer | Technology |
|---|---|
| Markup | Static HTML5 (`index.html`) |
| Styling | Plain CSS (`styles.css`) |
| Logic | Vanilla JavaScript (`app.js`), no frameworks or bundler |
| Storage | IndexedDB (practice data, backups, Sankalpa) + localStorage (display preferences only) |
| PWA shell | `manifest.json` + `icons/` |
| Testing | Puppeteer-driven structural, unit, and E2E tests (`tests/`), run via `npm test` |
| Hosting | GitHub Pages (static) |

## Project structure

```
jaap-ledger/
├── index.html                 Page shell; all containers filled by app.js
├── app.js                     All application logic
├── styles.css                 All styling
├── data.json                  Historical seed data (used only on first-ever load)
├── poornima.json              Static full-moon date fallback list
├── manifest.json              PWA manifest
├── splash/                    5 rotating splash images (.png/.webp pairs)
├── icons/                     App icons (192x192, 512x512) + bg-alpana.webp/bg-mandala.webp tile assets
├── tests/
│   ├── test.js                Puppeteer structural smoke tests
│   ├── test-unit.js           Puppeteer-driven unit tests for pure logic functions
│   └── test-e2e.js            Puppeteer full user-flow E2E tests
├── package.json                devDependencies: puppeteer, sharp; "test" script runs all 3 suites
└── package-lock.json
```

## Running locally

The app uses `fetch()` to load `data.json` and `poornima.json`, so it must be served over HTTP rather than opened via a `file://` URL.

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

`npm test` runs the full suite against a running instance of the app: `tests/test.js` (structural smoke tests), `tests/test-unit.js` (pure-logic unit tests, calling app.js's global functions directly), and `tests/test-e2e.js` (full user-flow E2E tests — Sankalpa, Import/Export, Restore from Backup, Background themes, Splash rotation, and more). Each file can also be run individually, e.g. `node tests/test-unit.js`.

## Deployment

The app is deployed as a static site via GitHub Pages, configured to deploy from the `main` branch root. Since it's a static PWA with only relative asset paths, no environment-specific configuration is required — pushing to `main` and letting Pages rebuild is sufficient.

## Documentation

See [Sumiran-Lite-Technical-Documentation.docx](Sumiran-Lite-Technical-Documentation.docx) for the full technical reference (architecture, data model, algorithms, function reference, known limitations).
