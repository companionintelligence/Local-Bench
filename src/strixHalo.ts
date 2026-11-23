import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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
  /** Prompt tokens per test (llama-bench -p). Default 512. */
  nPrompt?: number;
  /** Generated tokens per test (llama-bench -n). Default 128. */
  nGen?: number;
  /** Context depth in tokens, prefilled before timing (llama-bench -d). Default 0. */
  depth?: number;
  /** Repetitions per test (llama-bench -r). Default 5. */
  repetitions?: number;
  /** Skip llama-bench's warm-up runs (--no-warmup). */
  noWarmup?: boolean;
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
  /** Kept for display only: llama-bench has no context-size flag. Use `depth` for prefilled context. */
  contextSize?: number;
  /** Context depth the run was measured at. */
  depth?: number;
  promptTokensPerSecond?: number;
  /** Decode (token generation) speed, the number the dashboard compares. Also mirrored in tokensPerSecond. */
  decodeTokensPerSecond?: number;
  decodeStddevTokensPerSecond?: number;
  decodeSamples?: number[];
  /** Every test llama-bench ran, as parsed from its JSON output. */
  rows?: LlamaBenchRow[];
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
 * llama-bench arguments for one run. The run prints JSON on stdout (`-o json`), so nothing
 * has to be read out of the markdown table. Flag spellings follow llama-bench's own options:
 * `-fa` takes on|off|auto, `-d` sets the context depth, `-r` the repetitions.
 */
export function buildLlamaBenchArgs(options: StrixHaloBenchmarkOptions): string[] {
  const args = ['-m', options.modelPath, '-ngl', String(options.numGpuLayers ?? 99)];
  // STRIX Halo runs were stable with memory-mapping off. llama-bench spells that as a load mode.
  if (options.noMmap !== false) {
    args.push('-lm', 'none');
  }
  if (options.flashAttention) {
    args.push('-fa', 'on');
  }
  args.push(
    '-p', String(options.nPrompt ?? 512),
    '-n', String(options.nGen ?? 128),
    '-d', String(options.depth ?? 0),
    '-r', String(options.repetitions ?? 5),
    '-o', 'json'
  );
  if (options.noWarmup) {
    args.push('--no-warmup');
  }
  return args;
}

/** One test from llama-bench's JSON array. `pp` is prompt processing, `tg` token generation. */
export interface LlamaBenchRow {
  kind: 'pp' | 'tg' | 'pp+tg';
  nPrompt: number;
  nGen: number;
  depth: number;
  /** Mean tokens per second over the repetitions (avg_ts). */
  tokensPerSecond: number;
  stddevTokensPerSecond?: number;
  /** Each repetition's tokens per second (samples_ts). */
  samplesTokensPerSecond: number[];
  backend?: string;
  modelFilename?: string;
  buildCommit?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse llama-bench's `-o json` output. Anything printed before the array (build logs,
 * warnings) is skipped; output with no array at all is an error, not an empty result.
 */
export function parseLlamaBenchJson(text: string): LlamaBenchRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1) {
      throw new Error('llama-bench printed no JSON results (expected -o json output)');
    }
    if (end <= start) {
      throw new Error('llama-bench printed output that is not valid JSON');
    }
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new Error('llama-bench printed output that is not valid JSON');
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error('llama-bench JSON is not a list of results');
  }

  const rows: LlamaBenchRow[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) {
      continue;
    }
    const tokensPerSecond = finiteNumber(item.avg_ts);
    const nPrompt = finiteNumber(item.n_prompt) ?? 0;
    const nGen = finiteNumber(item.n_gen) ?? 0;
    if (tokensPerSecond === undefined || (nPrompt === 0 && nGen === 0)) {
      continue;
    }
    rows.push({
      kind: nPrompt > 0 && nGen === 0 ? 'pp' : nPrompt === 0 && nGen > 0 ? 'tg' : 'pp+tg',
      nPrompt,
      nGen,
      depth: finiteNumber(item.n_depth) ?? 0,
      tokensPerSecond,
      stddevTokensPerSecond: finiteNumber(item.stddev_ts),
      samplesTokensPerSecond: Array.isArray(item.samples_ts)
        ? item.samples_ts.filter((value): value is number => finiteNumber(value) !== undefined)
        : [],
      backend: typeof item.backends === 'string' ? item.backends : undefined,
      modelFilename: typeof item.model_filename === 'string' ? item.model_filename : undefined,
      buildCommit: typeof item.build_commit === 'string' ? item.build_commit : undefined
    });
  }
  return rows;
}

