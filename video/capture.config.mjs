import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * ── TWO SCENARIOS, TWO CAPTURE PASSES ────────────────────────────────────────
 * `LB_CAPTURE_SCENARIO` selects which stage state this run films:
 *
 *   first-run  (default) — no Ollama daemon. Every model card disabled, the amber
 *                          "Ollama unavailable" pill, the welcome banner, empty
 *                          results. This is the honest FTUE and was the only state
 *                          the stage could ever reach before.
 *   benchmarked          — Ollama connected with two catalog models installed, and
 *                          a completed run. Reaches the run controls with the
 *                          daemon connected, the completion notice, the response
 *                          comparison and the system specifications card.
 *
 *                          No shot films the progress meter, and none can. It is
 *                          display:none outside a run (index.html:369-370), and
 *                          #progressContainer (index.html:563) sits below the
 *                          whole 42-card model grid and the prompt library —
 *                          nowhere near #benchmarkAlert (index.html:537), which
 *                          is the anchor the completion shot scrolls to.
 *
 * ONE RUN CANNOT FILM BOTH. `src/capture.mjs` calls `onContext` once per viewport
 * context, *before* the per-shot loop, so route mocks are global to the whole run.
 * The workflow therefore runs `npm run capture` twice with disjoint `--only` lists.
 *
 *   ⚠ Every shot id in storyboard.json must appear in exactly ONE of those two
 *     lists. A shot in neither list is never captured, and video-kit silently
 *     substitutes a branded "capture pending" slate for a missing PNG — the build
 *     still goes green. That silent substitution is the exact failure this split
 *     exists to prevent, so when you add a shot, add it to a list in the same PR.
 *
 * ── The fixture ──────────────────────────────────────────────────────────────
 * `fixtures/run-fixture.json` holds the recorded stage state for `benchmarked`:
 * which catalog models were installed, the real system specifications, and the
 * real model responses. It was produced by Local Bench itself against a real
 * Ollama daemon — nothing in it is hand-written.
 *
 * We mock routes rather than seeding the database because `benchmark_data.db` and
 * `benchmark_results.csv` are gitignored (root .gitignore:145-146), so a seeded DB
 * is not committable and could never reproduce on a runner. Mocking also keeps the
 * workflow's `curl /api/results == []` determinism gate orthogonal and still valid.
 *
 * We do NOT run Ollama in CI. ubuntu-latest has ~2 vCPU and no GPU, live tokens/sec
 * would differ on every run, and the "Detect UI drift" step opens a PR on any byte
 * diff — a genuine run would guarantee a weekly PR of pure noise that never
 * converges on committable shots.
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
 *     does. `onContext` pins the route per scenario so both produce the same PNG.
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
 *     a clean tree, or delete `benchmark_data.db` first. This is true in BOTH
 *     scenarios — `benchmarked` deliberately leaves `/api/results` alone.
 *   • Montserrat is loaded from fonts.googleapis.com (index.html:24-27) with a
 *     system-font fallback. Capture with network access or every glyph metric
 *     changes. The `requestfailed` warning below exists for exactly this.
 *   • Font rasterisation differs between macOS and Linux even with the same
 *     woff2. The committed shots should be the ones the ubuntu-latest workflow
 *     produces; a laptop capture will diff on antialiasing alone.
 *
 * ── ⚠ THE FROZEN CLOCK, if you add a shot ────────────────────────────────────
 * `src/capture.mjs:178-180` calls `context.clock.install()`, which replaces
 * requestAnimationFrame, setTimeout and setInterval with fake, PAUSED
 * implementations. The kit never calls runFor/fastForward/resume, so **no timer
 * ever fires**. Two consequences worth knowing before you write a `capture` block:
 *
 *   • `runBenchmark`'s `setTimeout(() => { loadResults(); loadSystemSpecs(); }, 800)`
 *     (index.html:1499) never runs, so no shot may depend on that deferred refresh.
 *     Its sibling `setTimeout(..., 2600)` that clears the progress bar never runs
 *     either — which is helpful: the completed 100% progress state holds still.
 *   • Chart.js animates its bars over rAF and index.html never disables animation,
 *     so a throughput-chart shot would photograph the canvas at frame zero: axes
 *     with no bars, and a green build, because the PNG exists. Before adding that
 *     shot, `addInitScript` a configurable `defineProperty` setter on `window.Chart`
 *     that sets `defaults.animation = false` and `defaults.animations = {}` the
 *     instant `assets/chart.umd.min.js` assigns it — that runs before the vendored
 *     library loads and makes Chart.js draw synchronously on first render. Then
 *     verify by eye that the bars have height.
 *
 * NOT MASKED, DELIBERATELY
 *   No `mask` selectors are used anywhere in the storyboard. The app renders no
 *   clock, uptime, load average or "N minutes ago" — the only volatile surfaces
 *   are API-derived (`/api/models`, `/api/results`, `/api/system-specs`) and are
 *   either pinned above or empty on a fresh checkout. In particular the Ollama
 *   status pill (`#ollamaStatus`) is left VISIBLE in `first-run` and reading
 *   "Ollama unavailable": that is the honest first-run state, the route pin makes
 *   it deterministic, and masking it would blank the one element that explains why
 *   every model card is disabled. Its amber dot animates
 *   (`@keyframes ollama-breathe`), which the kit's FREEZE_CSS zeroes out.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

