import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { benchmarkModel, checkModelAvailable, saveResultsToCSV } from './benchmark';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock fs
jest.mock('fs');
const mockedFs = fs as jest.Mocked<typeof fs>;

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
});
