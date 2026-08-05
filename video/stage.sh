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

# Shot lists, kept in step with storyboard.json. verify_shot_coverage below
# fails if the two lists do not exactly cover it.
SHOTS_FIRST_RUN="${SHOTS_FIRST_RUN:-}"
SHOTS_BENCHMARKED="${SHOTS_BENCHMARKED:-}"

_load_shot_lists() {
  # The workflow keeps these in its env block; read them from there so there is
  # one source of truth rather than a copy that silently drifts.
  local wf="$REPO_ROOT/.github/workflows/video.yml"
  [ -n "$SHOTS_FIRST_RUN" ] || SHOTS_FIRST_RUN="$(
    python3 -c "
import yaml,sys
d=yaml.safe_load(open('$wf'))
env=list(d['jobs'].values())[0].get('env',{}) or {}
print(env.get('SHOTS_FIRST_RUN',''))
" )"
  [ -n "$SHOTS_BENCHMARKED" ] || SHOTS_BENCHMARKED="$(
    python3 -c "
import yaml,sys
d=yaml.safe_load(open('$wf'))
env=list(d['jobs'].values())[0].get('env',{}) or {}
print(env.get('SHOTS_BENCHMARKED',''))
" )"
  [ -n "$SHOTS_FIRST_RUN" ] && [ -n "$SHOTS_BENCHMARKED" ] || {
    echo "could not read SHOTS_FIRST_RUN / SHOTS_BENCHMARKED from the workflow" >&2
    return 1
  }
}

stage_up() {
  STAGE_PORT="$(pick_port 3000)"
  STAGE_URL="http://localhost:$STAGE_PORT"
  export APP_URL="$STAGE_URL"
  export PORT="$STAGE_PORT"
  [ "$STAGE_PORT" = 3000 ] || echo "note: :3000 was busy, using :$STAGE_PORT"

  _load_shot_lists

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
  LB_CAPTURE_SCENARIO=first-run npm run capture -- --only "$SHOTS_FIRST_RUN"

  echo "  pass 2/2 — benchmarked shots (fixture-backed routes)"
  LB_CAPTURE_SCENARIO=benchmarked npm run capture -- --only "$SHOTS_BENCHMARKED"
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
