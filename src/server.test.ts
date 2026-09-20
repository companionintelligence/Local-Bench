import * as http from 'http';
import * as fs from 'fs';
import axios from 'axios';
import { server, resetTargetState } from './server';
import * as database from './database';
import * as benchmark from './benchmark';
import { BenchmarkResult, BenchmarkAggregate } from './benchmark';
import { BenchmarkResultRecord } from './database';

// Mock fs module
jest.mock('fs');
const mockedFs = fs as jest.Mocked<typeof fs>;

// Mock database module
jest.mock('./database');
const mockedDatabase = database as jest.Mocked<typeof database>;

// Mock the benchmark runner and the save helpers, but keep the real prompt
// list, model catalog and target resolver so /api/prompts, /api/models and
// /api/target exercise real code (axios is mocked underneath).
jest.mock('./benchmark', () => ({
  ...jest.requireActual('./benchmark'),
  benchmarkModelConcurrently: jest.fn(),
  saveResultsToCSV: jest.fn(),
  saveResultsToDatabase: jest.fn()
}));
const mockedBenchmark = benchmark as jest.Mocked<typeof benchmark>;

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const TEST_PROMPT_ID = benchmark.TEST_PROMPTS[0].id;

const ENV_KEYS = ['OLLAMA_API_URL', 'CI_LLM_BASE_URL', 'CI_LLM_API_KEY', 'BENCH_TRANSPORT'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

/** Build a POST request whose body is delivered through the 'data'/'end' events. */
function postRequest(url: string, body: unknown): http.IncomingMessage {
  const handlers: Record<string, (chunk?: unknown) => void> = {};
  const req = {
    method: 'POST',
    url,
    on: jest.fn((event: string, handler: (chunk?: unknown) => void) => {
      handlers[event] = handler;
      if (event === 'end') {
        handlers['data'](Buffer.from(JSON.stringify(body)));
        handlers['end']();
      }
      return req;
    })
  } as unknown as http.IncomingMessage;
  return req;
}

function makeResult(overrides: Partial<BenchmarkResult> & Record<string, unknown> = {}): BenchmarkResult {
  return {
    model: 'llama2',
    tokensPerSecond: 40,
    totalTokens: 80,
    durationSeconds: 2,
    timestamp: '2026-09-20T10:00:00.000Z',
    success: true,
    ...overrides
  };
}

function makeAggregate(overrides: Partial<BenchmarkAggregate> = {}): BenchmarkAggregate {
  return {
    batchId: 'batch-1',
    model: 'llama2',
    concurrency: 1,
    wallSeconds: 2,
    aggregateTokensPerSecond: 40,
    servedByCounts: {},
    backendCounts: {},
    successes: 1,
    failures: 0,
    ...overrides
  };
}

describe('Server Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetTargetState();
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

  describe('HTTP Server', () => {
    it('should be defined', () => {
      expect(server).toBeDefined();
      expect(server).toBeInstanceOf(http.Server);
    });

    it('should handle successful file reads', (done) => {
      const mockContent = Buffer.from('<html>Test</html>');
      
      // Mock fs.readFile to call callback with success
      (mockedFs.readFile as unknown as jest.Mock).mockImplementation(
        (path: string, callback: (err: null, data: Buffer) => void) => {
          callback(null, mockContent);
        }
      );

      const req = {
        method: 'GET',
        url: '/index.html'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn((data) => {
          expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
          expect(data).toBe(mockContent);
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });

    it('should handle 404 errors for missing files', (done) => {
      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';

      (mockedFs.readFile as unknown as jest.Mock).mockImplementation(
        (path: string, callback: (err: NodeJS.ErrnoException, data?: Buffer) => void) => {
          callback(error);
        }
      );

      const req = {
        method: 'GET',
        url: '/nonexistent.html'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn((data) => {
          expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'text/html' });
          expect(data).toContain('404');
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });

    it('should handle 500 errors for other file errors', (done) => {
      const error = new Error('Permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';

      (mockedFs.readFile as unknown as jest.Mock).mockImplementation(
        (path: string, callback: (err: NodeJS.ErrnoException, data?: Buffer) => void) => {
          callback(error);
        }
      );

      const req = {
        method: 'GET',
        url: '/protected.html'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn((data) => {
          expect(res.writeHead).toHaveBeenCalledWith(500);
          expect(data).toContain('EACCES');
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });

    it('should serve index.html for root path', (done) => {
      const mockContent = Buffer.from('<html>Index</html>');

      (mockedFs.readFile as unknown as jest.Mock).mockImplementation(
        (filePath: string, callback: (err: null, data: Buffer) => void) => {
          // Root resolves to <cwd>/index.html, contained inside the static root.
          expect(filePath).toBe(require('path').join(process.cwd(), 'index.html'));
          callback(null, mockContent);
        }
      );

      const req = {
        method: 'GET',
        url: '/'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn(() => {
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });

    it('should contain path traversal attempts inside the static root', (done) => {
      const root = process.cwd();
      // A traversal attempt must resolve to a path *inside* the static root, never
      // to the real filesystem location it is trying to escape to.
      (mockedFs.readFile as unknown as jest.Mock).mockImplementation(
        (filePath: string, callback: (err: NodeJS.ErrnoException) => void) => {
          expect(filePath.startsWith(root + require('path').sep)).toBe(true);
          expect(filePath).not.toBe('/etc/passwd');
          const error = new Error('File not found') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          callback(error);
        }
      );

      const req = {
        method: 'GET',
        url: '/../../../etc/passwd'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn((data) => {
          expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'text/html' });
          expect(data).toContain('404');
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });

    it('should set correct MIME type for HTML files', (done) => {
      const mockContent = Buffer.from('<html>Test</html>');

      (mockedFs.readFile as unknown as jest.Mock).mockImplementation(
        (path: string, callback: (err: null, data: Buffer) => void) => {
          callback(null, mockContent);
        }
      );

      const req = {
        method: 'GET',
        url: '/test.html'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn(() => {
          expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });

    it('should set correct MIME type for CSS files', (done) => {
      const mockContent = Buffer.from('body { color: red; }');

      (mockedFs.readFile as unknown as jest.Mock).mockImplementation(
        (path: string, callback: (err: null, data: Buffer) => void) => {
          callback(null, mockContent);
        }
      );

      const req = {
        method: 'GET',
        url: '/styles.css'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn(() => {
          expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/css' });
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });

    it('should set correct MIME type for JavaScript files', (done) => {
      const mockContent = Buffer.from('console.log("test");');

      (mockedFs.readFile as unknown as jest.Mock).mockImplementation(
        (path: string, callback: (err: null, data: Buffer) => void) => {
          callback(null, mockContent);
        }
      );

      const req = {
        method: 'GET',
        url: '/script.js'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn(() => {
          expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/javascript' });
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });

    it('should set correct MIME type for CSV files', (done) => {
      const mockContent = Buffer.from('name,value\ntest,123');

      (mockedFs.readFile as unknown as jest.Mock).mockImplementation(
        (path: string, callback: (err: null, data: Buffer) => void) => {
          callback(null, mockContent);
        }
      );

      const req = {
        method: 'GET',
        url: '/data.csv'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn(() => {
          expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/csv' });
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });

    it('should use default MIME type for unknown file types', (done) => {
      const mockContent = Buffer.from('Unknown content');

      (mockedFs.readFile as unknown as jest.Mock).mockImplementation(
        (path: string, callback: (err: null, data: Buffer) => void) => {
          callback(null, mockContent);
        }
      );

      const req = {
        method: 'GET',
        url: '/file.unknown'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn(() => {
          expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/octet-stream' });
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });

    it('should log requests', (done) => {
      const mockContent = Buffer.from('Test');

      (mockedFs.readFile as unknown as jest.Mock).mockImplementation(
        (path: string, callback: (err: null, data: Buffer) => void) => {
          callback(null, mockContent);
        }
      );

      const req = {
        method: 'POST',
        url: '/api/test'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn(() => {
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('POST'));
          expect(console.log).toHaveBeenCalledWith(expect.stringContaining('/api/test'));
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });
  });

  describe('API Endpoints', () => {
    describe('GET /api/results', () => {
      it('should return all benchmark results', (done) => {
        const mockResults = [
          {
            id: 1,
            model: 'llama2',
            tokensPerSecond: 45.5,
            totalTokens: 100,
            durationSeconds: 2.2,
            timestamp: '2024-01-15T10:30:00.000Z',
            success: true
          }
        ];

        mockedDatabase.getAllBenchmarkResults.mockReturnValue(mockResults);

        const req = {
          method: 'GET',
          url: '/api/results'
        } as http.IncomingMessage;

        const res = {
          writeHead: jest.fn(),
          end: jest.fn((data) => {
            expect(res.writeHead).toHaveBeenCalledWith(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            expect(JSON.parse(data)).toEqual(mockResults);
            done();
          })
        } as unknown as http.ServerResponse;

        server.emit('request', req, res);
      });

      it('should handle errors when fetching results', (done) => {
        mockedDatabase.getAllBenchmarkResults.mockImplementation(() => {
          throw new Error('Database error');
        });

        const req = {
          method: 'GET',
          url: '/api/results'
        } as http.IncomingMessage;

        const res = {
          writeHead: jest.fn(),
          end: jest.fn((data) => {
            expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
            expect(JSON.parse(data)).toEqual({ error: 'Failed to fetch results' });
            done();
          })
        } as unknown as http.ServerResponse;

        server.emit('request', req, res);
      });
    });

    describe('GET /api/system-specs', () => {
      it('should return latest system specs', (done) => {
        const mockSpecs = {
          id: 1,
          serverName: 'test-server',
          cpuModel: 'Test CPU',
          cpuCores: 8,
          cpuThreads: 16,
          totalMemoryGB: 32,
          osType: 'linux',
          osVersion: 'Ubuntu 22.04',
          gpus: [{ model: 'Test GPU' }],
          timestamp: '2024-01-15T10:30:00.000Z'
        };

        mockedDatabase.getLatestSystemSpecs.mockReturnValue(mockSpecs);

        const req = {
          method: 'GET',
          url: '/api/system-specs'
        } as http.IncomingMessage;

        const res = {
          writeHead: jest.fn(),
          end: jest.fn((data) => {
            expect(res.writeHead).toHaveBeenCalledWith(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            expect(JSON.parse(data)).toEqual(mockSpecs);
            done();
          })
        } as unknown as http.ServerResponse;

        server.emit('request', req, res);
      });

      it('should handle errors when fetching system specs', (done) => {
        mockedDatabase.getLatestSystemSpecs.mockImplementation(() => {
          throw new Error('Database error');
        });

        const req = {
          method: 'GET',
          url: '/api/system-specs'
        } as http.IncomingMessage;

        const res = {
          writeHead: jest.fn(),
          end: jest.fn((data) => {
            expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
            expect(JSON.parse(data)).toEqual({ error: 'Failed to fetch system specs' });
            done();
          })
        } as unknown as http.ServerResponse;

        server.emit('request', req, res);
      });
    });

    describe('GET /api/results-with-specs', () => {
      it('should return results with system specs', (done) => {
        const mockResults: Array<BenchmarkResultRecord & { systemSpecs?: any }> = [
          {
            id: 1,
            model: 'llama2',
            tokensPerSecond: 45.5,
            totalTokens: 100,
            durationSeconds: 2.2,
            timestamp: '2024-01-15T10:30:00.000Z',
            success: true,
            systemSpecs: {
              serverName: 'test-server',
              cpuModel: 'Test CPU'
            }
          }
        ];

        mockedDatabase.getBenchmarkResultsWithSpecs.mockReturnValue(mockResults);

        const req = {
          method: 'GET',
          url: '/api/results-with-specs'
        } as http.IncomingMessage;

        const res = {
          writeHead: jest.fn(),
          end: jest.fn((data) => {
            expect(res.writeHead).toHaveBeenCalledWith(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            expect(JSON.parse(data)).toEqual(mockResults);
            done();
          })
        } as unknown as http.ServerResponse;

        server.emit('request', req, res);
      });

      it('should handle limit parameter', (done) => {
        const mockResults: Array<BenchmarkResultRecord & { systemSpecs?: any }> = [
          {
            id: 1,
            model: 'llama2',
            tokensPerSecond: 45.5,
            totalTokens: 100,
            durationSeconds: 2.2,
            timestamp: '2024-01-15T10:30:00.000Z',
            success: true
          }
        ];

        mockedDatabase.getBenchmarkResultsWithSpecs.mockReturnValue(mockResults);

        const req = {
          method: 'GET',
          url: '/api/results-with-specs?limit=10'
        } as http.IncomingMessage;

        const res = {
          writeHead: jest.fn(),
          end: jest.fn((data) => {
            expect(mockedDatabase.getBenchmarkResultsWithSpecs).toHaveBeenCalledWith(10);
            expect(res.writeHead).toHaveBeenCalledWith(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            done();
          })
        } as unknown as http.ServerResponse;

        server.emit('request', req, res);
      });

      it('should handle errors when fetching results with specs', (done) => {
        mockedDatabase.getBenchmarkResultsWithSpecs.mockImplementation(() => {
          throw new Error('Database error');
        });

        const req = {
          method: 'GET',
          url: '/api/results-with-specs'
        } as http.IncomingMessage;

        const res = {
          writeHead: jest.fn(),
          end: jest.fn((data) => {
            expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
            expect(JSON.parse(data)).toEqual({ error: 'Failed to fetch results with specs' });
            done();
          })
        } as unknown as http.ServerResponse;

        server.emit('request', req, res);
      });
    });

    describe('GET /api/prompts', () => {
      it('should return available test prompts', (done) => {
        const req = {
          method: 'GET',
          url: '/api/prompts'
        } as http.IncomingMessage;

        const res = {
          writeHead: jest.fn(),
          end: jest.fn((data) => {
            expect(res.writeHead).toHaveBeenCalledWith(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            
            const prompts = JSON.parse(data);
            expect(Array.isArray(prompts)).toBe(true);
            expect(prompts.length).toBeGreaterThan(0);
            
            // Verify prompt structure
            prompts.forEach((prompt: any) => {
              expect(prompt).toHaveProperty('id');
              expect(prompt).toHaveProperty('name');
              expect(prompt).toHaveProperty('prompt');
              expect(prompt).toHaveProperty('description');
            });
            
            done();
          })
        } as unknown as http.ServerResponse;

        server.emit('request', req, res);
      });
    });

    describe('GET /api/meta', () => {
      it('should return intelligence-score attribution metadata', (done) => {
        const req = {
          method: 'GET',
          url: '/api/meta'
        } as http.IncomingMessage;

        const res = {
          writeHead: jest.fn(),
          end: jest.fn((data) => {
            expect(res.writeHead).toHaveBeenCalledWith(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            const meta = JSON.parse(data);
            expect(meta).toHaveProperty('intelligence');
            expect(meta.intelligence).toHaveProperty('source');
            expect(meta.intelligence).toHaveProperty('url');
            expect(meta.intelligence).toHaveProperty('asOf');
            expect(meta.intelligence.source).toMatch(/Artificial Analysis/i);
            done();
          })
        } as unknown as http.ServerResponse;

        server.emit('request', req, res);
      });
    });

    describe('GET /api/models', () => {
      it('should include the intelligence index on catalog entries', (done) => {
        mockedAxios.get.mockResolvedValue({ data: { models: [] } });

        const req = {
          method: 'GET',
          url: '/api/models'
        } as http.IncomingMessage;

        const res = {
          writeHead: jest.fn(),
          end: jest.fn((data) => {
            const models = JSON.parse(data);
            expect(models.length).toBeGreaterThan(0);
            models.forEach((model: any) => {
              expect(model).toHaveProperty('intelligenceIndex');
            });
            const gptOss = models.find((m: any) => m.name === 'gpt-oss:120b');
            expect(typeof gptOss.intelligenceIndex).toBe('number');
            done();
          })
        } as unknown as http.ServerResponse;

        server.emit('request', req, res);
      });

      it('should merge installed models with the supported catalog', (done) => {
        mockedAxios.get.mockResolvedValue({
          data: {
            models: [
              { name: 'qwen3:8b' },
              { name: 'custom-model:latest', size: 512 * 1024 * 1024 }
            ]
          }
        });

        const req = {
          method: 'GET',
          url: '/api/models'
        } as http.IncomingMessage;

        const res = {
          writeHead: jest.fn(),
          end: jest.fn((data) => {
            expect(res.writeHead).toHaveBeenCalledWith(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });

            const models = JSON.parse(data);
            const installedCatalogModel = models.find((model: any) => model.name === 'qwen3:8b');
            const installedOnlyModel = models.find((model: any) => model.name === 'custom-model:latest');

            expect(installedCatalogModel).toMatchObject({
              name: 'qwen3:8b',
              installed: true,
              supported: true
            });
            expect(installedOnlyModel).toMatchObject({
              name: 'custom-model:latest',
              installed: true,
              supported: false,
              source: 'installed'
            });
            done();
          })
        } as unknown as http.ServerResponse;

        server.emit('request', req, res);
      });

      it('should fall back to the supported catalog when Ollama is unavailable', (done) => {
        mockedAxios.get.mockRejectedValue(new Error('Connection refused'));

        const req = {
          method: 'GET',
          url: '/api/models'
        } as http.IncomingMessage;

        const res = {
          writeHead: jest.fn(),
          end: jest.fn((data) => {
            expect(res.writeHead).toHaveBeenCalledWith(503, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });

            const models = JSON.parse(data);
            expect(Array.isArray(models)).toBe(true);
            expect(models.length).toBeGreaterThan(0);
            expect(models.every((model: any) => model.installed === false)).toBe(true);
            done();
          })
        } as unknown as http.ServerResponse;

        server.emit('request', req, res);
      });
    });
  });

  describe('GET /api/target', () => {
    function getTarget(done: () => void, assert: (body: any) => void): void {
      const req = { method: 'GET', url: '/api/target' } as http.IncomingMessage;
      const res = {
        writeHead: jest.fn(),
        end: jest.fn((data) => {
          expect(res.writeHead).toHaveBeenCalledWith(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          assert(JSON.parse(data));
          done();
        })
      } as unknown as http.ServerResponse;
      server.emit('request', req, res);
    }

    it('reports a direct Ollama target with no pool block', (done) => {
      mockedAxios.get.mockResolvedValue({ data: { models: [] }, headers: {} });
      getTarget(done, (body) => {
        expect(body).toEqual({
          url: 'http://localhost:11434',
          transport: 'ollama',
          path: 'direct',
          pool: null
        });
        expect(mockedAxios.get).toHaveBeenCalledWith('http://localhost:11434/api/tags', expect.objectContaining({ headers: {} }));
      });
    });

    it('reports a pool proxy target and whether the pool has answered yet', (done) => {
      process.env.OLLAMA_API_URL = 'http://100.115.174.32:5002/api/inference/pool';
      mockedAxios.get.mockResolvedValue({ data: { models: [] }, headers: {} });
      getTarget(done, (body) => {
        expect(body.path).toBe('pool');
        expect(body.transport).toBe('ollama');
        expect(body.pool).toEqual({ servedByHeaderSeen: false });
      });
    });

    it('marks the served-by header as seen once a model listing carries it', (done) => {
      process.env.OLLAMA_API_URL = 'http://hub:5002/api/inference/pool';
      mockedAxios.get.mockResolvedValue({ data: { models: [] }, headers: { 'x-hub-pool-served-by': 'local' } });
      const modelsReq = { method: 'GET', url: '/api/models' } as http.IncomingMessage;
      const modelsRes = {
        writeHead: jest.fn(),
        end: jest.fn(() => {
          getTarget(done, (body) => {
            expect(body.pool).toEqual({ servedByHeaderSeen: true });
          });
        })
      } as unknown as http.ServerResponse;
      server.emit('request', modelsReq, modelsRes);
    });

    it('falls back to the openai transport when /api/tags is not there', (done) => {
      process.env.CI_LLM_BASE_URL = 'http://strix:8000/v1';
      mockedAxios.get.mockRejectedValue(new Error('404'));
      getTarget(done, (body) => {
        expect(body).toEqual({ url: 'http://strix:8000', transport: 'openai', path: 'direct', pool: null });
      });
    });

    it('honours BENCH_TRANSPORT without probing', (done) => {
      process.env.BENCH_TRANSPORT = 'openai';
      getTarget(done, (body) => {
        expect(body.transport).toBe('openai');
        expect(mockedAxios.get).not.toHaveBeenCalled();
      });
    });

    it('sends the CI_LLM_API_KEY as a bearer token on the probe', (done) => {
      process.env.CI_LLM_API_KEY = 'secret-key';
      mockedAxios.get.mockResolvedValue({ data: { models: [] }, headers: {} });
      getTarget(done, () => {
        expect(mockedAxios.get).toHaveBeenCalledWith(
          'http://localhost:11434/api/tags',
          expect.objectContaining({ headers: { Authorization: 'Bearer secret-key' } })
        );
      });
    });

    it('probes the transport once and caches it per base URL', (done) => {
      mockedAxios.get.mockResolvedValue({ data: { models: [] }, headers: {} });
      getTarget(() => {
        getTarget(done, () => {
          expect(mockedAxios.get).toHaveBeenCalledTimes(1);
        });
      }, () => {});
    });
  });

  describe('GET /api/models against non-Ollama targets', () => {
    it('lists models from /v1/models when /api/tags is not served', (done) => {
      process.env.CI_LLM_BASE_URL = 'http://strix:8000/v1';
      process.env.CI_LLM_API_KEY = 'secret-key';
      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url === 'http://strix:8000/api/tags') {
          throw new Error('404');
        }
        if (url === 'http://strix:8000/v1/models') {
          return { data: { data: [{ id: 'qwen3:8b', object: 'model' }, { id: 'Qwen/Qwen3-32B-AWQ', object: 'model' }] }, headers: {} };
        }
        throw new Error(`unexpected url ${url}`);
      });

      const req = { method: 'GET', url: '/api/models' } as http.IncomingMessage;
      const res = {
        writeHead: jest.fn(),
        end: jest.fn((data) => {
          expect(res.writeHead).toHaveBeenCalledWith(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          expect(mockedAxios.get).toHaveBeenCalledWith(
            'http://strix:8000/v1/models',
            expect.objectContaining({ headers: { Authorization: 'Bearer secret-key' } })
          );
          const models = JSON.parse(data);
          expect(models.find((m: any) => m.name === 'qwen3:8b')).toMatchObject({ installed: true, supported: true });
          expect(models.find((m: any) => m.name === 'Qwen/Qwen3-32B-AWQ')).toMatchObject({ installed: true, supported: false, source: 'installed' });
          done();
        })
      } as unknown as http.ServerResponse;
      server.emit('request', req, res);
    });

    it('falls back to the catalog with 503 when neither protocol answers', (done) => {
      process.env.CI_LLM_BASE_URL = 'http://strix:8000';
      mockedAxios.get.mockRejectedValue(new Error('Connection refused'));

      const req = { method: 'GET', url: '/api/models' } as http.IncomingMessage;
      const res = {
        writeHead: jest.fn(),
        end: jest.fn((data) => {
          expect(res.writeHead).toHaveBeenCalledWith(503, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          expect(mockedAxios.get).toHaveBeenCalledWith('http://strix:8000/api/tags', expect.anything());
          expect(mockedAxios.get).toHaveBeenCalledWith('http://strix:8000/v1/models', expect.anything());
          expect(JSON.parse(data).every((m: any) => m.installed === false)).toBe(true);
          done();
        })
      } as unknown as http.ServerResponse;
      server.emit('request', req, res);
    });
  });

  describe('GET /api/aggregates', () => {
    it('returns recent aggregates and forwards the limit', (done) => {
      const rows = [
        { id: 1, timestamp: '2026-09-20T10:00:00.000Z', ...makeAggregate({ batchId: 'b1' }) },
        { id: 2, timestamp: '2026-09-20T10:05:00.000Z', ...makeAggregate({ batchId: 'b2', concurrency: 4 }) }
      ];
      mockedDatabase.getRecentAggregates.mockReturnValue(rows);

      const req = { method: 'GET', url: '/api/aggregates?limit=25' } as http.IncomingMessage;
      const res = {
        writeHead: jest.fn(),
        end: jest.fn((data) => {
          expect(mockedDatabase.getRecentAggregates).toHaveBeenCalledWith(25);
          expect(res.writeHead).toHaveBeenCalledWith(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          expect(JSON.parse(data)).toEqual(rows);
          done();
        })
      } as unknown as http.ServerResponse;
      server.emit('request', req, res);
    });

    it('ignores a non-numeric limit', (done) => {
      mockedDatabase.getRecentAggregates.mockReturnValue([]);
      const req = { method: 'GET', url: '/api/aggregates?limit=abc' } as http.IncomingMessage;
      const res = {
        writeHead: jest.fn(),
        end: jest.fn(() => {
          expect(mockedDatabase.getRecentAggregates).toHaveBeenCalledWith(undefined);
          done();
        })
      } as unknown as http.ServerResponse;
      server.emit('request', req, res);
    });

    it('returns 500 when the table cannot be read', (done) => {
      mockedDatabase.getRecentAggregates.mockImplementation(() => {
        throw new Error('no such table');
      });
      const req = { method: 'GET', url: '/api/aggregates' } as http.IncomingMessage;
      const res = {
        writeHead: jest.fn(),
        end: jest.fn((data) => {
          expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
          expect(JSON.parse(data)).toEqual({ error: 'Failed to fetch aggregates' });
          done();
        })
      } as unknown as http.ServerResponse;
      server.emit('request', req, res);
    });
  });

  describe('POST /api/run-benchmark', () => {
    function runBenchmark(body: unknown, done: () => void, assert: (status: number, headers: unknown, body: any) => void): void {
      const res = {
        writeHead: jest.fn(),
        end: jest.fn((data) => {
          const [status, headers] = res.writeHead.mock.calls[0];
          assert(status, headers, JSON.parse(data));
          done();
        })
      } as unknown as http.ServerResponse & { writeHead: jest.Mock };
      server.emit('request', postRequest('/api/run-benchmark', body), res);
    }

    it('answers the CORS preflight as before', (done) => {
      const req = { method: 'OPTIONS', url: '/api/run-benchmark' } as http.IncomingMessage;
      const res = {
        writeHead: jest.fn(),
        end: jest.fn(() => {
          expect(res.writeHead).toHaveBeenCalledWith(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
          });
          done();
        })
      } as unknown as http.ServerResponse;
      server.emit('request', req, res);
    });

    it('runs a single-model batch with concurrency 1 and streaming by default', (done) => {
      const rows = [makeResult()];
      const aggregate = makeAggregate();
      mockedBenchmark.benchmarkModelConcurrently.mockResolvedValue({ results: rows, aggregate });

      runBenchmark({ models: ['llama2'], promptId: TEST_PROMPT_ID }, done, (status, headers, body) => {
        expect(mockedBenchmark.benchmarkModelConcurrently).toHaveBeenCalledTimes(1);
        expect(mockedBenchmark.benchmarkModelConcurrently).toHaveBeenCalledWith(
          'llama2',
          expect.any(String),
          1,
          { stream: true }
        );
        expect(mockedBenchmark.saveResultsToCSV).toHaveBeenCalledWith(rows);
        // Rows and their aggregate go to the database in one call so they share a specs row.
        expect(mockedBenchmark.saveResultsToDatabase).toHaveBeenCalledWith(rows, [aggregate]);
        expect(status).toBe(200);
        expect(headers).toEqual({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        expect(body).toEqual({ success: true, results: rows, aggregates: [aggregate] });
      });
    });

    it('passes concurrency and stream through and returns one aggregate per model', (done) => {
      mockedBenchmark.benchmarkModelConcurrently.mockImplementation(async (model, _prompt, concurrency) => ({
        results: Array.from({ length: concurrency }, (_, i) => makeResult({ model, batchId: `${model}-batch`, concurrency, servedBy: i % 2 ? 'peer-a' : 'local' })),
        aggregate: makeAggregate({ model, batchId: `${model}-batch`, concurrency })
      }));

      runBenchmark({ models: ['llama2', 'qwen3:8b'], customPrompt: '  hello  ', concurrency: 4, stream: false }, done, (status, _headers, body) => {
        expect(status).toBe(200);
        expect(mockedBenchmark.benchmarkModelConcurrently).toHaveBeenNthCalledWith(1, 'llama2', 'hello', 4, { stream: false });
        expect(mockedBenchmark.benchmarkModelConcurrently).toHaveBeenNthCalledWith(2, 'qwen3:8b', 'hello', 4, { stream: false });
        expect(body.results).toHaveLength(8);
        expect(body.aggregates.map((a: BenchmarkAggregate) => a.model)).toEqual(['llama2', 'qwen3:8b']);
        // Everything went to the database in one call, so rows and aggregates share specs.
        expect(mockedBenchmark.saveResultsToDatabase).toHaveBeenCalledTimes(1);
        const [savedRows, savedAggregates] = mockedBenchmark.saveResultsToDatabase.mock.calls[0];
        expect(savedRows).toHaveLength(8);
        expect(savedAggregates!.map(a => a.model)).toEqual(['llama2', 'qwen3:8b']);
      });
    });

    it('flips /api/target pool.servedByHeaderSeen once a row carries servedBy', (done) => {
      mockedBenchmark.benchmarkModelConcurrently.mockResolvedValue({
        results: [makeResult({ servedBy: 'peer-a', backend: 'ollama' })],
        aggregate: makeAggregate({ servedByCounts: { 'peer-a': 1 } })
      });
      mockedAxios.get.mockResolvedValue({ data: { models: [] }, headers: {} });

      runBenchmark({ models: ['llama2'] }, () => {
        const req = { method: 'GET', url: '/api/target' } as http.IncomingMessage;
        const res = {
          writeHead: jest.fn(),
          end: jest.fn((data) => {
            // URL still looks direct, but the pool has demonstrably answered.
            expect(JSON.parse(data)).toMatchObject({ path: 'direct', pool: { servedByHeaderSeen: true } });
            done();
          })
        } as unknown as http.ServerResponse;
        server.emit('request', req, res);
      }, (status) => {
        expect(status).toBe(200);
      });
    });

    it.each([0, 17, 1.5, 'four'])('rejects concurrency %p with 400', (concurrency, done) => {
      runBenchmark({ models: ['llama2'], concurrency }, done as () => void, (status, _headers, body) => {
        expect(status).toBe(400);
        expect(body.error).toMatch(/Invalid concurrency/);
        expect(mockedBenchmark.benchmarkModelConcurrently).not.toHaveBeenCalled();
      });
    });

    it('accepts concurrency at the 16 ceiling', (done) => {
      mockedBenchmark.benchmarkModelConcurrently.mockResolvedValue({ results: [], aggregate: makeAggregate({ concurrency: 16 }) });
      runBenchmark({ models: ['llama2'], concurrency: 16 }, done, (status) => {
        expect(status).toBe(200);
        expect(mockedBenchmark.benchmarkModelConcurrently).toHaveBeenCalledWith('llama2', undefined, 16, { stream: true });
      });
    });

    it('rejects an empty model list', (done) => {
      runBenchmark({ models: [] }, done, (status, _headers, body) => {
        expect(status).toBe(400);
        expect(body).toEqual({ error: 'No models specified' });
      });
    });

    it('rejects an unknown prompt id', (done) => {
      runBenchmark({ models: ['llama2'], promptId: 'nope' }, done, (status, _headers, body) => {
        expect(status).toBe(400);
        expect(body.error).toContain('Invalid prompt ID: nope');
      });
    });

    it('returns 500 when the runner throws', (done) => {
      mockedBenchmark.benchmarkModelConcurrently.mockRejectedValue(new Error('pool 502: no candidate'));
      runBenchmark({ models: ['llama2'] }, done, (status, headers, body) => {
        expect(status).toBe(500);
        expect(headers).toEqual({ 'Content-Type': 'application/json' });
        expect(body.error).toBe('Failed to run benchmark: pool 502: no candidate');
        expect(mockedBenchmark.saveResultsToDatabase).not.toHaveBeenCalled();
      });
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle requests without URL', (done) => {
      const mockContent = Buffer.from('<html>Test</html>');

      (mockedFs.readFile as unknown as jest.Mock).mockImplementation(
        (path: string, callback: (err: null, data: Buffer) => void) => {
          callback(null, mockContent);
        }
      );

      const req = {
        method: 'GET',
        url: undefined
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn(() => {
          expect(res.writeHead).toHaveBeenCalled();
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });

    it('should handle invalid limit parameter', (done) => {
      const mockResults: Array<BenchmarkResultRecord & { systemSpecs?: any }> = [
        {
          id: 1,
          model: 'llama2',
          tokensPerSecond: 45.5,
          totalTokens: 100,
          durationSeconds: 2.2,
          timestamp: '2024-01-15T10:30:00.000Z',
          success: true
        }
      ];

      mockedDatabase.getBenchmarkResultsWithSpecs.mockReturnValue(mockResults);

      const req = {
        method: 'GET',
        url: '/api/results-with-specs?limit=invalid'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn(() => {
          // Should call with NaN which becomes undefined
          expect(mockedDatabase.getBenchmarkResultsWithSpecs).toHaveBeenCalled();
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });

    it('should handle CORS headers correctly', (done) => {
      const mockResults: any[] = [];
      mockedDatabase.getAllBenchmarkResults.mockReturnValue(mockResults);

      const req = {
        method: 'GET',
        url: '/api/results'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn(() => {
          expect(res.writeHead).toHaveBeenCalledWith(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });

    it('should handle file read with empty buffer', (done) => {
      const mockContent = Buffer.from('');

      (mockedFs.readFile as unknown as jest.Mock).mockImplementation(
        (path: string, callback: (err: null, data: Buffer) => void) => {
          callback(null, mockContent);
        }
      );

      const req = {
        method: 'GET',
        url: '/empty.html'
      } as http.IncomingMessage;

      const res = {
        writeHead: jest.fn(),
        end: jest.fn((data) => {
          expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
          expect(data).toEqual(mockContent);
          done();
        })
      } as unknown as http.ServerResponse;

      server.emit('request', req, res);
    });
  });
});
