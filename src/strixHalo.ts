import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * STRIX Halo GPU information
 */
export interface StrixHaloInfo {
  detected: boolean;
  gpuModel?: string;
  vram?: number;
  rocmVersion?: string;
  vulkanSupport?: boolean;
}

/**
 * STRIX Halo toolbox configuration
 */
export interface StrixHaloToolbox {
  name: string;
  backend: 'rocm' | 'vulkan';
  version: string;
  image: string;
  available: boolean;
}

/**
 * STRIX Halo benchmark options
 */
export interface StrixHaloBenchmarkOptions {
  modelPath: string;
  toolboxName: string;
  contextSize?: number;
  numGpuLayers?: number;
  flashAttention?: boolean;
  noMmap?: boolean;
  prompt?: string;
}

/**
 * STRIX Halo benchmark result
 */
export interface StrixHaloBenchmarkResult {
  model: string;
  toolbox: string;
  backend: string;
  tokensPerSecond: number;
  totalTokens: number;
  durationSeconds: number;
  timestamp: string;
  success: boolean;
  error?: string;
  contextSize?: number;
}

/**
 * Available STRIX Halo toolboxes
 */
export const STRIX_HALO_TOOLBOXES: StrixHaloToolbox[] = [
  {
    name: 'llama-rocm-6.4.4',
    backend: 'rocm',
    version: '6.4.4',
    image: 'docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-6.4.4',
    available: false
  },
  {
    name: 'llama-rocm-7.1.1',
    backend: 'rocm',
    version: '7.1.1',
    image: 'docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.1.1',
    available: false
  },
  {
    name: 'llama-rocm-7.2',
    backend: 'rocm',
    version: '7.2',
    image: 'docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2',
    available: false
  },
  {
    name: 'llama-rocm7-nightlies',
    backend: 'rocm',
    version: 'nightly',
    image: 'docker.io/kyuz0/amd-strix-halo-toolboxes:rocm7-nightlies',
    available: false
  },
  {
    name: 'llama-vulkan-radv',
    backend: 'vulkan',
    version: 'radv',
    image: 'docker.io/kyuz0/amd-strix-halo-toolboxes:vulkan-radv',
    available: false
  },
  {
    name: 'llama-vulkan-amdvlk',
    backend: 'vulkan',
    version: 'amdvlk',
    image: 'docker.io/kyuz0/amd-strix-halo-toolboxes:vulkan-amdvlk',
    available: false
  }
];

/**
 * Detect if system has AMD STRIX Halo GPU
 */
