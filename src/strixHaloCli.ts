#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import {
  detectStrixHalo,
  isToolboxInstalled,
  listAvailableToolboxes,
  createToolbox,
  benchmarkWithToolbox,
  formatStrixHaloInfo,
  STRIX_HALO_TOOLBOXES,
  StrixHaloToolbox,
  StrixHaloBenchmarkResult
} from './strixHalo';
import { initDatabase, saveBenchmarkResults, saveSystemSpecs } from './database';
import { getSystemSpecs, formatSystemSpecs } from './systemSpecs';

/**
 * Display help information
 */
function displayHelp(): void {
  console.log(`
=== STRIX Halo Benchmark Tool ===

A tool for benchmarking LLMs on AMD Ryzen AI Max "Strix Halo" GPUs using llama.cpp toolboxes.

USAGE:
  npm run strix-halo <command> [options]

COMMANDS:
  detect              Detect AMD STRIX Halo GPU and check system configuration
  list-toolboxes      List available STRIX Halo toolboxes
  setup <toolbox>     Create and setup a specific toolbox
  setup-all           Create all STRIX Halo toolboxes
  benchmark <model>   Run benchmark on a GGUF model file
  help                Display this help message

OPTIONS FOR BENCHMARK:
  --toolbox <name>    Specify toolbox to use (default: llama-rocm-7.2)
  --context <size>    Context size (default: 8192)
  --flash-attention   Enable flash attention (recommended for STRIX Halo)
  --no-mmap           Disable memory mapping (recommended for STRIX Halo)

EXAMPLES:
  # Detect STRIX Halo GPU
  npm run strix-halo detect

  # List available toolboxes
  npm run strix-halo list-toolboxes

  # Setup ROCm 7.2 toolbox
  npm run strix-halo setup llama-rocm-7.2

  # Setup all toolboxes
  npm run strix-halo setup-all

  # Benchmark a model
  npm run strix-halo benchmark /path/to/model.gguf --toolbox llama-rocm-7.2 --flash-attention

TOOLBOXES:
  ROCm backends:
    - llama-rocm-6.4.4
    - llama-rocm-7.1.1
    - llama-rocm-7.2 (recommended)
    - llama-rocm7-nightlies

  Vulkan backends:
    - llama-vulkan-radv
    - llama-vulkan-amdvlk

For more information, visit:
  https://github.com/kyuz0/amd-strix-halo-toolboxes
  `);
}

/**
 * Detect STRIX Halo GPU
 */
async function cmdDetect(): Promise<void> {
  console.log('Detecting AMD STRIX Halo GPU...\n');
  
  const strixInfo = await detectStrixHalo();
  console.log(formatStrixHaloInfo(strixInfo));
  
  if (!strixInfo.detected) {
    console.log('\nNote: This tool is optimized for AMD Ryzen AI Max "Strix Halo" GPUs.');
    console.log('If you have a Strix Halo system, make sure the GPU drivers are installed.');
    return;
  }
  
  console.log('\n');
  const toolboxInstalled = await isToolboxInstalled();
  console.log(`Toolbox (container system): ${toolboxInstalled ? 'Installed ✓' : 'Not installed ✗'}`);
  
  if (!toolboxInstalled) {
    console.log('\nTo install toolbox:');
    console.log('  Fedora: sudo dnf install toolbox');
    console.log('  Ubuntu: sudo apt install podman-toolbox');
  }
  
  console.log('\n');
  const systemSpecs = await getSystemSpecs();
  console.log(formatSystemSpecs(systemSpecs));
}

/**
 * List available toolboxes
 */
