import * as si from 'systeminformation';
import * as os from 'os';
import { detectStrixHalo, StrixHaloInfo } from './strixHalo';

export interface SystemSpecs {
  serverName: string;
  cpuModel: string;
  cpuCores: number;
  cpuThreads: number;
  totalMemoryGB: number;
  osType: string;
  osVersion: string;
  motherboard?: string;
  gpus: Array<{
    model: string;
    vram?: number;
  }>;
  strixHalo?: StrixHaloInfo;
}

/**
 * Query and collect system specifications
 */
export async function getSystemSpecs(): Promise<SystemSpecs> {
  try {
    const [cpu, mem, osInfo, graphics, baseboard, strixHalo] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.osInfo(),
      si.graphics(),
      si.baseboard(),
      detectStrixHalo()
    ]);

    const gpus = graphics.controllers.map(gpu => ({
      model: gpu.model || 'Unknown GPU',
      vram: gpu.vram || undefined
    }));

    return {
      serverName: os.hostname(),
      cpuModel: cpu.brand || 'Unknown CPU',
      cpuCores: cpu.physicalCores || 0,
      cpuThreads: cpu.cores || 0,
      totalMemoryGB: parseFloat((mem.total / (1024 ** 3)).toFixed(2)),
      osType: osInfo.platform || os.platform(),
      osVersion: osInfo.distro || os.release(),
      motherboard: baseboard.manufacturer && baseboard.model 
        ? `${baseboard.manufacturer} ${baseboard.model}` 
        : undefined,
      gpus: gpus.length > 0 ? gpus : [{ model: 'No GPU detected' }],
      strixHalo: strixHalo.detected ? strixHalo : undefined
    };
  } catch (error) {
    console.error('Error collecting system specs:', error);
    
    // Fallback to basic Node.js os module
    return {
      serverName: os.hostname(),
      cpuModel: os.cpus()[0]?.model || 'Unknown CPU',
      cpuCores: os.cpus().length,
      cpuThreads: os.cpus().length,
      totalMemoryGB: parseFloat((os.totalmem() / (1024 ** 3)).toFixed(2)),
      osType: os.platform(),
      osVersion: os.release(),
      gpus: [{ model: 'Unable to detect GPU' }]
    };
  }
}

/**
 * Format system specs for display
 */
export function formatSystemSpecs(specs: SystemSpecs): string {
  const lines = [
    '=== System Specifications ===',
    `Server Name: ${specs.serverName}`,
    `CPU: ${specs.cpuModel}`,
    `  Cores: ${specs.cpuCores}, Threads: ${specs.cpuThreads}`,
    `Memory: ${specs.totalMemoryGB} GB`,
    `OS: ${specs.osType} ${specs.osVersion}`,
  ];

  if (specs.motherboard) {
    lines.push(`Motherboard: ${specs.motherboard}`);
  }

  lines.push('GPUs:');
  specs.gpus.forEach((gpu, index) => {
    const vramStr = gpu.vram ? ` (${gpu.vram} MB)` : '';
    lines.push(`  ${index + 1}. ${gpu.model}${vramStr}`);
  });

  if (specs.strixHalo) {
    lines.push('');
    lines.push('AMD STRIX Halo:');
    lines.push(`  GPU: ${specs.strixHalo.gpuModel || 'Detected'}`);
    if (specs.strixHalo.rocmVersion) {
      lines.push(`  ROCm: ${specs.strixHalo.rocmVersion}`);
    }
    if (specs.strixHalo.vulkanSupport !== undefined) {
      lines.push(`  Vulkan: ${specs.strixHalo.vulkanSupport ? 'Available' : 'Not available'}`);
    }
  }

  return lines.join('\n');
}
