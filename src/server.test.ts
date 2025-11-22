import * as http from 'http';
import * as fs from 'fs';
import { server } from './server';

// Mock fs module
jest.mock('fs');
const mockedFs = fs as jest.Mocked<typeof fs>;

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
});
