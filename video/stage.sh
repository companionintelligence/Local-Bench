#!/usr/bin/env bash
#
# Local-Bench's stage, for local video capture. Sourced by video/make.sh, which
# owns the generic toolchain/build/check/render steps.
#
# Ported from .github/workflows/video.yml. Two things here are not boilerplate
# and both are load-bearing for a correct video:
#
#   1. The capture happens in TWO passes against DIFFERENT app states — the
#      first-run shots must be filmed against an empty results list, the
#      benchmarked shots against the seeded fixture. That is why capture_all
#      exists rather than a single `npm run capture`.
#
#   2. The empty-results assertion. The first-run shots are only honest if the
#      server really has no results yet; if a previous run left data behind, the
#      capture still succeeds and films a "first run" that already has history.

STAGE_PID=""

# Which shots belong to which scenario. These used to live in the workflow's env
# block; the workflow is gone, so they live here — and _verify_shot_coverage
# below keeps them honest rather than trusting them, which is what the
# workflow's own "Verify shot coverage" step did.
# WHICH SCENARIO A SHOT BELONGS TO IS A CONTINUITY DECISION, NOT A TECHNICAL ONE.
#
# The topbar is `position: sticky`, so its Ollama pill is in EVERY scrolled desktop
# frame. That makes the scenario lists the thing that decides whether the film says
# "Ollama connected" or "Ollama unavailable" at any given second — and the film
# tells a story about that: no daemon, then the daemon starts, then everything
# works. Once `models-installed` turns the pill green it must stay green.
#
# It did not. `run-controls` was moved here for exactly this reason, and the same
# reasoning was never applied to the other four. In scene order the pill read
# unavailable, unavailable, CONNECTED, unavailable, unavailable, CONNECTED,
# connected, connected, connected, UNAVAILABLE, unavailable — four state flips in
# 78 seconds, with a full-width amber "Ollama is currently unavailable" banner
# reappearing one scene after the narration said "Start Ollama and the catalog
# comes alive".
#
# Only the two scenes whose narration is ABOUT having no daemon stay in first-run.
# Everything from `models-installed` onward films with the daemon connected, whether
# or not that shot's subject depends on Ollama.
SHOTS_FIRST_RUN="${SHOTS_FIRST_RUN:-dashboard-hero,model-catalog}"
SHOTS_BENCHMARKED="${SHOTS_BENCHMARKED:-models-installed,prompt-picker,prompt-library,run-controls,benchmark-complete,system-specs,response-compare,intelligence-index,docs}"

# Every shot in the storyboard must appear in exactly one list. Without this a
# shot added to storyboard.json is simply never captured, and `ci-video check`
# is what finally complains — a long way from the cause.
_verify_shot_coverage() {
  SHOTS_FIRST_RUN="$SHOTS_FIRST_RUN" SHOTS_BENCHMARKED="$SHOTS_BENCHMARKED" \
  node -e '
    const fs = require("node:fs");
    const sb = JSON.parse(fs.readFileSync("video/storyboard.json", "utf8"));
    const declared = sb.scenes.flatMap((s) => (s.shots ?? []).map((x) => x.id));
    const listed = [
      ...process.env.SHOTS_FIRST_RUN.split(","),
      ...process.env.SHOTS_BENCHMARKED.split(","),
    ].map((s) => s.trim()).filter(Boolean);

    const errs = [];
    const uncaptured = declared.filter((id) => !listed.includes(id));
    const twice = listed.filter((id, i) => listed.indexOf(id) !== i);
    const unknown = listed.filter((id) => !declared.includes(id));
    if (uncaptured.length) errs.push("never captured: " + uncaptured.join(", "));
    if (twice.length) errs.push("captured twice: " + twice.join(", "));
    if (unknown.length) errs.push("not in the storyboard: " + unknown.join(", "));
    if (errs.length) {
      console.error("  x scenario shot lists do not cover storyboard.json\n    " + errs.join("\n    "));
      process.exit(1);
    }
    console.log(`  shot coverage ok (${declared.length} shots across 2 scenarios)`);
  ' || return 1
}

