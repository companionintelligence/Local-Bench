#!/usr/bin/env node

import axios from 'axios';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, saveBenchmarkResults, saveBenchmarkAggregate, saveSystemSpecs } from './database';
import { getSystemSpecs, formatSystemSpecs } from './systemSpecs';
import { DRIVER_DESCRIPTORS, DriverType, Seat, TimingSource, UnknownDriverError, parseDriverType, resolveDriverFromEnv, wireOf } from './drivers';
import { buildExport } from './exporter';
import { EngineInfo, mergeEngineInfo, parseLlamaCppProps, parseOllamaPs, parseOllamaTags, parseOllamaVersion, parseOpenAiModels, parseVllmVersion } from './engineInfo';
import { arrivalOffsetsMs, buildDepthPrompt, goodputFraction, interTokenLatencyMs, parseContextDepth, SloTargets } from './measure';
import { PowerDeps, PowerReading, PowerSource, startPowerSampling } from './power';
import { Summary, summarize } from './stats';
import { Scenario, buildScenarioPrompt, parseScenario } from './workloads';

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
  /** X-Hub-Pool-Backend: one of the Hub's engines (ollama, vllm, lemonade, omlx, localai). Kept as received. */
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
  /** The driver that produced the row (drivers.ts). */
  driver?: DriverType;
  /** 'app' for HTTP drivers; 'engine-native' for llama-bench. The two are never averaged together. */
  seat?: Seat;
  /** Whose clock produced the speed numbers: the engine's own timings, or this client's. */
  timingSource?: TimingSource;
  /** Requested context depth in tokens (0 for none). The prompt really sent is in `prompt`. */
  contextDepth?: number;
  /** The context window the engine reports at runtime (llama.cpp's /props n_ctx). */
  contextWindow?: number;
  /** Prompt processing speed: the engine's figure when it reports one, else promptTokens / TTFT. */
  promptTokensPerSecond?: number;
  /** True for a model's first request on a target, or a request that loaded the model. */
  cold?: boolean;
  /** Which repetition of a repeated run the row belongs to, counted from 0. */
  repeatIndex?: number;
  /** 'burst' for a concurrent batch; 'constant' or 'poisson' for load profiles. */
  profile?: MeasurementProfile;
  /** The fixed workload this row ran, e.g. "pp1024+tg16" (workloads.ts). Absent for free-prompt runs. */
  scenario?: string;
  /** The prompt length the workload asked for, in tokens. The engine's own count is promptTokens. */
  requestedPromptTokens?: number;
  /** The generation cap the workload asked for, in tokens. */
  requestedGenTokens?: number;
  /** Why generation stopped, as the engine reports it: 'stop' (end of sequence) or 'length' (the cap was reached). */
  finishReason?: string;
  /** What the engine reports about itself and the model: version, digest, quantization, context, slots. */
  engine?: EngineInfo;
  /** Bytes of the model held in GPU memory once the run finished (Ollama's /api/ps). */
  vramBytes?: number;
  /** Mean power draw over the run or batch, in watts. */
  powerWatts?: number;
  /** Which host counter the power reading came from. */
  powerSource?: PowerSource;
  /** Why there is no power reading, when there is none. */
  powerNote?: string;
  /** A free-text note the person attached to the run. */
  note?: string;
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
  /** Bytes of the model held in GPU memory once the batch finished (Ollama). */
  vramBytes?: number;
  /** Mean power draw over the batch, in watts. */
  powerWatts?: number;
  powerSource?: PowerSource;
  powerNote?: string;
  /** aggregateTokensPerSecond divided by powerWatts: tokens generated per joule. */
  tokensPerJoule?: number;
}

export type MeasurementProfile = 'burst' | 'constant' | 'poisson';
export type Transport = 'ollama' | 'openai';
export type TargetPath = 'direct' | 'pool';

export interface ResolvedTarget {
  url: string;
  /** The wire protocol used to talk to the target. */
  transport: Transport;
  /** The engine driver (drivers.ts). */
  driver: DriverType;
  path: TargetPath;
}

export interface BenchmarkOptions {
  /** Stream the response (default true). Streaming is what makes TTFT measurable. */
  stream?: boolean;
  /** benchmarkModel runs one request; use benchmarkModelConcurrently for a batch. */
  concurrency?: never;
  /** Clock for wall-time measurements; injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** Use this driver rather than detecting one from the target. */
  driver?: DriverType;
  /** Prefill this many tokens of context before the question (0 = none). */
  contextDepth?: number;
  /** Repetition index recorded on each row; set by benchmarkRepeated. */
  repeatIndex?: number;
  /** A fixed workload (workloads.ts): a prompt of scenario.promptTokens and a cap of scenario.genTokens. Replaces contextDepth. */
  scenario?: Scenario;
  /** A free-text note recorded on every row. */
  note?: string;
  /** Sample power draw around each batch or load run. Off by default; the CLI and the server turn it on. An object gives the sampler's dependencies, for tests. */
  measurePower?: boolean | PowerDeps;
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
  done_reason?: string;
  [key: string]: any;
}

interface OpenAIUsage {
  completion_tokens?: number;
  prompt_tokens?: number;
  [key: string]: any;
}

interface OpenAIChatChunk {
  choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: OpenAIUsage | null;
  [key: string]: any;
}

interface PoolHeaders {
  servedBy?: string;
  backend?: string;
  requestId?: string;
}

