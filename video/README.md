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

Ollama is **not** required, and the capture deliberately does not use it.
[`capture.config.mjs`](capture.config.mjs) pins `/api/models` to the no-daemon response so a
laptop with `ollama serve` running produces the same PNGs as the CI runner, which has none. The
determinism hazards are enumerated in that file's header comment — read it before you capture.

## Editing the video

Everything editorial lives in [`storyboard.json`](storyboard.json) — scene order, durations,
captions, narration, and which screens appear. The **capture spec for each shot lives in the same
file**, so the script and the screenshots cannot drift apart.

Adding a beat is: add a scene, add its shot's `capture` block, `npm run capture -- --only <id>`,
then `npm run build && npm run render`.

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
