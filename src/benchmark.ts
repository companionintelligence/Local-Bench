#!/usr/bin/env node

import axios from 'axios';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, saveBenchmarkResults, saveBenchmarkAggregate, saveSystemSpecs } from './database';
import { getSystemSpecs, formatSystemSpecs } from './systemSpecs';

// Configuration
// The target base URL is read from env at call time; see getConfiguredBaseUrl().
const CSV_FILE = path.join(__dirname, '..', 'benchmark_results.csv');

export interface BenchmarkPrompt {
  id: string;
  name: string;
  prompt: string;
  description: string;
  category: string;
  type: string;
}

export interface SupportedOllamaModel {
  name: string;
  size?: string;
  contextWindow?: string;
  inputs: string[];
  family: string;
  /**
   * Artificial Analysis Intelligence Index (higher = more capable). `null` means
   * the model is not individually rated by the index (vision-only or very small
   * models). See INTELLIGENCE_INDEX_* constants below for sourcing details.
   */
  intelligenceIndex: number | null;
}

export interface OllamaModelCatalogEntry extends SupportedOllamaModel {
  installed: boolean;
  supported: boolean;
  source: 'catalog' | 'installed';
}

/**
 * Provenance for the per-model intelligence scores.
 *
 * Scores come from the Artificial Analysis Intelligence Index — a composite
 * "intelligence" benchmark (MMLU-Pro, GPQA Diamond, LiveCodeBench, AIME, etc.)
 * scored roughly 0–100 where higher is more capable. Values are a snapshot and
 * are version-sensitive; vision-only (`-vl`) and very small models are not
 * individually rated by the index and are left `null` ("Not rated").
 *
 * To mirror CI-Hub's curated tutorial numbers exactly, override the
 * `intelligenceIndex` values in SUPPORTED_OLLAMA_MODELS below — this is the
 * single source of truth consumed by both the CLI and the web UI.
 */
export const INTELLIGENCE_INDEX_SOURCE = 'Artificial Analysis Intelligence Index';
export const INTELLIGENCE_INDEX_URL = 'https://artificialanalysis.ai/';
export const INTELLIGENCE_INDEX_AS_OF = '2026-06';

// Predefined test prompts for benchmarking
export const TEST_PROMPTS: BenchmarkPrompt[] = [
  {
    id: 'ai-paragraph',
    name: 'AI Paragraph',
    prompt: 'Write a short paragraph about artificial intelligence.',
    description: 'Basic text generation about AI',
    category: 'General',
    type: 'Text Generation'
  },
  {
    id: 'code-python',
    name: 'Python Function',
    prompt: 'Write a Python function that calculates the factorial of a number recursively.',
    description: 'Code generation test',
    category: 'Coding',
    type: 'Code Generation'
  },
  {
    id: 'math-problem',
    name: 'Math Problem',
    prompt: 'Solve this step by step: If a train travels at 60 mph for 2.5 hours, then at 80 mph for 1.5 hours, what is the total distance traveled?',
    description: 'Mathematical reasoning',
    category: 'Reasoning',
    type: 'Numerical Reasoning'
  },
  {
    id: 'creative-story',
    name: 'Creative Story',
    prompt: 'Write a very short story (3-4 sentences) about a robot learning to paint.',
    description: 'Creative writing test',
    category: 'Creative',
    type: 'Creative Writing'
  },
  {
    id: 'explain-concept',
    name: 'Explain Concept',
    prompt: 'Explain quantum computing to a 10-year-old in simple terms.',
    description: 'Explanation and simplification',
    category: 'Education',
    type: 'Explanation'
  },
  {
    id: 'summarize',
    name: 'Summarization',
    prompt: 'Summarize the key benefits of renewable energy sources in 2-3 sentences.',
    description: 'Text summarization',
    category: 'Analysis',
    type: 'Summarization'
  },
  {
    id: 'translation',
    name: 'Translation',
    prompt: 'Translate "Hello, how are you today?" to French, Spanish, and German.',
    description: 'Multi-language translation',
    category: 'Language',
    type: 'Translation'
  },
  {
    id: 'logic-puzzle',
    name: 'Logic Puzzle',
    prompt: 'If all roses are flowers and some flowers fade quickly, can we conclude that some roses fade quickly? Explain your reasoning.',
    description: 'Logical reasoning test',
    category: 'Reasoning',
    type: 'Logical Reasoning'
  },
  {
    id: 'structured-output',
    name: 'Structured Output',
    prompt: 'Read this note and return JSON with keys action_items, owner, due_date: "Alice should finish the release checklist by Friday and Bob needs to verify the benchmark dashboard charts."',
    description: 'Tests consistent JSON-style extraction and formatting',
    category: 'Productivity',
    type: 'Structured Extraction'
  },
  {
    id: 'classification',
    name: 'Sentiment Classification',
    prompt: 'Classify the sentiment of this review as Positive, Neutral, or Negative and explain why in one sentence: "The benchmark dashboard looks polished, but the model picker still feels a little slow."',
    description: 'Instruction following with short classification output',
    category: 'Analysis',
    type: 'Classification'
  },
  {
    id: 'planning',
    name: 'Planning Assistant',
    prompt: 'Create a 4-step benchmark plan for comparing two local LLMs on summarization quality and throughput, keeping the steps concise.',
    description: 'Measures planning and concise instruction following',
    category: 'Operations',
    type: 'Planning'
  },
  {
    id: 'data-extraction',
    name: 'Data Extraction',
    prompt: 'Extract the company, product, and deadline from this sentence: "Companion Intelligence will ship the Local-Bench UI refresh before April 30." Return them as bullet points.',
    description: 'Information extraction with light formatting requirements',
    category: 'Analysis',
    type: 'Information Extraction'
  },
  {
    id: 'comparison',
    name: 'Comparative Analysis',
    prompt: 'Compare CPU-based local inference and GPU-accelerated local inference in 3 concise bullet points focused on latency, throughput, and power efficiency.',
    description: 'Evaluates short-form comparative analysis',
    category: 'Analysis',
    type: 'Comparative Reasoning'
  },
  {
    id: 'instruction-following',
    name: 'Instruction Following',
    prompt: 'Respond with exactly three bullets. Each bullet must contain one benefit of running benchmarks in a web UI and be under 10 words.',
    description: 'Tests strict formatting and concise response control',
    category: 'General',
    type: 'Instruction Following'
  }
];

