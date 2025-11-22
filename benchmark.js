#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434';
const TEST_PROMPT = 'Write a short paragraph about artificial intelligence.';
const CSV_FILE = path.join(__dirname, 'benchmark_results.csv');

// Default models to benchmark (can be overridden via command line)
const DEFAULT_MODELS = [
  'llama2',
  'mistral',
  'codellama',
  'phi'
];

/**
 * Check if a model is available in Ollama
 */
async function checkModelAvailable(modelName) {
  try {
    const response = await axios.get(`${OLLAMA_API_URL}/api/tags`);
    const models = response.data.models || [];
    return models.some(m => m.name.startsWith(modelName));
  } catch (error) {
    console.error(`Error checking models: ${error.message}`);
    return false;
  }
}

/**
 * Benchmark a single model
 */
async function benchmarkModel(modelName) {
  console.log(`\nBenchmarking ${modelName}...`);
  
  try {
    const startTime = Date.now();
    let totalTokens = 0;
    let responseText = '';
    
    const response = await axios.post(
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
    console.error(`  ✗ Error benchmarking ${modelName}: ${error.message}`);
    return {
      model: modelName,
      tokensPerSecond: 0,
      totalTokens: 0,
      durationSeconds: 0,
      timestamp: new Date().toISOString(),
      success: false,
      error: error.message
    };
  }
}

/**
 * Save results to CSV file
 */
function saveResultsToCSV(results) {
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
async function main() {
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
    console.error(`  Error: ${error.message}`);
    process.exit(1);
  }
  
  // Run benchmarks
  const results = [];
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

module.exports = { benchmarkModel, saveResultsToCSV };
