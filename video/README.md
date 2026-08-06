# Local Bench — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Generates a **16:9 desktop cut** and a **9:16 mobile cut** of Local Bench's FTUE and major
screens, from this repo's own UI. Both are produced from [`storyboard.json`](storyboard.json).

**Videos are built locally, on demand.** No GitHub Actions workflow builds them, nothing is
scheduled, and the MP4s are not stored anywhere — not committed, not uploaded as artifacts, not
attached to releases. A cut is a build output: render one when you need it, use it, delete it.

The **screenshots are committed**, as of the fleet-wide policy of 2026-08-05. Only three of the
twelve products have a stage that actually boots, so an ignored shot set means nobody but the
stage's author can render the cut — eleven of twelve were rendering as "capture pending" slates.
The staleness risk is handled the other way round: when you change a screen the video covers,
re-run the matching capture pass and commit the new PNGs in the same PR.

## Quick start

One command does the whole thing — builds the app, starts the server, captures **both**
scenarios, checks the composition, renders both cuts, and stops the server again:

```bash
./video/make.sh
```

Needs `node` and `ffmpeg` (`brew install ffmpeg`). Chromium is installed on the first run and
cached afterwards.

```bash
./video/make.sh --no-render          # capture + check only, much faster
./video/make.sh --only <shot-id>     # re-shoot a single shot
```

`make.sh` picks a free port instead of assuming `:3000` is available and points the capture at
whatever it picked via `APP_URL` — a developer machine is not a clean CI runner. It also keeps the
empty-results assertion described below, so a first-run shot cannot quietly film a dirty server.

### Running the steps by hand

```bash
npm install
npx playwright install chromium
npm run doctor        # verify node / ffmpeg / playwright / hyperframes / fonts

# with the app's stage running (see below):
npm run capture       # drive the real UI -> assets/shots/*.png (both viewports)
npm run build         # storyboard.json -> build/{landscape,portrait}/index.html
npm run check         # HyperFrames gate: lint, runtime, layout, motion, contrast
npm run render        # -> out/ci-local-bench-landscape.mp4 and out/ci-local-bench-portrait.mp4
```