// Default prompt (first one in the list)
const DEFAULT_PROMPT = TEST_PROMPTS[0].prompt;

// Default models to benchmark (all models from README)
// This list matches the models listed in the README.md "Default LLM Tests" section
// Users can override this by passing model names as command-line arguments
export const SUPPORTED_OLLAMA_MODELS: SupportedOllamaModel[] = [
  { name: 'gemma3:270m', size: '292MB', contextWindow: '32K', inputs: ['Text'], family: 'gemma3', intelligenceIndex: null },
  { name: 'qwen3:0.6b', size: '523MB', contextWindow: '40K', inputs: ['Text'], family: 'qwen3', intelligenceIndex: null },
  { name: 'gemma3:1b', size: '815MB', contextWindow: '32K', inputs: ['Text'], family: 'gemma3', intelligenceIndex: null },
  { name: 'deepseek-r1:1.5b', size: '1.1GB', contextWindow: '128K', inputs: ['Text'], family: 'deepseek-r1', intelligenceIndex: null },
  { name: 'llama3.2:1b', size: '1.3GB', contextWindow: '128K', inputs: ['Text'], family: 'llama3.2', intelligenceIndex: null },
  { name: 'qwen3:1.7b', size: '1.4GB', contextWindow: '40K', inputs: ['Text'], family: 'qwen3', intelligenceIndex: 3 },
  { name: 'qwen3-vl:2b', size: '1.9GB', contextWindow: '256K', inputs: ['Text', 'Image'], family: 'qwen3-vl', intelligenceIndex: null },
  { name: 'llama3.2:3b', size: '2.0GB', contextWindow: '128K', inputs: ['Text'], family: 'llama3.2', intelligenceIndex: 4 },
  { name: 'qwen3:4b', size: '2.5GB', contextWindow: '256K', inputs: ['Text'], family: 'qwen3', intelligenceIndex: 6 },
  { name: 'gemma3:4b', size: '3.3GB', contextWindow: '128K', inputs: ['Text', 'Image'], family: 'gemma3', intelligenceIndex: 4 },
  { name: 'qwen3-vl:4b', size: '3.3GB', contextWindow: '256K', inputs: ['Text', 'Image'], family: 'qwen3-vl', intelligenceIndex: null },
  { name: 'deepseek-r1:7b', size: '4.7GB', contextWindow: '128K', inputs: ['Text'], family: 'deepseek-r1', intelligenceIndex: 8 },
  { name: 'llama3.1:8b', size: '4.9GB', contextWindow: '128K', inputs: ['Text'], family: 'llama3.1', intelligenceIndex: 8 },
  { name: 'deepseek-r1:8b', size: '5.2GB', contextWindow: '128K', inputs: ['Text'], family: 'deepseek-r1', intelligenceIndex: 9 },
  { name: 'qwen3:8b', size: '5.2GB', contextWindow: '40K', inputs: ['Text'], family: 'qwen3', intelligenceIndex: 9 },
  { name: 'qwen3-vl:8b', size: '6.1GB', contextWindow: '256K', inputs: ['Text', 'Image'], family: 'qwen3-vl', intelligenceIndex: null },
  { name: 'gemma3:12b', size: '8.1GB', contextWindow: '128K', inputs: ['Text', 'Image'], family: 'gemma3', intelligenceIndex: 7 },
  { name: 'deepseek-r1:14b', size: '9.0GB', contextWindow: '128K', inputs: ['Text'], family: 'deepseek-r1', intelligenceIndex: 13 },
  { name: 'qwen3:14b', size: '9.3GB', contextWindow: '40K', inputs: ['Text'], family: 'qwen3', intelligenceIndex: 11 },
  { name: 'gpt-oss:20b', size: '14GB', contextWindow: '128K', inputs: ['Text'], family: 'gpt-oss', intelligenceIndex: 24 },
  { name: 'gemma3:27b', size: '17GB', contextWindow: '128K', inputs: ['Text', 'Image'], family: 'gemma3', intelligenceIndex: 10 },
  { name: 'qwen3-coder:latest', size: '19GB', contextWindow: '256K', inputs: ['Text'], family: 'qwen3-coder', intelligenceIndex: 20 },
  { name: 'qwen3-coder:30b', size: '19GB', contextWindow: '256K', inputs: ['Text'], family: 'qwen3-coder', intelligenceIndex: 20 },
  { name: 'qwen3:30b', size: '19GB', contextWindow: '256K', inputs: ['Text'], family: 'qwen3', intelligenceIndex: 15 },
  { name: 'deepseek-r1:32b', size: '20GB', contextWindow: '128K', inputs: ['Text'], family: 'deepseek-r1', intelligenceIndex: 18 },
  { name: 'qwen3:32b', size: '20GB', contextWindow: '40K', inputs: ['Text'], family: 'qwen3', intelligenceIndex: 15 },
  { name: 'qwen3-vl:30b', size: '20GB', contextWindow: '256K', inputs: ['Text', 'Image'], family: 'qwen3-vl', intelligenceIndex: null },
  { name: 'qwen3-vl:32b', size: '21GB', contextWindow: '256K', inputs: ['Text', 'Image'], family: 'qwen3-vl', intelligenceIndex: null },
  { name: 'deepseek-r1:70b', size: '43GB', contextWindow: '128K', inputs: ['Text'], family: 'deepseek-r1', intelligenceIndex: 20 },
  { name: 'llama3.1:70b', size: '43GB', contextWindow: '128K', inputs: ['Text'], family: 'llama3.1', intelligenceIndex: 16 },
  { name: 'gpt-oss:120b', size: '65GB', contextWindow: '128K', inputs: ['Text'], family: 'gpt-oss', intelligenceIndex: 33 },
  { name: 'llama4:16x17b', size: '67GB', contextWindow: '10M', inputs: ['Text', 'Image'], family: 'llama4', intelligenceIndex: 13 },
  // KNOWN GAP — the two GLM-4.6 rows below are the last names in this table that do not
  // resolve on registry.ollama.ai (checked 2026-08-06: library/glm-4.6, library/GLM-4.6
  // and library/glm4.6 all 404 at every tag; the library carries glm4, glm-4.7-flash and
  // glm-5.x instead, and TQ1_0/Q4_K_M are Unsloth GGUF quant names, not Ollama tags).
  // They are rank 4 and rank 5 of the intelligence list, so they are on screen. Left in
  // place rather than renamed: substituting a GLM-5.x row means sourcing a new
  // Artificial Analysis score for it, and an unsourced score is worse than a stale name.
  { name: 'GLM-4.6:TQ1_0', size: '84GB', contextWindow: '198K', inputs: ['Text'], family: 'GLM-4.6', intelligenceIndex: 30 },
  { name: 'qwen3:235b', size: '142GB', contextWindow: '256K', inputs: ['Text'], family: 'qwen3', intelligenceIndex: 45 },
  { name: 'qwen3-vl:235b', size: '143GB', contextWindow: '256K', inputs: ['Text', 'Image'], family: 'qwen3-vl', intelligenceIndex: null },
  { name: 'GLM-4.6:Q4_K_M', size: '216GB', contextWindow: '198K', inputs: ['Text'], family: 'GLM-4.6', intelligenceIndex: 30 },
  { name: 'llama3.1:405b', size: '243GB', contextWindow: '128K', inputs: ['Text'], family: 'llama3.1', intelligenceIndex: 17 },
  { name: 'llama4:128x17b', size: '245GB', contextWindow: '1M', inputs: ['Text', 'Image'], family: 'llama4', intelligenceIndex: 18 },
  { name: 'qwen3-coder:480b', size: '290GB', contextWindow: '256K', inputs: ['Text'], family: 'qwen3-coder', intelligenceIndex: 24 },
  { name: 'deepseek-v3.1:671b', size: '404GB', contextWindow: '160K', inputs: ['Text'], family: 'deepseek-v3.1', intelligenceIndex: 28 },
  { name: 'deepseek-r1:671b', size: '404GB', contextWindow: '160K', inputs: ['Text'], family: 'deepseek-r1', intelligenceIndex: 27 },
  // Was `minmax m2` at 968GB: a misspelling of MiniMax M2, a name with a space in it
  // (so never a tag Ollama could resolve), and a size that matches no quant of a 230B
  // model. Verified against registry.ollama.ai on 2026-08-06: there is no
  // `library/minimax-m2` at any tag — the only MiniMax M2 on the registry is this
  // community publish, whose manifest layers total 56.4 GB. That is the same
  // ollama.com decimal-GB convention every other `size` in this table uses (checked:
  // all 39 remaining names resolve, and each size matches its manifest total).
  { name: 'gabegoodhart/minimax-m2:230b', size: '56GB', contextWindow: '200K', inputs: ['Text'], family: 'minimax-m2', intelligenceIndex: 44 }
];

