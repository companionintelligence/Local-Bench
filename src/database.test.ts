import {
  initDatabase,
  closeDatabase,
  saveSystemSpecs,
  saveBenchmarkResults,
  getAllBenchmarkResults,
  getLatestSystemSpecs,
  getBenchmarkResultsWithSpecs,
  getBenchmarkResultsByModel,
  getAllSystemSpecs,
  getDatabase,
  saveBenchmarkAggregate,
  getRecentAggregates,
  BenchmarkResultRecord
} from './database';
import { BenchmarkAggregate } from './benchmark';
import { SystemSpecs } from './systemSpecs';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';

/** The benchmark_results schema as it shipped before the pool columns existed. */
const OLD_SCHEMA = `
  CREATE TABLE system_specs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL,
    cpu_model TEXT NOT NULL,
    cpu_cores INTEGER NOT NULL,
    cpu_threads INTEGER NOT NULL,
    total_memory_gb REAL NOT NULL,
    os_type TEXT NOT NULL,
    os_version TEXT NOT NULL,
    motherboard TEXT,
    gpus TEXT NOT NULL,
    strix_halo TEXT,
    timestamp TEXT NOT NULL
  );
  CREATE TABLE benchmark_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    tokens_per_second REAL NOT NULL,
    total_tokens INTEGER NOT NULL,
    duration_seconds REAL NOT NULL,
    timestamp TEXT NOT NULL,
    success INTEGER NOT NULL,
    error TEXT,
    system_specs_id INTEGER,
    FOREIGN KEY (system_specs_id) REFERENCES system_specs(id)
  );
  CREATE INDEX idx_benchmark_timestamp ON benchmark_results(timestamp);
  CREATE INDEX idx_benchmark_model ON benchmark_results(model);
  CREATE INDEX idx_system_specs_timestamp ON system_specs(timestamp);
`;

const NEW_RESULT_COLUMNS = [
  'transport', 'path', 'target_url', 'served_by', 'backend', 'request_id',
  'ttft_ms', 'prompt_tokens', 'load_ms', 'prompt_eval_ms', 'eval_ms',
  'decode_tokens_per_second', 'concurrency', 'batch_id'
];

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
}

/** A fully-populated pool row, as benchmarkModel would produce for a streamed pool request. */
function fullPoolResult(overrides: Partial<BenchmarkResultRecord> = {}): BenchmarkResultRecord {
  return {
    model: 'qwen3:8b',
    tokensPerSecond: 40.2,
    totalTokens: 201,
    durationSeconds: 5.0,
    timestamp: '2026-09-20T10:00:00.000Z',
    success: true,
    transport: 'ollama',
    path: 'pool',
    targetUrl: 'http://100.115.174.32:5002/api/inference/pool',
    servedBy: 'beta-max',
    backend: 'ollama',
    requestId: 'req-abc123',
    ttftMs: 312.5,
    promptTokens: 27,
    loadMs: 1200.25,
    promptEvalMs: 80.5,
    evalMs: 3900.75,
    decodeTokensPerSecond: 51.5,
    concurrency: 4,
    batchId: 'batch-0001',
    ...overrides
  };
}

