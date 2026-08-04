# Local Bench — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Generates a **16:9 desktop cut** and a **9:16 mobile cut** of Local Bench's FTUE and major
screens, from this repo's own UI. Both are produced from [`storyboard.json`](storyboard.json).

## Quick start

```bash
npm install
npx playwright install --with-deps chromium
npm run doctor        # verify node / ffmpeg / playwright / hyperframes / fonts

# with the app's stage running (see below):
npm run capture       # drive the real UI -> assets/shots/*.png (both viewports)
npm run build         # storyboard.json -> build/{landscape,portrait}/index.html
npm run check         # HyperFrames gate: lint, runtime, layout, motion, contrast
npm run render        # -> out/ci-local-bench-landscape.mp4 and out/ci-local-bench-portrait.mp4
```

## The stage

Local Bench is a single static page served by its own Node server. Start it **from the repo
root** — `STATIC_ROOT = process.cwd()` (`src/server.ts:16`), so anywhere else and `/` 404s:

```bash
cd ..                 # repo root, not video/
rm -f benchmark_data.db          # captures assume an empty results DB
npm ci && npm run build && node dist/server.js     # tsc, then :3000
```

There is no Playwright `webServer` to reuse: `tests/container/playwright.config.ts` deliberately
has none — it points at an already-running container on :8080.

Ollama is **not** required, and the capture deliberately does not run it.
[`capture.config.mjs`](capture.config.mjs) pins `/api/models` at the route layer so a laptop with
`ollama serve` running produces the same PNGs as the CI runner, which has none. The determinism
hazards are enumerated in that file's header comment — read it before you capture.

### Two scenarios, two passes

`LB_CAPTURE_SCENARIO` selects which stage state a run films:

| Scenario | What it films |
|---|---|
| `first-run` *(default)* | No Ollama daemon. Every model card disabled, the amber "Ollama unavailable" pill, the welcome banner, empty results. The honest FTUE. |
| `benchmarked` | Ollama connected with the fixture's catalog models installed, and a completed run: the success notice, the response comparison, the system specifications card. |

**One run cannot film both.** `video-kit` calls `onContext` once per viewport context, *before*
the per-shot loop, so its route mocks are global to the whole run. So capture twice:

```bash
LB_CAPTURE_SCENARIO=first-run   npm run capture -- --only dashboard-hero,model-catalog,prompt-picker,prompt-library,run-controls,intelligence-index,docs
LB_CAPTURE_SCENARIO=benchmarked npm run capture -- --only models-installed,benchmark-complete,system-specs,response-compare
```

> ⚠ **Every shot id in `storyboard.json` must appear in exactly one of those two lists.** A shot
> in neither is never captured, and video-kit silently substitutes a branded "capture pending"
> slate for the missing PNG — the build still goes green. The workflow's **Verify shot coverage**
> step fails the run if the lists and the storyboard ever drift apart, so when you add a shot, add
> it to `SHOTS_FIRST_RUN` or `SHOTS_BENCHMARKED` in
> [`.github/workflows/video.yml`](../.github/workflows/video.yml) in the same PR.

### The fixture

[`fixtures/run-fixture.json`](fixtures/run-fixture.json) holds the recorded stage state the
`benchmarked` pass replays: which catalog models were installed, the real system specifications,
and each model's real generated response. It was produced by Local Bench itself against a real
Ollama daemon — nothing in it is hand-written, and the workflow asserts every model it names is
still in `SUPPORTED_OLLAMA_MODELS` (`src/benchmark.ts`).

We mock routes rather than seeding the database: `benchmark_data.db` and `benchmark_results.csv`
are gitignored, so a seeded DB is not committable and could never reproduce on a runner. Mocking
also keeps the workflow's `curl /api/results == []` gate orthogonal and still valid.

**The fixture carries no throughput numbers**, and no scene displays one. See the `_README` block
at the top of the file for why, and for what to re-record if you want to add the results table,
statistics and throughput chart scenes.

### Two traps, if you add a shot

1. **`eval` must be an expression, not a bare arrow function.** The kit runs a `before` step's
   `eval` through `page.evaluate(string)`, which evaluates the string *as an expression*. A
   `"() => { … }"` string therefore just constructs a function and throws it away — it never runs,
   silently, and the shot is captured at whatever scroll position it already had. Wrap it in an
   IIFE: `"(() => { … })()"`. Every `eval` in `storyboard.json` uses that form.
2. **The clock is frozen, so no timer ever fires.** `context.clock.install()` replaces
   `requestAnimationFrame`/`setTimeout`/`setInterval` with paused fakes and the kit never resumes
   them. `runBenchmark`'s deferred `loadResults()`/`loadSystemSpecs()` refresh never happens (so no
   shot may depend on it), and Chart.js — which animates over rAF — would be photographed at frame
   zero as an empty axis. `capture.config.mjs`'s header explains how to disable Chart.js animation
   before adding a chart shot.

## Editing the video

Everything editorial lives in [`storyboard.json`](storyboard.json) — scene order, durations,
captions, narration, and which screens appear. The **capture spec for each shot lives in the same
file**, so the script and the screenshots cannot drift apart.

Adding a beat is: add a scene, add its shot's `capture` block, add the shot id to the matching
scenario list in [`.github/workflows/video.yml`](../.github/workflows/video.yml), then
`LB_CAPTURE_SCENARIO=<scenario> npm run capture -- --only <id>` and `npm run build && npm run render`.
**Open the resulting PNG and look at it** — a shot that reached the wrong scroll position, an empty
state or an unrendered chart still writes a file, and every downstream step stays green.

## Media

Drop prepared media into `assets/media/` and point `media.music` at it. Per-scene voiceover is
picked up automatically from `assets/audio/<sceneId>.mp3`; regenerate it from the storyboard's
`narration` fields with `npm run narrate`.

## What is committed

`assets/shots/*.png` and `assets/audio/*.mp3` **are** committed — they are the record of what the
product looked like, and captures are byte-stable, so a diff in them means the UI genuinely
changed. `out/` is not committed.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.