export const DEFAULT_MODELS: string[] = SUPPORTED_OLLAMA_MODELS.map(model => model.name);

function inferModelFamily(modelName: string): string {
  const [baseName] = modelName.split(':');
  return baseName.split(' ')[0];
}

function formatModelSize(bytes?: number): string | undefined {
  if (bytes == null || bytes < 0) {
    return undefined;
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)}${units[unitIndex]}`;
}

export function getOllamaModelCatalog(installedModels: OllamaModel[] = []): OllamaModelCatalogEntry[] {
  const installedByName = new Map(installedModels.map(model => [model.name, model]));
  const catalogNames = new Set(SUPPORTED_OLLAMA_MODELS.map(model => model.name));

  const catalogEntries = SUPPORTED_OLLAMA_MODELS.map(model => ({
    ...model,
    installed: installedByName.has(model.name),
    supported: true,
    source: 'catalog' as const
  }));

  const installedOnlyEntries = installedModels
    .filter(model => !catalogNames.has(model.name))
    .map(model => ({
      name: model.name,
      size: formatModelSize(typeof model.size === 'number' ? model.size : undefined),
      contextWindow: undefined,
      inputs: ['Text'],
      family: inferModelFamily(model.name),
      intelligenceIndex: null,
      installed: true,
      supported: false,
      source: 'installed' as const
    }));

  return [...catalogEntries, ...installedOnlyEntries].sort((a, b) =>
    (b.installed ? 1 : 0) - (a.installed ? 1 : 0) ||
    (b.supported ? 1 : 0) - (a.supported ? 1 : 0) ||
    a.name.localeCompare(b.name)
  );
}

export interface BenchmarkResult {
  model: string;
  tokensPerSecond: number;
  totalTokens: number;
  durationSeconds: number;
  timestamp: string;
  success: boolean;
  error?: string;
  /** The exact prompt sent to the model for this run. */
  prompt?: string;
  /** The model's generated response text (kept for side-by-side comparison and PDF export). */
  response?: string;
  // The fields below were added for CI-Hub pool benchmarking. They are optional so rows
  // written before they existed still parse; benchmarkModel fills every one it can.
  /** Which wire protocol was used. */
  transport?: Transport;
  /** 'pool' when the target URL contains '/inference/pool' or the response carried X-Hub-Pool-Served-By. */
  path?: TargetPath;
  /** The base URL that was hit. */
  targetUrl?: string;
  /** X-Hub-Pool-Served-By ("local" or a peer MagicDNS name). */
  servedBy?: string;
  /** X-Hub-Pool-Backend (ollama|vllm|lemonade|lucebox|dspark|mtplx). */
  backend?: string;
  /** X-Hub-Pool-Request-Id. */
  requestId?: string;
  /** Wall ms from request start to the first content chunk (streaming only). */
  ttftMs?: number;
  /** prompt_eval_count / usage.prompt_tokens. */
  promptTokens?: number;
  /** load_duration / 1e6 (ollama only). */
  loadMs?: number;
  /** prompt_eval_duration / 1e6 (ollama only). */
  promptEvalMs?: number;
  /** eval_duration / 1e6 (ollama only). */
  evalMs?: number;
  /**
   * Engine decode speed: eval_count / (eval_duration / 1e9) when Ollama timings exist;
   * else totalTokens / (durationSeconds - ttftMs / 1000) when streaming; else undefined.
   * tokensPerSecond keeps meaning totalTokens / wall-clock duration.
   */
  decodeTokensPerSecond?: number;
  /** How many requests ran at once in the batch this row belongs to (1 for a single run). */
  concurrency?: number;
  /** Shared by all rows of one concurrent batch. */
  batchId?: string;
}

export interface BenchmarkAggregate {
  batchId: string;
  model: string;
  concurrency: number;
  wallSeconds: number;
  /** sum totalTokens / wallSeconds */
  aggregateTokensPerSecond: number;
  medianTtftMs?: number;
  medianDecodeTokensPerSecond?: number;
  servedByCounts: Record<string, number>;
  backendCounts: Record<string, number>;
  successes: number;
  failures: number;
}

export type Transport = 'ollama' | 'openai';
export type TargetPath = 'direct' | 'pool';

export interface ResolvedTarget {
  url: string;
  transport: Transport;
  path: TargetPath;
}

export interface BenchmarkOptions {
  /** Stream the response (default true). Streaming is what makes TTFT measurable. */
  stream?: boolean;
  /** benchmarkModel runs one request; use benchmarkModelConcurrently for a batch. */
  concurrency?: never;
  /** Clock for wall-time measurements; injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

interface OllamaModel {
  name: string;
  [key: string]: any;
}

interface OllamaGenerateResponse {
  response?: string;
  done?: boolean;
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  load_duration?: number;
  total_duration?: number;
  [key: string]: any;
}

interface OpenAIUsage {
  completion_tokens?: number;
  prompt_tokens?: number;
  [key: string]: any;
}

interface OpenAIChatChunk {
  choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string | null } }>;
  usage?: OpenAIUsage | null;
  [key: string]: any;
}

interface PoolHeaders {
  servedBy?: string;
  backend?: string;
  requestId?: string;
}

/** What one request produced, independent of transport. */
interface RunOutcome {
  responseText: string;
  totalTokens: number;
  promptTokens?: number;
  ttftMs?: number;
  loadMs?: number;
  promptEvalMs?: number;
  evalMs?: number;
  evalCount?: number;
  evalDurationNs?: number;
  headers: PoolHeaders;
}

const REQUEST_TIMEOUT_MS = 120000; // 2 minutes
const PROBE_TIMEOUT_MS = 5000;
const POOL_URL_MARKER = '/inference/pool';
export const MAX_CONCURRENCY = 16;

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Strip trailing slashes and a trailing `/v1` so both `http://host:8000` and
 * `http://host:8000/v1` (the shape CI-Hub writes into CI_LLM_BASE_URL) name the same base.
 */