describe('Database Module', () => {
  const testDbPath = path.join(__dirname, '..', 'benchmark_data.db');

  beforeEach(() => {
    // Remove test database if it exists
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  afterEach(() => {
    closeDatabase();
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('initDatabase', () => {
    it('should create database with required tables', () => {
      const db = initDatabase();
      
      expect(db).toBeDefined();
      
      // Check if tables exist
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const tableNames = tables.map((t: any) => t.name);
      
      expect(tableNames).toContain('system_specs');
      expect(tableNames).toContain('benchmark_results');
    });

    it('should create indexes', () => {
      const db = initDatabase();
      
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
      const indexNames = indexes.map((i: any) => i.name);
      
      expect(indexNames.length).toBeGreaterThan(0);
    });
  });

  describe('saveSystemSpecs', () => {
    it('should save system specs and return ID', () => {
      initDatabase();
      
      const specs: SystemSpecs = {
        serverName: 'test-server',
        cpuModel: 'Test CPU',
        cpuCores: 8,
        cpuThreads: 16,
        totalMemoryGB: 32,
        osType: 'linux',
        osVersion: 'Ubuntu 22.04',
        motherboard: 'Test Board',
        gpus: [{ model: 'Test GPU', vram: 8000 }]
      };
      
      const id = saveSystemSpecs(specs);
      
      expect(id).toBeGreaterThan(0);
    });

    it('should save system specs without motherboard', () => {
      initDatabase();
      
      const specs: SystemSpecs = {
        serverName: 'test-server',
        cpuModel: 'Test CPU',
        cpuCores: 4,
        cpuThreads: 8,
        totalMemoryGB: 16,
        osType: 'linux',
        osVersion: 'Ubuntu 22.04',
        gpus: [{ model: 'Test GPU' }]
      };
      
      const id = saveSystemSpecs(specs);
      
      expect(id).toBeGreaterThan(0);
    });
  });

  describe('saveBenchmarkResults', () => {
    it('should save benchmark results', () => {
      initDatabase();
      
      const results: BenchmarkResultRecord[] = [
        {
          model: 'llama2',
          tokensPerSecond: 45.5,
          totalTokens: 100,
          durationSeconds: 2.2,
          timestamp: new Date().toISOString(),
          success: true
        },
        {
          model: 'mistral',
          tokensPerSecond: 50.0,
          totalTokens: 120,
          durationSeconds: 2.4,
          timestamp: new Date().toISOString(),
          success: true
        }
      ];
      
      expect(() => saveBenchmarkResults(results)).not.toThrow();
    });

    it('should save benchmark results with system specs ID', () => {
      initDatabase();
      
      const specs: SystemSpecs = {
        serverName: 'test-server',
        cpuModel: 'Test CPU',
        cpuCores: 8,
        cpuThreads: 16,
        totalMemoryGB: 32,
        osType: 'linux',
        osVersion: 'Ubuntu 22.04',
        gpus: [{ model: 'Test GPU' }]
      };
      
      const systemSpecsId = saveSystemSpecs(specs);
      
      const results: BenchmarkResultRecord[] = [
        {
          model: 'llama2',
          tokensPerSecond: 45.5,
          totalTokens: 100,
          durationSeconds: 2.2,
          timestamp: new Date().toISOString(),
          success: true
        }
      ];
      
      expect(() => saveBenchmarkResults(results, systemSpecsId)).not.toThrow();
    });

    it('should save failed benchmark results', () => {
      initDatabase();
      
      const results: BenchmarkResultRecord[] = [
        {
          model: 'failed-model',
          tokensPerSecond: 0,
          totalTokens: 0,
          durationSeconds: 0,
          timestamp: new Date().toISOString(),
          success: false,
          error: 'Model not found'
        }
      ];
      
      expect(() => saveBenchmarkResults(results)).not.toThrow();
    });
  });

  describe('getAllBenchmarkResults', () => {
    it('should return empty array when no results', () => {
      initDatabase();
      
      const results = getAllBenchmarkResults();
      
      expect(results).toEqual([]);
    });

    it('should return all benchmark results', () => {
      initDatabase();
      
      const testResults: BenchmarkResultRecord[] = [
        {
          model: 'llama2',
          tokensPerSecond: 45.5,
          totalTokens: 100,
          durationSeconds: 2.2,
          timestamp: new Date().toISOString(),
          success: true
        },
        {
          model: 'mistral',
          tokensPerSecond: 50.0,
          totalTokens: 120,
          durationSeconds: 2.4,
          timestamp: new Date().toISOString(),
          success: true
        }
      ];
      
      saveBenchmarkResults(testResults);
      
      const results = getAllBenchmarkResults();
      
      expect(results.length).toBe(2);
      expect(results[0].model).toBeDefined();
      expect(results[0].tokensPerSecond).toBeDefined();
    });
  });

  describe('getLatestSystemSpecs', () => {
    it('should return null when no specs', () => {
      initDatabase();
      
      const specs = getLatestSystemSpecs();
      
      expect(specs).toBeNull();
    });

    it('should return latest system specs', () => {
      initDatabase();
      
      const specs1: SystemSpecs = {
        serverName: 'server1',
        cpuModel: 'CPU 1',
        cpuCores: 4,
        cpuThreads: 8,
        totalMemoryGB: 16,
        osType: 'linux',
        osVersion: 'Ubuntu 20.04',
        gpus: [{ model: 'GPU 1' }]
      };
      
      const specs2: SystemSpecs = {
        serverName: 'server2',
        cpuModel: 'CPU 2',
        cpuCores: 8,
        cpuThreads: 16,
        totalMemoryGB: 32,
        osType: 'linux',
        osVersion: 'Ubuntu 22.04',
        gpus: [{ model: 'GPU 2' }]
      };
      
      saveSystemSpecs(specs1);
      saveSystemSpecs(specs2);
      
      const latest = getLatestSystemSpecs();
      
      expect(latest).not.toBeNull();
      expect(latest?.serverName).toBe('server2');
      expect(latest?.cpuModel).toBe('CPU 2');
    });
  });

  describe('getBenchmarkResultsWithSpecs', () => {
    it('should return results with system specs', () => {
      initDatabase();
      
      const specs: SystemSpecs = {
        serverName: 'test-server',
        cpuModel: 'Test CPU',
        cpuCores: 8,
        cpuThreads: 16,
        totalMemoryGB: 32,
        osType: 'linux',
        osVersion: 'Ubuntu 22.04',
        gpus: [{ model: 'Test GPU' }]
      };
      
      const systemSpecsId = saveSystemSpecs(specs);
      
      const testResults: BenchmarkResultRecord[] = [
        {
          model: 'llama2',
          tokensPerSecond: 45.5,
          totalTokens: 100,
          durationSeconds: 2.2,
          timestamp: new Date().toISOString(),
          success: true
        }
      ];
      
      saveBenchmarkResults(testResults, systemSpecsId);
      
      const results = getBenchmarkResultsWithSpecs();
      
      expect(results.length).toBe(1);
      expect(results[0].model).toBe('llama2');
      expect(results[0].systemSpecs).toBeDefined();
      expect(results[0].systemSpecs?.serverName).toBe('test-server');
    });

    it('should limit results when specified', () => {
      initDatabase();
      
      const testResults: BenchmarkResultRecord[] = [
        {
          model: 'model1',
          tokensPerSecond: 45.5,
          totalTokens: 100,
          durationSeconds: 2.2,
          timestamp: new Date().toISOString(),
          success: true
        },
        {
          model: 'model2',
          tokensPerSecond: 50.0,
          totalTokens: 120,
          durationSeconds: 2.4,
          timestamp: new Date().toISOString(),
          success: true
        },
        {
          model: 'model3',
          tokensPerSecond: 55.0,
          totalTokens: 130,
          durationSeconds: 2.5,
          timestamp: new Date().toISOString(),
          success: true
        }
      ];
      
      saveBenchmarkResults(testResults);
      
      const results = getBenchmarkResultsWithSpecs(2);
      
      expect(results.length).toBe(2);
    });
  });

  describe('getBenchmarkResultsByModel', () => {
    it('should return results for specific model', () => {
      initDatabase();
      
      const testResults: BenchmarkResultRecord[] = [
        {
          model: 'llama2',
          tokensPerSecond: 45.5,
          totalTokens: 100,
          durationSeconds: 2.2,
          timestamp: new Date().toISOString(),
          success: true
        },
        {
          model: 'mistral',
          tokensPerSecond: 50.0,
          totalTokens: 120,
          durationSeconds: 2.4,
          timestamp: new Date().toISOString(),
          success: true
        },
        {
          model: 'llama2',
          tokensPerSecond: 46.0,
          totalTokens: 110,
          durationSeconds: 2.3,
          timestamp: new Date().toISOString(),
          success: true
        }
      ];
      
      saveBenchmarkResults(testResults);
      
      const results = getBenchmarkResultsByModel('llama2');
      
      expect(results.length).toBe(2);
      expect(results[0].model).toBe('llama2');
      expect(results[1].model).toBe('llama2');
    });

    it('should return empty array for unknown model', () => {
      initDatabase();
      
      const testResults: BenchmarkResultRecord[] = [
        {
          model: 'llama2',
          tokensPerSecond: 45.5,
          totalTokens: 100,
          durationSeconds: 2.2,
          timestamp: new Date().toISOString(),
          success: true
        }
      ];
      
      saveBenchmarkResults(testResults);
      
      const results = getBenchmarkResultsByModel('unknown-model');
      
      expect(results.length).toBe(0);
    });
  });

  describe('getAllSystemSpecs', () => {
    it('should return all system specs records', () => {
      initDatabase();
      
      const specs1: SystemSpecs = {
        serverName: 'server1',
        cpuModel: 'CPU 1',
        cpuCores: 4,
        cpuThreads: 8,
        totalMemoryGB: 16,
        osType: 'linux',
        osVersion: 'Ubuntu 20.04',
        gpus: [{ model: 'GPU 1' }]
      };
      
      const specs2: SystemSpecs = {
        serverName: 'server2',
        cpuModel: 'CPU 2',
        cpuCores: 8,
        cpuThreads: 16,
        totalMemoryGB: 32,
        osType: 'linux',
        osVersion: 'Ubuntu 22.04',
        gpus: [{ model: 'GPU 2' }]
      };
      
      saveSystemSpecs(specs1);
      saveSystemSpecs(specs2);
      
      const allSpecs = getAllSystemSpecs();
      
      expect(allSpecs.length).toBe(2);
      expect(allSpecs[0].serverName).toBe('server2'); // Latest first
      expect(allSpecs[1].serverName).toBe('server1');
    });

    it('should return empty array when no specs', () => {
      initDatabase();
      
      const allSpecs = getAllSystemSpecs();
      
      expect(allSpecs.length).toBe(0);
    });

    it('should parse GPU JSON correctly', () => {
      initDatabase();
      
      const specs: SystemSpecs = {
        serverName: 'test-server',
        cpuModel: 'Test CPU',
        cpuCores: 8,
        cpuThreads: 16,
        totalMemoryGB: 32,
        osType: 'linux',
        osVersion: 'Ubuntu 22.04',
        gpus: [
          { model: 'GPU 1', vram: 8000 },
          { model: 'GPU 2', vram: 16000 }
        ]
      };
      
      saveSystemSpecs(specs);
      
      const allSpecs = getAllSystemSpecs();
      
      expect(allSpecs.length).toBe(1);
      expect(allSpecs[0].gpus.length).toBe(2);
      expect(allSpecs[0].gpus[0].model).toBe('GPU 1');
      expect(allSpecs[0].gpus[0].vram).toBe(8000);
    });
  });

  describe('getDatabase', () => {
    it('should return existing database instance', () => {
      const db1 = initDatabase();
      const db2 = getDatabase();
      
      expect(db1).toBe(db2);
    });

    it('should initialize database if not exists', () => {
      const db = getDatabase();
      
      expect(db).toBeDefined();
      
      // Verify it's a working database
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      expect(tables.length).toBeGreaterThan(0);
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle malformed JSON in GPU data', () => {
      initDatabase();
      
      const db = getDatabase();
      
      // Insert record with malformed JSON directly (clearly invalid)
      db.prepare(`
        INSERT INTO system_specs (
          server_name, cpu_model, cpu_cores, cpu_threads,
          total_memory_gb, os_type, os_version, motherboard,
          gpus, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'test-server',
        'Test CPU',
        8,
        16,
        32,
        'linux',
        'Ubuntu 22.04',
        null,
        '{invalid: json}',
        new Date().toISOString()
      );
      
      // Should handle malformed JSON gracefully
      const allSpecs = getAllSystemSpecs();
      
      expect(allSpecs.length).toBe(1);
      expect(allSpecs[0].gpus).toEqual([]); // Fallback to empty array
    });

    it('should handle results without system specs', () => {
      initDatabase();
      
      const results: BenchmarkResultRecord[] = [
        {
          model: 'llama2',
          tokensPerSecond: 45.5,
          totalTokens: 100,
          durationSeconds: 2.2,
          timestamp: new Date().toISOString(),
          success: true
        }
      ];
      
      // Save without systemSpecsId
      saveBenchmarkResults(results);
      
      const resultsWithSpecs = getBenchmarkResultsWithSpecs();
      
      expect(resultsWithSpecs.length).toBe(1);
      expect(resultsWithSpecs[0].systemSpecs).toBeUndefined();
    });
  });

  describe('schema migration', () => {
    it('should add the pool columns to a pre-change database file and keep its rows', () => {
      // Build the database exactly as the old code would have, with one row.
      const old = new DatabaseSync(testDbPath);
      old.exec(OLD_SCHEMA);
      old.prepare(`
        INSERT INTO benchmark_results (
          model, tokens_per_second, total_tokens, duration_seconds, timestamp, success, error, system_specs_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('llama2', 45.5, 100, 2.2, '2026-01-01T00:00:00.000Z', 1, null, null);
      expect(columnNames(old, 'benchmark_results')).not.toContain('transport');
      old.close();

      const db = initDatabase();

      const cols = columnNames(db, 'benchmark_results');
      for (const col of NEW_RESULT_COLUMNS) {
        expect(cols).toContain(col);
      }
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t: any) => t.name);
      expect(tables).toContain('benchmark_aggregates');

      // The pre-migration row survives and reads back with nulls for the new fields.
      const results = getAllBenchmarkResults();
      expect(results.length).toBe(1);
      expect(results[0].model).toBe('llama2');
      expect(results[0].tokensPerSecond).toBe(45.5);
      expect(results[0].success).toBe(true);
      expect(results[0].transport).toBeNull();
      expect(results[0].servedBy).toBeNull();
      expect(results[0].ttftMs).toBeNull();
      expect(results[0].concurrency).toBeNull();
      expect(results[0].batchId).toBeNull();

      // And new-style rows can be written into the migrated table.
      saveBenchmarkResults([fullPoolResult()]);
      expect(getAllBenchmarkResults().length).toBe(2);
    });

    it('should be idempotent across re-opens', () => {
      const old = new DatabaseSync(testDbPath);
      old.exec(OLD_SCHEMA);
      old.close();

      initDatabase();
      const firstCols = columnNames(getDatabase(), 'benchmark_results');
      closeDatabase();

      expect(() => initDatabase()).not.toThrow();
      const secondCols = columnNames(getDatabase(), 'benchmark_results');
      expect(secondCols).toEqual(firstCols);
      closeDatabase();

      expect(() => initDatabase()).not.toThrow();
      expect(columnNames(getDatabase(), 'benchmark_results')).toEqual(firstCols);
    });

    it('should give a fresh database the same result columns as a migrated one', () => {
      initDatabase();
      const fresh = columnNames(getDatabase(), 'benchmark_results');
      closeDatabase();
      fs.unlinkSync(testDbPath);

      const old = new DatabaseSync(testDbPath);
      old.exec(OLD_SCHEMA);
      old.close();
      initDatabase();
      const migrated = columnNames(getDatabase(), 'benchmark_results');

      expect(migrated).toEqual(fresh);
    });

    it('should create the batch_id and aggregates indexes', () => {
      const db = initDatabase();
      const indexNames = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((i: any) => i.name);
      expect(indexNames).toContain('idx_benchmark_batch_id');
      expect(indexNames).toContain('idx_benchmark_aggregates_timestamp');
    });
  });

  describe('pool fields on benchmark results', () => {
    it('should round-trip every new field through getAllBenchmarkResults', () => {
      initDatabase();
      const row = fullPoolResult();
      saveBenchmarkResults([row]);

      const [read] = getAllBenchmarkResults();
      expect(read.transport).toBe('ollama');
      expect(read.path).toBe('pool');
      expect(read.targetUrl).toBe('http://100.115.174.32:5002/api/inference/pool');
      expect(read.servedBy).toBe('beta-max');
      expect(read.backend).toBe('ollama');
      expect(read.requestId).toBe('req-abc123');
      expect(read.ttftMs).toBe(312.5);
      expect(read.promptTokens).toBe(27);
      expect(read.loadMs).toBe(1200.25);
      expect(read.promptEvalMs).toBe(80.5);
      expect(read.evalMs).toBe(3900.75);
      expect(read.decodeTokensPerSecond).toBe(51.5);
      expect(read.concurrency).toBe(4);
      expect(read.batchId).toBe('batch-0001');
      // Existing fields untouched.
      expect(read.tokensPerSecond).toBe(40.2);
      expect(read.totalTokens).toBe(201);
      expect(read.durationSeconds).toBe(5.0);
      expect(read.success).toBe(true);
    });

    it('should round-trip an openai/direct row through getBenchmarkResultsByModel', () => {
      initDatabase();
      saveBenchmarkResults([
        fullPoolResult({
          model: 'vllm-model',
          transport: 'openai',
          path: 'direct',
          targetUrl: 'http://host:8000/v1',
          servedBy: undefined,
          backend: undefined,
          requestId: undefined,
          loadMs: undefined,
          promptEvalMs: undefined,
          evalMs: undefined,
          concurrency: 1,
          batchId: 'batch-single'
        })
      ]);

      const [read] = getBenchmarkResultsByModel('vllm-model');
      expect(read.transport).toBe('openai');
      expect(read.path).toBe('direct');
      expect(read.targetUrl).toBe('http://host:8000/v1');
      expect(read.servedBy).toBeNull();
      expect(read.backend).toBeNull();
      expect(read.requestId).toBeNull();
      expect(read.loadMs).toBeNull();
      expect(read.promptEvalMs).toBeNull();
      expect(read.evalMs).toBeNull();
      expect(read.ttftMs).toBe(312.5);
      expect(read.decodeTokensPerSecond).toBe(51.5);
      expect(read.concurrency).toBe(1);
    });

    it('should return the new fields alongside system specs', () => {
      initDatabase();
      const specs: SystemSpecs = {
        serverName: 'pool-hub',
        cpuModel: 'Test CPU',
        cpuCores: 8,
        cpuThreads: 16,
        totalMemoryGB: 32,
        osType: 'linux',
        osVersion: 'Ubuntu 24.04',
        gpus: [{ model: 'Test GPU' }]
      };
      const systemSpecsId = saveSystemSpecs(specs);
      saveBenchmarkResults([fullPoolResult()], systemSpecsId);

      const [read] = getBenchmarkResultsWithSpecs();
      expect(read.systemSpecs?.serverName).toBe('pool-hub');
      expect(read.servedBy).toBe('beta-max');
      expect(read.backend).toBe('ollama');
      expect(read.path).toBe('pool');
      expect(read.transport).toBe('ollama');
      expect(read.ttftMs).toBe(312.5);
      expect(read.decodeTokensPerSecond).toBe(51.5);
      expect(read.batchId).toBe('batch-0001');
      expect(read.concurrency).toBe(4);
    });

    it('should write null for every new field when a legacy-shaped row is saved', () => {
      initDatabase();
      saveBenchmarkResults([
        {
          model: 'llama2',
          tokensPerSecond: 45.5,
          totalTokens: 100,
          durationSeconds: 2.2,
          timestamp: new Date().toISOString(),
          success: true
        }
      ]);

      const [read] = getAllBenchmarkResults();
      expect(read.transport).toBeNull();
      expect(read.path).toBeNull();
      expect(read.targetUrl).toBeNull();
      expect(read.servedBy).toBeNull();
      expect(read.backend).toBeNull();
      expect(read.requestId).toBeNull();
      expect(read.ttftMs).toBeNull();
      expect(read.promptTokens).toBeNull();
      expect(read.loadMs).toBeNull();
      expect(read.promptEvalMs).toBeNull();
      expect(read.evalMs).toBeNull();
      expect(read.decodeTokensPerSecond).toBeNull();
      expect(read.concurrency).toBeNull();
      expect(read.batchId).toBeNull();

      const [withSpecs] = getBenchmarkResultsWithSpecs();
      expect(withSpecs.transport).toBeNull();
      expect(withSpecs.batchId).toBeNull();
    });

    it('should store NaN numeric fields as null rather than failing', () => {
      initDatabase();
      saveBenchmarkResults([fullPoolResult({ ttftMs: NaN, decodeTokensPerSecond: NaN })]);
      const [read] = getAllBenchmarkResults();
      expect(read.ttftMs).toBeNull();
      expect(read.decodeTokensPerSecond).toBeNull();
    });
  });

  describe('benchmark aggregates', () => {
    const aggregate = (overrides: Partial<BenchmarkAggregate> = {}): BenchmarkAggregate => ({
      batchId: 'batch-0001',
      model: 'qwen3:8b',
      concurrency: 4,
      wallSeconds: 6.5,
      aggregateTokensPerSecond: 123.4,
      medianTtftMs: 300.5,
      medianDecodeTokensPerSecond: 48.25,
      servedByCounts: { local: 1, 'beta-max': 3 },
      backendCounts: { ollama: 3, vllm: 1 },
      successes: 4,
      failures: 0,
      ...overrides
    });

    it('should insert an aggregate and return its id', () => {
      initDatabase();
      const id = saveBenchmarkAggregate(aggregate());
      expect(id).toBeGreaterThan(0);
    });

    it('should round-trip every field including the JSON count columns', () => {
      initDatabase();
      const specs: SystemSpecs = {
        serverName: 'pool-hub',
        cpuModel: 'Test CPU',
        cpuCores: 8,
        cpuThreads: 16,
        totalMemoryGB: 32,
        osType: 'linux',
        osVersion: 'Ubuntu 24.04',
        gpus: [{ model: 'Test GPU' }]
      };
      const systemSpecsId = saveSystemSpecs(specs);
      const id = saveBenchmarkAggregate(aggregate(), systemSpecsId);

      const [read] = getRecentAggregates();
      expect(read.id).toBe(id);
      expect(read.batchId).toBe('batch-0001');
      expect(read.model).toBe('qwen3:8b');
      expect(read.concurrency).toBe(4);
      expect(read.wallSeconds).toBe(6.5);
      expect(read.aggregateTokensPerSecond).toBe(123.4);
      expect(read.medianTtftMs).toBe(300.5);
      expect(read.medianDecodeTokensPerSecond).toBe(48.25);
      expect(read.servedByCounts).toEqual({ local: 1, 'beta-max': 3 });
      expect(read.backendCounts).toEqual({ ollama: 3, vllm: 1 });
      expect(read.successes).toBe(4);
      expect(read.failures).toBe(0);
      expect(read.systemSpecsId).toBe(systemSpecsId);
      expect(typeof read.timestamp).toBe('string');
      expect(Number.isNaN(Date.parse(read.timestamp))).toBe(false);
    });

    it('should store absent medians as null and read them back as undefined', () => {
      initDatabase();
      saveBenchmarkAggregate(aggregate({ medianTtftMs: undefined, medianDecodeTokensPerSecond: undefined, servedByCounts: {}, backendCounts: {} }));

      const raw = getDatabase().prepare('SELECT median_ttft_ms, median_decode_tokens_per_second, served_by_counts FROM benchmark_aggregates').get() as any;
      expect(raw.median_ttft_ms).toBeNull();
      expect(raw.median_decode_tokens_per_second).toBeNull();
      expect(raw.served_by_counts).toBe('{}');

      const [read] = getRecentAggregates();
      expect(read.medianTtftMs).toBeUndefined();
      expect(read.medianDecodeTokensPerSecond).toBeUndefined();
      expect(read.servedByCounts).toEqual({});
      expect(read.backendCounts).toEqual({});
      expect(read.systemSpecsId).toBeUndefined();
    });

    it('should list aggregates newest first and honour the limit', () => {
      initDatabase();
      // Insert with explicit, distinct timestamps so ordering is deterministic
      // regardless of how fast the inserts run.
      for (const [i, ts] of ['2026-09-20T10:00:00.000Z', '2026-09-20T10:00:02.000Z', '2026-09-20T10:00:01.000Z'].entries()) {
        saveBenchmarkAggregate(aggregate({ batchId: `batch-${i}` }));
        getDatabase().prepare('UPDATE benchmark_aggregates SET timestamp = ? WHERE batch_id = ?').run(ts, `batch-${i}`);
      }

      const all = getRecentAggregates();
      expect(all.map(a => a.batchId)).toEqual(['batch-1', 'batch-2', 'batch-0']);

      const limited = getRecentAggregates(2);
      expect(limited.map(a => a.batchId)).toEqual(['batch-1', 'batch-2']);

      expect(getRecentAggregates(0).length).toBe(3);
    });

    it('should break timestamp ties by insertion order, newest first', () => {
      initDatabase();
      saveBenchmarkAggregate(aggregate({ batchId: 'first' }));
      saveBenchmarkAggregate(aggregate({ batchId: 'second' }));
      getDatabase().prepare('UPDATE benchmark_aggregates SET timestamp = ?').run('2026-09-20T10:00:00.000Z');

      expect(getRecentAggregates().map(a => a.batchId)).toEqual(['second', 'first']);
    });

    it('should replace the row when the same batch_id is saved again', () => {
      initDatabase();
      const id1 = saveBenchmarkAggregate(aggregate({ successes: 3, failures: 1 }));
      const id2 = saveBenchmarkAggregate(aggregate({ successes: 4, failures: 0, servedByCounts: { local: 4 } }));

      expect(id2).toBe(id1);
      const all = getRecentAggregates();
      expect(all.length).toBe(1);
      expect(all[0].successes).toBe(4);
      expect(all[0].failures).toBe(0);
      expect(all[0].servedByCounts).toEqual({ local: 4 });
    });

    it('should return an empty array when there are no aggregates', () => {
      initDatabase();
      expect(getRecentAggregates()).toEqual([]);
      expect(getRecentAggregates(5)).toEqual([]);
    });

    it('should fall back to empty counts on malformed JSON', () => {
      initDatabase();
      saveBenchmarkAggregate(aggregate());
      getDatabase().prepare('UPDATE benchmark_aggregates SET served_by_counts = ?').run('{not json');

      const [read] = getRecentAggregates();
      expect(read.servedByCounts).toEqual({});
      expect(read.backendCounts).toEqual({ ollama: 3, vllm: 1 });
    });
  });
});