const SCENARIOS = ["first-run", "benchmarked"];
const scenario = process.env.LB_CAPTURE_SCENARIO ?? "first-run";
if (!SCENARIOS.includes(scenario)) {
  throw new Error(`LB_CAPTURE_SCENARIO must be one of ${SCENARIOS.join(" | ")} — got "${scenario}"`);
}

const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "run-fixture.json"), "utf8"));

/**
 * Reproduce `getOllamaModelCatalog`'s ordering (src/benchmark.ts:276-280) after
 * flipping `installed`, so the mocked body is byte-identical in shape to what a
 * real server with those models pulled would have returned.
 */
const sortLikeServer = (models) =>
  [...models].sort(
    (a, b) =>
      (b.installed ? 1 : 0) - (a.installed ? 1 : 0) ||
      (b.supported ? 1 : 0) - (a.supported ? 1 : 0) ||
      a.name.localeCompare(b.name),
  );

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

    // ── /api/models ──────────────────────────────────────────────────────────
    // We never invent models: the body is always the server's OWN curated
    // catalog, fetched live, so it cannot go stale against SUPPORTED_OLLAMA_MODELS.
    // Only the `installed` flags and the status code are pinned.
    //
    //   first-run   → 503 + installed:false everywhere. The client reads 503 as
    //                 "catalog fallback" (`loadAvailableModels`, `isCatalogFallback`),
    //                 which is exactly what a machine with no `ollama serve` shows.
    //   benchmarked → 200 + installed:true for the fixture's models, which really
    //                 were pulled on the machine the fixture was recorded on.
    const installed = new Set(fixture.installedModels);
    await context.route("**/api/models", async (route) => {
      const response = await route.fetch();
      let catalog;
      try {
        catalog = await response.json();
      } catch {
        catalog = [];
      }
      if (!Array.isArray(catalog)) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify(catalog) });
        return;
      }
      if (scenario === "first-run") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify(catalog.map((model) => ({ ...model, installed: false }))),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(sortLikeServer(catalog.map((m) => ({ ...m, installed: installed.has(m.name) })))),
      });
    });

    if (scenario === "benchmarked") {
      // The recorded specifications of the machine the fixture was benchmarked on.
      // On a runner /api/system-specs reads an empty DB and returns null, so
      // `displaySystemSpecs` takes its "No system specs yet" branch and the card
      // never renders. Without this mock the system-specs shot is unfilmable.
      await context.route("**/api/system-specs", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(fixture.systemSpecs),
        });
      });

      // The only route that can populate #responseSection: `renderResponseComparison`
      // reads `lastRun`, which is set from this POST's `results` and from nothing
      // else. The fixture carries each model's real generated text.
      //
      // Note what this deliberately does NOT do: it leaves /api/results alone, so
      // the results table, statistics and chart stay in their empty state and no
      // throughput number is ever rendered. See fixtures/run-fixture.json.
      await context.route("**/api/run-benchmark", async (route) => {
        if (route.request().method() !== "POST") {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(fixture.run),
        });
      });
    }

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
