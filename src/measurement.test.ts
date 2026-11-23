import axios from 'axios';
import { Readable } from 'node:stream';
import {
  benchmarkModel,
  benchmarkRepeated,
  clampRepetitions,
  parseCliArgs,
  resetTargetCache,
  resolveTarget,
  runLoadProfile,
  runSweep
} from './benchmark';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const ENV_KEYS = ['OLLAMA_API_URL', 'CI_LLM_BASE_URL', 'CI_LLM_API_KEY', 'BENCH_TRANSPORT', 'BENCH_DRIVER'] as const;

function bodyStream(chunks: string[]): Readable {
  return Readable.from(chunks.map(c => Buffer.from(c, 'utf8')));
}

function sse(chunks: Array<object | '[DONE]'>): string[] {
  return chunks.map(c => `data: ${c === '[DONE]' ? c : JSON.stringify(c)}\n\n`);
}

/** A clock that returns the given readings in order and then keeps returning the last one. */
function fakeClock(readings: number[]): () => number {
  let i = 0;
  return () => readings[Math.min(i++, readings.length - 1)];
}

const notFound = { isAxiosError: true, response: { status: 404 } };

/** One streamed completion: a content delta, then a final chunk with usage and llama.cpp timings. */
function llamaCppStream(text = 'Hi'): Readable {
  return bodyStream(sse([
    { choices: [{ delta: { content: text } }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { completion_tokens: 4, prompt_tokens: 9 },
      timings: { prompt_n: 9, prompt_per_second: 310.2, predicted_n: 4, predicted_per_second: 52.5 }
    },
    '[DONE]'
  ]));
}

function plainStream(text = 'Hi'): Readable {
  return bodyStream(sse([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {} }], usage: { completion_tokens: 4, prompt_tokens: 9 } },
    '[DONE]'
  ]));
}

