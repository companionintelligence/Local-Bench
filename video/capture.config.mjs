/**
 * Capture stage for Local Bench.
 *
 * `ci-video capture` drives the REAL app through this config, so whatever it
 * takes to get a brand-new user to a filmable screen belongs here: the base
 * URL, any pre-authenticated session, route mocks, and seeding.
 *
 * ── The stage ────────────────────────────────────────────────────────────────
 * Local Bench is a single static page (`index.html` + `assets/`) served by its
 * own Node server, `src/server.ts`. Two things about that server matter here:
 *
 *   1. `STATIC_ROOT = process.cwd()` (src/server.ts:16), so the server MUST be
 *      started from the repo root or `/` 404s and every capture is a 404 page.
 *   2. It listens on `PORT` (default 3000) and proxies model discovery to
 *      `OLLAMA_API_URL` (default http://localhost:11434).
 *
 * Boot it from the REPO ROOT, not from `video/`:
 *
 *   npm ci && npm run build && node dist/server.js     # tsc, then :3000
 *
 * There is no `webServer` config to reuse: the repo's only Playwright config,
 * `tests/container/playwright.config.ts`, deliberately has none — it points at
 * an already-running container on :8080.
 *
 * ── Determinism hazards found while writing this ─────────────────────────────
 * Shots are committed, so a rerun on unchanged UI must produce identical bytes.
 * Everything below is either pinned here or is a known, documented residual.
 *
 * PINNED HERE
 *   • Ollama presence. `/api/models` returns 200 + real `installed` flags when a
 *     daemon answers and 503 + the curated-catalog fallback when it does not
 *     (src/server.ts, `getOllamaModelCatalog`). That flips the status pill, the
 *     "N installed" count, the summary cards, whether the model cards are
 *     disabled, and whether the amber "Ollama is currently unavailable" note
 *     exists at all. A CI runner has no Ollama; a developer's laptop usually
 *     does. `onContext` pins the route to the no-daemon answer so both produce
 *     the same PNG — see the route handler below.
 *   • Theme. `index.html` picks the colorway pre-paint from
 *     `localStorage['lb-theme']`, falling back to `prefers-color-scheme`
 *     (index.html:12-19). `addInitScript` writes 'dark' before that IIFE runs,
 *     so the capture is dark even if the browser default ever changes.
 *   • Clock / locale / timezone. Pinned below. The results table renders
 *     `new Date(...).toLocaleString()`, which would otherwise be host-dependent.
 *
 * RESIDUAL — NOT fixable from here, mind them when you capture
 *   • `benchmark_data.db` (src/database.ts:22 — repo root). A fresh checkout has
 *     an empty DB, so `/api/results` returns `[]` and the page shows its welcome
 *     banner, the empty stats note and an unrendered chart. If you have ever run
 *     a benchmark in that checkout the DB persists and rows appear. Capture from
 *     a clean tree, or delete `benchmark_data.db` first.
 *   • Montserrat is loaded from fonts.googleapis.com (index.html:24-27) with a
 *     system-font fallback. Capture with network access or every glyph metric
 *     changes. The `requestfailed` warning below exists for exactly this.
 *   • Font rasterisation differs between macOS and Linux even with the same
 *     woff2. The committed shots should be the ones the ubuntu-latest workflow
 *     produces; a laptop capture will diff on antialiasing alone.
 *
 * NOT MASKED, DELIBERATELY
 *   No `mask` selectors are used anywhere in the storyboard. The app renders no
 *   clock, uptime, load average or "N minutes ago" — the only volatile surfaces
 *   are API-derived (`/api/models`, `/api/results`, `/api/system-specs`) and are
 *   either pinned above or empty on a fresh checkout. In particular the Ollama
 *   status pill (`#ollamaStatus`) is left VISIBLE and reading "Ollama
 *   unavailable": that is the honest first-run state this storyboard films, the
 *   route pin makes it deterministic, and masking it would blank the one element
 *   that explains why every model card is disabled. Its amber dot animates
 *   (`@keyframes ollama-breathe`), which the kit's FREEZE_CSS zeroes out.
 */
export default {
  baseURL: process.env.APP_URL ?? "http://localhost:3000",

  // CI apps are dark-first. Pinned locale/timezone/clock keep captures stable.
  colorScheme: "dark",
  locale: "en-US",
  timezoneId: "UTC",
  fixedTime: "2026-06-15T15:04:00Z",

  // No auth of any kind: the server has no sessions, cookies or login wall, so
  // there is no storageState to pre-seed.

  async onContext(context) {
    // Pin the theme before the page's own pre-paint IIFE reads localStorage.
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem("lb-theme", "dark");
      } catch {
        /* storage blocked — colorScheme: "dark" still gets us there */
      }
    });

    // Pin the Ollama-absent state.
    //
    // We do NOT invent models: the response body is still the server's own
    // curated catalog, fetched live, so it can never go stale against
    // SUPPORTED_OLLAMA_MODELS. We only force `installed: false` on every entry
    // and force the 503 the client reads as "catalog fallback"
    // (index.html `loadAvailableModels`, `isCatalogFallback`). The result is the
    // exact state a machine with no `ollama serve` produces — reproducibly, on
    // any host. Delete this block once there is a capture stage that really does
    // run Ollama with models pulled; then add the results/chart/system-specs
    // shots the storyboard currently cannot film.
    await context.route("**/api/models", async (route) => {
      const response = await route.fetch();
      let catalog;
      try {
        catalog = await response.json();
      } catch {
        catalog = [];
      }
      const offline = Array.isArray(catalog)
        ? catalog.map((model) => ({ ...model, installed: false }))
        : catalog;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify(offline),
      });
    });

    // Warn loudly if an external asset fails — an unstyled capture looks like a
    // UI regression but is really a network failure. Montserrat is the one that
    // matters here; Chart.js and jsPDF are vendored under assets/.
    context.on("requestfailed", (req) => {
      if (/fonts\.(googleapis|gstatic)|cdn\./.test(req.url())) {
        console.warn(`  ! external asset failed: ${req.url()}`);
      }
    });
  },
};