# Prove the export above actually took, rather than trusting it — the same reason
# _verify_shot_coverage exists. A leaked catalog does not fail a capture: every
# shot still renders, `kit check` still passes, and the only trace is a model
# count in a PNG that nobody diffs by eye.
#
# The invariant asserted is "no entry came from a local daemon", NOT a hard-coded
# 42. Adding a model to SUPPORTED_OLLAMA_MODELS is a legitimate change that should
# not fail the stage; a stray card from the capturing machine never is. The counts
# are echoed so the honest numbers are visible in the run log — 42 curated / 11
# unrated today, and the 11 is what the intelligence footnote must read.
#
# `curl -sS`, NOT `-fsS` like the /api/results check above: with no daemon
# reachable /api/models answers 503 by design (src/server.ts takes its
# catalog-fallback branch), and -f would discard that body and fail the stage on
# the very state it is here to confirm. The 503 IS the healthy answer.
_verify_catalog_is_machine_independent() {
  curl -sS "$STAGE_URL/api/models" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      let catalog;
      try {
        catalog = JSON.parse(raw);
      } catch {
        console.error(`  x /api/models did not return JSON: ${raw.slice(0, 200) || "(empty)"}`);
        process.exit(1);
      }
      const strays = catalog.filter((m) => m.source !== "catalog");
      if (strays.length) {
        console.error(
          `  x /api/models served ${strays.length} model(s) pulled on THIS machine:\n` +
          `      ${strays.map((m) => m.name).join(", ")}\n` +
          `    The stage reached an Ollama daemon despite OLLAMA_API_URL pointing at a\n` +
          `    closed port. Capturing now would bake this machine into the shots.`,
        );
        process.exit(1);
      }
      const unrated = catalog.filter((m) => typeof m.intelligenceIndex !== "number").length;
      console.log(`  catalog ok (${catalog.length} curated, ${unrated} unrated — the intelligence footnote must read ${unrated})`);
    });
  ' || return 1
}

stage_up() {
  STAGE_PORT="$(pick_port 3000)"
  STAGE_URL="http://localhost:$STAGE_PORT"
  export APP_URL="$STAGE_URL"
  export PORT="$STAGE_PORT"
  [ "$STAGE_PORT" = 3000 ] || echo "note: :3000 was busy, using :$STAGE_PORT"

  # The stage must not be able to see an Ollama daemon. `/api/models` appends a
  # card for every locally pulled tag that is not in SUPPORTED_OLLAMA_MODELS
  # (getOllamaModelCatalog's installedOnly branch), so a server that can reach a
  # daemon serves a catalog shaped by whoever happens to be capturing — which is
  # how shots reading "25 model(s) are not individually rated" on one laptop and
  # "24" on another got committed. The honest number is 11.
  #
  # :9 is discard. Nothing listens, the connect fails immediately rather than
  # hanging, and the handler takes its 503 catalog-fallback branch — exactly the
  # no-daemon state the first-run shots are supposed to film.
  #
  # NOT overridable, deliberately: an env var a developer can set is the same
  # per-operator workaround this replaces. capture.config.mjs filters the strays
  # out independently, so this is the second lock — but it is the one that also
  # keeps the raw server honest for anything reading it directly (--keep-up, a
  # curl, the assertions below).
  export OLLAMA_API_URL="http://127.0.0.1:9"

  ( cd "$REPO_ROOT" && _verify_shot_coverage ) || return 1

  ( cd "$REPO_ROOT" && npm ci --silent && npm run build )

  ( cd "$REPO_ROOT" && PORT="$STAGE_PORT" node dist/server.js ) > "$STAGE_LOG" 2>&1 &
  STAGE_PID=$!

  for _ in $(seq 1 60); do
    curl -fsS "$STAGE_URL/" >/dev/null 2>&1 && break
    kill -0 "$STAGE_PID" 2>/dev/null || { echo "server exited during startup" >&2; return 1; }
    sleep 2
  done
  curl -fsS "$STAGE_URL/" >/dev/null || { echo "server never answered on :$STAGE_PORT" >&2; return 1; }

  # The first-run shots are a lie if results already exist. A capture against a
  # dirty server succeeds and films a "first run" with history in it.
  local results
  results="$(curl -fsS "$STAGE_URL/api/results")"
  [ "$results" = "[]" ] || {
    echo "expected no results for the first-run shots, got: ${results:0:120}" >&2
    return 1
  }

  _verify_catalog_is_machine_independent || return 1

  echo "stage up at $STAGE_URL (no results yet)"
}

# Two passes against two different app states.
#
# LB_CAPTURE_SCENARIO is what actually switches the state: capture.config.mjs
# reads it and pins route mocks for the whole context (see its header). Leaving
# it unset does NOT fail — the config defaults to "first-run", so the
# benchmarked pass quietly films the empty app and every one of its shots times
# out waiting for results that were never mocked in. The variable is the state.
capture_all() {
  echo "  pass 1/2 — first-run shots (empty app)"
  LB_CAPTURE_SCENARIO=first-run kit capture --only "$SHOTS_FIRST_RUN"

  echo "  pass 2/2 — benchmarked shots (fixture-backed routes)"
  LB_CAPTURE_SCENARIO=benchmarked kit capture --only "$SHOTS_BENCHMARKED"
}

stage_down() {
  [ -n "$STAGE_PID" ] || return 0
  kill -0 "$STAGE_PID" 2>/dev/null || return 0
  # Children first, then the parent. Not the process group: a background job in
  # a non-interactive shell shares the script's own group, so signalling the
  # group would kill make.sh too.
  pkill -P "$STAGE_PID" 2>/dev/null || true
  kill "$STAGE_PID" 2>/dev/null || true
  wait "$STAGE_PID" 2>/dev/null || true
}
