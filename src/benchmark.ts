#!/usr/bin/env node

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434';
const TEST_PROMPT = 'Write a short paragraph about artificial intelligence.';
const CSV_FILE = path.join(__dirname, '..', 'benchmark_results.csv');

// Default models to benchmark (all models from README)
const DEFAULT_MODELS: string[] = [
  'gemma3:270m',
  'qwen3:0.6b',
  'gemma3:1b',
  'deepseek-r1:1.5b',
  'llama3.2:1b',
  'qwen3:1.7b',
  'qwen3-vl:2b',
  'llama3.2:3b',
  'qwen3:4b',
  'gemma3:4b',
  'qwen3-vl:4b',
  'deepseek-r1:7b',
  'llama3.1:8b',
  'deepseek-r1:8b',
  'qwen3:8b',
  'qwen3-vl:8b',
  'gemma3:12b',
  'deepseek-r1:14b',
  'qwen3:14b',
  'gpt-oss:20b',
  'gemma3:27b',
  'qwen3-coder:latest',
  'qwen3-coder:30b',
  'qwen3:30b',
  'deepseek-r1:32b',
  'qwen3:32b',
  'qwen3-vl:30b',
  'qwen3-vl:32b',
  'deepseek-r1:70b',
  'llama3.1:70b',
  'gpt-oss:120b',
  'llama4:16x17b',
  'GLM-4.6:TQ1_0',
  'qwen3:235b',
  'qwen3-vl:235b',
  'GLM-4.6:Q4_K_M',
  'llama3.1:405b',
  'llama4:128x17b',
  'qwen3-coder:480b',
  'deepseek-v3.1:671b',
  'deepseek-r1:671b',
  'minmax m2'
];

interface BenchmarkResult {
  model: string;
  tokensPerSecond: string;
  totalTokens: number;
  durationSeconds: string;
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
export async function benchmarkModel(modelName: string): Promise<BenchmarkResult> {
  console.log(`\nBenchmarking ${modelName}...`);
  
  try {
    const startTime = Date.now();
    let totalTokens = 0;
    let responseText = '';
    
    const response = await axios.post<OllamaGenerateResponse>(
      `${OLLAMA_API_URL}/api/generate`,
      {
        model: modelName,
        prompt: TEST_PROMPT,
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
      tokensPerSecond: tokensPerSecond.toFixed(2),
      totalTokens: totalTokens,
      durationSeconds: durationSeconds.toFixed(2),
      timestamp: new Date().toISOString(),
      success: true
    };
  } catch (error) {
    console.error(`  ✗ Error benchmarking ${modelName}: ${(error as Error).message}`);
    return {
      model: modelName,
      tokensPerSecond: '0',
      totalTokens: 0,
      durationSeconds: '0',
      timestamp: new Date().toISOString(),
      success: false,
      error: (error as Error).message
    };
  }
}

/**
 * Save results to CSV file
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
  
  // Summary
  console.log('\n=== Benchmark Summary ===');
  const successfulResults = results.filter(r => r.success);
  if (successfulResults.length > 0) {
    successfulResults.sort((a, b) => parseFloat(b.tokensPerSecond) - parseFloat(a.tokensPerSecond));
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