A bare `npm run capture` films the **first-run** scenario only — see [Two scenarios, two
passes](#two-scenarios-two-passes) below. `make.sh` runs both passes for you.

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
`ollama serve` running produces the same PNGs as a machine with no daemon at all. The determinism
hazards are enumerated in that file's header comment — read it before you capture.

### Two scenarios, two passes

`LB_CAPTURE_SCENARIO` selects which stage state a run films:

| Scenario | What it films |
|---|---|
| `first-run` *(default)* | No Ollama daemon. Every model card disabled, the amber "Ollama unavailable" pill, the welcome banner, empty results. The honest FTUE. |
| `benchmarked` | Ollama connected with the fixture's catalog models installed, and a completed run: the run controls, the success notice, the response comparison, the system specifications card. |

**One run cannot film both.** `video-kit` calls `onContext` once per viewport context, *before*
the per-shot loop, so its route mocks are global to the whole run. So capture twice:

```bash
LB_CAPTURE_SCENARIO=first-run   npm run capture -- --only dashboard-hero,model-catalog,prompt-picker,prompt-library,intelligence-index,docs
LB_CAPTURE_SCENARIO=benchmarked npm run capture -- --only models-installed,run-controls,benchmark-complete,system-specs,response-compare
```

> ⚠ **Every shot id in `storyboard.json` must appear in exactly one of those two commands.** A
> shot in neither is never captured, and video-kit silently substitutes a branded "capture
> pending" slate for the missing PNG — the build still goes green. Those two `--only` lists above
> are now the only place the split is written down, so when you add a shot, add it to the matching
> list in this README in the same PR, and check both lists against the storyboard before you
> capture:
>
> ```bash
> node -e "
>   const sb = require('./storyboard.json');
>   const declared = sb.scenes.flatMap(s => (s.shots ?? []).map(x => x.id));
>   console.log(declared.join('\n'));
> "
> ```

### The fixture

[`fixtures/run-fixture.json`](fixtures/run-fixture.json) holds the recorded stage state the
`benchmarked` pass replays: which catalog models were installed, the real system specifications,
and each model's real generated response. It was produced by Local Bench itself against a real
Ollama daemon — nothing in it is hand-written. Every model it names must still be in
`SUPPORTED_OLLAMA_MODELS` (`src/benchmark.ts`); a model the picker no longer offers would film a
run of a catalog the product does not have, so check it before a `benchmarked` capture:

```bash
cd .. && npm run build && node -e "
  const { SUPPORTED_OLLAMA_MODELS } = require('./dist/benchmark.js');
  const fixture = require('./video/fixtures/run-fixture.json');
  const catalog = new Set(SUPPORTED_OLLAMA_MODELS.map(m => m.name));
  const named = [...new Set([...fixture.installedModels, ...fixture.run.results.map(r => r.model)])];
  const stray = named.filter(n => !catalog.has(n));
  console.log(stray.length ? 'x stray: ' + stray.join(', ') : 'fixture ok: ' + named.join(', '));
"
```

We mock routes rather than seeding the database: `benchmark_data.db` and `benchmark_results.csv`
are gitignored, so a seeded DB is not committable and could never reproduce on another machine.
Delete `benchmark_data.db` before you capture — `curl -fsS localhost:3000/api/results` must answer
`[]`, or a stray local run bleeds into the shots. Mocking keeps that check orthogonal: the
`benchmarked` scenario pins `/api/models`, `/api/system-specs` and `POST /api/run-benchmark` and
deliberately leaves `/api/results` alone.

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
scenario list in [Two scenarios, two passes](#two-scenarios-two-passes) above, then
`LB_CAPTURE_SCENARIO=<scenario> npm run capture -- --only <id>` and `npm run build && npm run render`.
**Open the resulting PNG and look at it** — a shot that reached the wrong scroll position, an empty
state or an unrendered chart still writes a file, and every downstream step stays green.

## Media

Drop prepared media into `assets/media/` and point `media.music` at it. Per-scene voiceover is
picked up automatically from `assets/audio/<sceneId>.mp3`; regenerate it from the storyboard's
`narration` fields with `npm run narrate`.

## What is committed

`storyboard.json`, `capture.config.mjs`, `fixtures/run-fixture.json`, `assets/audio/*.mp3` and
`assets/shots/*.png` **are** committed. The first four are inputs that are expensive or impossible
to regenerate — the narration costs a synthesis run, and the fixture records a real Ollama session
on real hardware. The shots are committed because a checkout without them cannot render at all
(`ci-video check` fails on missing shots by design, and the kit substitutes a "capture pending"
slate), and most products in the fleet cannot re-stage themselves.

`out/` and `build/` are **not** committed — they are build outputs, and
[`.gitignore`](.gitignore) ignores them. `./video/make.sh` regenerates the lot in about a minute.
Nothing re-captures on a schedule: when you change a screen the video covers, re-run the matching
capture pass yourself, **open the PNGs and look at them**, and commit them with the change.

See [CI-Engineering `projects/product-video-pipeline/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/product-video-pipeline)
for the full contract.

## Why Playwright is pinned exactly

`video/package.json` pins `playwright` to an exact version, not a range.

Captures are byte-stable — that is what makes committing the shots worthwhile, because a UI change
then lands as a reviewable image diff instead of noise. But that property only holds **within one
Chromium build**. A `^1.58.0` range resolved to 1.62.1 on one machine and rewrote every committed
shot in a repo by 0.07–0.47% of pixels: pure text antialiasing, no layout change, and completely
indistinguishable from a real UI change in review.

So the range is gone. Re-pin deliberately when you want the newer browser, and re-capture the whole
shot set in the same commit.