async function cmdListToolboxes(): Promise<void> {
  console.log('Checking STRIX Halo toolboxes...\n');
  
  const toolboxInstalled = await isToolboxInstalled();
  if (!toolboxInstalled) {
    console.log('✗ Toolbox is not installed on this system.');
    console.log('\nTo install toolbox:');
    console.log('  Fedora: sudo dnf install toolbox');
    console.log('  Ubuntu: sudo apt install podman-toolbox');
    return;
  }
  
  const toolboxes = await listAvailableToolboxes();
  
  console.log('=== STRIX Halo Toolboxes ===\n');
  console.log('ROCm Backends:');
  toolboxes.filter(t => t.backend === 'rocm').forEach(t => {
    const status = t.available ? '✓ Available' : '✗ Not installed';
    const recommended = t.name === 'llama-rocm-7.2' ? ' (recommended)' : '';
    console.log(`  ${t.name} (${t.version})${recommended}: ${status}`);
  });
  
  console.log('\nVulkan Backends:');
  toolboxes.filter(t => t.backend === 'vulkan').forEach(t => {
    const status = t.available ? '✓ Available' : '✗ Not installed';
    console.log(`  ${t.name} (${t.version}): ${status}`);
  });
  
  const notInstalled = toolboxes.filter(t => !t.available);
  if (notInstalled.length > 0) {
    console.log(`\nTo create a toolbox, use: npm run strix-halo setup <toolbox-name>`);
  }
}

/**
 * Setup a toolbox
 */
async function cmdSetup(toolboxName: string): Promise<void> {
  const toolbox = STRIX_HALO_TOOLBOXES.find(t => t.name === toolboxName);
  
  if (!toolbox) {
    console.error(`Error: Unknown toolbox '${toolboxName}'`);
    console.log('\nAvailable toolboxes:');
    STRIX_HALO_TOOLBOXES.forEach(t => console.log(`  - ${t.name}`));
    process.exit(1);
  }
  
  const toolboxInstalled = await isToolboxInstalled();
  if (!toolboxInstalled) {
    console.error('✗ Toolbox is not installed on this system.');
    console.log('\nTo install toolbox:');
    console.log('  Fedora: sudo dnf install toolbox');
    console.log('  Ubuntu: sudo apt install podman-toolbox');
    process.exit(1);
  }
  
  console.log(`Setting up ${toolbox.name}...\n`);
  const success = await createToolbox(toolbox);
  
  if (!success) {
    console.error('\nFailed to create toolbox. Check the error messages above.');
    process.exit(1);
  }
  
  console.log('\n✓ Toolbox setup complete!');
  console.log(`\nYou can now use this toolbox to benchmark models:`);
  console.log(`  npm run strix-halo benchmark /path/to/model.gguf --toolbox ${toolbox.name}`);
}

/**
 * Setup all toolboxes
 */
async function cmdSetupAll(): Promise<void> {
  const toolboxInstalled = await isToolboxInstalled();
  if (!toolboxInstalled) {
    console.error('✗ Toolbox is not installed on this system.');
    console.log('\nTo install toolbox:');
    console.log('  Fedora: sudo dnf install toolbox');
    console.log('  Ubuntu: sudo apt install podman-toolbox');
    process.exit(1);
  }
  
  console.log('Setting up all STRIX Halo toolboxes...\n');
  console.log('This may take a while as it downloads container images.\n');
  
  for (const toolbox of STRIX_HALO_TOOLBOXES) {
    console.log(`\n--- Setting up ${toolbox.name} ---`);
    await createToolbox(toolbox);
  }
  
  console.log('\n✓ All toolboxes setup complete!');
}

/**
 * Parse command line arguments for benchmark command
 */
interface BenchmarkOptions {
  modelPath: string;
  toolbox: string;
  contextSize: number;
  flashAttention: boolean;
  noMmap: boolean;
}

function parseBenchmarkArgs(args: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    modelPath: '',
    toolbox: 'llama-rocm-7.2',
    contextSize: 8192,
    flashAttention: true,
    noMmap: true
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--toolbox' && i + 1 < args.length) {
      options.toolbox = args[++i];
    } else if (arg === '--context' && i + 1 < args.length) {
      const contextValue = parseInt(args[++i], 10);
      if (isNaN(contextValue) || contextValue <= 0) {
        console.error(`Error: Invalid context size '${args[i]}'. Must be a positive number.`);
        process.exit(1);
      }
      options.contextSize = contextValue;
    } else if (arg === '--flash-attention') {
      options.flashAttention = true;
    } else if (arg === '--no-mmap') {
      options.noMmap = true;
    } else if (!arg.startsWith('--')) {
      options.modelPath = arg;
    }
  }
  
  return options;
}