export interface LlamaBenchSummary {
  promptTokensPerSecond?: number;
  decodeTokensPerSecond?: number;
  decodeStddevTokensPerSecond?: number;
  decodeSamples: number[];
  depth: number;
  nGen: number;
}

/** The prompt-processing test and the decode test, which is what the dashboard compares. */
export function summarizeLlamaBench(rows: LlamaBenchRow[]): LlamaBenchSummary {
  const decode = rows.find(row => row.nPrompt === 0 && row.nGen > 0) ?? rows.find(row => row.nGen > 0);
  const prompt = rows.find(row => row.kind === 'pp');
  return {
    promptTokensPerSecond: prompt?.tokensPerSecond,
    decodeTokensPerSecond: decode?.tokensPerSecond,
    decodeStddevTokensPerSecond: decode?.stddevTokensPerSecond,
    decodeSamples: decode?.samplesTokensPerSecond ?? [],
    depth: decode?.depth ?? prompt?.depth ?? 0,
    nGen: decode?.nGen ?? 0
  };
}

/**
 * Run llama-bench inside a STRIX Halo toolbox and read its JSON results. The command runs
 * without a shell: the model path and every flag reach llama-bench as separate arguments.
 */
export async function benchmarkWithToolbox(options: StrixHaloBenchmarkOptions): Promise<StrixHaloBenchmarkResult> {
  const startTime = Date.now();
  const model = path.basename(options.modelPath, '.gguf');
  const backend = options.toolboxName.includes('rocm') ? 'rocm' : 'vulkan';
  try {
    // Paths follow the AMD STRIX Halo toolbox layout: Vulkan installs under /usr/sbin, ROCm under /usr/local/bin.
    const binary = options.toolboxName.includes('vulkan') ? '/usr/sbin/llama-bench' : '/usr/local/bin/llama-bench';
    // ROCBLAS_USE_HIPBLASLT=1 selects the optimised BLAS on ROCm toolboxes; 'hblt0' toolboxes turn it off on purpose.
    const envPrefix = options.toolboxName.includes('rocm') && !options.toolboxName.includes('hblt0')
      ? ['env', 'ROCBLAS_USE_HIPBLASLT=1']
      : [];
    const argv = ['run', '-c', options.toolboxName, '--', ...envPrefix, binary, ...buildLlamaBenchArgs(options)];

    console.log(`Running benchmark in ${options.toolboxName}...`);
    const { stdout } = await execFileAsync('toolbox', argv, { maxBuffer: 10 * 1024 * 1024, timeout: 300000 });
    const durationSeconds = (Date.now() - startTime) / 1000;

    const rows = parseLlamaBenchJson(stdout);
    const summary = summarizeLlamaBench(rows);
    const decode = summary.decodeTokensPerSecond;
    return {
      model,
      toolbox: options.toolboxName,
      backend,
      tokensPerSecond: decode ?? 0,
      totalTokens: summary.nGen,
      durationSeconds,
      timestamp: new Date().toISOString(),
      success: decode !== undefined && decode > 0,
      error: decode === undefined ? 'llama-bench reported no decode rate' : undefined,
      contextSize: options.contextSize,
      depth: summary.depth,
      promptTokensPerSecond: summary.promptTokensPerSecond,
      decodeTokensPerSecond: decode,
      decodeStddevTokensPerSecond: summary.decodeStddevTokensPerSecond,
      decodeSamples: summary.decodeSamples,
      rows
    };
  } catch (error) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    return {
      model,
      toolbox: options.toolboxName,
      backend,
      tokensPerSecond: 0,
      totalTokens: 0,
      durationSeconds,
      timestamp: new Date().toISOString(),
      success: false,
      error: (error as Error).message,
      rows: []
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
