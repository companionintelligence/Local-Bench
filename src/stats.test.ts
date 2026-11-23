import { confidenceInterval95, mean, percentile, sampleStdDev, summarize } from './stats';

describe('percentile', () => {
  it('interpolates linearly between ranks', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5, 10);
    expect(percentile([1, 2, 3, 4], 90)).toBeCloseTo(3.7, 10);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
  });

  it('sorts unsorted input and ignores non-finite values', () => {
    expect(percentile([4, Number.NaN, 1, 3, 2], 50)).toBeCloseTo(2.5, 10);
  });

  it('returns the single value for one sample and undefined for none', () => {
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeUndefined();
  });
});

describe('mean and sample standard deviation', () => {
  it('uses the n-1 denominator', () => {
    expect(mean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5);
    expect(sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });

  it('has no spread below two values', () => {
    expect(sampleStdDev([3])).toBeUndefined();
    expect(mean([])).toBeUndefined();
  });
});

describe('confidenceInterval95', () => {
  it('uses the Student-t critical value for the sample size', () => {
    // mean 12, s 2, n 3 -> t(0.975, 2) = 4.303 -> half-width 4.303 * 2 / sqrt(3)
    const ci = confidenceInterval95([10, 12, 14]) as { low: number; high: number };
    const half = (4.303 * 2) / Math.sqrt(3);
    expect(ci.low).toBeCloseTo(12 - half, 6);
    expect(ci.high).toBeCloseTo(12 + half, 6);
  });

  it('is undefined for a single run', () => {
    expect(confidenceInterval95([5])).toBeUndefined();
  });
});

describe('summarize', () => {
  it('reports the percentiles, spread and interval together', () => {
    const summary = summarize([10, 12, 14]);
    expect(summary).toMatchObject({ n: 3, mean: 12, median: 12, min: 10, max: 14, p50: 12 });
    expect(summary?.stddev).toBeCloseTo(2, 10);
    expect(summary?.ci95).toBeDefined();
  });

  it('is undefined when there is nothing to summarise', () => {
    expect(summarize([])).toBeUndefined();
    expect(summarize([Number.NaN])).toBeUndefined();
  });
});
