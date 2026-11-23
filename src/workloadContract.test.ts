/**
 * Contract tests for fixed workloads and engine metadata: the real runners talking over real
 * HTTP to the in-process engine stub (src/testing/stubEngine.ts). The conformance matrix points
 * its generation-cap, engine-metadata and loaded-memory cells at these tests.
 */
import { benchmarkModel, benchmarkModelConcurrently, resetTargetCache, runScaling } from './benchmark';
import { parseScenario } from './workloads';
import {
  startStubEngine,
  StubEngine,
  StubOptions,
  STUB_LLAMACPP_BUILD,
  STUB_LLAMACPP_SLOTS,
  STUB_OLLAMA_CONTEXT,
  STUB_OLLAMA_DIGEST,
  STUB_OLLAMA_VERSION,
  STUB_OLLAMA_VRAM_BYTES
} from './testing/stubEngine';

const ENV_KEYS = ['OLLAMA_API_URL', 'CI_LLM_BASE_URL', 'CI_LLM_API_KEY', 'BENCH_TRANSPORT', 'BENCH_DRIVER'] as const;

describe('Fixed workloads and engine metadata over HTTP', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let engine: StubEngine | undefined;

  async function stub(options: StubOptions): Promise<StubEngine> {
    engine = await startStubEngine(options);
    return engine;
  }

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetTargetCache();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await engine?.close();
    engine = undefined;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe('Ollama native API', () => {
    it('stops at the generation cap and reports done_reason length', async () => {
      const server = await stub({ engine: 'ollama', generateTokens: 64 });
      process.env.OLLAMA_API_URL = server.url;

      const result = await benchmarkModel('gemma3:1b', undefined, { stream: true, scenario: parseScenario('pp16+tg8') });

      const sent = server.requests.find(request => request.url === '/api/generate')?.body;
      expect(sent.options).toEqual({ num_predict: 8 });
      expect(sent.prompt).toMatch(/^Session [0-9a-f-]{36}\./);
      expect(result).toMatchObject({
        success: true,
        scenario: 'pp16+tg8',
        requestedPromptTokens: 16,
        requestedGenTokens: 8,
        totalTokens: 8,
        finishReason: 'length'
      });
    });

    it('reports done_reason stop when the model ends before the cap', async () => {
      const server = await stub({ engine: 'ollama', generateTokens: 4 });
      process.env.OLLAMA_API_URL = server.url;

      const result = await benchmarkModel('gemma3:1b', undefined, { stream: true, scenario: parseScenario('pp16+tg8') });

      expect(result).toMatchObject({ success: true, totalTokens: 4, finishReason: 'stop' });
    });

    it('reads the engine version, model digest and quantization from its own endpoints', async () => {
      const server = await stub({ engine: 'ollama' });
      process.env.OLLAMA_API_URL = server.url;

      const result = await benchmarkModel('gemma3:1b', 'Say hello.', { stream: true });

      expect(result.engine).toEqual({
        engineVersion: STUB_OLLAMA_VERSION,
        modelDigest: STUB_OLLAMA_DIGEST,
        modelFamily: 'gemma3',
        modelFormat: 'gguf',
        parameterSize: '999.89M',
        quantization: 'Q4_K_M'
      });
    });

    it('reads GPU memory and runtime context from /api/ps after the run', async () => {
      const server = await stub({ engine: 'ollama' });
      process.env.OLLAMA_API_URL = server.url;

      const result = await benchmarkModel('gemma3:1b', 'Say hello.', { stream: true });

      expect(result).toMatchObject({ vramBytes: STUB_OLLAMA_VRAM_BYTES, contextWindow: STUB_OLLAMA_CONTEXT });
    });

    it('attaches the power draw and tokens per joule to a concurrent batch', async () => {
      const server = await stub({ engine: 'ollama', generateTokens: 16 });
      process.env.OLLAMA_API_URL = server.url;

      const batch = await benchmarkModelConcurrently('gemma3:1b', undefined, 2, {
        stream: true,
        measurePower: {
          platform: 'linux',
          intervalMs: 5,
          run: (_command, args) => (args.includes('--version') ? Promise.resolve('ok') : Promise.resolve('200\n100\n'))
        }
      });

      expect(batch.aggregate).toMatchObject({ powerWatts: 300, powerSource: 'nvidia-smi', vramBytes: STUB_OLLAMA_VRAM_BYTES });
      expect(batch.aggregate.tokensPerJoule).toBeCloseTo(batch.aggregate.aggregateTokensPerSecond / 300, 3);
      for (const row of batch.results) {
        expect(row).toMatchObject({ powerWatts: 300, powerSource: 'nvidia-smi', vramBytes: STUB_OLLAMA_VRAM_BYTES });
      }
    });

    it('runs a scaling curve, one burst per concurrency level', async () => {
      const server = await stub({ engine: 'ollama' });
      process.env.OLLAMA_API_URL = server.url;

      const scaling = await runScaling('gemma3:1b', undefined, [1, 2], { stream: true });

      expect(scaling.levels.map(level => level.concurrency)).toEqual([1, 2]);
      expect(scaling.results).toHaveLength(3);
      expect(scaling.levels[1].aggregate).toMatchObject({ concurrency: 2, successes: 2, failures: 0 });
    });
  });

  describe('OpenAI-compatible wire', () => {
    it('caps generation with max_tokens and reports finish_reason', async () => {
      const server = await stub({ engine: 'openai', generateTokens: 64 });
      process.env.CI_LLM_BASE_URL = server.url;

      const result = await benchmarkModel('stub-model', undefined, { stream: true, scenario: parseScenario('pp16+tg8') });

      const sent = server.requests.find(request => request.url === '/v1/chat/completions')?.body;
      expect(sent.max_tokens).toBe(8);
      expect(sent).not.toHaveProperty('ignore_eos');
      expect(result).toMatchObject({ success: true, driver: 'openai', totalTokens: 8, finishReason: 'length' });
    });
  });

  describe('llama.cpp server', () => {
    it('sends ignore_eos to llama-server so a capped run reaches the cap', async () => {
      const server = await stub({ engine: 'llamacpp', generateTokens: 64 });
      process.env.CI_LLM_BASE_URL = server.url;

      const result = await benchmarkModel('local.gguf', undefined, { stream: true, scenario: parseScenario('pp16+tg8') });

      const sent = server.requests.find(request => request.url === '/v1/chat/completions')?.body;
      expect(sent).toMatchObject({ max_tokens: 8, ignore_eos: true });
      expect(result).toMatchObject({ success: true, driver: 'llamacpp', totalTokens: 8, finishReason: 'length' });
    });

    it('reads llama-server build, context window and slot count from /props', async () => {
      const server = await stub({ engine: 'llamacpp' });
      process.env.CI_LLM_BASE_URL = server.url;

      const result = await benchmarkModel('local.gguf', 'Say hi now', { stream: true });

      expect(result.engine).toMatchObject({
        engineVersion: STUB_LLAMACPP_BUILD,
        contextWindow: 4096,
        slots: STUB_LLAMACPP_SLOTS,
        modelBytes: 1100000000
      });
    });
  });
});
