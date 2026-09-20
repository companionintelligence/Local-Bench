#!/usr/bin/env node

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, getAllBenchmarkResults, getLatestSystemSpecs, getBenchmarkResultsWithSpecs, getDatabase, getRecentAggregates } from './database';
import {
  BenchmarkResult,
  BenchmarkAggregate,
  MAX_CONCURRENCY,
  benchmarkModelConcurrently,
  getConfiguredBaseUrl,
  getOllamaModelCatalog,
  resetTargetCache,
  resolveTarget,
  saveResultsToCSV,
  saveResultsToDatabase,
  TEST_PROMPTS,
  INTELLIGENCE_INDEX_SOURCE,
  INTELLIGENCE_INDEX_URL,
  INTELLIGENCE_INDEX_AS_OF
} from './benchmark';
import axios from 'axios';

const PORT = parseInt(process.env.PORT || '3000', 10);
const PROBE_TIMEOUT_MS = 10000;

// Root directory for static file serving. Requests are resolved relative to this
// and must stay inside it, so path-traversal attempts (e.g. /../../etc/passwd)
// cannot escape the app directory.
const STATIC_ROOT = process.cwd();

interface MimeTypes {
  [key: string]: string;
}

interface BenchmarkRequest {
  models: string[];
  promptId?: string;
  customPrompt?: string;
  concurrency?: number;
  stream?: boolean;
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

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------
// Base URL, transport probe and pool detection live in ./benchmark
// (getConfiguredBaseUrl / resolveTarget) so /api/target can never disagree with
// the requests the runner actually sends.

function authHeaders(): Record<string, string> {
  const key = process.env.CI_LLM_API_KEY && process.env.CI_LLM_API_KEY.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// Set once any response we see carries X-Hub-Pool-Served-By, so /api/target can
// say whether the pool has actually answered us (not only that the URL looks
// like a pool).
let servedByHeaderSeen = false;

function noteResponseHeaders(headers: unknown): void {
  if (headers && typeof headers === 'object' && (headers as Record<string, unknown>)['x-hub-pool-served-by']) {
    servedByHeaderSeen = true;
  }
}

function noteResultRows(results: BenchmarkResult[]): void {
  if (results.some(r => typeof r.servedBy === 'string' && r.servedBy.length > 0)) {
    servedByHeaderSeen = true;
  }
}

interface InstalledModel {
  name: string;
  size?: number;
}

/**
 * Model list from an Ollama-native base (/api/tags). Throws when the base does
 * not speak Ollama.
 */
async function fetchOllamaTags(base: string): Promise<InstalledModel[]> {
  const response = await axios.get(`${base}/api/tags`, { headers: authHeaders(), timeout: PROBE_TIMEOUT_MS });
  noteResponseHeaders(response.headers);
  const models = response.data && Array.isArray(response.data.models) ? response.data.models : [];
  return models as InstalledModel[];
}

/**
 * Model list from an OpenAI-compatible base (/v1/models). data[].id → {name}.
 */
async function fetchOpenAiModels(base: string): Promise<InstalledModel[]> {
  const response = await axios.get(`${base}/v1/models`, { headers: authHeaders(), timeout: PROBE_TIMEOUT_MS });
  noteResponseHeaders(response.headers);
  const data = response.data && Array.isArray(response.data.data) ? response.data.data : [];
  return data
    .filter((entry: unknown) => entry && typeof (entry as { id?: unknown }).id === 'string')
    .map((entry: { id: string }) => ({ name: entry.id }));
}

/** Test hook: forget the cached transport probe and the served-by observation. */
export function resetTargetState(): void {
  resetTargetCache();
  servedByHeaderSeen = false;
}

/**
 * Installed models from whichever protocol the target speaks: /api/tags first
 * (Ollama or a pool proxy), then /v1/models (vLLM, Lemonade, Lucebox, or a
 * pool's OpenAI surface). Throws when neither answers.
 */
async function fetchInstalledModels(base: string): Promise<InstalledModel[]> {
  try {
    return await fetchOllamaTags(base);
  } catch (tagsError) {
    try {
      return await fetchOpenAiModels(base);
    } catch {
      throw tagsError;
    }
  }
}

/**
 * Clamp the requested concurrency to the contract's 1..16; returns undefined
 * when the value is not a usable integer.
 */
function parseConcurrency(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return 1;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
    return undefined;
  }
  return n;
}

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

