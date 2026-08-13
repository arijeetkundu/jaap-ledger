// ESLint flat config.
//
// This project has no build step and no CI — `npm run lint` is a local-only
// static check, run alongside `npm test` before pushing. It is deliberately
// scoped to correctness (undefined names, unreachable code, unused values,
// accidental globals), not style: app.js is a single classic script whose
// formatting conventions predate this config, and reformatting it would bury
// real findings in noise.
//
// Three source shapes, three environments:
//   app.js      — browser, classic script (every function is a top-level
//                 global; no modules, hence sourceType "script")
//   sw.js       — service worker globals (self, caches, clients, skipWaiting)
//   tests/*.js  — Node + CommonJS (require, process, __dirname), and their
//                 page.evaluate() callbacks run in the browser, so browser
//                 globals are allowed there too.

const globals = require("globals");

const correctnessRules = {
  "no-undef": "error",
  "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
  "no-unreachable": "error",
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-duplicate-case": "error",
  "no-func-assign": "error",
  "no-cond-assign": "error",
  "no-constant-condition": "error",
  "no-self-compare": "error",
  "no-sparse-arrays": "error",
  "no-fallthrough": "error",
  // no-implicit-globals is deliberately OFF, everywhere. It is the one rule
  // that is architecturally wrong for this codebase: app.js has no modules by
  // design, so every function and `let` in it is *intended* to be a top-level
  // global (tests even call them directly through page.evaluate()). Enabling
  // it produced 103 errors, all of them false, which is exactly the noise that
  // buries a real finding.
  "no-shadow-restricted-names": "error",
  "no-empty": ["error", { allowEmptyCatch: true }],
  "valid-typeof": "error",
  "use-isnan": "error",
  eqeqeq: ["warn", "smart"],
};

module.exports = [
  {
    ignores: ["node_modules/**", "data.json", "eslint.config.js"],
  },
  {
    files: ["app.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        // Injected by the lazily-loaded Google Identity Services script
        // (accounts.google.com/gsi/client) — only ever touched after that
        // script has loaded, so it is a genuine runtime global here.
        google: "readonly",
      },
    },
    rules: {
      ...correctnessRules,
      // app.js IS the global scope — its top-level function/let declarations
      // are the app's whole API surface, and tests call them directly via
      // page.evaluate(). Flagging them as unused would be wrong.
      "no-unused-vars": ["warn", { args: "none", vars: "local" }],
    },
  },
  {
    files: ["sw.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: globals.serviceworker,
    },
    rules: correctnessRules,
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        // page.evaluate()/evaluateOnNewDocument() callbacks are serialized
        // and run inside the browser, so they legitimately reference DOM and
        // app.js globals from inside these files.
        ...globals.browser,
      },
    },
    rules: {
      ...correctnessRules,
      // Those same page.evaluate() callbacks also reach app.js's own globals
      // (ledgerData, renderToday, addDaysISO, ...). ESLint can't know the
      // callback body is evaluated in the page against a different script, so
      // every such reference reads as undefined here. All false positives, and
      // there's no way to enumerate them that wouldn't rot as app.js changes.
      "no-undef": "off",
    },
  },
];
