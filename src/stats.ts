/**
 * Small, dependency-free statistics for repeated runs and load profiles.
 * Every function ignores non-finite inputs and returns undefined when the
 * answer is not defined (no values, or too few for a spread).
 */

function finiteValues(values: readonly number[]): number[] {
  return values.filter(value => typeof value === 'number' && Number.isFinite(value));
}

/** Linear-interpolated percentile, p in 0..100 (p50 is the median). */
export function percentile(values: readonly number[], p: number): number | undefined {
  const sorted = finiteValues(values).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return undefined;
  }
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export function mean(values: readonly number[]): number | undefined {
  const finite = finiteValues(values);
  if (finite.length === 0) {
    return undefined;
  }
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

/** Sample standard deviation (n - 1 denominator). Undefined below two values. */
export function sampleStdDev(values: readonly number[]): number | undefined {
  const finite = finiteValues(values);
  if (finite.length < 2) {
    return undefined;
  }
  const m = mean(finite) as number;
  const variance = finite.reduce((sum, value) => sum + (value - m) ** 2, 0) / (finite.length - 1);
  return Math.sqrt(variance);
}

/** Two-sided 95% Student-t critical values for 1..30 degrees of freedom. */
const T_CRITICAL_95 = [
  Number.NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074,
  2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042
];

/** Mean ± t(0.975, n-1) × s / √n. Undefined below two values. */
export function confidenceInterval95(values: readonly number[]): { low: number; high: number } | undefined {
  const finite = finiteValues(values);
  const spread = sampleStdDev(finite);
  if (spread === undefined) {
    return undefined;
  }
  const df = finite.length - 1;
  const t = df <= 30 ? T_CRITICAL_95[df] : 1.96;
  const center = mean(finite) as number;
  const half = (t * spread) / Math.sqrt(finite.length);
  return { low: center - half, high: center + half };
}

export interface Summary {
  n: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p99: number;
  stddev?: number;
  ci95?: { low: number; high: number };
}

/** Everything a repeated-run or load-profile table needs, from one list of values. */
export function summarize(values: readonly number[]): Summary | undefined {
  const finite = finiteValues(values);
  if (finite.length === 0) {
    return undefined;
  }
  const p50 = percentile(finite, 50) as number;
  return {
    n: finite.length,
    mean: mean(finite) as number,
    median: p50,
    min: Math.min(...finite),
    max: Math.max(...finite),
    p50,
    p90: percentile(finite, 90) as number,
    p99: percentile(finite, 99) as number,
    stddev: sampleStdDev(finite),
    ci95: confidenceInterval95(finite)
  };
}
