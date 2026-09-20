import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'node:stream';
import {
  benchmarkModel,
  benchmarkModelConcurrently,
  checkModelAvailable,
  clampConcurrency,
  computeAggregate,
  computeDecodeTokensPerSecond,
  detectTransport,
  getConfiguredBaseUrl,
  getOllamaModelCatalog,
  normaliseBaseUrl,
  parseCliArgs,
  parseNdjsonLine,
  parseSseLine,
  readPoolHeaders,
  resetTargetCache,
  resolveTarget,
  saveResultsToCSV,
  saveResultsToDatabase,
  BenchmarkResult,
  SUPPORTED_OLLAMA_MODELS,
  TEST_PROMPTS,
  INTELLIGENCE_INDEX_SOURCE,
  INTELLIGENCE_INDEX_URL,
  INTELLIGENCE_INDEX_AS_OF
} from './benchmark';
import * as database from './database';
import * as systemSpecs from './systemSpecs';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock fs
jest.mock('fs');
const mockedFs = fs as jest.Mocked<typeof fs>;

// Mock database module
jest.mock('./database');
const mockedDatabase = database as jest.Mocked<typeof database>;

// Mock systemSpecs module
jest.mock('./systemSpecs');
const mockedSystemSpecs = systemSpecs as jest.Mocked<typeof systemSpecs>;

const ENV_KEYS = ['OLLAMA_API_URL', 'CI_LLM_BASE_URL', 'CI_LLM_API_KEY', 'BENCH_TRANSPORT'] as const;

/** A stream the way axios hands one back with responseType: 'stream'. */
function bodyStream(chunks: string[]): Readable {
  return Readable.from(chunks.map(c => Buffer.from(c, 'utf8')));
}

function ndjson(lines: object[]): string[] {
  return lines.map(l => JSON.stringify(l) + '\n');
}

function sse(chunks: Array<object | '[DONE]'>): string[] {
  return chunks.map(c => `data: ${c === '[DONE]' ? c : JSON.stringify(c)}\n\n`);
}

/** A clock that returns the given readings in order and then keeps returning the last one. */
function fakeClock(readings: number[]): () => number {
  let i = 0;
  return () => readings[Math.min(i++, readings.length - 1)];
}

const NO_STREAM = { stream: false as const };

const POOL_HEADERS = {
  'x-hub-pool-served-by': 'beta-max.tail1234.ts.net',
  'x-hub-pool-backend': 'ollama',
  'x-hub-pool-model': 'qwen3:8b',
  'x-hub-pool-request-id': 'req-42'
};

