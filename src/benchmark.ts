#!/usr/bin/env node

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, saveBenchmarkResults, saveSystemSpecs, BenchmarkResult as DBBenchmarkResult } from './database';
import { getSystemSpecs, formatSystemSpecs } from './systemSpecs';

// Configuration
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434';
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
}

export interface OllamaModelCatalogEntry extends SupportedOllamaModel {
  installed: boolean;
  supported: boolean;
  source: 'catalog' | 'installed';
}

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
  { name: 'gemma3:270m', size: '292MB', contextWindow: '32K', inputs: ['Text'], family: 'gemma3' },
  { name: 'qwen3:0.6b', size: '523MB', contextWindow: '40K', inputs: ['Text'], family: 'qwen3' },
  { name: 'gemma3:1b', size: '815MB', contextWindow: '32K', inputs: ['Text'], family: 'gemma3' },
  { name: 'deepseek-r1:1.5b', size: '1.1GB', contextWindow: '128K', inputs: ['Text'], family: 'deepseek-r1' },
  { name: 'llama3.2:1b', size: '1.3GB', contextWindow: '128K', inputs: ['Text'], family: 'llama3.2' },
  { name: 'qwen3:1.7b', size: '1.4GB', contextWindow: '40K', inputs: ['Text'], family: 'qwen3' },
  { name: 'qwen3-vl:2b', size: '1.9GB', contextWindow: '256K', inputs: ['Text', 'Image'], family: 'qwen3-vl' },
  { name: 'llama3.2:3b', size: '2.0GB', contextWindow: '128K', inputs: ['Text'], family: 'llama3.2' },
  { name: 'qwen3:4b', size: '2.5GB', contextWindow: '256K', inputs: ['Text'], family: 'qwen3' },
  { name: 'gemma3:4b', size: '3.3GB', contextWindow: '128K', inputs: ['Text', 'Image'], family: 'gemma3' },
  { name: 'qwen3-vl:4b', size: '3.3GB', contextWindow: '256K', inputs: ['Text', 'Image'], family: 'qwen3-vl' },
  { name: 'deepseek-r1:7b', size: '4.7GB', contextWindow: '128K', inputs: ['Text'], family: 'deepseek-r1' },
  { name: 'llama3.1:8b', size: '4.9GB', contextWindow: '128K', inputs: ['Text'], family: 'llama3.1' },
  { name: 'deepseek-r1:8b', size: '5.2GB', contextWindow: '128K', inputs: ['Text'], family: 'deepseek-r1' },
  { name: 'qwen3:8b', size: '5.2GB', contextWindow: '40K', inputs: ['Text'], family: 'qwen3' },
  { name: 'qwen3-vl:8b', size: '6.1GB', contextWindow: '256K', inputs: ['Text', 'Image'], family: 'qwen3-vl' },
  { name: 'gemma3:12b', size: '8.1GB', contextWindow: '128K', inputs: ['Text', 'Image'], family: 'gemma3' },
  { name: 'deepseek-r1:14b', size: '9.0GB', contextWindow: '128K', inputs: ['Text'], family: 'deepseek-r1' },
  { name: 'qwen3:14b', size: '9.3GB', contextWindow: '40K', inputs: ['Text'], family: 'qwen3' },
  { name: 'gpt-oss:20b', size: '14GB', contextWindow: '128K', inputs: ['Text'], family: 'gpt-oss' },
  { name: 'gemma3:27b', size: '17GB', contextWindow: '128K', inputs: ['Text', 'Image'], family: 'gemma3' },
  { name: 'qwen3-coder:latest', size: '19GB', contextWindow: '256K', inputs: ['Text'], family: 'qwen3-coder' },
  { name: 'qwen3-coder:30b', size: '19GB', contextWindow: '256K', inputs: ['Text'], family: 'qwen3-coder' },
  { name: 'qwen3:30b', size: '19GB', contextWindow: '256K', inputs: ['Text'], family: 'qwen3' },
  { name: 'deepseek-r1:32b', size: '20GB', contextWindow: '128K', inputs: ['Text'], family: 'deepseek-r1' },
  { name: 'qwen3:32b', size: '20GB', contextWindow: '40K', inputs: ['Text'], family: 'qwen3' },
  { name: 'qwen3-vl:30b', size: '20GB', contextWindow: '256K', inputs: ['Text', 'Image'], family: 'qwen3-vl' },
  { name: 'qwen3-vl:32b', size: '21GB', contextWindow: '256K', inputs: ['Text', 'Image'], family: 'qwen3-vl' },
  { name: 'deepseek-r1:70b', size: '43GB', contextWindow: '128K', inputs: ['Text'], family: 'deepseek-r1' },
  { name: 'llama3.1:70b', size: '43GB', contextWindow: '128K', inputs: ['Text'], family: 'llama3.1' },
  { name: 'gpt-oss:120b', size: '65GB', contextWindow: '128K', inputs: ['Text'], family: 'gpt-oss' },
  { name: 'llama4:16x17b', size: '67GB', contextWindow: '10M', inputs: ['Text', 'Image'], family: 'llama4' },
  { name: 'GLM-4.6:TQ1_0', size: '84GB', contextWindow: '198K', inputs: ['Text'], family: 'GLM-4.6' },
  { name: 'qwen3:235b', size: '142GB', contextWindow: '256K', inputs: ['Text'], family: 'qwen3' },
  { name: 'qwen3-vl:235b', size: '143GB', contextWindow: '256K', inputs: ['Text', 'Image'], family: 'qwen3-vl' },
  { name: 'GLM-4.6:Q4_K_M', size: '216GB', contextWindow: '198K', inputs: ['Text'], family: 'GLM-4.6' },
  { name: 'llama3.1:405b', size: '243GB', contextWindow: '128K', inputs: ['Text'], family: 'llama3.1' },
  { name: 'llama4:128x17b', size: '245GB', contextWindow: '1M', inputs: ['Text', 'Image'], family: 'llama4' },
  { name: 'qwen3-coder:480b', size: '290GB', contextWindow: '256K', inputs: ['Text'], family: 'qwen3-coder' },
  { name: 'deepseek-v3.1:671b', size: '404GB', contextWindow: '160K', inputs: ['Text'], family: 'deepseek-v3.1' },
  { name: 'deepseek-r1:671b', size: '404GB', contextWindow: '160K', inputs: ['Text'], family: 'deepseek-r1' },
  { name: 'minmax m2', size: '968GB', contextWindow: '200K', inputs: ['Text'], family: 'minmax' }
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

