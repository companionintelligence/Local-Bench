import * as http from 'http';
import * as fs from 'fs';
import { server } from './server';
import * as database from './database';

// Mock fs module
jest.mock('fs');
const mockedFs = fs as jest.Mocked<typeof fs>;

// Mock database module
jest.mock('./database');
const mockedDatabase = database as jest.Mocked<typeof database>;

describe('Server Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
        (path: string, callback: (err: null, data: Buffer) => void) => {
          expect(path).toBe('./index.html');
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
        const mockResults = [
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

        mockedDatabase.getBenchmarkResultsWithSpecs.mockReturnValue(mockResults as any);

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

        mockedDatabase.getBenchmarkResultsWithSpecs.mockReturnValue(mockResults as any);

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

      mockedDatabase.getBenchmarkResultsWithSpecs.mockReturnValue(mockResults as any);

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
