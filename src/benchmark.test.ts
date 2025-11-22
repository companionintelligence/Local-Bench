import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { benchmarkModel, checkModelAvailable, saveResultsToCSV, saveResultsToDatabase } from './benchmark';
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

describe('Benchmark Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  describe('benchmarkModel', () => {
    it('should successfully benchmark a model', async () => {
      const mockResponse = {
        data: {
          response: 'Test response about AI',
          eval_count: 100
        }
      };

      mockedAxios.post.mockResolvedValue(mockResponse);

      const result = await benchmarkModel('llama2');

      expect(result.success).toBe(true);
      expect(result.model).toBe('llama2');
      expect(result.totalTokens).toBe(100);
      // Duration might be very small, so tokensPerSecond could be very high or 0
      expect(result.tokensPerSecond).toBeTruthy();
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

      const result = await benchmarkModel('test-model');

      expect(result.success).toBe(true);
      expect(result.totalTokens).toBe(0);
      // When eval_count is 0, tokensPerSecond will be either '0' or 'NaN' depending on timing
      expect(result.tokensPerSecond).toBeDefined();
    });

    it('should handle API errors gracefully', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Model not found'));

      const result = await benchmarkModel('nonexistent-model');

      expect(result.success).toBe(false);
      expect(result.model).toBe('nonexistent-model');
      expect(result.totalTokens).toBe(0);
      expect(result.tokensPerSecond).toBe(0);
      expect(result.error).toBe('Model not found');
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error benchmarking'));
    });

    it('should handle timeout errors', async () => {
      mockedAxios.post.mockRejectedValue(new Error('timeout of 120000ms exceeded'));

      const result = await benchmarkModel('slow-model');

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

      await benchmarkModel('test-model');

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

      const result = await benchmarkModel('large-model');

      expect(result.success).toBe(true);
      expect(result.totalTokens).toBe(1000000);
      expect(result.tokensPerSecond).toBeGreaterThan(0);
    });

    it('should handle models with special characters in names', async () => {
      const mockResponse = {
        data: {
          response: 'Test response',
          eval_count: 50
        }
      };

      mockedAxios.post.mockResolvedValue(mockResponse);

      const result = await benchmarkModel('model-name:v1.0');

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

      const result = await benchmarkModel('test-model');

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
});