export async function detectStrixHalo(): Promise<StrixHaloInfo> {
  const info: StrixHaloInfo = {
    detected: false
  };

  try {
    // Check for AMD GPU via lspci
    const { stdout: lspciOutput } = await execAsync('lspci -nn | grep -i "vga\\|display\\|3d" || true');
    
    // Look for AMD/ATI and potential Strix Halo identifiers
    const isAMD = lspciOutput.toLowerCase().includes('amd') || lspciOutput.toLowerCase().includes('ati');
    const hasRadeon = lspciOutput.toLowerCase().includes('radeon');
    
    if (isAMD || hasRadeon) {
      info.detected = true;
      
      // Try to get more specific GPU info
      const lines = lspciOutput.split('\n').filter(line => line.trim());
      if (lines.length > 0) {
        // Extract GPU model from first AMD GPU line
        const match = lines[0].match(/:\s*(.+?)\s*\[/);
        if (match) {
          info.gpuModel = match[1].trim();
        } else {
          info.gpuModel = lines[0].split(':').slice(1).join(':').trim();
        }
      }
    }

    // Check for ROCm installation
    try {
      const { stdout: rocmOutput } = await execAsync('which rocm-smi || echo ""');
      if (rocmOutput.trim()) {
        // Try to get ROCm version
        try {
          const { stdout: versionOutput } = await execAsync('rocm-smi --showproductname || true');
          if (versionOutput) {
            info.rocmVersion = 'installed';
          }
        } catch {
          info.rocmVersion = 'installed';
        }
      }
    } catch {
      // ROCm not installed
    }

    // Check for Vulkan support
    try {
      const { stdout: vulkanOutput } = await execAsync('which vulkaninfo || echo ""');
      info.vulkanSupport = !!vulkanOutput.trim();
    } catch {
      info.vulkanSupport = false;
    }

  } catch (error) {
    console.error('Error detecting STRIX Halo:', error);
  }

  return info;
}

/**
 * Check if toolbox is installed
 */
export async function isToolboxInstalled(): Promise<boolean> {
  try {
    await execAsync('which toolbox');
    return true;
  } catch {
    return false;
  }
}

/**
 * List available STRIX Halo toolboxes on the system
 */
export async function listAvailableToolboxes(): Promise<StrixHaloToolbox[]> {
  try {
    const { stdout } = await execAsync('toolbox list --images 2>/dev/null || toolbox list 2>/dev/null || echo ""');
    
    return STRIX_HALO_TOOLBOXES.map(toolbox => ({
      ...toolbox,
      available: stdout.includes(toolbox.name)
    }));
  } catch {
    return STRIX_HALO_TOOLBOXES;
  }
}

/**
 * Create a STRIX Halo toolbox
 */
export async function createToolbox(toolbox: StrixHaloToolbox): Promise<boolean> {
  try {
    const deviceArgs = toolbox.backend === 'rocm'
      ? '--device /dev/dri --device /dev/kfd --group-add video --group-add render --group-add sudo'
      : '--device /dev/dri --group-add video';

    const cmd = `toolbox create ${toolbox.name} --image ${toolbox.image} -- ${deviceArgs} --security-opt seccomp=unconfined`;
    
    console.log(`Creating toolbox: ${toolbox.name}`);
    await execAsync(cmd);
    console.log(`✓ Toolbox ${toolbox.name} created successfully`);
    return true;
  } catch (error) {
    console.error(`✗ Failed to create toolbox ${toolbox.name}:`, error);
    return false;
  }
}

/**
 * Run llama-bench inside a STRIX Halo toolbox
 */
export async function benchmarkWithToolbox(options: StrixHaloBenchmarkOptions): Promise<StrixHaloBenchmarkResult> {
  const startTime = Date.now();
  
  try {
    // Build llama-bench command
    const llamaBenchPath = options.toolboxName.includes('vulkan') 
      ? '/usr/sbin/llama-bench'
      : '/usr/local/bin/llama-bench';

    const args = [
      `-m ${options.modelPath}`,
      `-ngl ${options.numGpuLayers || 99}`,
      '-mmp 0' // no memory mapping
    ];

    if (options.flashAttention) {
      args.push('-fa 1');
    }

    if (options.contextSize) {
      args.push(`-c ${options.contextSize}`);
    }

    // STRIX Halo requires flash attention and no-mmap for stability
    const envVars = options.toolboxName.includes('rocm') && !options.toolboxName.includes('hblt0')
      ? 'env ROCBLAS_USE_HIPBLASLT=1'
      : '';

    const cmd = `toolbox run -c ${options.toolboxName} -- ${envVars} ${llamaBenchPath} ${args.join(' ')}`;
    
    console.log(`Running benchmark in ${options.toolboxName}...`);
    const { stdout, stderr } = await execAsync(cmd, { 
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300000 // 5 minutes
    });

    const endTime = Date.now();
    const durationSeconds = (endTime - startTime) / 1000;

    // Parse llama-bench output
    const output = stdout + stderr;
    
    // Extract tokens per second from output
    // llama-bench typically outputs in format like "pp 512: 123.45 t/s"
    const tpsMatch = output.match(/(\d+\.?\d*)\s+t\/s/i);
    const tokensPerSecond = tpsMatch ? parseFloat(tpsMatch[1]) : 0;

    // Extract total tokens if available
    const tokensMatch = output.match(/tokens:\s*(\d+)/i);
    const totalTokens = tokensMatch ? parseInt(tokensMatch[1], 10) : 0;

    const modelName = path.basename(options.modelPath, '.gguf');
    const backend = options.toolboxName.includes('rocm') ? 'rocm' : 'vulkan';

    return {
      model: modelName,
      toolbox: options.toolboxName,
      backend,
      tokensPerSecond,
      totalTokens,
      durationSeconds,
      timestamp: new Date().toISOString(),
      success: tokensPerSecond > 0,
      contextSize: options.contextSize
    };
  } catch (error) {
    const endTime = Date.now();
    const durationSeconds = (endTime - startTime) / 1000;
    
    return {
      model: path.basename(options.modelPath, '.gguf'),
      toolbox: options.toolboxName,
      backend: options.toolboxName.includes('rocm') ? 'rocm' : 'vulkan',
      tokensPerSecond: 0,
      totalTokens: 0,
      durationSeconds,
      timestamp: new Date().toISOString(),
      success: false,
      error: (error as Error).message
    };
  }
}

/**
 * Check if a model file exists
 */
export function checkModelExists(modelPath: string): boolean {
  return fs.existsSync(modelPath);
}

/**
 * Format STRIX Halo info for display
 */
export function formatStrixHaloInfo(info: StrixHaloInfo): string {
  if (!info.detected) {
    return 'AMD STRIX Halo: Not detected';
  }

  const lines = [
    '=== AMD STRIX Halo Detected ===',
    `GPU: ${info.gpuModel || 'Unknown AMD GPU'}`,
  ];

  if (info.vram) {
    lines.push(`VRAM: ${info.vram} MB`);
  }

  if (info.rocmVersion) {
    lines.push(`ROCm: ${info.rocmVersion}`);
  }

  if (info.vulkanSupport !== undefined) {
    lines.push(`Vulkan: ${info.vulkanSupport ? 'Supported' : 'Not available'}`);
  }

  return lines.join('\n');
}