describe('Measurement modes', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetTargetCache();
    mockedAxios.isAxiosError.mockImplementation((e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe('engine detection and driver labels', () => {
    it('detects llama.cpp from /props and labels the run with the engine timings', async () => {
      process.env.CI_LLM_BASE_URL = 'http://llama.local:8080';
      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.endsWith('/api/tags')) throw notFound;
        if (url.endsWith('/props')) return { data: { default_generation_settings: { n_ctx: 4096 } } };
        throw new Error(`unexpected GET ${url}`);
      });
      mockedAxios.post.mockResolvedValue({ data: llamaCppStream(), headers: {} } as any);

      const result = await benchmarkModel('local-model', 'Say hi', { now: fakeClock([0, 500, 2000]) });

      expect(result).toMatchObject({
        success: true,
        driver: 'llamacpp',
        transport: 'openai',
        seat: 'app',
        timingSource: 'llamacpp',
        decodeTokensPerSecond: 52.5,
        promptTokensPerSecond: 310.2
      });
    });

    it('falls back to the generic OpenAI driver when /props is absent too', async () => {
      process.env.CI_LLM_BASE_URL = 'http://vllm.local:8000';
      mockedAxios.get.mockRejectedValue(notFound);
      mockedAxios.post.mockResolvedValue({ data: plainStream(), headers: {} } as any);

      const result = await benchmarkModel('served-model', 'Say hi', { now: fakeClock([0, 400, 1400]) });

      expect(result).toMatchObject({ driver: 'openai', timingSource: 'client', success: true });
    });

    it('takes an explicit driver without probing the engine', async () => {
      process.env.CI_LLM_BASE_URL = 'http://lemonade.local:13305';
      const target = await resolveTarget({ driver: 'lemonade' });
      expect(target).toMatchObject({ driver: 'lemonade', transport: 'openai' });
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('honours BENCH_DRIVER over detection', async () => {
      process.env.CI_LLM_BASE_URL = 'http://engine.local:8000';
      process.env.BENCH_DRIVER = 'vllm';
      expect(await resolveTarget()).toMatchObject({ driver: 'vllm', transport: 'openai' });
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('refuses llama-bench as an endpoint driver', async () => {
      process.env.BENCH_DRIVER = 'llama-bench';
      await expect(resolveTarget()).rejects.toThrow(/npm run strix-halo/);
    });
  });

  describe('cold and warm requests', () => {
    it('marks the first request to a model on a target cold and later ones warm', async () => {
      process.env.CI_LLM_BASE_URL = 'http://engine.local:8000';
      mockedAxios.get.mockRejectedValue(notFound);
      mockedAxios.post.mockImplementation(async () => ({ data: plainStream(), headers: {} }) as any);

      const first = await benchmarkModel('m', 'Say hi', { now: fakeClock([0, 100, 200]) });
      const second = await benchmarkModel('m', 'Say hi', { now: fakeClock([0, 100, 200]) });

      expect(first.cold).toBe(true);
      expect(second.cold).toBe(false);
    });
  });

  describe('context depth', () => {
    it('prefills the requested depth, keeps the question last, and records the depth', async () => {
      process.env.CI_LLM_BASE_URL = 'http://engine.local:8000';
      mockedAxios.get.mockRejectedValue(notFound);
      mockedAxios.post.mockResolvedValue({ data: plainStream(), headers: {} } as any);

      const result = await benchmarkModel('m', 'Why is the sky blue?', { contextDepth: 200, now: fakeClock([0, 100, 200]) });

      const sent = (mockedAxios.post.mock.calls[0][1] as any).messages[0].content as string;
      expect(sent.endsWith('Why is the sky blue?')).toBe(true);
      expect(sent.length).toBeGreaterThan(200);
      expect(result).toMatchObject({ contextDepth: 200, prompt: sent });
    });
  });

  describe('repeated runs', () => {
    it('runs one batch per repetition and summarises the spread', async () => {
      process.env.CI_LLM_BASE_URL = 'http://engine.local:8000';
      mockedAxios.get.mockRejectedValue(notFound);
      mockedAxios.post.mockImplementation(async () => ({ data: plainStream(), headers: {} }) as any);

      const run = await benchmarkRepeated('m', 'Say hi', 3, 1, {});

      expect(run.results.map(r => r.repeatIndex)).toEqual([0, 1, 2]);
      expect(run.aggregates).toHaveLength(3);
      expect(run.summary.tokensPerSecond?.n).toBe(3);
      expect(run.summary.tokensPerSecond?.ci95).toBeDefined();
    });

    it('clamps the repetition count to 1..50 and treats junk as 1', () => {
      expect(clampRepetitions(0)).toBe(1);
      expect(clampRepetitions(3.7)).toBe(3);
      expect(clampRepetitions(999)).toBe(50);
      expect(clampRepetitions('x')).toBe(1);
    });
  });

  describe('load profiles', () => {
    it('sends the scheduled requests and reports latency and goodput', async () => {
      process.env.CI_LLM_BASE_URL = 'http://engine.local:8000';
      mockedAxios.get.mockRejectedValue(notFound);
      mockedAxios.post.mockImplementation(async () => ({ data: plainStream(), headers: {} }) as any);

      const run = await runLoadProfile('m', 'Say hi', {
        profile: 'constant',
        rate: 2,
        durationSeconds: 3,
        slo: { ttftMs: 1000 },
        now: () => 0,
        sleep: async () => undefined
      });

      expect(run).toMatchObject({ profile: 'constant', requests: 6, successes: 6, failures: 0, goodput: 1 });
      expect(run.ttftMs?.p50).toBe(0);
    });

    it('counts every request as a goodput miss when the SLO cannot be met', async () => {
      process.env.CI_LLM_BASE_URL = 'http://engine.local:8000';
      mockedAxios.get.mockRejectedValue(notFound);
      mockedAxios.post.mockImplementation(async () => ({ data: plainStream(), headers: {} }) as any);

      const run = await runLoadProfile('m', 'Say hi', {
        profile: 'constant',
        rate: 1,
        durationSeconds: 2,
        slo: { ttftMs: -1 },
        now: () => 0,
        sleep: async () => undefined
      });

      expect(run.goodput).toBe(0);
    });

    it('stops a sweep at the first rate where requests fail', async () => {
      process.env.CI_LLM_BASE_URL = 'http://engine.local:8000';
      mockedAxios.get.mockRejectedValue(notFound);
      mockedAxios.post.mockRejectedValue(new Error('engine overloaded'));

      const sweep = await runSweep('m', 'Say hi', {
        profile: 'constant',
        durationSeconds: 2,
        rates: [1, 2, 4],
        now: () => 0,
        sleep: async () => undefined
      });

      expect(sweep.saturatedAt).toBe(1);
      expect(sweep.runs).toHaveLength(1);
      expect(sweep.runs[0].failures).toBe(2);
    });
  });

  describe('command-line measurement flags', () => {
    it('reads the driver, depths, repetitions, profile and SLO targets', () => {
      expect(parseCliArgs(['--driver=vllm', '--depth=0,4096', '--repetitions=3', '--ttft-slo=500', '--itl-slo=80'])).toMatchObject({
        driver: 'vllm',
        depths: [0, 4096],
        repetitions: 3,
        slo: { ttftMs: 500, itlMs: 80 }
      });
      expect(parseCliArgs(['--profile=constant', '--rate=2'])).toMatchObject({ profile: 'constant', rate: 2 });
      expect(parseCliArgs(['--profile=sweep', '--rates=1,2,4'])).toMatchObject({ profile: 'sweep', rates: [1, 2, 4] });
    });

    it('fails on values it cannot use instead of measuring the default', () => {
      expect(() => parseCliArgs(['--driver=llama-bench'])).toThrow(/npm run strix-halo/);
      expect(() => parseCliArgs(['--driver=nope'])).toThrow(/Unknown driver/);
      expect(() => parseCliArgs(['--depth=-1'])).toThrow(/--depth values/);
      expect(() => parseCliArgs(['--repetitions=0'])).toThrow(/--repetitions/);
      expect(() => parseCliArgs(['--profile=weird'])).toThrow(/--profile/);
      expect(() => parseCliArgs(['--duration=abc'])).toThrow(/--duration/);
      expect(() => parseCliArgs(['--profile=poisson'])).toThrow(/needs --rate/);
      expect(() => parseCliArgs(['--profile=sweep'])).toThrow(/needs --rates/);
    });
  });
});
