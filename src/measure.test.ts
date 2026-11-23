import {
  arrivalOffsetsMs,
  buildDepthPrompt,
  goodputFraction,
  interTokenLatencyMs,
  meetsSlo,
  mulberry32,
  parseContextDepth
} from './measure';

describe('parseContextDepth', () => {
  it('accepts integers from 0 to 32768, as numbers or numeric strings', () => {
    expect(parseContextDepth(0)).toBe(0);
    expect(parseContextDepth('4096')).toBe(4096);
    expect(parseContextDepth(32768)).toBe(32768);
  });

  it('rejects anything else', () => {
    expect(parseContextDepth(32769)).toBeUndefined();
    expect(parseContextDepth(-1)).toBeUndefined();
    expect(parseContextDepth(1.5)).toBeUndefined();
    expect(parseContextDepth('abc')).toBeUndefined();
    expect(parseContextDepth('')).toBeUndefined();
    expect(parseContextDepth(null)).toBeUndefined();
  });
});

describe('buildDepthPrompt', () => {
  it('returns the question unchanged at depth 0', () => {
    expect(buildDepthPrompt('Why is the sky blue?', 0)).toBe('Why is the sky blue?');
  });

  it('starts each prompt with a nonce, so no two requests share a prefix', () => {
    const a = buildDepthPrompt('Why?', 100, 'run-1');
    const b = buildDepthPrompt('Why?', 100, 'run-2');
    expect(a.startsWith('Session run-1.')).toBe(true);
    expect(a.slice(0, 16)).not.toBe(b.slice(0, 16));
    expect(a.endsWith('\n\nWhy?')).toBe(true);
  });

  it('puts about depth/10 filler sentences before the question', () => {
    const prompt = buildDepthPrompt('Why is the sky blue?', 100);
    expect(prompt.endsWith('\n\nWhy is the sky blue?')).toBe(true);
    expect(prompt.split('The quick brown fox jumps over the lazy dog.').length - 1).toBe(10);
  });
});

describe('arrivalOffsetsMs', () => {
  it('spaces constant arrivals evenly, none at or after the duration', () => {
    expect(arrivalOffsetsMs({ profile: 'constant', rate: 2, durationSeconds: 3 })).toEqual([0, 500, 1000, 1500, 2000, 2500]);
  });

  it('schedules nothing for a non-positive rate or duration', () => {
    expect(arrivalOffsetsMs({ profile: 'constant', rate: 0, durationSeconds: 3 })).toEqual([]);
    expect(arrivalOffsetsMs({ profile: 'poisson', rate: 2, durationSeconds: 0 })).toEqual([]);
  });

  it('is reproducible for a seed and stays inside the window', () => {
    const first = arrivalOffsetsMs({ profile: 'poisson', rate: 10, durationSeconds: 60, seed: 7 });
    const second = arrivalOffsetsMs({ profile: 'poisson', rate: 10, durationSeconds: 60, seed: 7 });
    expect(first).toEqual(second);
    expect(first.every(ms => ms >= 0 && ms < 60000)).toBe(true);
    expect(first.every((ms, i) => i === 0 || ms > first[i - 1])).toBe(true);
    // About rate x duration = 600 arrivals; a seeded schedule should land well inside this band.
    expect(first.length).toBeGreaterThan(520);
    expect(first.length).toBeLessThan(680);
  });

  it('draws different schedules for different seeds', () => {
    const a = arrivalOffsetsMs({ profile: 'poisson', rate: 5, durationSeconds: 10, seed: 1 });
    const b = arrivalOffsetsMs({ profile: 'poisson', rate: 5, durationSeconds: 10, seed: 2 });
    expect(a).not.toEqual(b);
  });
});

describe('mulberry32', () => {
  it('returns values in [0, 1) that repeat for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const value = a();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(value).toBe(b());
    }
  });
});

describe('interTokenLatencyMs', () => {
  it('is the mean gap after the first token', () => {
    expect(interTokenLatencyMs({ durationSeconds: 2, ttftMs: 500, totalTokens: 31 })).toBeCloseTo(50, 10);
  });

  it('is undefined without TTFT or with fewer than two tokens', () => {
    expect(interTokenLatencyMs({ durationSeconds: 2, totalTokens: 31 })).toBeUndefined();
    expect(interTokenLatencyMs({ durationSeconds: 2, ttftMs: 500, totalTokens: 1 })).toBeUndefined();
  });
});

describe('SLO goodput', () => {
  const fast = { success: true, durationSeconds: 1.0, ttftMs: 300, totalTokens: 11 }; // itl 70 ms
  const slow = { success: true, durationSeconds: 2.0, ttftMs: 900, totalTokens: 11 }; // itl 110 ms
  const failed = { success: false, durationSeconds: 0.5, ttftMs: 100, totalTokens: 0 };

  it('requires every stated target to hold', () => {
    const slo = { ttftMs: 500, itlMs: 100 };
    expect(meetsSlo(fast, slo)).toBe(true);
    expect(meetsSlo(slow, slo)).toBe(false);
    expect(meetsSlo(failed, slo)).toBe(false);
  });

  it('counts failures as misses in the goodput share', () => {
    expect(goodputFraction([fast, slow, failed], { ttftMs: 500, itlMs: 100 })).toBeCloseTo(1 / 3, 10);
    expect(goodputFraction([], { ttftMs: 500 })).toBeUndefined();
  });
});
