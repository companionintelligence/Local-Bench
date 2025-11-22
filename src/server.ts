#!/usr/bin/env node

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, getAllBenchmarkResults, getLatestSystemSpecs, getBenchmarkResultsWithSpecs, getDatabase } from './database';
import { checkModelAvailable, benchmarkModel, saveResultsToCSV, saveResultsToDatabase } from './benchmark';
import axios from 'axios';

const PORT = parseInt(process.env.PORT || '3000', 10);
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434';

interface MimeTypes {
  [key: string]: string;
}

interface BenchmarkRequest {
  models: string[];
}

const mimeTypes: MimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/**
 * Handle API requests
 */
async function handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = req.url || '';
  
  // API endpoint: Get all benchmark results
  if (url === '/api/results') {
    try {
      const results = getAllBenchmarkResults();
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(results));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch results' }));
      return true;
    }
  }
  
  // API endpoint: Get system specs
  if (url === '/api/system-specs') {
    try {
      const specs = getLatestSystemSpecs();
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(specs));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch system specs' }));
      return true;
    }
  }
  
  // API endpoint: Get results with system specs
  if (url.startsWith('/api/results-with-specs')) {
    try {
      const urlParams = new URL(url, `http://localhost:${PORT}`);
      const limit = urlParams.searchParams.get('limit');
      const results = getBenchmarkResultsWithSpecs(limit ? parseInt(limit) : undefined);
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(results));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch results with specs' }));
      return true;
    }
  }
  
  // API endpoint: Get available models from Ollama
  if (url === '/api/models') {
    try {
      const response = await axios.get(`${OLLAMA_API_URL}/api/tags`);
      const models = response.data.models || [];
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(models));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch models from Ollama' }));
      return true;
    }
  }
  
  // API endpoint: Run benchmark (POST)
  if (url === '/api/run-benchmark') {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return true;
    }
    
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      req.on('end', async () => {
        try {
          const data: BenchmarkRequest = JSON.parse(body);
          const models = data.models || [];
          
          if (models.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No models specified' }));
            return;
          }
          
          // Run benchmarks
          const results = [];
          for (const model of models) {
            const result = await benchmarkModel(model);
            results.push(result);
          }
          
          // Save results
          saveResultsToCSV(results);
          await saveResultsToDatabase(results);
          
          res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({ 
            success: true, 
            results: results 
          }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            error: 'Failed to run benchmark: ' + (error as Error).message 
          }));
        }
      });
      
      return true;
    }
    
    return true;
  }
  
  return false;
}

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  
  // Handle API requests
  if (await handleApiRequest(req, res)) {
    return;
  }
  
  let filePath = '.' + req.url;
  if (filePath === './') {
    filePath = './index.html';
  }
  
  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = mimeTypes[extname] || 'application/octet-stream';
  
  fs.readFile(filePath, (error: NodeJS.ErrnoException | null, content: Buffer) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 - File Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code}`, 'utf-8');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

// Only start server if this is the main module
if (require.main === module) {
  // Initialize database once at startup
  try {
    initDatabase();
    console.log('✓ Database initialized');
  } catch (error) {
    console.error('⚠️  Database initialization failed:', (error as Error).message);
    console.error('   API endpoints may not work properly');
  }
  
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log('Press Ctrl+C to stop the server');
  });
}

export { server };