/**
 * Run benchmark
 */
async function cmdBenchmark(args: string[]): Promise<void> {
  const options = parseBenchmarkArgs(args);
  
  if (!options.modelPath) {
    console.error('Error: Model path is required');
    console.log('\nUsage: npm run strix-halo benchmark <model-path> [options]');
    process.exit(1);
  }
  
  if (!fs.existsSync(options.modelPath)) {
    console.error(`Error: Model file not found: ${options.modelPath}`);
    process.exit(1);
  }
  
  const toolbox = STRIX_HALO_TOOLBOXES.find(t => t.name === options.toolbox);
  if (!toolbox) {
    console.error(`Error: Unknown toolbox '${options.toolbox}'`);
    console.log('\nAvailable toolboxes:');
    STRIX_HALO_TOOLBOXES.forEach(t => console.log(`  - ${t.name}`));
    process.exit(1);
  }
  
  console.log('=== STRIX Halo Benchmark ===\n');
  console.log(`Model: ${path.basename(options.modelPath)}`);
  console.log(`Toolbox: ${options.toolbox}`);
  console.log(`Backend: ${toolbox.backend}`);
  console.log(`Context Size: ${options.contextSize}`);
  console.log(`Flash Attention: ${options.flashAttention ? 'Enabled' : 'Disabled'}`);
  console.log(`No-mmap: ${options.noMmap ? 'Enabled' : 'Disabled'}`);
  console.log('');
  
  const result = await benchmarkWithToolbox({
    modelPath: options.modelPath,
    toolboxName: options.toolbox,
    contextSize: options.contextSize,
    flashAttention: options.flashAttention,
    noMmap: options.noMmap
  });
  
  if (result.success) {
    console.log('\n=== Benchmark Results ===');
    console.log(`Model: ${result.model}`);
    console.log(`Tokens per second: ${result.tokensPerSecond.toFixed(2)}`);
    console.log(`Total tokens: ${result.totalTokens}`);
    console.log(`Duration: ${result.durationSeconds.toFixed(2)}s`);
    console.log(`Backend: ${result.backend}`);
    
    // Save to database
    try {
      initDatabase();
      const systemSpecs = await getSystemSpecs();
      const systemSpecsId = saveSystemSpecs(systemSpecs);
      
      // Convert STRIX Halo result to standard benchmark result format
      const benchmarkResults = [{
        model: `${result.model} (${result.toolbox})`,
        tokensPerSecond: result.tokensPerSecond,
        totalTokens: result.totalTokens,
        durationSeconds: result.durationSeconds,
        timestamp: result.timestamp,
        success: result.success
      }];
      
      saveBenchmarkResults(benchmarkResults, systemSpecsId);
      console.log('\n✓ Results saved to database');
    } catch (error) {
      console.error('\n✗ Failed to save results to database:', (error as Error).message);
    }
  } else {
    console.error('\n✗ Benchmark failed');
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
}

/**
 * Main function
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    displayHelp();
    return;
  }
  
  const command = args[0];
  const commandArgs = args.slice(1);
  
  switch (command) {
    case 'detect':
      await cmdDetect();
      break;
    
    case 'list-toolboxes':
      await cmdListToolboxes();
      break;
    
    case 'setup':
      if (commandArgs.length === 0) {
        console.error('Error: Toolbox name is required');
        console.log('\nUsage: npm run strix-halo setup <toolbox-name>');
        console.log('\nRun "npm run strix-halo list-toolboxes" to see available toolboxes');
        process.exit(1);
      }
      await cmdSetup(commandArgs[0]);
      break;
    
    case 'setup-all':
      await cmdSetupAll();
      break;
    
    case 'benchmark':
      await cmdBenchmark(commandArgs);
      break;
    
    case 'help':
    case '--help':
    case '-h':
      displayHelp();
      break;
    
    default:
      console.error(`Error: Unknown command '${command}'`);
      console.log('\nRun "npm run strix-halo help" for usage information');
      process.exit(1);
  }
}

// Run main function
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