interface BenchmarkResult {
  model: string;
  tokensPerSecond: number;
  totalTokens: number;
  durationSeconds: number;
  timestamp: string;
  success: boolean;
  error?: string;
}

interface OllamaModel {
  name: string;
  [key: string]: any;
}

interface OllamaGenerateResponse {
  response?: string;
  eval_count?: number;
  [key: string]: any;
}

/**
 * Check if a model is available in Ollama
 */
export async function checkModelAvailable(modelName: string): Promise<boolean> {
  try {
    const response = await axios.get<{ models?: OllamaModel[] }>(`${OLLAMA_API_URL}/api/tags`);
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
export async function benchmarkModel(modelName: string, customPrompt?: string): Promise<BenchmarkResult> {
  const promptToUse = customPrompt || DEFAULT_PROMPT;
  console.log(`\nBenchmarking ${modelName}...`);
  
  try {
    const startTime = Date.now();
    let totalTokens = 0;
    let responseText = '';
    
    const response = await axios.post<OllamaGenerateResponse>(
      `${OLLAMA_API_URL}/api/generate`,
      {
        model: modelName,
        prompt: promptToUse,
        stream: false
      },
      {
        timeout: 120000 // 2 minutes timeout
      }
    );
    
    const endTime = Date.now();
    const durationSeconds = (endTime - startTime) / 1000;
    
    // Extract token count and response
    if (response.data) {
      totalTokens = response.data.eval_count || 0;
      responseText = response.data.response || '';
    }
    
    const tokensPerSecond = totalTokens / durationSeconds;
    
    console.log(`  ✓ Completed in ${durationSeconds.toFixed(2)}s`);
    console.log(`  ✓ Generated ${totalTokens} tokens`);
    console.log(`  ✓ Speed: ${tokensPerSecond.toFixed(2)} tokens/second`);
    
    return {
      model: modelName,
      tokensPerSecond: parseFloat(tokensPerSecond.toFixed(2)),
      totalTokens: totalTokens,
      durationSeconds: parseFloat(durationSeconds.toFixed(2)),
      timestamp: new Date().toISOString(),
      success: true
    };
  } catch (error) {
    console.error(`  ✗ Error benchmarking ${modelName}: ${(error as Error).message}`);
    return {
      model: modelName,
      tokensPerSecond: 0,
      totalTokens: 0,
      durationSeconds: 0,
      timestamp: new Date().toISOString(),
      success: false,
      error: (error as Error).message
    };
  }
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
 * Save results to database
 */
export async function saveResultsToDatabase(results: BenchmarkResult[]): Promise<void> {
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
  } catch (error) {
    console.error('Error saving to database:', (error as Error).message);
    throw error;
  }
}

/**
 * Main function
 */
async function main(): Promise<void> {
  console.log('=== Local LLM Benchmark Tool ===');
  console.log(`Ollama API URL: ${OLLAMA_API_URL}`);
  
  // Get models from command line arguments or use defaults
  const modelsToTest = process.argv.slice(2).length > 0 
    ? process.argv.slice(2) 
    : DEFAULT_MODELS;
  
  console.log(`\nModels to benchmark: ${modelsToTest.join(', ')}`);
  
  // Check Ollama connection
  try {
    await axios.get(`${OLLAMA_API_URL}/api/tags`);
    console.log('✓ Connected to Ollama API');
  } catch (error) {
    console.error('✗ Cannot connect to Ollama API. Make sure Ollama is running.');
    console.error(`  Error: ${(error as Error).message}`);
    process.exit(1);
  }
  
  // Run benchmarks
  const results: BenchmarkResult[] = [];
  for (const model of modelsToTest) {
    const result = await benchmarkModel(model);
    results.push(result);
  }
  
  // Save results
  saveResultsToCSV(results);
  await saveResultsToDatabase(results);
  
  // Summary
  console.log('\n=== Benchmark Summary ===');
  const successfulResults = results.filter(r => r.success);
  if (successfulResults.length > 0) {
    successfulResults.sort((a, b) => b.tokensPerSecond - a.tokensPerSecond);
    console.log('\nRanking (by tokens/second):');
    successfulResults.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.model}: ${r.tokensPerSecond} tokens/s`);
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