export function normaliseBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (/\/v1$/i.test(url)) {
    url = url.slice(0, -3).replace(/\/+$/, '');
  }
  return url;
}

/**
 * The configured base URL. An explicit OLLAMA_API_URL wins (the tool's original
 * contract), then CI_LLM_BASE_URL (what the Hub injects into every app env), then
 * the Ollama default.
 */
export function getConfiguredBaseUrl(): string {
  const raw = process.env.OLLAMA_API_URL || process.env.CI_LLM_BASE_URL || 'http://localhost:11434';
  return normaliseBaseUrl(raw);
}

function isPoolUrl(url: string): boolean {
  return url.includes(POOL_URL_MARKER);
}

function authHeaders(): Record<string, string> {
  const key = process.env.CI_LLM_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

const transportCache = new Map<string, Transport>();

/** Forget probed transports (tests, or after the target URL changes at runtime). */
export function resetTargetCache(): void {
  transportCache.clear();
}

/**
 * 'ollama' when the base answers GET /api/tags, else 'openai'. Probed once per URL and
 * cached; BENCH_TRANSPORT=ollama|openai forces it without probing.
 */
export async function detectTransport(url: string): Promise<Transport> {
  const forced = (process.env.BENCH_TRANSPORT || '').trim().toLowerCase();
  if (forced === 'ollama' || forced === 'openai') {
    return forced;
  }
  const cached = transportCache.get(url);
  if (cached) {
    return cached;
  }
  let transport: Transport;
  try {
    await axios.get(`${url}/api/tags`, { timeout: PROBE_TIMEOUT_MS, headers: authHeaders() });
    transport = 'ollama';
  } catch (error) {
    transport = 'openai';
    // Only an HTTP answer says anything about the server ("no /api/tags here" → OpenAI). A
    // connection refusal or timeout says the target was not up yet — the dashboard container
    // routinely starts before its engine — and caching that would pin every later run to the
    // wrong protocol until a restart. Probe again next time instead.
    if (!axios.isAxiosError(error) || !error.response) {
      return transport;
    }
  }
  transportCache.set(url, transport);
  return transport;
}

/** Resolve env into the target every runner hits. */
export async function resolveTarget(): Promise<ResolvedTarget> {
  const url = getConfiguredBaseUrl();
  const transport = await detectTransport(url);
  return { url, transport, path: isPoolUrl(url) ? 'pool' : 'direct' };
}

// ---------------------------------------------------------------------------
// Wire parsing
// ---------------------------------------------------------------------------

function readHeader(headers: any, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  let value = typeof headers.get === 'function' ? headers.get(name) : undefined;
  if (value === undefined || value === null) {
    const wanted = name.toLowerCase();
    const key = Object.keys(headers).find(k => k.toLowerCase() === wanted);
    value = key === undefined ? undefined : headers[key];
  }
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return Array.isArray(value) ? String(value[0]) : String(value);
}

/** The X-Hub-Pool-* headers a CI-Hub pool proxy adds to every routed response. */
export function readPoolHeaders(headers: any): PoolHeaders {
  return {
    servedBy: readHeader(headers, 'x-hub-pool-served-by'),
    backend: readHeader(headers, 'x-hub-pool-backend'),
    requestId: readHeader(headers, 'x-hub-pool-request-id')
  };
}

/** One NDJSON line from Ollama's streaming /api/generate; null for blank or unparsable lines. */
export function parseNdjsonLine(line: string): OllamaGenerateResponse | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed as OllamaGenerateResponse : null;
  } catch {
    return null;
  }
}

