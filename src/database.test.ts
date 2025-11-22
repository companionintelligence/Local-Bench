import {
  initDatabase,
  closeDatabase,
  saveSystemSpecs,
  saveBenchmarkResults,
  getAllBenchmarkResults,
  getLatestSystemSpecs,
  getBenchmarkResultsWithSpecs,
  BenchmarkResult
} from './database';
import { SystemSpecs } from './systemSpecs';
import * as fs from 'fs';
import * as path from 'path';

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
      
      const results: BenchmarkResult[] = [
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
      
      const results: BenchmarkResult[] = [
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
      
      const results: BenchmarkResult[] = [
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
      
      const testResults: BenchmarkResult[] = [
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
      
      const testResults: BenchmarkResult[] = [
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
      
      const testResults: BenchmarkResult[] = [
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
});
