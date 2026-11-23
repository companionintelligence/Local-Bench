/**
 * Pure helpers for the measurement modes: context-depth prompts, load-profile
 * arrival schedules, inter-token latency, and SLO goodput. No I/O here, so
 * every rule can be tested without an engine.
 */

export const MAX_CONTEXT_DEPTH = 32768;

/** Roughly ten tokens per repetition; the engine reports the exact count it saw. */
const DEPTH_FILLER_SENTENCE = 'The quick brown fox jumps over the lazy dog.';
const FILLER_TOKENS_PER_REPETITION = 10;

/** An integer context depth in 0..MAX_CONTEXT_DEPTH, or undefined when the value is not one. */
export function parseContextDepth(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN);
  if (!Number.isInteger(n) || n < 0 || n > MAX_CONTEXT_DEPTH) {
    return undefined;
  }
  return n;
}

/**
 * The prompt for a context-depth run: neutral filler of about `depthTokens` tokens,
 * then the question, so the question is always the last thing the model reads.
 * Depth 0 returns the question unchanged.
 */
export function buildDepthPrompt(question: string, depthTokens: number): string {
  if (!depthTokens || depthTokens <= 0) {
    return question;
  }
  const repetitions = Math.ceil(depthTokens / FILLER_TOKENS_PER_REPETITION);
  const filler = Array.from({ length: repetitions }, () => DEPTH_FILLER_SENTENCE).join(' ');
  return `${filler}\n\n${question}`;
}

/** Deterministic PRNG (mulberry32) so a seeded Poisson schedule is reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ArrivalProfile = 'constant' | 'poisson';

export interface ArrivalOptions {
  profile: ArrivalProfile;
  /** Requests per second. */
  rate: number;
  durationSeconds: number;
  /** Seeds the Poisson schedule; ignored for constant arrivals. */
  seed?: number;
}

/**
 * When each request is sent, in milliseconds from the start of the profile.
 * Constant: evenly spaced, one every 1000/rate ms. Poisson: exponential gaps with
 * mean 1/rate. Nothing is scheduled at or after durationSeconds.
 */
export function arrivalOffsetsMs(options: ArrivalOptions): number[] {
  const { profile, rate, durationSeconds } = options;
  if (!(rate > 0) || !(durationSeconds > 0)) {
    return [];
  }
  const offsets: number[] = [];
  if (profile === 'constant') {
    for (let i = 0; i / rate < durationSeconds; i++) {
      offsets.push((i * 1000) / rate);
    }
    return offsets;
  }
  const random = mulberry32(options.seed ?? 1);
  let seconds = 0;
  for (;;) {
    seconds += -Math.log(1 - random()) / rate;
    if (seconds >= durationSeconds) {
      break;
    }
    offsets.push(seconds * 1000);
  }
  return offsets;
}

export interface LatencyRow {
  success?: boolean;
  durationSeconds: number;
  ttftMs?: number;
  totalTokens: number;
}

/** Mean gap between tokens after the first one, in ms. Undefined without TTFT or with fewer than two tokens. */
export function interTokenLatencyMs(row: LatencyRow): number | undefined {
  if (typeof row.ttftMs !== 'number' || row.totalTokens < 2) {
    return undefined;
  }
  return (row.durationSeconds * 1000 - row.ttftMs) / (row.totalTokens - 1);
}

export interface SloTargets {
  ttftMs?: number;
  itlMs?: number;
}

/** A request meets the SLO when it succeeded and every stated target holds. */
export function meetsSlo(row: LatencyRow, slo: SloTargets): boolean {
  if (row.success === false) {
    return false;
  }
  if (slo.ttftMs !== undefined && !(typeof row.ttftMs === 'number' && row.ttftMs <= slo.ttftMs)) {
    return false;
  }
  if (slo.itlMs !== undefined) {
    const itl = interTokenLatencyMs(row);
    if (itl === undefined || itl > slo.itlMs) {
      return false;
    }
  }
  return true;
}

/** Share of requests that met the SLO, counting failures as misses. Undefined for no requests. */
export function goodputFraction(rows: readonly LatencyRow[], slo: SloTargets): number | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  return rows.filter(row => meetsSlo(row, slo)).length / rows.length;
}
