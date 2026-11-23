/**
 * Contract tests: the real benchmark code talking over real HTTP to an in-process engine
 * stub (src/testing/stubEngine.ts). Unlike the mocked suites, nothing between the runner and
 * the socket is faked, so these catch wire-format and parsing mistakes.
 */
import * as path from 'path';
import { benchmarkModel, resetTargetCache, resolveTarget, runLoadProfile } from './benchmark';
import { startStubEngine, StubEngine, StubOptions } from './testing/stubEngine';

// A real streamed generation captured from a local Ollama (gemma3:1b).
const OLLAMA_CAPTURE = path.join(__dirname, '__fixtures__', 'ollama-generate-stream.ndjson');

const ENV_KEYS = ['OLLAMA_API_URL', 'CI_LLM_BASE_URL', 'CI_LLM_API_KEY', 'BENCH_TRANSPORT', 'BENCH_DRIVER'] as const;
const POOL_HEADERS = {
  'x-hub-pool-served-by': 'beta-max.tail1234.ts.net',
  'x-hub-pool-backend': 'vllm',
  'x-hub-pool-request-id': 'req-42'
};

describe('Engine contract over HTTP', () => {
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
    it('reads TTFT, Ollama eval timings and the cold load from a real captured stream', async () => {
      const server = await stub({ engine: 'ollama', ollamaFixture: OLLAMA_CAPTURE });
      process.env.OLLAMA_API_URL = server.url;

      const result = await benchmarkModel('gemma3:1b', 'Say hello in five words.', { stream: true });

      expect(result).toMatchObject({
        success: true,
        driver: 'ollama',
        transport: 'ollama',
        timingSource: 'ollama',
        seat: 'app',
        totalTokens: 8,
        promptTokens: 16,
        cold: true
      });
      expect(result.ttftMs).toBeGreaterThanOrEqual(0);
      expect(result.loadMs).toBeCloseTo(5689.84, 1);
      expect(result.decodeTokensPerSecond).toBeCloseTo(8 / 0.108956, 1);
      expect(result.promptTokensPerSecond).toBeCloseTo(17.19, 1);
    });

    it('reports the same engine timings when the reply is not streamed', async () => {
      const server = await stub({ engine: 'ollama', reply: 'one two three four five six seven eight' });
      process.env.OLLAMA_API_URL = server.url;

      const result = await benchmarkModel('gemma3:1b', 'hi', { stream: false });

      expect(result).toMatchObject({ success: true, timingSource: 'ollama', totalTokens: 8 });
      expect(result.decodeTokensPerSecond).toBeCloseTo(8 / 0.05, 1);
    });

    it('surfaces an error line in the stream as a failed row', async () => {
      const server = await stub({ engine: 'ollama', streamError: 'model requires more memory' });
      process.env.OLLAMA_API_URL = server.url;

      const result = await benchmarkModel('gemma3:1b', 'hi', { stream: true });

      expect(result).toMatchObject({ success: false, error: 'model requires more memory' });
    });

    it('sends the Bearer token the engine requires, and fails without it', async () => {
      const server = await stub({ engine: 'ollama', requireToken: 'secret' });
      process.env.OLLAMA_API_URL = server.url;

      process.env.CI_LLM_API_KEY = 'secret';
      expect(await benchmarkModel('gemma3:1b', 'hi', { stream: true })).toMatchObject({ success: true });

      delete process.env.CI_LLM_API_KEY;
      expect(await benchmarkModel('gemma3:1b', 'hi', { stream: true })).toMatchObject({ success: false, error: expect.stringContaining('401') });
    });

    it('records the Hub pool headers on every row', async () => {
      const server = await stub({ engine: 'ollama', headers: { 'x-hub-pool-served-by': POOL_HEADERS['x-hub-pool-served-by'], 'x-hub-pool-backend': 'ollama', 'x-hub-pool-request-id': 'req-7' } });
      process.env.OLLAMA_API_URL = server.url;

      const result = await benchmarkModel('gemma3:1b', 'hi', { stream: true });

      expect(result).toMatchObject({ success: true, path: 'pool', servedBy: 'beta-max.tail1234.ts.net', backend: 'ollama', requestId: 'req-7' });
    });

    it('sends the prefilled depth to the engine, with the question last', async () => {
      const server = await stub({ engine: 'ollama' });
      process.env.OLLAMA_API_URL = server.url;

      const result = await benchmarkModel('gemma3:1b', 'Why is the sky blue?', { stream: true, contextDepth: 300 });

      const sent = server.requests.find(request => request.url === '/api/generate')?.body.prompt as string;
      expect(sent.length).toBeGreaterThan(300);
      expect(sent.endsWith('Why is the sky blue?')).toBe(true);
      expect(result).toMatchObject({ success: true, contextDepth: 300, prompt: sent });
    });
  });

  describe('OpenAI-compatible wire', () => {
    it('counts tokens from the usage the engine returns', async () => {
      const server = await stub({ engine: 'openai', reply: 'one two three four' });
      process.env.CI_LLM_BASE_URL = server.url;

      const result = await benchmarkModel('stub-model', 'Say hi now', { stream: true });

      expect(result).toMatchObject({ success: true, driver: 'openai', transport: 'openai', timingSource: 'client', totalTokens: 4, promptTokens: 3 });
      expect(result.ttftMs).toBeGreaterThanOrEqual(0);
    });

    it('counts content deltas when the engine ignores stream_options', async () => {
      const server = await stub({ engine: 'openai', reply: 'one two three four', omitUsage: true });
      process.env.CI_LLM_BASE_URL = server.url;

      const result = await benchmarkModel('stub-model', 'Say hi now', { stream: true });

      expect(result).toMatchObject({ success: true, totalTokens: 4 });
    });

    it('falls back to a plain request when the engine rejects streaming options', async () => {
      const server = await stub({ engine: 'openai', reply: 'one two three four', rejectStreamOptions: true });
      process.env.CI_LLM_BASE_URL = server.url;

      const result = await benchmarkModel('stub-model', 'Say hi now', { stream: true });

      expect(result).toMatchObject({ success: true, totalTokens: 4 });
      expect(result.ttftMs).toBeUndefined();
      expect(server.requests.filter(request => request.url === '/v1/chat/completions')).toHaveLength(2);
    });

    it('sends the prefilled depth through the OpenAI wire, with the question last', async () => {
      const server = await stub({ engine: 'openai' });
      process.env.CI_LLM_BASE_URL = server.url;

      const result = await benchmarkModel('stub-model', 'Why is the sky blue?', { stream: true, contextDepth: 300 });

      const chat = server.requests.find(request => request.url === '/v1/chat/completions');
      const sent = chat?.body.messages[0].content as string;
      expect(sent.length).toBeGreaterThan(300);
      expect(sent.endsWith('Why is the sky blue?')).toBe(true);
      expect(result).toMatchObject({ success: true, contextDepth: 300 });
    });

    it('surfaces an error chunk in the stream as a failed row', async () => {
      const server = await stub({ engine: 'openai', streamError: 'context length exceeded' });
      process.env.CI_LLM_BASE_URL = server.url;

      const result = await benchmarkModel('stub-model', 'hi', { stream: true });

      expect(result).toMatchObject({ success: false, error: 'context length exceeded' });
    });

    it('sends the bearer token and fails loudly without it', async () => {
      const server = await stub({ engine: 'openai', requireToken: 'secret' });
      process.env.CI_LLM_BASE_URL = server.url;

      process.env.CI_LLM_API_KEY = 'secret';
      expect(await benchmarkModel('stub-model', 'hi', { stream: true })).toMatchObject({ success: true });
      expect(server.requests[0].headers.authorization).toBe('Bearer secret');

      delete process.env.CI_LLM_API_KEY;
      expect(await benchmarkModel('stub-model', 'hi', { stream: true })).toMatchObject({ success: false, error: expect.stringContaining('401') });
    });

    it('records the Hub pool headers and marks the row as routed through the pool', async () => {
      const server = await stub({ engine: 'openai', headers: POOL_HEADERS });
      process.env.CI_LLM_BASE_URL = server.url;

      const result = await benchmarkModel('stub-model', 'hi', { stream: true });

      expect(result).toMatchObject({ success: true, path: 'pool', servedBy: 'beta-max.tail1234.ts.net', backend: 'vllm', requestId: 'req-42' });
    });

    it('takes a named profile through the same wire, labelled with the profile', async () => {
      const server = await stub({ engine: 'openai' });
      process.env.CI_LLM_BASE_URL = server.url;
      process.env.BENCH_DRIVER = 'vllm';

      const result = await benchmarkModel('stub-model', 'hi', { stream: true });

      expect(result).toMatchObject({ success: true, driver: 'vllm', transport: 'openai' });
      expect(server.requests.some(request => request.url === '/api/tags')).toBe(false);
    });
  });

  describe('llama.cpp server', () => {
    it('detects llama-server, reads its timings and context window into the row', async () => {
      const server = await stub({ engine: 'llamacpp', timings: true, reply: 'one two three four' });
      process.env.CI_LLM_BASE_URL = server.url;

      const result = await benchmarkModel('local.gguf', 'Say hi now', { stream: true });

      expect(result).toMatchObject({
        success: true,
        driver: 'llamacpp',
        transport: 'openai',
        timingSource: 'llamacpp',
        decodeTokensPerSecond: 52.5,
        promptTokensPerSecond: 310.2,
        contextWindow: 4096
      });
    });

    it('reads the same timings from a non-streamed reply', async () => {
      const server = await stub({ engine: 'llamacpp', timings: true, reply: 'one two three four' });
      process.env.CI_LLM_BASE_URL = server.url;

      const result = await benchmarkModel('local.gguf', 'Say hi now', { stream: false });

      expect(result).toMatchObject({ success: true, timingSource: 'llamacpp', decodeTokensPerSecond: 52.5 });
    });

    it('is not mistaken for llama-server when /props is absent', async () => {
      const server = await stub({ engine: 'openai' });
      process.env.CI_LLM_BASE_URL = server.url;

      expect((await resolveTarget()).driver).toBe('openai');
    });
  });

  describe('load profiles over HTTP', () => {
    it('sends every scheduled request and reports the successes', async () => {
      const server = await stub({ engine: 'openai', reply: 'one two' });
      process.env.CI_LLM_BASE_URL = server.url;

      const run = await runLoadProfile('stub-model', 'hi', {
        profile: 'constant',
        rate: 4,
        durationSeconds: 1,
        slo: { ttftMs: 60000 }
      });

      expect(run).toMatchObject({ requests: 4, successes: 4, failures: 0, goodput: 1 });
      expect(server.requests.filter(request => request.url === '/v1/chat/completions')).toHaveLength(4);
    });
  });
});
