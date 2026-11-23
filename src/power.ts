/**
 * Power draw during a run, from whichever source the host has. Sampling is best effort: when
 * no source is available the run still completes, and the reading says why.
 *
 *  - nvidia-smi: NVIDIA GPUs. It needs no privileges.
 *  - powermetrics: Apple Silicon. It needs root. The request is made non-interactively
 *    (sudo -n), so a run never stops to ask for a password.
 */
import { execFile, spawn } from 'child_process';
import { mean } from './stats';

export type PowerSource = 'nvidia-smi' | 'powermetrics';

export interface PowerReading {
  watts?: number;
  source?: PowerSource;
  /** Why there is no reading, when there is none. */
  note?: string;
}

export interface PowerSession {
  stop(): Promise<PowerReading>;
}

export interface PowerDeps {
  platform?: NodeJS.Platform;
  intervalMs?: number;
  /** Runs a command to completion and resolves with its stdout. */
  run?: (command: string, args: string[]) => Promise<string>;
  /** Starts a long-running command and reports its output as it arrives. */
  stream?: (command: string, args: string[], onData: (chunk: string) => void) => { kill(): void };
}

/** Sum of the per-GPU draws nvidia-smi prints for one sample (csv, no header, no units). */
export function parseNvidiaSmiPower(stdout: string): number | undefined {
  const values = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(Number)
    .filter(value => Number.isFinite(value) && value >= 0);
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
}

const POWERMETRICS_PATTERN = /Combined Power \(CPU \+ GPU \+ ANE\):\s*([\d.]+)\s*mW/gi;

/**
 * Takes the complete powermetrics samples out of the buffer, in watts, and returns whatever
 * text is left after the last one, so a sample split across chunks is read once it completes.
 */
export function drainPowermetrics(buffer: string, readings: number[]): string {
  let consumed = 0;
  for (const match of buffer.matchAll(POWERMETRICS_PATTERN)) {
    readings.push(Number(match[1]) / 1000);
    consumed = (match.index ?? 0) + match[0].length;
  }
  return buffer.slice(consumed);
}

const runCommand = (command: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000, maxBuffer: 1 << 20 }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(String(stdout));
      }
    });
  });

const streamCommand = (command: string, args: string[], onData: (chunk: string) => void): { kill(): void } => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout?.on('data', chunk => onData(String(chunk)));
  return { kill: () => child.kill() };
};

function unavailable(note: string): PowerSession {
  return { stop: async () => ({ note }) };
}

function sampleNvidia(run: NonNullable<PowerDeps['run']>, intervalMs: number): PowerSession {
  const readings: number[] = [];
  let inFlight: Promise<void> = Promise.resolve();
  const tick = (): void => {
    inFlight = run('nvidia-smi', ['--query-gpu=power.draw', '--format=csv,noheader,nounits']).then(
      out => {
        const watts = parseNvidiaSmiPower(out);
        if (watts !== undefined) {
          readings.push(watts);
        }
      },
      () => undefined
    );
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return {
    async stop(): Promise<PowerReading> {
      clearInterval(timer);
      await inFlight;
      if (readings.length === 0) {
        return { source: 'nvidia-smi', note: 'nvidia-smi reported no power draw during the run' };
      }
      return { watts: mean(readings), source: 'nvidia-smi' };
    }
  };
}

async function samplePowermetrics(deps: PowerDeps, intervalMs: number): Promise<PowerSession> {
  const run = deps.run ?? runCommand;
  const stream = deps.stream ?? streamCommand;
  const allowed = await run('sudo', ['-n', 'true']).then(() => true, () => false);
  if (!allowed) {
    return unavailable('powermetrics needs root, and sudo would ask for a password; allow `sudo -n powermetrics` for this user to record power');
  }
  const readings: number[] = [];
  let buffer = '';
  const child = stream('sudo', ['-n', 'powermetrics', '--samplers', 'cpu_power', '-i', String(intervalMs)], chunk => {
    buffer = drainPowermetrics(buffer + chunk, readings);
  });
  return {
    async stop(): Promise<PowerReading> {
      child.kill();
      if (readings.length === 0) {
        return { source: 'powermetrics', note: 'powermetrics produced no samples during the run' };
      }
      return { watts: mean(readings), source: 'powermetrics' };
    }
  };
}

/** Starts sampling power for one run or batch. Resolves once the source is chosen. */
export async function startPowerSampling(deps: PowerDeps = {}): Promise<PowerSession> {
  const platform = deps.platform ?? process.platform;
  const intervalMs = deps.intervalMs ?? 500;
  const run = deps.run ?? runCommand;
  const nvidiaPresent = await run('nvidia-smi', ['--version']).then(() => true, () => false);
  if (nvidiaPresent) {
    return sampleNvidia(run, intervalMs);
  }
  if (platform === 'darwin') {
    return samplePowermetrics(deps, intervalMs);
  }
  return unavailable('no power source on this host: needs nvidia-smi, or powermetrics on macOS');
}