describe('Benchmark Module', () => {
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
    // Default: the target answers /api/tags, so the transport probe picks 'ollama'.
    mockedAxios.get.mockResolvedValue({ data: { models: [] } });
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

  describe('checkModelAvailable', () => {
    it('should return true if model is available', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          models: [
            { name: 'llama2:latest' },
            { name: 'mistral:latest' }
          ]
        }
      });

      const result = await checkModelAvailable('llama2');
      expect(result).toBe(true);
    });

    it('should return false if model is not available', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          models: [
            { name: 'llama2:latest' }
          ]
        }
      });

      const result = await checkModelAvailable('mistral');
      expect(result).toBe(false);
    });

    it('should return false on API error', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Connection error'));

      const result = await checkModelAvailable('llama2');
      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error checking models'));
    });

    it('should handle missing models array', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {}
      });

      const result = await checkModelAvailable('llama2');
      expect(result).toBe(false);
    });
  });

  describe('benchmarkModel (non-streaming Ollama)', () => {
    it('should successfully benchmark a model', async () => {
      const mockResponse = {
        data: {
          response: 'Test response about AI',
          eval_count: 100
        }
      };

      mockedAxios.post.mockResolvedValue(mockResponse);

      const result = await benchmarkModel('llama2', undefined, { ...NO_STREAM, now: fakeClock([0, 2_000]) });

      expect(result.success).toBe(true);
      expect(result.model).toBe('llama2');
      expect(result.totalTokens).toBe(100);
      expect(result.durationSeconds).toBe(2);
      expect(result.tokensPerSecond).toBe(50);
      expect(result.timestamp).toBeTruthy();
      expect(result.error).toBeUndefined();
    });

    it('should handle model with no tokens generated', async () => {
      const mockResponse = {
        data: {
          response: 'Test response',
          eval_count: 0
        }
      };

      mockedAxios.post.mockResolvedValue(mockResponse);

      const result = await benchmarkModel('test-model', undefined, NO_STREAM);

      expect(result.success).toBe(true);
      expect(result.totalTokens).toBe(0);
      expect(result.tokensPerSecond).toBe(0);
    });

    it('should handle API errors gracefully', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Model not found'));

      const result = await benchmarkModel('nonexistent-model', undefined, NO_STREAM);

      expect(result.success).toBe(false);
      expect(result.model).toBe('nonexistent-model');
      expect(result.totalTokens).toBe(0);
      expect(result.tokensPerSecond).toBe(0);
      expect(result.error).toBe('Model not found');
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error benchmarking'));
    });

    it('should handle timeout errors', async () => {
      mockedAxios.post.mockRejectedValue(new Error('timeout of 120000ms exceeded'));

      const result = await benchmarkModel('slow-model', undefined, NO_STREAM);

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('should call Ollama API with correct parameters', async () => {
      const mockResponse = {
        data: {
          response: 'Test response',
          eval_count: 50
        }
      };

      mockedAxios.post.mockResolvedValue(mockResponse);

      await benchmarkModel('test-model', undefined, NO_STREAM);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/generate'),
        expect.objectContaining({
          model: 'test-model',
          prompt: expect.any(String),
          stream: false
        }),
        expect.objectContaining({
          timeout: 120000
        })
      );
    });

    it('should use custom prompt when provided', async () => {
      const mockResponse = {
        data: {
          response: 'Custom response',
          eval_count: 75
        }
      };

      mockedAxios.post.mockResolvedValue(mockResponse);
      const customPrompt = 'Write a haiku about programming.';

      await benchmarkModel('test-model', customPrompt, NO_STREAM);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/generate'),
        expect.objectContaining({
          model: 'test-model',
          prompt: customPrompt,
          stream: false
        }),
        expect.objectContaining({
          timeout: 120000
        })
      );
    });

    it('should use default prompt when no custom prompt is provided', async () => {
      const mockResponse = {
        data: {
          response: 'Default response',
          eval_count: 60
        }
      };

      mockedAxios.post.mockResolvedValue(mockResponse);

      await benchmarkModel('test-model', undefined, NO_STREAM);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/generate'),
        expect.objectContaining({
          prompt: TEST_PROMPTS[0].prompt // Should use default (first) prompt
        }),
        expect.any(Object)
      );
    });
  });

  describe('TEST_PROMPTS', () => {
    it('should have multiple test prompts defined', () => {
      expect(TEST_PROMPTS.length).toBeGreaterThan(8);
    });

    it('should have required properties for each prompt', () => {
      TEST_PROMPTS.forEach(prompt => {
        expect(prompt).toHaveProperty('id');
        expect(prompt).toHaveProperty('name');
        expect(prompt).toHaveProperty('prompt');
        expect(prompt).toHaveProperty('description');
        expect(prompt).toHaveProperty('category');
        expect(prompt).toHaveProperty('type');
        expect(typeof prompt.id).toBe('string');
        expect(typeof prompt.name).toBe('string');
        expect(typeof prompt.prompt).toBe('string');
        expect(typeof prompt.description).toBe('string');
        expect(typeof prompt.category).toBe('string');
        expect(typeof prompt.type).toBe('string');
      });
    });

    it('should have unique IDs for each prompt', () => {
      const ids = TEST_PROMPTS.map(p => p.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should have non-empty prompts', () => {
      TEST_PROMPTS.forEach(prompt => {
        expect(prompt.prompt.trim().length).toBeGreaterThan(0);
      });
    });

    it('should cover multiple benchmark categories and types', () => {
      const categories = new Set(TEST_PROMPTS.map(prompt => prompt.category));
      const types = new Set(TEST_PROMPTS.map(prompt => prompt.type));

      expect(categories.size).toBeGreaterThan(4);
      expect(types.size).toBeGreaterThan(6);
    });
  });

  describe('intelligence index', () => {
    it('should expose intelligence-index source attribution', () => {
      expect(INTELLIGENCE_INDEX_SOURCE).toMatch(/Artificial Analysis/i);
      expect(INTELLIGENCE_INDEX_URL).toMatch(/^https?:\/\//);
      expect(typeof INTELLIGENCE_INDEX_AS_OF).toBe('string');
      expect(INTELLIGENCE_INDEX_AS_OF.length).toBeGreaterThan(0);
    });

    it('should define an intelligenceIndex (number or null) for every curated model', () => {
      SUPPORTED_OLLAMA_MODELS.forEach(model => {
        expect(model).toHaveProperty('intelligenceIndex');
        const score = model.intelligenceIndex;
        const isNumberOrNull = score === null || typeof score === 'number';
        expect(isNumberOrNull).toBe(true);
        if (typeof score === 'number') {
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(100);
        }
      });
    });

    it('should name every curated model with a reference Ollama can actually resolve', () => {
      // `minmax m2` shipped in this list for months: a misspelling of MiniMax M2 whose
      // SPACE made it a reference `ollama pull` can never take, so the row could not be
      // installed, matched against an installed model, or benchmarked — it existed only
      // as rank #2 of the intelligence list under a name nobody can use. A name is a
      // valid reference when it is [namespace/]model[:tag] over the characters a registry
      // path allows; whitespace is the tell.
      const REFERENCE = /^(?:[a-z0-9][a-z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/;
      const bad = SUPPORTED_OLLAMA_MODELS.filter(m => !REFERENCE.test(m.name)).map(m => m.name);
      expect(bad).toEqual([]);
    });

    it('should not list the same model twice', () => {
      const names = SUPPORTED_OLLAMA_MODELS.map(m => m.name);
      expect(names.length).toBe(new Set(names).size);
    });

    it('should rate at least the flagship text models and leave vision-only models unrated', () => {
      const byName = new Map(SUPPORTED_OLLAMA_MODELS.map(m => [m.name, m]));
      expect(byName.get('gpt-oss:120b')?.intelligenceIndex).toBeGreaterThan(0);
      expect(byName.get('qwen3:235b')?.intelligenceIndex).toBeGreaterThan(0);
      // Vision-only variants are not individually rated by the intelligence index.
      expect(byName.get('qwen3-vl:235b')?.intelligenceIndex).toBeNull();
    });
  });

  describe('getOllamaModelCatalog', () => {
    it('should include the curated supported Ollama catalog', () => {
      const catalog = getOllamaModelCatalog();

      expect(catalog.length).toBeGreaterThanOrEqual(SUPPORTED_OLLAMA_MODELS.length);
      expect(catalog[0]).toHaveProperty('installed');
      expect(catalog[0]).toHaveProperty('supported');
      expect(catalog[0]).toHaveProperty('inputs');
      expect(catalog[0]).toHaveProperty('intelligenceIndex');
    });

    it('should set intelligenceIndex to null for installed-only (non-catalog) models', () => {
      const catalog = getOllamaModelCatalog([
        { name: 'custom-model:latest', size: 512 * 1024 * 1024 }
      ] as any);
      const installedOnlyModel = catalog.find(model => model.name === 'custom-model:latest');
      expect(installedOnlyModel?.intelligenceIndex).toBeNull();
    });

    it('should mark installed catalog models and include installed-only models', () => {
      const installedModels = [
        { name: 'qwen3:8b', size: 5 * 1024 * 1024 * 1024 },
        { name: 'custom-model:latest', size: 512 * 1024 * 1024 }
      ];

      const catalog = getOllamaModelCatalog(installedModels as any);
      const installedCatalogModel = catalog.find(model => model.name === 'qwen3:8b');
      const installedOnlyModel = catalog.find(model => model.name === 'custom-model:latest');

      expect(installedCatalogModel?.installed).toBe(true);
      expect(installedCatalogModel?.supported).toBe(true);
      expect(installedOnlyModel).toMatchObject({
        name: 'custom-model:latest',
        installed: true,
        supported: false,
        source: 'installed'
      });
      expect(installedOnlyModel?.size).toBe('512MB');
    });

    it('should preserve zero-byte installed model sizes instead of dropping them', () => {
      const catalog = getOllamaModelCatalog([
        { name: 'empty-model:latest', size: 0 }
      ] as any);

      expect(catalog.find(model => model.name === 'empty-model:latest')?.size).toBe('0B');
    });
  });

  describe('saveResultsToCSV', () => {
    it('should save results to CSV file with correct format', () => {
      const results = [
        {
          model: 'llama2',
          tokensPerSecond: 45.23,
          totalTokens: 120,
          durationSeconds: 2.65,
          timestamp: '2024-01-15T10:30:00.000Z',
          success: true
        },
        {
          model: 'mistral',
          tokensPerSecond: 52.18,
          totalTokens: 125,
          durationSeconds: 2.40,
          timestamp: '2024-01-15T10:32:30.000Z',
          success: true
        }
      ];

      saveResultsToCSV(results);

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('benchmark_results.csv'),
        expect.stringContaining('Model,Tokens Per Second,Total Tokens,Duration (s),Timestamp,Status'),
        'utf8'
      );

      const csvContent = (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1];
      expect(csvContent).toContain('llama2,45.23,120,2.65,2024-01-15T10:30:00.000Z,Success');
      expect(csvContent).toContain('mistral,52.18,125,2.4,2024-01-15T10:32:30.000Z,Success');
    });

    it('should handle failed benchmarks in CSV', () => {
      const results = [
        {
          model: 'failed-model',
          tokensPerSecond: 0,
          totalTokens: 0,
          durationSeconds: 0,
          timestamp: '2024-01-15T10:30:00.000Z',
          success: false,
          error: 'Model not found'
        }
      ];

      saveResultsToCSV(results);

      const csvContent = (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1];
      expect(csvContent).toContain('failed-model,0,0,0,2024-01-15T10:30:00.000Z,Failed');
    });

    it('should handle empty results array', () => {
      const results: any[] = [];

      saveResultsToCSV(results);

      expect(mockedFs.writeFileSync).toHaveBeenCalled();
      const csvContent = (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1];
      expect(csvContent).toContain('Model,Tokens Per Second,Total Tokens,Duration (s),Timestamp,Status');
    });

    it('should log success message', () => {
      const results = [
        {
          model: 'test-model',
          tokensPerSecond: 10,
          totalTokens: 50,
          durationSeconds: 5,
          timestamp: '2024-01-15T10:30:00.000Z',
          success: true
        }
      ];

      saveResultsToCSV(results);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Results saved to'));
    });
  });

  describe('CSV file path', () => {
    it('should create CSV in the correct location', () => {
      const results = [
        {
          model: 'test',
          tokensPerSecond: 10,
          totalTokens: 50,
          durationSeconds: 5,
          timestamp: '2024-01-15T10:30:00.000Z',
          success: true
        }
      ];

      saveResultsToCSV(results);

      const filePath = (mockedFs.writeFileSync as jest.Mock).mock.calls[0][0];
      expect(filePath).toContain('benchmark_results.csv');
    });
  });

  describe('saveResultsToDatabase', () => {
    beforeEach(() => {
      // Reset mocks for this describe block
      mockedDatabase.initDatabase.mockReturnValue({} as any);
      mockedDatabase.saveSystemSpecs.mockReturnValue(1);
      mockedDatabase.saveBenchmarkResults.mockReturnValue(undefined);
    });

    it('should initialize database and save results', async () => {
      const mockSpecs = {
        serverName: 'test-server',
        cpuModel: 'Test CPU',
        cpuCores: 8,
        cpuThreads: 16,
        totalMemoryGB: 32,
        osType: 'linux',
        osVersion: 'Ubuntu 22.04',
        gpus: [{ model: 'Test GPU' }]
      };

      mockedSystemSpecs.getSystemSpecs.mockResolvedValue(mockSpecs);
      mockedSystemSpecs.formatSystemSpecs.mockReturnValue('Formatted specs');

      const results = [
        {
          model: 'llama2',
          tokensPerSecond: 45.5,
          totalTokens: 100,
          durationSeconds: 2.2,
          timestamp: '2024-01-15T10:30:00.000Z',
          success: true
        }
      ];

      await saveResultsToDatabase(results);

      expect(mockedDatabase.initDatabase).toHaveBeenCalled();
      expect(mockedSystemSpecs.getSystemSpecs).toHaveBeenCalled();
      expect(mockedDatabase.saveSystemSpecs).toHaveBeenCalledWith(mockSpecs);
      expect(mockedDatabase.saveBenchmarkResults).toHaveBeenCalledWith(results, 1);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Collecting system specifications'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('System specs saved to database'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Benchmark results saved to database'));
    });

    it('should save each batch aggregate against the same specs row as the results', async () => {
      mockedSystemSpecs.getSystemSpecs.mockResolvedValue({} as any);
      mockedSystemSpecs.formatSystemSpecs.mockReturnValue('');
      mockedDatabase.saveSystemSpecs.mockReturnValue(42);
      const results: BenchmarkResult[] = [
        { model: 'llama2', tokensPerSecond: 40, totalTokens: 80, durationSeconds: 2, timestamp: 't', success: true, batchId: 'b1', concurrency: 2 }
      ];
      const aggregates = [
        computeAggregate(results, 2),
        computeAggregate([{ ...results[0], model: 'qwen3:8b', batchId: 'b2' }], 3)
      ];

      await expect(saveResultsToDatabase(results, aggregates)).resolves.toBe(42);

      expect(mockedDatabase.saveBenchmarkResults).toHaveBeenCalledWith(results, 42);
      expect(mockedDatabase.saveBenchmarkAggregate).toHaveBeenCalledTimes(2);
      expect(mockedDatabase.saveBenchmarkAggregate).toHaveBeenNthCalledWith(1, aggregates[0], 42);
      expect(mockedDatabase.saveBenchmarkAggregate).toHaveBeenNthCalledWith(2, aggregates[1], 42);
    });

    it('should save no aggregates when none are given', async () => {
      mockedSystemSpecs.getSystemSpecs.mockResolvedValue({} as any);
      mockedSystemSpecs.formatSystemSpecs.mockReturnValue('');
      await saveResultsToDatabase([]);
      expect(mockedDatabase.saveBenchmarkAggregate).not.toHaveBeenCalled();
    });

    it('should handle database errors gracefully', async () => {
      mockedDatabase.initDatabase.mockImplementation(() => {
        throw new Error('Database initialization failed');
      });

      const results = [
        {
          model: 'llama2',
          tokensPerSecond: 45.5,
          totalTokens: 100,
          durationSeconds: 2.2,
          timestamp: '2024-01-15T10:30:00.000Z',
          success: true
        }
      ];

      await expect(saveResultsToDatabase(results)).rejects.toThrow('Database initialization failed');
      expect(console.error).toHaveBeenCalledWith(
        'Error saving to database:',
        expect.stringContaining('Database initialization failed')
      );
    });

    it('should handle system specs collection errors', async () => {
      mockedSystemSpecs.getSystemSpecs.mockRejectedValue(new Error('Failed to collect specs'));

      const results = [
        {
          model: 'llama2',
          tokensPerSecond: 45.5,
          totalTokens: 100,
          durationSeconds: 2.2,
          timestamp: '2024-01-15T10:30:00.000Z',
          success: true
        }
      ];

      await expect(saveResultsToDatabase(results)).rejects.toThrow('Failed to collect specs');
      expect(console.error).toHaveBeenCalledWith(
        'Error saving to database:',
        expect.stringContaining('Failed to collect specs')
      );
    });
  });

  describe('Edge cases', () => {
    it('should handle very large token counts', async () => {
      const mockResponse = {
        data: {
          response: 'Very long response',
          eval_count: 1000000 // 1 million tokens
        }
      };

      mockedAxios.post.mockResolvedValue(mockResponse);

      const result = await benchmarkModel('large-model', undefined, { ...NO_STREAM, now: fakeClock([0, 500]) });

      expect(result.success).toBe(true);
      expect(result.totalTokens).toBe(1000000);
      expect(result.tokensPerSecond).toBe(2000000);
    });

    it('should handle models with special characters in names', async () => {
      const mockResponse = {
        data: {
          response: 'Test response',
          eval_count: 50
        }
      };

      mockedAxios.post.mockResolvedValue(mockResponse);

      const result = await benchmarkModel('model-name:v1.0', undefined, NO_STREAM);

      expect(result.success).toBe(true);
      expect(result.model).toBe('model-name:v1.0');
    });

    it('should handle missing eval_count in response', async () => {
      const mockResponse = {
        data: {
          response: 'Test response'
          // eval_count is missing
        }
      };

      mockedAxios.post.mockResolvedValue(mockResponse);

      const result = await benchmarkModel('test-model', undefined, NO_STREAM);

      expect(result.success).toBe(true);
      expect(result.totalTokens).toBe(0);
    });

    it('should handle empty results array in CSV', () => {
      const results: any[] = [];

      saveResultsToCSV(results);

      const csvContent = (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1];
      expect(csvContent).toBe('Model,Tokens Per Second,Total Tokens,Duration (s),Timestamp,Status\n');
    });

    it('should format CSV correctly with multiple results', () => {
      const results = [
        {
          model: 'model1',
          tokensPerSecond: 45.23,
          totalTokens: 100,
          durationSeconds: 2.21,
          timestamp: '2024-01-15T10:30:00.000Z',
          success: true
        },
        {
          model: 'model2',
          tokensPerSecond: 50.5,
          totalTokens: 120,
          durationSeconds: 2.38,
          timestamp: '2024-01-15T10:31:00.000Z',
          success: true
        }
      ];

      saveResultsToCSV(results);

      const csvContent = (mockedFs.writeFileSync as jest.Mock).mock.calls[0][1];
      expect(csvContent).toContain('model1,45.23,100,2.21');
      expect(csvContent).toContain('model2,50.5,120,2.38');
    });
  });

  describe('target resolution', () => {
    it('normalises trailing slashes and a trailing /v1 off the base URL', () => {
      expect(normaliseBaseUrl('http://host:8000/v1')).toBe('http://host:8000');
      expect(normaliseBaseUrl('http://host:8000/v1/')).toBe('http://host:8000');
      expect(normaliseBaseUrl('http://host:11434/')).toBe('http://host:11434');
      expect(normaliseBaseUrl(' http://100.115.174.32:5002/api/inference/pool/ ')).toBe('http://100.115.174.32:5002/api/inference/pool');
    });

    it('prefers OLLAMA_API_URL, then CI_LLM_BASE_URL, then the Ollama default', () => {
      expect(getConfiguredBaseUrl()).toBe('http://localhost:11434');
      process.env.CI_LLM_BASE_URL = 'http://hub.ci.localhost/api/inference/pool/v1';
      expect(getConfiguredBaseUrl()).toBe('http://hub.ci.localhost/api/inference/pool');
      process.env.OLLAMA_API_URL = 'http://ollama:11434/';
      expect(getConfiguredBaseUrl()).toBe('http://ollama:11434');
    });

    it('picks ollama when /api/tags answers and caches the probe', async () => {
      mockedAxios.get.mockResolvedValue({ data: { models: [] } });
      expect(await detectTransport('http://a:11434')).toBe('ollama');
      expect(await detectTransport('http://a:11434')).toBe('ollama');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      expect(mockedAxios.get).toHaveBeenCalledWith('http://a:11434/api/tags', expect.objectContaining({ timeout: expect.any(Number) }));
    });

    it('picks openai when /api/tags fails', async () => {
      mockedAxios.get.mockRejectedValue(new Error('404'));
      expect(await detectTransport('http://vllm:8000')).toBe('openai');
    });

    it('caches openai only when the server actually answered — a 404 is an answer', async () => {
      mockedAxios.isAxiosError.mockImplementation((e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError));
      mockedAxios.get.mockRejectedValue({ isAxiosError: true, response: { status: 404 } });
      expect(await detectTransport('http://vllm:8000')).toBe('openai');
      expect(await detectTransport('http://vllm:8000')).toBe('openai');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it('does not pin a target that was merely down: a refused probe is retried on the next call', async () => {
      // The dashboard container routinely starts before its engine. Caching that first
      // ECONNREFUSED as "openai" sent every later run to /v1/chat/completions on an Ollama.
      mockedAxios.isAxiosError.mockImplementation((e: unknown) => Boolean((e as { isAxiosError?: boolean })?.isAxiosError));
      mockedAxios.get.mockRejectedValueOnce({ isAxiosError: true, code: 'ECONNREFUSED' });
      expect(await detectTransport('http://a:11434')).toBe('openai');
      mockedAxios.get.mockResolvedValue({ data: { models: [] } });
      expect(await detectTransport('http://a:11434')).toBe('ollama');
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('lets BENCH_TRANSPORT force the transport without probing', async () => {
      process.env.BENCH_TRANSPORT = 'openai';
      mockedAxios.get.mockResolvedValue({ data: { models: [] } });
      expect(await detectTransport('http://a:11434')).toBe('openai');
      expect(mockedAxios.get).not.toHaveBeenCalled();
      process.env.BENCH_TRANSPORT = 'ollama';
      mockedAxios.get.mockRejectedValue(new Error('404'));
      expect(await detectTransport('http://b:8000')).toBe('ollama');
    });

    it('reports path=pool when the URL is a Hub pool proxy', async () => {
      process.env.OLLAMA_API_URL = 'http://100.115.174.32:5002/api/inference/pool';
      expect(await resolveTarget()).toEqual({ url: 'http://100.115.174.32:5002/api/inference/pool', transport: 'ollama', path: 'pool' });
      process.env.OLLAMA_API_URL = 'http://localhost:11434';
      expect(await resolveTarget()).toEqual({ url: 'http://localhost:11434', transport: 'ollama', path: 'direct' });
    });

    it('sends CI_LLM_API_KEY as a bearer token', async () => {
      process.env.CI_LLM_API_KEY = 'secret';
      await detectTransport('http://a:11434');
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: { Authorization: 'Bearer secret' } }));
    });
  });

  describe('wire parsing', () => {
    it('parses NDJSON lines and ignores blank or broken ones', () => {
      expect(parseNdjsonLine('{"response":"Hi","done":false}')).toEqual({ response: 'Hi', done: false });
      expect(parseNdjsonLine('')).toBeNull();
      expect(parseNdjsonLine('   ')).toBeNull();
      expect(parseNdjsonLine('{not json')).toBeNull();
      expect(parseNdjsonLine('"a string"')).toBeNull();
    });

    it('parses SSE data lines, the [DONE] sentinel, and skips comments', () => {
      expect(parseSseLine('data: {"choices":[{"delta":{"content":"x"}}]}')).toEqual({ chunk: { choices: [{ delta: { content: 'x' } }] } });
      expect(parseSseLine('data:{"usage":{"completion_tokens":3}}')).toEqual({ chunk: { usage: { completion_tokens: 3 } } });
      expect(parseSseLine('data: [DONE]')).toEqual({ done: true });
      expect(parseSseLine(': keep-alive')).toBeNull();
      expect(parseSseLine('event: ping')).toBeNull();
      expect(parseSseLine('')).toBeNull();
      expect(parseSseLine('data: {broken')).toBeNull();
    });

    it('reads X-Hub-Pool-* headers case-insensitively and leaves them undefined when absent', () => {
      expect(readPoolHeaders(POOL_HEADERS)).toEqual({ servedBy: 'beta-max.tail1234.ts.net', backend: 'ollama', requestId: 'req-42' });
      expect(readPoolHeaders({ 'X-Hub-Pool-Served-By': 'local' })).toEqual({ servedBy: 'local', backend: undefined, requestId: undefined });
      expect(readPoolHeaders({})).toEqual({ servedBy: undefined, backend: undefined, requestId: undefined });
      expect(readPoolHeaders(undefined)).toEqual({ servedBy: undefined, backend: undefined, requestId: undefined });
    });
  });

  describe('benchmarkModel (streaming Ollama)', () => {
    const finalLine = {
      response: '',
      done: true,
      eval_count: 40,
      eval_duration: 2_000_000_000,
      prompt_eval_count: 12,
      prompt_eval_duration: 300_000_000,
      load_duration: 150_000_000,
      total_duration: 2_600_000_000
    };

    it('streams by default, measures TTFT at the first content chunk and takes timings from the done line', async () => {
      mockedAxios.post.mockResolvedValue({
        data: bodyStream(ndjson([
          { response: '', done: false },
          { response: 'Hello', done: false },
          { response: ' world', done: false },
          finalLine
        ])),
        headers: {}
      });
      // start, first content chunk, end
      const now = fakeClock([1_000, 1_250, 4_000]);

      const result = await benchmarkModel('qwen3:8b', undefined, { now });

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        { model: 'qwen3:8b', prompt: TEST_PROMPTS[0].prompt, stream: true },
        expect.objectContaining({ responseType: 'stream', timeout: 120000 })
      );
      expect(result.success).toBe(true);
      expect(result.response).toBe('Hello world');
      expect(result.totalTokens).toBe(40);
      expect(result.durationSeconds).toBe(3);
      expect(result.tokensPerSecond).toBeCloseTo(40 / 3, 2);
      expect(result.ttftMs).toBe(250);
      expect(result.promptTokens).toBe(12);
      expect(result.loadMs).toBe(150);
      expect(result.promptEvalMs).toBe(300);
      expect(result.evalMs).toBe(2000);
      expect(result.decodeTokensPerSecond).toBe(20); // 40 tokens / 2s of eval_duration
      expect(result.transport).toBe('ollama');
      expect(result.path).toBe('direct');
      expect(result.targetUrl).toBe('http://localhost:11434');
      expect(result.concurrency).toBe(1);
      expect(result.batchId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.servedBy).toBeUndefined();
    });

    it('reassembles NDJSON lines split across chunk boundaries', async () => {
      const [a, b, c] = ndjson([{ response: 'ab', done: false }, { response: 'cd', done: false }, { ...finalLine, eval_count: 2 }]);
      const joined = a + b + c;
      mockedAxios.post.mockResolvedValue({
        data: bodyStream([joined.slice(0, 7), joined.slice(7, 30), joined.slice(30)]),
        headers: {}
      });

      const result = await benchmarkModel('m', undefined, { now: fakeClock([0, 10, 1000]) });

      expect(result.response).toBe('abcd');
      expect(result.totalTokens).toBe(2);
      expect(result.ttftMs).toBe(10);
    });

    it('captures the pool headers and flags path=pool even on a direct-looking URL', async () => {
      mockedAxios.post.mockResolvedValue({
        data: bodyStream(ndjson([{ response: 'x', done: false }, finalLine])),
        headers: POOL_HEADERS
      });

      const result = await benchmarkModel('qwen3:8b', undefined, { now: fakeClock([0, 100, 1000]) });

      expect(result.servedBy).toBe('beta-max.tail1234.ts.net');
      expect(result.backend).toBe('ollama');
      expect(result.requestId).toBe('req-42');
      expect(result.path).toBe('pool');
    });

    it('flags path=pool from the URL alone when no header comes back', async () => {
      process.env.OLLAMA_API_URL = 'http://100.115.174.32:5002/api/inference/pool';
      mockedAxios.post.mockResolvedValue({
        data: bodyStream(ndjson([{ response: 'x', done: false }, finalLine])),
        headers: {}
      });

      const result = await benchmarkModel('qwen3:8b', undefined, { now: fakeClock([0, 100, 1000]) });

      expect(result.path).toBe('pool');
      expect(result.targetUrl).toBe('http://100.115.174.32:5002/api/inference/pool');
      expect(mockedAxios.post).toHaveBeenCalledWith('http://100.115.174.32:5002/api/inference/pool/api/generate', expect.any(Object), expect.any(Object));
    });

    it('falls back to wall-minus-TTFT decode speed when the done line has no eval timings', async () => {
      mockedAxios.post.mockResolvedValue({
        data: bodyStream(ndjson([{ response: 'x', done: false }, { response: '', done: true, eval_count: 30 }])),
        headers: {}
      });

      const result = await benchmarkModel('m', undefined, { now: fakeClock([0, 500, 2_000]) });

      expect(result.totalTokens).toBe(30);
      expect(result.tokensPerSecond).toBe(15); // 30 / 2s wall
      expect(result.decodeTokensPerSecond).toBe(20); // 30 / (2s - 0.5s)
      expect(result.evalMs).toBeUndefined();
    });

    it('surfaces an error line from the stream as a failed row', async () => {
      mockedAxios.post.mockResolvedValue({
        data: bodyStream(ndjson([{ error: 'model "nope" not found' }])),
        headers: {}
      });

      const result = await benchmarkModel('nope');

      expect(result.success).toBe(false);
      expect(result.error).toBe('model "nope" not found');
      expect(result.transport).toBe('ollama');
      expect(result.targetUrl).toBe('http://localhost:11434');
    });

    it('leaves ttftMs undefined for a non-streaming run but still fills the Ollama timings', async () => {
      mockedAxios.post.mockResolvedValue({ data: { ...finalLine, response: 'hi' }, headers: POOL_HEADERS });

      const result = await benchmarkModel('m', undefined, { ...NO_STREAM, now: fakeClock([0, 1000]) });

      expect(result.ttftMs).toBeUndefined();
      expect(result.decodeTokensPerSecond).toBe(20);
      expect(result.evalMs).toBe(2000);
      expect(result.servedBy).toBe('beta-max.tail1234.ts.net');
      expect(result.path).toBe('pool');
      expect(mockedAxios.post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ stream: false }), expect.not.objectContaining({ responseType: 'stream' }));
    });
  });

  describe('benchmarkModel (OpenAI-compatible)', () => {
    beforeEach(() => {
      process.env.CI_LLM_BASE_URL = 'http://vllm:8000/v1';
      process.env.CI_LLM_API_KEY = 'k';
      mockedAxios.get.mockRejectedValue(new Error('404')); // no /api/tags → openai
    });

    it('streams SSE, measures TTFT at the first delta and reads usage from the final chunk', async () => {
      mockedAxios.post.mockResolvedValue({
        data: bodyStream(sse([
          { choices: [{ delta: { role: 'assistant', content: '' } }] },
          { choices: [{ delta: { content: 'Hel' } }] },
          { choices: [{ delta: { content: 'lo' } }] },
          { choices: [], usage: { completion_tokens: 25, prompt_tokens: 9 } },
          '[DONE]'
        ])),
        headers: { 'x-hub-pool-served-by': 'local', 'x-hub-pool-backend': 'vllm' }
      });

      const result = await benchmarkModel('Qwen/Qwen3-8B', 'hi', { now: fakeClock([0, 400, 2_400]) });

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://vllm:8000/v1/chat/completions',
        { model: 'Qwen/Qwen3-8B', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } },
        expect.objectContaining({ responseType: 'stream', headers: expect.objectContaining({ Authorization: 'Bearer k' }) })
      );
      expect(result.success).toBe(true);
      expect(result.transport).toBe('openai');
      expect(result.response).toBe('Hello');
      expect(result.totalTokens).toBe(25);
      expect(result.promptTokens).toBe(9);
      expect(result.ttftMs).toBe(400);
      expect(result.durationSeconds).toBe(2.4);
      expect(result.decodeTokensPerSecond).toBe(12.5); // 25 / (2.4 - 0.4)
      expect(result.servedBy).toBe('local');
      expect(result.backend).toBe('vllm');
      expect(result.path).toBe('pool');
      expect(result.loadMs).toBeUndefined();
    });

    it('counts content deltas when the server never sends usage', async () => {
      mockedAxios.post.mockResolvedValue({
        data: bodyStream(sse([
          { choices: [{ delta: { content: 'a' } }] },
          { choices: [{ delta: { content: 'b' } }] },
          { choices: [{ delta: { content: 'c' } }] },
          '[DONE]'
        ])),
        headers: {}
      });

      const result = await benchmarkModel('m', undefined, { now: fakeClock([0, 100, 1_100]) });

      expect(result.totalTokens).toBe(3);
      expect(result.promptTokens).toBeUndefined();
      expect(result.path).toBe('direct');
    });

    it('falls back to a non-streaming request when the server rejects stream_options', async () => {
      const rejection = Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { error: 'unknown field stream_options' } }
      });
      mockedAxios.post
        .mockRejectedValueOnce(rejection)
        .mockResolvedValueOnce({
          data: { choices: [{ message: { role: 'assistant', content: 'plain answer' } }], usage: { completion_tokens: 7, prompt_tokens: 4 } },
          headers: { 'x-hub-pool-served-by': 'peer-b', 'x-hub-pool-backend': 'lemonade' }
        });

      const result = await benchmarkModel('m', undefined, { now: fakeClock([0, 3_500]) });

      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
      expect(mockedAxios.post).toHaveBeenLastCalledWith(
        'http://vllm:8000/v1/chat/completions',
        { model: 'm', messages: [{ role: 'user', content: TEST_PROMPTS[0].prompt }], stream: false },
        expect.not.objectContaining({ responseType: 'stream' })
      );
      expect(result.success).toBe(true);
      expect(result.response).toBe('plain answer');
      expect(result.totalTokens).toBe(7);
      expect(result.promptTokens).toBe(4);
      expect(result.ttftMs).toBeUndefined();
      expect(result.decodeTokensPerSecond).toBeUndefined();
      expect(result.tokensPerSecond).toBe(2);
      expect(result.servedBy).toBe('peer-b');
      expect(result.backend).toBe('lemonade');
    });

    it('does not retry on non-4xx failures', async () => {
      mockedAxios.post.mockRejectedValue(Object.assign(new Error('502'), { response: { status: 502 } }));

      const result = await benchmarkModel('m');

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.error).toBe('502');
    });

    it('runs a plain non-streaming request when stream: false', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { choices: [{ message: { content: 'ok' } }], usage: { completion_tokens: 5, prompt_tokens: 2 } },
        headers: {}
      });

      const result = await benchmarkModel('m', undefined, { ...NO_STREAM, now: fakeClock([0, 1_000]) });

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(mockedAxios.post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ stream: false }), expect.any(Object));
      expect(result.totalTokens).toBe(5);
      expect(result.tokensPerSecond).toBe(5);
    });
  });

  describe('computeDecodeTokensPerSecond', () => {
    it('prefers Ollama eval timings', () => {
      expect(computeDecodeTokensPerSecond({ totalTokens: 100, durationSeconds: 10, ttftMs: 100, evalCount: 50, evalDurationNs: 1e9 }, true)).toBe(50);
      expect(computeDecodeTokensPerSecond({ totalTokens: 100, durationSeconds: 10, evalCount: 50, evalDurationNs: 1e9 }, false)).toBe(50);
    });

    it('subtracts TTFT from the wall clock when streaming without engine timings', () => {
      expect(computeDecodeTokensPerSecond({ totalTokens: 90, durationSeconds: 10, ttftMs: 1000 }, true)).toBe(10);
    });

    it('is undefined when it cannot be measured', () => {
      expect(computeDecodeTokensPerSecond({ totalTokens: 90, durationSeconds: 10 }, true)).toBeUndefined();
      expect(computeDecodeTokensPerSecond({ totalTokens: 90, durationSeconds: 10, ttftMs: 1000 }, false)).toBeUndefined();
      expect(computeDecodeTokensPerSecond({ totalTokens: 90, durationSeconds: 1, ttftMs: 1000 }, true)).toBeUndefined();
      expect(computeDecodeTokensPerSecond({ totalTokens: 90, durationSeconds: 1, evalCount: 90, evalDurationNs: 0 }, false)).toBeUndefined();
    });
  });

  describe('computeAggregate', () => {
    const row = (overrides: Partial<BenchmarkResult>): BenchmarkResult => ({
      model: 'qwen3:8b',
      tokensPerSecond: 10,
      totalTokens: 100,
      durationSeconds: 10,
      timestamp: '2026-09-20T00:00:00.000Z',
      success: true,
      batchId: 'batch-1',
      concurrency: 4,
      ...overrides
    });

    it('sums tokens over the wall clock, takes medians, and counts servedBy/backend', () => {
      const rows = [
        row({ totalTokens: 100, ttftMs: 100, decodeTokensPerSecond: 20, servedBy: 'local', backend: 'ollama' }),
        row({ totalTokens: 200, ttftMs: 300, decodeTokensPerSecond: 40, servedBy: 'peer-a', backend: 'vllm' }),
        row({ totalTokens: 300, ttftMs: 200, decodeTokensPerSecond: 30, servedBy: 'local', backend: 'ollama' }),
        row({ success: false, totalTokens: 0, error: 'boom', servedBy: 'peer-b', backend: 'lemonade' })
      ];

      expect(computeAggregate(rows, 8)).toEqual({
        batchId: 'batch-1',
        model: 'qwen3:8b',
        concurrency: 4,
        wallSeconds: 8,
        aggregateTokensPerSecond: 75,
        medianTtftMs: 200,
        medianDecodeTokensPerSecond: 30,
        servedByCounts: { local: 2, 'peer-a': 1, 'peer-b': 1 },
        backendCounts: { ollama: 2, vllm: 1, lemonade: 1 },
        successes: 3,
        failures: 1
      });
    });

    it('averages the two middle values for an even count and omits medians with no data', () => {
      const even = computeAggregate([row({ ttftMs: 100, decodeTokensPerSecond: 10 }), row({ ttftMs: 300, decodeTokensPerSecond: 20 })], 4);
      expect(even.medianTtftMs).toBe(200);
      expect(even.medianDecodeTokensPerSecond).toBe(15);
      expect(even.aggregateTokensPerSecond).toBe(50);

      const bare = computeAggregate([row({})], 2);
      expect(bare.medianTtftMs).toBeUndefined();
      expect(bare.medianDecodeTokensPerSecond).toBeUndefined();
      expect(bare.servedByCounts).toEqual({});
      expect(bare.backendCounts).toEqual({});
    });

    it('never divides by zero', () => {
      expect(computeAggregate([row({})], 0).aggregateTokensPerSecond).toBe(0);
      expect(computeAggregate([], 1)).toMatchObject({ batchId: '', model: '', concurrency: 0, successes: 0, failures: 0 });
    });
  });

  describe('benchmarkModelConcurrently', () => {
    it('fires N requests at once sharing one batchId and returns the aggregate', async () => {
      const finalLine = { response: '', done: true, eval_count: 10, eval_duration: 1_000_000_000 };
      let calls = 0;
      mockedAxios.post.mockImplementation(async () => ({
        data: bodyStream(ndjson([{ response: 'x', done: false }, finalLine])),
        headers: { 'x-hub-pool-served-by': calls++ % 2 === 0 ? 'local' : 'peer-a', 'x-hub-pool-backend': 'ollama' }
      }));
      let tick = 0;
      const now = () => (tick += 100);

      const { results, aggregate } = await benchmarkModelConcurrently('qwen3:8b', undefined, 4, { now });

      expect(mockedAxios.post).toHaveBeenCalledTimes(4);
      expect(results).toHaveLength(4);
      const batchIds = new Set(results.map(r => r.batchId));
      expect(batchIds.size).toBe(1);
      expect(results.every(r => r.concurrency === 4)).toBe(true);
      expect(results.every(r => r.success)).toBe(true);
      expect(aggregate.batchId).toBe(results[0].batchId);
      expect(aggregate.concurrency).toBe(4);
      expect(aggregate.successes).toBe(4);
      expect(aggregate.servedByCounts).toEqual({ local: 2, 'peer-a': 2 });
      expect(aggregate.backendCounts).toEqual({ ollama: 4 });
      expect(aggregate.medianDecodeTokensPerSecond).toBe(10);
      expect(aggregate.wallSeconds).toBeGreaterThan(0);
      expect(aggregate.aggregateTokensPerSecond).toBeCloseTo(40 / aggregate.wallSeconds, 1);
    });

    it('clamps concurrency to 1..16', async () => {
      mockedAxios.post.mockResolvedValue({ data: { response: 'x', eval_count: 1 }, headers: {} });

      const low = await benchmarkModelConcurrently('m', undefined, 0, NO_STREAM);
      expect(low.results).toHaveLength(1);
      expect(low.aggregate.concurrency).toBe(1);

      mockedAxios.post.mockClear();
      const high = await benchmarkModelConcurrently('m', undefined, 99, NO_STREAM);
      expect(high.results).toHaveLength(16);
      expect(mockedAxios.post).toHaveBeenCalledTimes(16);

      expect(clampConcurrency(NaN)).toBe(1);
      expect(clampConcurrency('8')).toBe(8);
      expect(clampConcurrency(3.9)).toBe(3);
      expect(clampConcurrency(undefined)).toBe(1);
    });

    it('keeps failed rows in the batch and counts them', async () => {
      mockedAxios.post
        .mockResolvedValueOnce({ data: { response: 'x', eval_count: 5 }, headers: {} })
        .mockRejectedValueOnce(new Error('overloaded'));

      const { results, aggregate } = await benchmarkModelConcurrently('m', 'p', 2, NO_STREAM);

      expect(results.filter(r => r.success)).toHaveLength(1);
      expect(aggregate.successes).toBe(1);
      expect(aggregate.failures).toBe(1);
      expect(results.find(r => !r.success)?.error).toBe('overloaded');
      expect(results.every(r => r.prompt === 'p')).toBe(true);
    });
  });

  describe('parseCliArgs', () => {
    it('separates flags from model names', () => {
      expect(parseCliArgs(['qwen3:8b', '--concurrency=4', 'gemma3:4b', '--no-stream'])).toEqual({
        models: ['qwen3:8b', 'gemma3:4b'],
        concurrency: 4,
        stream: false
      });
      expect(parseCliArgs([])).toEqual({ models: [], concurrency: 1, stream: true });
      expect(parseCliArgs(['--concurrency=100']).concurrency).toBe(16);
      expect(parseCliArgs(['--concurrency=abc']).concurrency).toBe(1);
    });

    it('warns about unknown flags instead of treating them as models', () => {
      expect(parseCliArgs(['--bogus', 'm']).models).toEqual(['m']);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--bogus'));
    });
  });
});