/** Timings an engine reports about its own run (llama.cpp's `timings` block). */
interface EngineTimings {
  source: 'llamacpp';
  promptPerSecond?: number;
  predictedPerSecond?: number;
  promptTokens?: number;
  predictedTokens?: number;
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
  /** The engine's own timings when it reports them (llama.cpp). */
  engineTimings?: EngineTimings;
  /** Why generation stopped, as the engine reports it ('stop' or 'length'). */
  finishReason?: string;
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
export function getConfiguredBaseUrl(driver?: DriverType): string {
  const fallback = (driver && DRIVER_DESCRIPTORS[driver].defaultBaseUrl) || 'http://localhost:11434';
  const raw = process.env.OLLAMA_API_URL || process.env.CI_LLM_BASE_URL || fallback;
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
const llamaCppCache = new Map<string, boolean>();
/** The runtime context window llama-server reports on /props (default_generation_settings.n_ctx). */
const llamaCppWindows = new Map<string, number>();
/** Model and target pairs already requested in this process. The first request to one is cold. */
const seenModelTargets = new Set<string>();
/** What each target reports about a model (version, digest, context), read once per target and model. */
const engineInfoCache = new Map<string, EngineInfo>();

/** Forget probed transports (tests, or after the target URL changes at runtime). */
export function resetTargetCache(): void {
  transportCache.clear();
  llamaCppCache.clear();
  llamaCppWindows.clear();
  seenModelTargets.clear();
  engineInfoCache.clear();
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

/**
 * Resolve the target every runner hits. An explicit driver (the option, or BENCH_DRIVER or
 * BENCH_TRANSPORT) is used as given. Otherwise the engine is detected: Ollama when /api/tags
 * answers, llama.cpp when /props answers, and the generic OpenAI driver otherwise.
 */
export async function resolveTarget(options: { driver?: DriverType } = {}): Promise<ResolvedTarget> {
  const explicit = options.driver ?? resolveDriverFromEnv();
  const url = getConfiguredBaseUrl(explicit);
  const path: TargetPath = isPoolUrl(url) ? 'pool' : 'direct';
  if (explicit) {
    if (wireOf(explicit) === 'cli') {
      throw new UnknownDriverError(`${explicit} runs a local binary, not an endpoint.`);
    }
    if (explicit === 'llamacpp') {
      await probeLlamaCpp(url);
    }
    return { url, transport: wireOf(explicit) === 'ollama' ? 'ollama' : 'openai', driver: explicit, path };
  }
  const transport = await detectTransport(url);
  if (transport === 'ollama') {
    return { url, transport, driver: 'ollama', path };
  }
  const llamaCpp = await probeLlamaCpp(url);
  return { url, transport, driver: llamaCpp ? 'llamacpp' : 'openai', path };
}

/**
 * True when the base answers GET /props with llama-server's settings object. Cached per URL.
 * A connection failure is not cached, for the same reason detectTransport retries those.
 */
async function probeLlamaCpp(url: string): Promise<boolean> {
  const cached = llamaCppCache.get(url);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const response = await axios.get(`${url}/props`, { timeout: PROBE_TIMEOUT_MS, headers: authHeaders() });
    const settings = isRecord(response.data) ? response.data.default_generation_settings : undefined;
    const isLlamaCpp = isRecord(settings);
    llamaCppCache.set(url, isLlamaCpp);
    if (isRecord(settings) && typeof settings.n_ctx === 'number') {
      llamaCppWindows.set(url, settings.n_ctx);
    }
    return isLlamaCpp;
  } catch (error) {
    if ((error as any)?.response) {
      llamaCppCache.set(url, false);
    }
    return false;
  }
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

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * llama.cpp's `timings` block: on the top level of a streamed chunk, or of a non-streamed body.
 * Undefined when the response carries none, so other engines are unaffected.
 */
function llamaCppTimings(data: unknown): EngineTimings | undefined {
  const timings = isRecord(data) ? data.timings : undefined;
  if (!isRecord(timings)) {
    return undefined;
  }
  const out: EngineTimings = { source: 'llamacpp' };
  if (typeof timings.prompt_per_second === 'number') out.promptPerSecond = timings.prompt_per_second;
  if (typeof timings.predicted_per_second === 'number') out.predictedPerSecond = timings.predicted_per_second;
  if (typeof timings.prompt_n === 'number') out.promptTokens = timings.prompt_n;
  if (typeof timings.predicted_n === 'number') out.predictedTokens = timings.predicted_n;
  return out.promptPerSecond === undefined && out.predictedPerSecond === undefined ? undefined : out;
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
  if (typeof data.done_reason === 'string') out.finishReason = data.done_reason;
  return out;
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/**
 * POST {base}/api/generate. Streaming parses NDJSON: the first line with a non-empty
 * `response` marks TTFT, the final `done: true` line carries Ollama's native timings.
 */
async function runOllama(
  target: ResolvedTarget,
  model: string,
  prompt: string,
  stream: boolean,
  now: () => number,
  startedAt: number,
  genTokens?: number
): Promise<RunOutcome> {
  const url = `${target.url}/api/generate`;
  const body: Record<string, unknown> = { model, prompt, stream };
  // A workload's generation cap: Ollama stops at num_predict and reports done_reason 'length'.
  if (genTokens !== undefined) {
    body.options = { num_predict: genTokens };
  }

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
async function runOpenAI(
  target: ResolvedTarget,
  model: string,
  prompt: string,
  stream: boolean,
  now: () => number,
  startedAt: number,
  genTokens?: number
): Promise<RunOutcome> {
  const url = `${target.url}/v1/chat/completions`;
  const messages = [{ role: 'user', content: prompt }];
  const headers = { 'Content-Type': 'application/json', ...authHeaders() };
  // A workload's generation cap. llama.cpp also gets ignore_eos, so its run reaches the cap
  // instead of ending at the model's end-of-sequence token; finish_reason says which happened.
  const cap: Record<string, unknown> = genTokens === undefined ? {} : {
    max_tokens: genTokens,
    ...(target.driver === 'llamacpp' ? { ignore_eos: true } : {})
  };

  const nonStream = async (): Promise<RunOutcome> => {
    const response = await axios.post<OpenAIChatChunk>(url, { model, messages, stream: false, ...cap }, { timeout: REQUEST_TIMEOUT_MS, headers });
    const data = response.data || {};
    const usage = data.usage || {};
    return {
      responseText: data.choices?.[0]?.message?.content || '',
      totalTokens: usage.completion_tokens || 0,
      promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
      engineTimings: llamaCppTimings(data),
      finishReason: finishReasonOf(data.choices?.[0]),
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
      { model, messages, stream: true, stream_options: { include_usage: true }, ...cap },
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
  let engineTimings: EngineTimings | undefined;
  let finishReason: string | undefined;
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
    engineTimings = llamaCppTimings(chunk) ?? engineTimings;
    finishReason = finishReasonOf(chunk.choices?.[0]) ?? finishReason;
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
    engineTimings,
    finishReason,
    headers: readPoolHeaders(response.headers)
  };
}

/** The finish_reason of one choice ('stop' or 'length'), when the engine sent one. */
function finishReasonOf(choice: unknown): string | undefined {
  return isRecord(choice) && typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined;
}

function round(value: number, places: number): number {
  return parseFloat(value.toFixed(places));
}

/**
 * Engine decode speed. Ollama's eval timings measure generation alone; without them,
 * subtract TTFT from the wall clock so prompt processing is not charged to decoding.
 */
export function computeDecodeTokensPerSecond(row: { totalTokens: number; durationSeconds: number; ttftMs?: number; evalCount?: number; evalDurationNs?: number; predictedPerSecond?: number }, streaming: boolean): number | undefined {
  if (typeof row.predictedPerSecond === 'number' && row.predictedPerSecond > 0) {
    return row.predictedPerSecond;
  }
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
  contextDepth?: number;
  repeatIndex?: number;
  profile?: MeasurementProfile;
  /** A fixed workload; when set, contextDepth is ignored. */
  scenario?: Scenario;
  note?: string;
}

/**
 * Prompt processing speed: the engine's own figure when it reports one, else the prompt
 * token count over the time to first token (which includes the network round trip).
 */
function promptTokensPerSecond(outcome: RunOutcome): number | undefined {
  if (outcome.engineTimings?.promptPerSecond !== undefined) {
    return outcome.engineTimings.promptPerSecond;
  }
  if (typeof outcome.promptEvalMs === 'number' && outcome.promptEvalMs > 0 && typeof outcome.promptTokens === 'number') {
    return outcome.promptTokens / (outcome.promptEvalMs / 1000);
  }
  if (typeof outcome.ttftMs === 'number' && outcome.ttftMs > 0 && typeof outcome.promptTokens === 'number') {
    return outcome.promptTokens / (outcome.ttftMs / 1000);
  }
  return undefined;
}

async function runSingle(modelName: string, promptToUse: string, ctx: SingleRunContext): Promise<BenchmarkResult> {
  const { target, stream, now } = ctx;
  const scenario = ctx.scenario;
  const contextDepth = scenario ? 0 : (ctx.contextDepth ?? 0);
  // A fresh nonce per request keeps an engine from reusing an earlier prefill of the same prompt.
  const nonce = randomUUID();
  const requestPrompt = scenario
    ? buildScenarioPrompt(scenario, nonce)
    : buildDepthPrompt(promptToUse, contextDepth, nonce);
  // The first request to a model on a target is cold. Recorded before any await, so the
  // first request of a concurrent batch is the one marked.
  const key = `${target.url}|${modelName}`;
  const firstRequest = !seenModelTargets.has(key);
  seenModelTargets.add(key);

  const base: Pick<BenchmarkResult, 'model' | 'transport' | 'path' | 'targetUrl' | 'concurrency' | 'batchId' | 'prompt' | 'driver' | 'seat' | 'contextDepth' | 'contextWindow' | 'repeatIndex' | 'profile' | 'scenario' | 'requestedPromptTokens' | 'requestedGenTokens' | 'note'> = {
    model: modelName,
    transport: target.transport,
    path: target.path,
    targetUrl: target.url,
    concurrency: ctx.concurrency,
    batchId: ctx.batchId,
    prompt: requestPrompt,
    driver: target.driver,
    seat: 'app',
    contextDepth,
    contextWindow: target.driver === 'llamacpp' ? llamaCppWindows.get(target.url) : undefined,
    repeatIndex: ctx.repeatIndex,
    profile: ctx.profile ?? 'burst',
    scenario: scenario?.name,
    requestedPromptTokens: scenario?.promptTokens,
    requestedGenTokens: scenario?.genTokens,
    note: ctx.note
  };

  try {
    // Read before the clock starts, so the engine's own metadata is never charged to the run.
    const engine = await engineInfoFor(target, modelName);
    const startTime = now();
    const outcome = target.transport === 'openai'
      ? await runOpenAI(target, modelName, requestPrompt, stream, now, startTime, scenario?.genTokens)
      : await runOllama(target, modelName, requestPrompt, stream, now, startTime, scenario?.genTokens);
    const durationSeconds = (now() - startTime) / 1000;
    const tokensPerSecond = durationSeconds > 0 ? outcome.totalTokens / durationSeconds : 0;
    const decode = computeDecodeTokensPerSecond(
      { ...outcome, durationSeconds, predictedPerSecond: outcome.engineTimings?.predictedPerSecond },
      stream
    );
    const promptRate = promptTokensPerSecond(outcome);
    const path: TargetPath = target.path === 'pool' || outcome.headers.servedBy ? 'pool' : 'direct';
    const cold = firstRequest || (outcome.loadMs ?? 0) > 0;
    const timingSource: TimingSource = outcome.engineTimings ? 'llamacpp' : target.transport === 'ollama' ? 'ollama' : 'client';

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
      decodeTokensPerSecond: decode === undefined ? undefined : round(decode, 2),
      promptTokensPerSecond: promptRate === undefined ? undefined : round(promptRate, 2),
      timingSource,
      cold,
      finishReason: outcome.finishReason,
      contextWindow: engine.contextWindow ?? base.contextWindow,
      engine: Object.keys(engine).length > 0 ? engine : undefined
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

/** GET a JSON endpoint, or undefined when it does not answer. Engine metadata is best effort. */
async function getJson(url: string): Promise<unknown> {
  try {
    const response = await axios.get(url, { timeout: PROBE_TIMEOUT_MS, headers: authHeaders() });
    return response.data;
  } catch {
    return undefined;
  }
}

/** What the engine reports about itself and the model, from its own endpoints. */
async function fetchEngineInfo(target: ResolvedTarget, model: string): Promise<EngineInfo> {
  if (target.driver === 'ollama') {
    const [tags, version] = await Promise.all([getJson(`${target.url}/api/tags`), getJson(`${target.url}/api/version`)]);
    return mergeEngineInfo(parseOllamaTags(tags, model), { engineVersion: parseOllamaVersion(version) });
  }
  if (target.driver === 'llamacpp') {
    const [props, models] = await Promise.all([getJson(`${target.url}/props`), getJson(`${target.url}/v1/models`)]);
    return mergeEngineInfo(parseLlamaCppProps(props), parseOpenAiModels(models));
  }
  if (target.driver === 'vllm') {
    return { engineVersion: parseVllmVersion(await getJson(`${target.url}/version`)) };
  }
  return {};
}

/** Engine metadata for a target and model, read once and then cached. Called before a run's clock starts. */
async function engineInfoFor(target: ResolvedTarget, model: string): Promise<EngineInfo> {
  const key = `${target.url}|${model}`;
  const cached = engineInfoCache.get(key);
  if (cached) {
    return cached;
  }
  const info = await fetchEngineInfo(target, model);
  engineInfoCache.set(key, info);
  return info;
}

/** What Ollama reports about the loaded model now: the GPU bytes it holds and the context it runs with. */
async function loadedModelState(target: ResolvedTarget, model: string): Promise<EngineInfo> {
  if (target.driver !== 'ollama') {
    return {};
  }
  return parseOllamaPs(await getJson(`${target.url}/api/ps`), model);
}

function applyPowerReading(into: { powerWatts?: number; powerSource?: PowerSource; powerNote?: string }, reading: PowerReading): void {
  if (reading.watts !== undefined) {
    into.powerWatts = round(reading.watts, 1);
  }
  if (reading.source !== undefined) {
    into.powerSource = reading.source;
  }
  if (reading.note !== undefined) {
    into.powerNote = reading.note;
  }
}

/**
 * Puts what was measured around a run onto its rows: the GPU memory the model holds, the
 * context it runs with, and the power draw. A batch's own row gets the same, plus tokens per
 * joule (its aggregate tokens per second over its watts).
 */
async function attachMeasurements(
  rows: BenchmarkResult[],
  target: ResolvedTarget,
  model: string,
  reading: PowerReading | undefined,
  aggregate?: BenchmarkAggregate
): Promise<void> {
  const loaded = await loadedModelState(target, model);
  for (const row of rows) {
    if (loaded.vramBytes !== undefined) {
      row.vramBytes = loaded.vramBytes;
    }
    if (row.contextWindow === undefined && loaded.contextWindow !== undefined) {
      row.contextWindow = loaded.contextWindow;
    }
    if (reading) {
      applyPowerReading(row, reading);
    }
  }
  if (aggregate) {
    if (loaded.vramBytes !== undefined) {
      aggregate.vramBytes = loaded.vramBytes;
    }
    if (reading) {
      applyPowerReading(aggregate, reading);
    }
    if (aggregate.powerWatts !== undefined && aggregate.powerWatts > 0) {
      aggregate.tokensPerJoule = round(aggregate.aggregateTokensPerSecond / aggregate.powerWatts, 4);
    }
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
  const target = await resolveTarget({ driver: options.driver });
  const power = options.measurePower ? await startPowerSampling(typeof options.measurePower === 'object' ? options.measurePower : undefined) : undefined;
  const result = await runSingle(modelName, promptToUse, {
    target,
    stream: options.stream !== false,
    now: options.now || Date.now,
    concurrency: 1,
    batchId: randomUUID(),
    contextDepth: options.contextDepth,
    repeatIndex: options.repeatIndex,
    profile: 'burst',
    scenario: options.scenario,
    note: options.note
  });
  const reading = power ? await power.stop() : undefined;
  await attachMeasurements([result], target, modelName, reading);
  return result;
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
  const target = await resolveTarget({ driver: options.driver });
  const ctx: SingleRunContext = {
    target,
    stream: options.stream !== false,
    now,
    concurrency: n,
    batchId: randomUUID(),
    contextDepth: options.contextDepth,
    repeatIndex: options.repeatIndex,
    profile: 'burst',
    scenario: options.scenario,
    note: options.note
  };

  console.log(`\nBenchmarking ${modelName} (${n} concurrent, ${ctx.stream ? 'streaming' : 'non-streaming'}, ${target.transport} → ${target.url})...`);
  // Engine metadata and the power sampler are set up before the clock starts, so neither is charged to the batch.
  await engineInfoFor(target, modelName);
  const power = options.measurePower ? await startPowerSampling(typeof options.measurePower === 'object' ? options.measurePower : undefined) : undefined;
  const wallStart = now();
  const results = await Promise.all(Array.from({ length: n }, () => runSingle(modelName, promptToUse, ctx)));
  const wallSeconds = (now() - wallStart) / 1000;
  const reading = power ? await power.stop() : undefined;
  const aggregate = computeAggregate(results, wallSeconds);
  await attachMeasurements(results, target, modelName, reading, aggregate);
  return { results, aggregate };
}


export const MAX_REPETITIONS = 50;

/** A whole number of repetitions from 1 to MAX_REPETITIONS; anything else is 1. */
export function clampRepetitions(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) {
    return 1;
  }
  return Math.min(Math.floor(n), MAX_REPETITIONS);
}

export interface RepeatedRun {
  results: BenchmarkResult[];
  aggregates: BenchmarkAggregate[];
  /** Spread across the repetitions, from successful rows only. */
  summary: {
    tokensPerSecond?: Summary;
    decodeTokensPerSecond?: Summary;
    promptTokensPerSecond?: Summary;
    ttftMs?: Summary;
  };
}

/** One concurrent batch per repetition, then the spread across the repetitions. */
export async function benchmarkRepeated(
  modelName: string,
  customPrompt: string | undefined,
  repetitions: number,
  concurrency: number,
  options: Omit<BenchmarkOptions, 'concurrency'> = {}
): Promise<RepeatedRun> {
  const results: BenchmarkResult[] = [];
  const aggregates: BenchmarkAggregate[] = [];
  const count = clampRepetitions(repetitions);
  for (let i = 0; i < count; i++) {
    const batch = await benchmarkModelConcurrently(modelName, customPrompt, concurrency, { ...options, repeatIndex: i });
    results.push(...batch.results);
    aggregates.push(batch.aggregate);
  }
  const ok = results.filter(row => row.success);
  const values = (pick: (row: BenchmarkResult) => number | undefined): number[] =>
    ok.map(pick).filter((value): value is number => typeof value === 'number');
  return {
    results,
    aggregates,
    summary: {
      tokensPerSecond: summarize(values(row => row.tokensPerSecond)),
      decodeTokensPerSecond: summarize(values(row => row.decodeTokensPerSecond)),
      promptTokensPerSecond: summarize(values(row => row.promptTokensPerSecond)),
      ttftMs: summarize(values(row => row.ttftMs))
    }
  };
}

export interface LoadProfileOptions extends Omit<BenchmarkOptions, 'concurrency'> {
  profile: 'constant' | 'poisson';
  /** Requests per second. */
  rate: number;
  durationSeconds: number;
  /** Seeds the Poisson schedule so a run can be repeated exactly. */
  seed?: number;
  slo?: SloTargets;
  /** Waiting between arrivals; injectable so tests need no real time. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LoadProfileRun {
  profile: 'constant' | 'poisson';
  rate: number;
  durationSeconds: number;
  results: BenchmarkResult[];
  requests: number;
  successes: number;
  failures: number;
  wallSeconds: number;
  /** Successful requests per wall-clock second. */
  completedPerSecond: number;
  ttftMs?: Summary;
  interTokenMs?: Summary;
  /** Share of requests that met the SLO. Undefined when no SLO was given. */
  goodput?: number;
  slo?: SloTargets;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Send single requests on a schedule (constant or Poisson arrivals) for a duration, then
 * summarise the latency distributions and the share of requests that met the SLO.
 */
export async function runLoadProfile(
  modelName: string,
  customPrompt: string | undefined,
  options: LoadProfileOptions
): Promise<LoadProfileRun> {
  const promptToUse = customPrompt || DEFAULT_PROMPT;
  const now = options.now || Date.now;
  const sleep = options.sleep || defaultSleep;
  const target = await resolveTarget({ driver: options.driver });
  const offsets = arrivalOffsetsMs({
    profile: options.profile,
    rate: options.rate,
    durationSeconds: options.durationSeconds,
    seed: options.seed
  });
  const ctx: SingleRunContext = {
    target,
    stream: options.stream !== false,
    now,
    concurrency: 1,
    batchId: randomUUID(),
    contextDepth: options.contextDepth,
    profile: options.profile,
    quiet: true,
    scenario: options.scenario,
    note: options.note
  };

  console.log(`\n${options.profile} load on ${modelName}: ${offsets.length} requests at ${options.rate}/s for ${options.durationSeconds}s (${target.driver} → ${target.url})...`);
  // Engine metadata and the power sampler are set up before the schedule starts.
  await engineInfoFor(target, modelName);
  const power = options.measurePower ? await startPowerSampling(typeof options.measurePower === 'object' ? options.measurePower : undefined) : undefined;
  const start = now();
  const results = await Promise.all(offsets.map(async offset => {
    const wait = start + offset - now();
    if (wait > 0) {
      await sleep(wait);
    }
    return runSingle(modelName, promptToUse, ctx);
  }));
  const wallSeconds = (now() - start) / 1000;
  const reading = power ? await power.stop() : undefined;
  await attachMeasurements(results, target, modelName, reading);

  const ok = results.filter(row => row.success);
  const present = (values: Array<number | undefined>): number[] =>
    values.filter((value): value is number => typeof value === 'number');
  return {
    profile: options.profile,
    rate: options.rate,
    durationSeconds: options.durationSeconds,
    results,
    requests: results.length,
    successes: ok.length,
    failures: results.length - ok.length,
    wallSeconds: round(wallSeconds, 2),
    completedPerSecond: wallSeconds > 0 ? round(ok.length / wallSeconds, 2) : 0,
    ttftMs: summarize(present(ok.map(row => row.ttftMs))),
    interTokenMs: summarize(present(ok.map(row => interTokenLatencyMs(row)))),
    goodput: options.slo ? goodputFraction(results, options.slo) : undefined,
    slo: options.slo
  };
}

export interface SweepRun {
  runs: LoadProfileRun[];
  /** The first rate that broke the SLO or failed requests, when one did. */
  saturatedAt?: number;
}

/**
 * Step through request rates with constant arrivals and stop at saturation: the first rate
 * where more than 5% of requests fail, or where the p90 TTFT breaks the TTFT target.
 */
export async function runSweep(
  modelName: string,
  customPrompt: string | undefined,
  options: Omit<LoadProfileOptions, 'rate'> & { rates: number[] }
): Promise<SweepRun> {
  const { rates, ...base } = options;
  const runs: LoadProfileRun[] = [];
  let saturatedAt: number | undefined;
  for (const rate of rates) {
    const run = await runLoadProfile(modelName, customPrompt, { ...base, rate });
    runs.push(run);
    const failing = run.requests > 0 && run.failures / run.requests > 0.05;
    const slow = base.slo?.ttftMs !== undefined && run.ttftMs !== undefined && run.ttftMs.p90 > base.slo.ttftMs;
    if (failing || slow) {
      saturatedAt = rate;
      break;
    }
  }
  return { runs, saturatedAt };
}

export interface ScalingLevel {
  concurrency: number;
  aggregate: BenchmarkAggregate;
}

/**
 * The same workload at several concurrency levels, one burst batch each: the throughput and
 * latency curve a serving decision needs. Levels run in the order given.
 */
export async function runScaling(
  modelName: string,
  customPrompt: string | undefined,
  levels: number[],
  options: Omit<BenchmarkOptions, 'concurrency'> = {}
): Promise<{ levels: ScalingLevel[]; results: BenchmarkResult[] }> {
  const curve: ScalingLevel[] = [];
  const results: BenchmarkResult[] = [];
  for (const level of levels) {
    const batch = await benchmarkModelConcurrently(modelName, customPrompt, level, options);
    results.push(...batch.results);
    curve.push({ concurrency: batch.aggregate.concurrency, aggregate: batch.aggregate });
  }
  return { levels: curve, results };
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


/** Longest note a run can carry. */
export const MAX_NOTE_LENGTH = 280;

/** A trimmed note, or undefined when there is none. Throws when it is too long. */
export function parseNote(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('note must be text');
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw new Error(`note must be ${MAX_NOTE_LENGTH} characters or fewer`);
  }
  return trimmed === '' ? undefined : trimmed;
}

export interface CliArgs {
  models: string[];
  concurrency: number;
  stream: boolean;
  driver?: DriverType;
  /** Context depths in tokens. One set of runs per depth. Not used when scenarios are given. */
  depths: number[];
  /** Fixed workloads (workloads.ts). When given, they replace the depths. */
  scenarios: Scenario[];
  repetitions: number;
  profile: MeasurementProfile | 'sweep' | 'scaling';
  rate?: number;
  rates?: number[];
  /** Concurrency levels for the scaling profile. */
  levels: number[];
  durationSeconds: number;
  seed?: number;
  slo: SloTargets;
  /** A free-text note attached to every row of this run. */
  note?: string;
  /** Where to write the shareable JSON export, when asked. */
  exportPath?: string;
}

function positiveNumber(value: string, flag: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} must be a number above zero, got "${value}"`);
  }
  return n;
}

function numberList(value: string, flag: string): string[] {
  const parts = value.split(',').map(part => part.trim()).filter(part => part !== '');
  if (parts.length === 0) {
    throw new Error(`${flag} needs at least one value`);
  }
  return parts;
}

/** Concurrency levels: comma-separated whole numbers from 1 to MAX_CONCURRENCY. */
function concurrencyList(value: string, flag: string): number[] {
  return numberList(value, flag).map(part => {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
      throw new Error(`${flag} values must be whole numbers from 1 to ${MAX_CONCURRENCY}, got "${part}"`);
    }
    return n;
  });
}

/**
 * Command-line options. `--concurrency=N`, `--no-stream` and the measurement flags are
 * recognised; anything else is a model name. Invalid values throw, so a typo fails the
 * run instead of quietly measuring the default.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    models: [],
    concurrency: 1,
    stream: true,
    depths: [0],
    scenarios: [],
    repetitions: 1,
    profile: 'burst',
    levels: [1, 2, 4, 8],
    durationSeconds: 30,
    slo: {}
  };
  for (const arg of argv) {
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : '';
    if (arg === '--no-stream') {
      args.stream = false;
    } else if (arg.startsWith('--concurrency=')) {
      args.concurrency = clampConcurrency(value);
    } else if (arg.startsWith('--driver=')) {
      const driver = parseDriverType(value);
      if (driver === 'llama-bench') {
        throw new Error('llama-bench runs a local binary, not an endpoint. Use npm run strix-halo for it.');
      }
      args.driver = driver;
    } else if (arg.startsWith('--depth=')) {
      args.depths = numberList(value, '--depth').map(part => {
        const depth = parseContextDepth(Number(part));
        if (depth === undefined) {
          throw new Error(`--depth values must be whole numbers from 0 to 32768, got "${part}"`);
        }
        return depth;
      });
    } else if (arg.startsWith('--scenario=')) {
      args.scenarios = numberList(value, '--scenario').map(part => parseScenario(part));
    } else if (arg.startsWith('--repetitions=')) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > MAX_REPETITIONS) {
        throw new Error(`--repetitions must be a whole number from 1 to ${MAX_REPETITIONS}, got "${value}"`);
      }
      args.repetitions = n;
    } else if (arg.startsWith('--profile=')) {
      if (!['burst', 'constant', 'poisson', 'sweep', 'scaling'].includes(value)) {
        throw new Error(`--profile must be burst, constant, poisson, sweep or scaling, got "${value}"`);
      }
      args.profile = value as CliArgs['profile'];
    } else if (arg.startsWith('--levels=')) {
      args.levels = concurrencyList(value, '--levels');
    } else if (arg.startsWith('--rate=')) {
      args.rate = positiveNumber(value, '--rate');
    } else if (arg.startsWith('--rates=')) {
      args.rates = numberList(value, '--rates').map(part => positiveNumber(part, '--rates'));
    } else if (arg.startsWith('--duration=')) {
      args.durationSeconds = positiveNumber(value, '--duration');
    } else if (arg.startsWith('--seed=')) {
      const n = Number(value);
      if (!Number.isInteger(n)) {
        throw new Error(`--seed must be a whole number, got "${value}"`);
      }
      args.seed = n;
    } else if (arg.startsWith('--ttft-slo=')) {
      args.slo.ttftMs = positiveNumber(value, '--ttft-slo');
    } else if (arg.startsWith('--itl-slo=')) {
      args.slo.itlMs = positiveNumber(value, '--itl-slo');
    } else if (arg.startsWith('--note=')) {
      args.note = parseNote(value);
    } else if (arg.startsWith('--export=')) {
      if (value.trim() === '') {
        throw new Error('--export needs a file path');
      }
      args.exportPath = value.trim();
    } else if (arg.startsWith('--')) {
      console.error(`Ignoring unknown flag ${arg}`);
    } else {
      args.models.push(arg);
    }
  }
  if ((args.profile === 'constant' || args.profile === 'poisson') && args.rate === undefined) {
    throw new Error(`--profile=${args.profile} needs --rate=<requests per second>`);
  }
  if (args.profile === 'sweep' && (args.rates === undefined || args.rates.length === 0)) {
    throw new Error('--profile=sweep needs --rates=<a,b,c>');
  }
  if (args.scenarios.length > 0 && args.depths.some(depth => depth > 0)) {
    throw new Error('--scenario fixes the prompt length, so it cannot be combined with --depth');
  }
  return args;
}

function formatLoadRun(run: LoadProfileRun): string {
  const parts = [
    `${run.profile} ${run.rate}/s: ${run.requests} sent, ${run.successes} ok`,
    `${run.completedPerSecond} completed/s`,
    run.ttftMs ? `TTFT p50 ${round(run.ttftMs.p50, 1)}ms, p90 ${round(run.ttftMs.p90, 1)}ms, p99 ${round(run.ttftMs.p99, 1)}ms` : undefined,
    run.interTokenMs ? `inter-token p50 ${round(run.interTokenMs.p50, 1)}ms, p90 ${round(run.interTokenMs.p90, 1)}ms` : undefined,
    run.goodput !== undefined ? `goodput ${round(run.goodput * 100, 1)}%` : undefined
  ].filter(Boolean);
  return parts.join(', ');
}

function formatRepeats(summary: Summary | undefined, repetitions: number): string {
  if (!summary) {
    return `repeated ×${repetitions}: no successful runs`;
  }
  const spread = summary.stddev !== undefined ? ` ± ${round(summary.stddev, 2)}` : '';
  const interval = summary.ci95 ? `, 95% CI ${round(summary.ci95.low, 2)} to ${round(summary.ci95.high, 2)}` : '';
  return `repeated ×${repetitions}: median ${round(summary.median, 2)} tokens/second (mean ${round(summary.mean, 2)}${spread}${interval})`;
}

function formatRow(r: BenchmarkResult): string {
  const parts = [
    `${r.tokensPerSecond} tok/s wall`,
    r.decodeTokensPerSecond !== undefined ? `${r.decodeTokensPerSecond} tok/s decode` : undefined,
    r.ttftMs !== undefined ? `TTFT ${r.ttftMs}ms` : undefined,
    r.requestedGenTokens !== undefined && r.finishReason !== undefined ? `finish ${r.finishReason} at ${r.totalTokens} of ${r.requestedGenTokens} tokens` : undefined,
    r.vramBytes !== undefined ? `VRAM ${round(r.vramBytes / 1e9, 2)} GB` : undefined,
    r.powerWatts !== undefined ? `${r.powerWatts} W (${r.powerSource})` : undefined,
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
    a.powerWatts !== undefined ? `${a.powerWatts} W` : undefined,
    a.tokensPerJoule !== undefined ? `${a.tokensPerJoule} tok/J` : undefined,
    a.vramBytes !== undefined ? `VRAM ${round(a.vramBytes / 1e9, 2)} GB` : undefined,
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
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exit(2);
  }
  const modelsToTest = args.models.length > 0 ? args.models : DEFAULT_MODELS;

  // Check the target answers before spending two minutes per model on it
  let target: ResolvedTarget;
  try {
    target = await resolveTarget({ driver: args.driver });
    if (target.transport === 'openai') {
      await axios.get(`${target.url}/v1/models`, { timeout: PROBE_TIMEOUT_MS, headers: authHeaders() });
    }
    console.log(`Target: ${target.url} (${target.driver}, ${target.path})`);
    console.log(`✓ Connected to ${target.transport === 'ollama' ? 'Ollama' : 'OpenAI-compatible'} API`);
  } catch (error) {
    console.error('✗ Cannot connect to the inference API. Set OLLAMA_API_URL or CI_LLM_BASE_URL and make sure it is running.');
    console.error(`  Error: ${(error as Error).message}`);
    process.exit(1);
  }

  // A fixed workload replaces the context depths: each one is a prompt length and a generation cap.
  const workloads: Array<{ scenario?: Scenario; contextDepth: number }> = args.scenarios.length > 0
    ? args.scenarios.map(scenario => ({ scenario, contextDepth: 0 }))
    : args.depths.map(contextDepth => ({ contextDepth }));
  const shape = args.scenarios.length > 0
    ? `scenarios ${args.scenarios.map(scenario => scenario.name).join(', ')}`
    : `depths ${args.depths.join(', ')}`;

  console.log(`\nModels to benchmark: ${modelsToTest.join(', ')}`);
  console.log(`Profile: ${args.profile}, concurrency ${args.concurrency}, ${shape}, repetitions ${args.repetitions}, streaming: ${args.stream ? 'on' : 'off'}`);
  if (args.note) {
    console.log(`Note: ${args.note}`);
  }

  const results: BenchmarkResult[] = [];
  const aggregates: BenchmarkAggregate[] = [];
  for (const model of modelsToTest) {
    for (const workload of workloads) {
      const options = {
        stream: args.stream,
        driver: args.driver,
        scenario: workload.scenario,
        contextDepth: workload.contextDepth,
        note: args.note,
        measurePower: true
      };
      if (args.profile === 'burst') {
        const run = await benchmarkRepeated(model, undefined, args.repetitions, args.concurrency, options);
        results.push(...run.results);
        aggregates.push(...run.aggregates);
        for (const row of run.results) {
          if (row.success) {
            console.log(`    ${formatRow(row)}`);
          }
        }
        for (const aggregate of run.aggregates) {
          console.log(`  = ${formatAggregate(aggregate)}`);
        }
        if (args.repetitions > 1) {
          console.log(`  = ${formatRepeats(run.summary.tokensPerSecond, args.repetitions)}`);
        }
      } else if (args.profile === 'scaling') {
        const scaling = await runScaling(model, undefined, args.levels, options);
        results.push(...scaling.results);
        for (const level of scaling.levels) {
          aggregates.push(level.aggregate);
          console.log(`  = ${formatAggregate(level.aggregate)}`);
        }
      } else if (args.profile === 'sweep') {
        const sweep = await runSweep(model, undefined, {
          ...options,
          profile: 'constant',
          durationSeconds: args.durationSeconds,
          seed: args.seed,
          slo: args.slo,
          rates: args.rates ?? []
        });
        for (const run of sweep.runs) {
          results.push(...run.results);
          console.log(`  ${formatLoadRun(run)}`);
        }
        if (sweep.saturatedAt !== undefined) {
          console.log(`  saturated at ${sweep.saturatedAt} requests/second`);
        }
      } else {
        const run = await runLoadProfile(model, undefined, {
          ...options,
          profile: args.profile,
          rate: args.rate as number,
          durationSeconds: args.durationSeconds,
          seed: args.seed,
          slo: args.slo
        });
        results.push(...run.results);
        console.log(`  ${formatLoadRun(run)}`);
      }
    }
  }

  // Save results
  saveResultsToCSV(results);
  await saveResultsToDatabase(results, aggregates);

  if (args.exportPath) {
    const hardware = await getSystemSpecs();
    const exported = buildExport({ results, aggregates, hardware, generatedAt: new Date() });
    fs.writeFileSync(args.exportPath, `${JSON.stringify(exported, null, 2)}\n`, 'utf8');
    console.log(`\nExport written to ${args.exportPath} (no prompts, responses, hostnames or addresses)`);
  }

  // Summary
  console.log('\n=== Benchmark Summary ===');
  const ranked = aggregates.filter(a => a.successes > 0).sort((a, b) => b.aggregateTokensPerSecond - a.aggregateTokensPerSecond);
  if (ranked.length > 0) {
    console.log(`\nRanking (by ${args.concurrency > 1 ? 'aggregate ' : ''}tokens/second):`);
    ranked.forEach((a, i) => {
      console.log(`  ${i + 1}. ${a.model}: ${formatAggregate(a)}`);
    });
  }

  const powerNote = results.find(r => r.powerNote !== undefined)?.powerNote;
  if (powerNote !== undefined) {
    console.log(`\nPower not recorded: ${powerNote}`);
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