/**
 * One SSE line from an OpenAI-compatible stream. Only `data:` lines carry payload;
 * `data: [DONE]` ends the stream. Returns null for comments, blank lines and junk.
 */
export function parseSseLine(line: string): { done: true } | { chunk: OpenAIChatChunk } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return null;
  }
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') {
    return { done: true };
  }
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? { chunk: parsed as OpenAIChatChunk } : null;
  } catch {
    return null;
  }
}

/** Yield complete text lines from a byte stream, decoding UTF-8 across chunk boundaries. */
async function* readLines(stream: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield buffer;
  }
}

function ollamaTimings(data: OllamaGenerateResponse): Partial<RunOutcome> {
  const out: Partial<RunOutcome> = {};
  if (typeof data.prompt_eval_count === 'number') out.promptTokens = data.prompt_eval_count;
  if (typeof data.load_duration === 'number') out.loadMs = data.load_duration / 1e6;
  if (typeof data.prompt_eval_duration === 'number') out.promptEvalMs = data.prompt_eval_duration / 1e6;
  if (typeof data.eval_duration === 'number') {
    out.evalMs = data.eval_duration / 1e6;
    out.evalDurationNs = data.eval_duration;
  }
  if (typeof data.eval_count === 'number') out.evalCount = data.eval_count;
  return out;
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/**
 * POST {base}/api/generate. Streaming parses NDJSON: the first line with a non-empty
 * `response` marks TTFT, the final `done: true` line carries Ollama's native timings.
 */
async function runOllama(target: ResolvedTarget, model: string, prompt: string, stream: boolean, now: () => number, startedAt: number): Promise<RunOutcome> {
  const url = `${target.url}/api/generate`;
  const body = { model, prompt, stream };

  if (!stream) {
    const response = await axios.post<OllamaGenerateResponse>(url, body, { timeout: REQUEST_TIMEOUT_MS, headers: authHeaders() });
    const data = response.data || {};
    return {
      responseText: data.response || '',
      totalTokens: data.eval_count || 0,
      ...ollamaTimings(data),
      headers: readPoolHeaders(response.headers)
    };
  }

  const response = await axios.post(url, body, { timeout: REQUEST_TIMEOUT_MS, responseType: 'stream', headers: authHeaders() });
  let responseText = '';
  let ttftMs: number | undefined;
  let finalLine: OllamaGenerateResponse = {};
  for await (const line of readLines(response.data)) {
    const data = parseNdjsonLine(line);
    if (!data) continue;
    if (data.error) {
      throw new Error(String(data.error));
    }
    if (data.response) {
      if (ttftMs === undefined) {
        ttftMs = now() - startedAt;
      }
      responseText += data.response;
    }
    if (data.done) {
      finalLine = data;
    }
  }
  return {
    responseText,
    totalTokens: finalLine.eval_count || 0,
    ttftMs,
    ...ollamaTimings(finalLine),
    headers: readPoolHeaders(response.headers)
  };
}

/** True when a server answered the streaming request with a client error, i.e. rejected the body. */
function rejectedRequestBody(error: unknown): boolean {
  const status = (error as any)?.response?.status;
  return status === 400 || status === 415 || status === 422;
}

/**
 * POST {base}/v1/chat/completions. Streaming reads SSE `data:` lines: the first
 * non-empty `delta.content` marks TTFT, and `usage` arrives in the final chunk because
 * the request asks for `stream_options: { include_usage: true }`. When the server
 * rejects that request (4xx), fall back to a plain non-streaming request and read
 * `usage` from its body; TTFT is then unknown.
 */
async function runOpenAI(target: ResolvedTarget, model: string, prompt: string, stream: boolean, now: () => number, startedAt: number): Promise<RunOutcome> {
  const url = `${target.url}/v1/chat/completions`;
  const messages = [{ role: 'user', content: prompt }];
  const headers = { 'Content-Type': 'application/json', ...authHeaders() };

  const nonStream = async (): Promise<RunOutcome> => {
    const response = await axios.post<OpenAIChatChunk>(url, { model, messages, stream: false }, { timeout: REQUEST_TIMEOUT_MS, headers });
    const data = response.data || {};
    const usage = data.usage || {};
    return {
      responseText: data.choices?.[0]?.message?.content || '',
      totalTokens: usage.completion_tokens || 0,
      promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
      headers: readPoolHeaders(response.headers)
    };
  };

  if (!stream) {
    return nonStream();
  }

  let response;
  try {
    response = await axios.post(
      url,
      { model, messages, stream: true, stream_options: { include_usage: true } },
      { timeout: REQUEST_TIMEOUT_MS, responseType: 'stream', headers }
    );
  } catch (error) {
    if (rejectedRequestBody(error)) {
      console.log('  ! server rejected the streaming request; retrying without streaming');
      return nonStream();
    }
    throw error;
  }

  let responseText = '';
  let ttftMs: number | undefined;
  let usage: OpenAIUsage | undefined;
  let contentDeltas = 0;
  for await (const line of readLines(response.data)) {
    const parsed = parseSseLine(line);
    if (!parsed) continue;
    if ('done' in parsed) break;
    const chunk = parsed.chunk;
    if (chunk.error) {
      throw new Error(typeof chunk.error === 'string' ? chunk.error : (chunk.error.message || JSON.stringify(chunk.error)));
    }
    const content = chunk.choices?.[0]?.delta?.content;
    if (content) {
      if (ttftMs === undefined) {
        ttftMs = now() - startedAt;
      }
      responseText += content;
      contentDeltas++;
    }
    if (chunk.usage) {
      usage = chunk.usage;
    }
  }

  // Servers that ignore stream_options never send usage. Each content delta is one
  // token on every engine the pool fronts (vLLM, llama.cpp-based Lemonade, Ollama), so
  // the delta count is the honest best estimate rather than reporting zero tokens.
  const totalTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : contentDeltas;
  return {
    responseText,
    totalTokens,
    promptTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    ttftMs,
    headers: readPoolHeaders(response.headers)
  };
}

function round(value: number, places: number): number {
  return parseFloat(value.toFixed(places));
}

/**
 * Engine decode speed. Ollama's eval timings measure generation alone; without them,
 * subtract TTFT from the wall clock so prompt processing is not charged to decoding.
 */
export function computeDecodeTokensPerSecond(row: { totalTokens: number; durationSeconds: number; ttftMs?: number; evalCount?: number; evalDurationNs?: number }, streaming: boolean): number | undefined {
  if (typeof row.evalCount === 'number' && typeof row.evalDurationNs === 'number' && row.evalDurationNs > 0) {
    return row.evalCount / (row.evalDurationNs / 1e9);
  }
  if (streaming && typeof row.ttftMs === 'number') {
    const decodeSeconds = row.durationSeconds - row.ttftMs / 1000;
    if (decodeSeconds > 0) {
      return row.totalTokens / decodeSeconds;
    }
  }
  return undefined;
}

interface SingleRunContext {
  target: ResolvedTarget;
  stream: boolean;
  now: () => number;
  concurrency: number;
  batchId: string;
  quiet?: boolean;
}

async function runSingle(modelName: string, promptToUse: string, ctx: SingleRunContext): Promise<BenchmarkResult> {
  const { target, stream, now } = ctx;
  const base: Pick<BenchmarkResult, 'model' | 'transport' | 'path' | 'targetUrl' | 'concurrency' | 'batchId' | 'prompt'> = {
    model: modelName,
    transport: target.transport,
    path: target.path,
    targetUrl: target.url,
    concurrency: ctx.concurrency,
    batchId: ctx.batchId,
    prompt: promptToUse
  };

  try {
    const startTime = now();
    const outcome = target.transport === 'openai'
      ? await runOpenAI(target, modelName, promptToUse, stream, now, startTime)
      : await runOllama(target, modelName, promptToUse, stream, now, startTime);
    const durationSeconds = (now() - startTime) / 1000;
    const tokensPerSecond = durationSeconds > 0 ? outcome.totalTokens / durationSeconds : 0;
    const decode = computeDecodeTokensPerSecond({ ...outcome, durationSeconds }, stream);
    const path: TargetPath = target.path === 'pool' || outcome.headers.servedBy ? 'pool' : 'direct';

    if (!ctx.quiet) {
      console.log(`  ✓ ${modelName}: ${durationSeconds.toFixed(2)}s, ${outcome.totalTokens} tokens, ${tokensPerSecond.toFixed(2)} tokens/second`);
    }

    return {
      ...base,
      path,
      tokensPerSecond: round(tokensPerSecond, 2),
      totalTokens: outcome.totalTokens,
      durationSeconds: round(durationSeconds, 2),
      timestamp: new Date().toISOString(),
      success: true,
      response: outcome.responseText,
      servedBy: outcome.headers.servedBy,
      backend: outcome.headers.backend,
      requestId: outcome.headers.requestId,
      ttftMs: outcome.ttftMs === undefined ? undefined : round(outcome.ttftMs, 1),
      promptTokens: outcome.promptTokens,
      loadMs: outcome.loadMs === undefined ? undefined : round(outcome.loadMs, 2),
      promptEvalMs: outcome.promptEvalMs === undefined ? undefined : round(outcome.promptEvalMs, 2),
      evalMs: outcome.evalMs === undefined ? undefined : round(outcome.evalMs, 2),
      decodeTokensPerSecond: decode === undefined ? undefined : round(decode, 2)
    };
  } catch (error) {
    const message = (error as Error).message;
    console.error(`  ✗ Error benchmarking ${modelName}: ${message}`);
    return {
      ...base,
      tokensPerSecond: 0,
      totalTokens: 0,
      durationSeconds: 0,
      timestamp: new Date().toISOString(),
      success: false,
      error: message,
      response: ''
    };
  }
}

/**
 * Check if a model is available in Ollama
 */
export async function checkModelAvailable(modelName: string): Promise<boolean> {
  try {
    const response = await axios.get<{ models?: OllamaModel[] }>(`${getConfiguredBaseUrl()}/api/tags`, { headers: authHeaders() });
    const models = response.data.models || [];
    return models.some((m: OllamaModel) => m.name.startsWith(modelName));
  } catch (error) {
    console.error(`Error checking models: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Benchmark a single model
 */
export async function benchmarkModel(modelName: string, customPrompt?: string, options: BenchmarkOptions = {}): Promise<BenchmarkResult> {
  const promptToUse = customPrompt || DEFAULT_PROMPT;
  console.log(`\nBenchmarking ${modelName}...`);
  const target = await resolveTarget();
  return runSingle(modelName, promptToUse, {
    target,
    stream: options.stream !== false,
    now: options.now || Date.now,
    concurrency: 1,
    batchId: randomUUID()
  });
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function countBy(rows: BenchmarkResult[], key: 'servedBy' | 'backend'): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = row[key];
    if (value) {
      counts[value] = (counts[value] || 0) + 1;
    }
  }
  return counts;
}

/** Roll one concurrent batch up into a single row. */
export function computeAggregate(rows: BenchmarkResult[], wallSeconds: number): BenchmarkAggregate {
  const successful = rows.filter(r => r.success);
  const totalTokens = successful.reduce((sum, r) => sum + r.totalTokens, 0);
  const medianTtft = median(successful.map(r => r.ttftMs).filter((v): v is number => typeof v === 'number'));
  const medianDecode = median(successful.map(r => r.decodeTokensPerSecond).filter((v): v is number => typeof v === 'number'));
  return {
    batchId: rows[0]?.batchId || '',
    model: rows[0]?.model || '',
    concurrency: rows.length,
    wallSeconds: round(wallSeconds, 2),
    aggregateTokensPerSecond: wallSeconds > 0 ? round(totalTokens / wallSeconds, 2) : 0,
    medianTtftMs: medianTtft === undefined ? undefined : round(medianTtft, 1),
    medianDecodeTokensPerSecond: medianDecode === undefined ? undefined : round(medianDecode, 2),
    servedByCounts: countBy(rows, 'servedBy'),
    backendCounts: countBy(rows, 'backend'),
    successes: successful.length,
    failures: rows.length - successful.length
  };
}

export function clampConcurrency(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) {
    return 1;
  }
  return Math.min(Math.floor(n), MAX_CONCURRENCY);
}

/**
 * Fire `concurrency` identical requests at once and report each row plus the batch
 * aggregate. Every row shares one batchId; concurrency is clamped to 1..16.
 */
export async function benchmarkModelConcurrently(
  modelName: string,
  customPrompt: string | undefined,
  concurrency: number,
  options: Omit<BenchmarkOptions, 'concurrency'> = {}
): Promise<{ results: BenchmarkResult[]; aggregate: BenchmarkAggregate }> {
  const promptToUse = customPrompt || DEFAULT_PROMPT;
  const n = clampConcurrency(concurrency);
  const now = options.now || Date.now;
  const target = await resolveTarget();
  const ctx: SingleRunContext = {
    target,
    stream: options.stream !== false,
    now,
    concurrency: n,
    batchId: randomUUID()
  };

  console.log(`\nBenchmarking ${modelName} (${n} concurrent, ${ctx.stream ? 'streaming' : 'non-streaming'}, ${target.transport} → ${target.url})...`);
  const wallStart = now();
  const results = await Promise.all(Array.from({ length: n }, () => runSingle(modelName, promptToUse, ctx)));
  const wallSeconds = (now() - wallStart) / 1000;
  return { results, aggregate: computeAggregate(results, wallSeconds) };
}


/**
 * Save results to CSV file (for backward compatibility)
 */
export function saveResultsToCSV(results: BenchmarkResult[]): void {
  const csvHeader = 'Model,Tokens Per Second,Total Tokens,Duration (s),Timestamp,Status\n';
  const csvRows = results.map(r => 
    `${r.model},${r.tokensPerSecond},${r.totalTokens},${r.durationSeconds},${r.timestamp},${r.success ? 'Success' : 'Failed'}`
  ).join('\n');
  
  const csvContent = csvHeader + csvRows;
  
  fs.writeFileSync(CSV_FILE, csvContent, 'utf8');
  console.log(`\nResults saved to ${CSV_FILE}`);
}

/**
 * Save results (and the batch aggregates they belong to) to the database. Both
 * attach to one freshly recorded system-specs row so a batch and its rows can
 * always be joined back to the machine that ran them. Returns that specs id.
 */
export async function saveResultsToDatabase(results: BenchmarkResult[], aggregates: BenchmarkAggregate[] = []): Promise<number> {
  try {
    // Initialize database
    initDatabase();
    
    // Get and save system specs
    console.log('\nCollecting system specifications...');
    const systemSpecs = await getSystemSpecs();
    console.log(formatSystemSpecs(systemSpecs));
    
    const systemSpecsId = saveSystemSpecs(systemSpecs);
    console.log(`\nSystem specs saved to database (ID: ${systemSpecsId})`);
    
    // Save benchmark results
    saveBenchmarkResults(results, systemSpecsId);
    console.log('Benchmark results saved to database');

    for (const aggregate of aggregates) {
      saveBenchmarkAggregate(aggregate, systemSpecsId);
    }
    if (aggregates.length > 0) {
      console.log(`${aggregates.length} batch aggregate${aggregates.length === 1 ? '' : 's'} saved to database`);
    }
    return systemSpecsId;
  } catch (error) {
    console.error('Error saving to database:', (error as Error).message);
    throw error;
  }
}


export interface CliArgs {
  models: string[];
  concurrency: number;
  stream: boolean;
}

/** `--concurrency=N` and `--no-stream` are flags; everything else is a model name. */
export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { models: [], concurrency: 1, stream: true };
  for (const arg of argv) {
    if (arg === '--no-stream') {
      args.stream = false;
    } else if (arg.startsWith('--concurrency=')) {
      args.concurrency = clampConcurrency(arg.slice('--concurrency='.length));
    } else if (arg.startsWith('--')) {
      console.error(`Ignoring unknown flag ${arg}`);
    } else {
      args.models.push(arg);
    }
  }
  return args;
}

function formatRow(r: BenchmarkResult): string {
  const parts = [
    `${r.tokensPerSecond} tok/s wall`,
    r.decodeTokensPerSecond !== undefined ? `${r.decodeTokensPerSecond} tok/s decode` : undefined,
    r.ttftMs !== undefined ? `TTFT ${r.ttftMs}ms` : undefined,
    r.servedBy ? `served by ${r.servedBy}` : undefined,
    r.backend ? `backend ${r.backend}` : undefined
  ].filter(Boolean);
  return parts.join(', ');
}

function formatAggregate(a: BenchmarkAggregate): string {
  const served = Object.entries(a.servedByCounts).map(([k, v]) => `${k}×${v}`).join(' ');
  const backends = Object.entries(a.backendCounts).map(([k, v]) => `${k}×${v}`).join(' ');
  const parts = [
    `aggregate ${a.aggregateTokensPerSecond} tok/s over ${a.wallSeconds}s`,
    `${a.successes}/${a.concurrency} ok`,
    a.medianTtftMs !== undefined ? `median TTFT ${a.medianTtftMs}ms` : undefined,
    a.medianDecodeTokensPerSecond !== undefined ? `median decode ${a.medianDecodeTokensPerSecond} tok/s` : undefined,
    served ? `served by ${served}` : undefined,
    backends ? `backends ${backends}` : undefined
  ].filter(Boolean);
  return parts.join(', ');
}

/**
 * Main function
 */
async function main(): Promise<void> {
  console.log('=== Local LLM Benchmark Tool ===');
  const args = parseCliArgs(process.argv.slice(2));
  const modelsToTest = args.models.length > 0 ? args.models : DEFAULT_MODELS;

  // Check the target answers before spending two minutes per model on it
  let target: ResolvedTarget;
  try {
    target = await resolveTarget();
    if (target.transport === 'openai') {
      await axios.get(`${target.url}/v1/models`, { timeout: PROBE_TIMEOUT_MS, headers: authHeaders() });
    }
    console.log(`Target: ${target.url} (${target.transport}, ${target.path})`);
    console.log(`✓ Connected to ${target.transport === 'ollama' ? 'Ollama' : 'OpenAI-compatible'} API`);
  } catch (error) {
    console.error('✗ Cannot connect to the inference API. Set OLLAMA_API_URL or CI_LLM_BASE_URL and make sure it is running.');
    console.error(`  Error: ${(error as Error).message}`);
    process.exit(1);
  }

  console.log(`\nModels to benchmark: ${modelsToTest.join(', ')}`);
  console.log(`Concurrency: ${args.concurrency}, streaming: ${args.stream ? 'on' : 'off'}`);

  // Run benchmarks
  const results: BenchmarkResult[] = [];
  const aggregates: BenchmarkAggregate[] = [];
  for (const model of modelsToTest) {
    const batch = await benchmarkModelConcurrently(model, undefined, args.concurrency, { stream: args.stream });
    results.push(...batch.results);
    aggregates.push(batch.aggregate);
    for (const row of batch.results) {
      if (row.success) {
        console.log(`    ${formatRow(row)}`);
      }
    }
    console.log(`  = ${formatAggregate(batch.aggregate)}`);
  }

  // Save results
  saveResultsToCSV(results);
  await saveResultsToDatabase(results, aggregates);

  // Summary
  console.log('\n=== Benchmark Summary ===');
  const ranked = aggregates.filter(a => a.successes > 0).sort((a, b) => b.aggregateTokensPerSecond - a.aggregateTokensPerSecond);
  if (ranked.length > 0) {
    console.log(`\nRanking (by ${args.concurrency > 1 ? 'aggregate ' : ''}tokens/second):`);
    ranked.forEach((a, i) => {
      console.log(`  ${i + 1}. ${a.model}: ${formatAggregate(a)}`);
    });
  }

  const failedResults = results.filter(r => !r.success);
  if (failedResults.length > 0) {
    console.log('\nFailed benchmarks:');
    failedResults.forEach(r => {
      console.log(`  ✗ ${r.model}: ${r.error}`);
    });
  }

  console.log('\nDone! Open index.html in a browser to view the results.');
}

// Run main function
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