  // API endpoint: Recent batch aggregates (one row per concurrent batch)
  if (url.startsWith('/api/aggregates')) {
    try {
      const urlParams = new URL(url, `http://localhost:${PORT}`);
      const limit = urlParams.searchParams.get('limit');
      const parsedLimit = limit ? parseInt(limit, 10) : NaN;
      const aggregates = getRecentAggregates(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(aggregates));
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch aggregates' }));
      return true;
    }
  }

  // API endpoint: What the benchmark is pointed at and how it will talk to it
  if (url === '/api/target') {
    const target = await resolveTarget();
    const pool = target.path === 'pool' || servedByHeaderSeen ? { servedByHeaderSeen } : null;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ url: target.url, transport: target.transport, path: target.path, pool }));
    return true;
  }

  // API endpoint: App metadata (intelligence-score attribution, etc.)
  if (url === '/api/meta') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      intelligence: {
        source: INTELLIGENCE_INDEX_SOURCE,
        url: INTELLIGENCE_INDEX_URL,
        asOf: INTELLIGENCE_INDEX_AS_OF
      }
    }));
    return true;
  }

  // API endpoint: Get available test prompts
  if (url === '/api/prompts') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(TEST_PROMPTS));
    return true;
  }

  // API endpoint: Get available models from the target (Ollama, pool proxy, or
  // an OpenAI-compatible engine); falls back to the curated catalog.
  if (url === '/api/models') {
    try {
      const models = await fetchInstalledModels(getConfiguredBaseUrl());
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(getOllamaModelCatalog(models)));
      return true;
    } catch (error) {
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(getOllamaModelCatalog()));
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

          const concurrency = parseConcurrency(data.concurrency);
          if (concurrency === undefined) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Invalid concurrency: expected an integer from 1 to ${MAX_CONCURRENCY}` }));
            return;
          }
          const stream = data.stream === undefined ? true : Boolean(data.stream);

          // Determine prompt to use
          let promptToUse: string | undefined;
          if (data.customPrompt && data.customPrompt.trim()) {
            promptToUse = data.customPrompt.trim();
          } else if (data.promptId) {
            const selectedPrompt = TEST_PROMPTS.find(p => p.id === data.promptId);
            if (!selectedPrompt) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Invalid prompt ID: ${data.promptId}` }));
              return;
            }
            promptToUse = selectedPrompt.prompt;
          }

          // Run benchmarks: one concurrent batch per model, models in sequence
          // so batches never contend with each other.
          const results: BenchmarkResult[] = [];
          const aggregates: BenchmarkAggregate[] = [];
          for (const model of models) {
            const batch = await benchmarkModelConcurrently(model, promptToUse, concurrency, { stream });
            results.push(...batch.results);
            aggregates.push(batch.aggregate);
          }
          noteResultRows(results);

          // Save results; the rows and their aggregates share one specs row.
          saveResultsToCSV(results);
          await saveResultsToDatabase(results, aggregates);

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({
            success: true,
            results: results,
            aggregates: aggregates
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

  // Resolve the request to a path inside STATIC_ROOT and reject anything that
  // would escape it (path traversal). Decode first so encoded "../" is caught too.
  let requestPath: string;
  try {
    requestPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    requestPath = '/';
  }
  if (requestPath === '/') {
    requestPath = '/index.html';
  }

  const filePath = path.join(STATIC_ROOT, path.normalize(requestPath));
  if (filePath !== STATIC_ROOT && !filePath.startsWith(STATIC_ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end('<h1>403 - Forbidden</h1>', 'utf-8');
    return;
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
    resolveTarget()
      .then(target => console.log(`Target: ${target.url} (${target.transport}, ${target.path})`))
      .catch(error => console.error(`Target probe failed: ${(error as Error).message}`));
    console.log('Press Ctrl+C to stop the server');
  });
}

export { server };
