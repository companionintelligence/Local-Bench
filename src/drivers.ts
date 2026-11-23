/**
 * The engine drivers Local-Bench can measure, and what each one can and cannot report.
 *
 * A driver is a name plus a capability record. Every capability is either "measured"
 * (the driver reads it) or "unsupported" with a reason. Absence is never used to mean
 * unsupported, so a blank cell in a result or the dashboard always has a stated cause.
 */

export const DRIVER_TYPES = [
  'ollama',
  'openai',
  'llamacpp',
  'vllm',
  'lemonade',
  'omlx',
  'localai',
  'llama-bench'
] as const;

export type DriverType = (typeof DRIVER_TYPES)[number];

/**
 * The engines a CI-Hub pool routes to. The pool proxy stamps one of these names into
 * X-Hub-Pool-Backend. Names outside this list are kept as received and flagged, never mapped.
 */
export const HUB_POOL_BACKENDS = ['ollama', 'vllm', 'lemonade', 'omlx', 'localai'] as const;
export type HubPoolBackend = (typeof HUB_POOL_BACKENDS)[number];

export function isHubPoolBackend(value: string | undefined): value is HubPoolBackend {
  return value !== undefined && (HUB_POOL_BACKENDS as readonly string[]).includes(value);
}

/** The wire protocol a driver speaks. 'cli' runs a local binary and has no endpoint. */
export type Wire = 'ollama' | 'openai' | 'cli';

/**
 * Where the measurement was taken. 'app' is the seat of an application calling an
 * endpoint (HTTP, through the pool when there is one). 'engine-native' is the engine's own
 * benchmark tool. The two are never averaged together.
 */
export type Seat = 'app' | 'engine-native';

/** Whose clock produced a row's speed numbers. */
export type TimingSource = 'ollama' | 'llamacpp' | 'llama-bench' | 'client';

export type CapabilityName =
  | 'streaming'
  | 'engineTimings'
  | 'listModels'
  | 'contextLength'
  | 'residency'
  | 'poolHeaders';

export type Capability = { status: 'measured' } | { status: 'unsupported'; reason: string };

export interface DriverDescriptor {
  type: DriverType;
  label: string;
  wire: Wire;
  seat: Seat;
  /** Where the engine listens by default. Undefined when the operator must set the URL. */
  defaultBaseUrl?: string;
  capabilities: Record<CapabilityName, Capability>;
}

const MEASURED: Capability = { status: 'measured' };

function unsupported(reason: string): Capability {
  return { status: 'unsupported', reason };
}

const USAGE_ONLY = 'this driver reads only the usage counts the engine returns';
const NO_CONTEXT = 'this driver does not read the context window';
const NO_RESIDENCY = 'loaded models are not queried; cold runs are detected from the first request and from load time';

function httpCapabilities(overrides: Partial<Record<CapabilityName, Capability>>): Record<CapabilityName, Capability> {
  return {
    streaming: MEASURED,
    engineTimings: unsupported(USAGE_ONLY),
    listModels: MEASURED,
    contextLength: unsupported(NO_CONTEXT),
    residency: unsupported(NO_RESIDENCY),
    poolHeaders: MEASURED,
    ...overrides
  };
}

export const DRIVER_DESCRIPTORS: Readonly<Record<DriverType, DriverDescriptor>> = {
  ollama: {
    type: 'ollama',
    label: 'Ollama (native API)',
    wire: 'ollama',
    seat: 'app',
    defaultBaseUrl: 'http://localhost:11434',
    capabilities: httpCapabilities({
      engineTimings: MEASURED,
      contextLength: unsupported('Ollama does not report the window per response; the server default applies')
    })
  },
  openai: {
    type: 'openai',
    label: 'OpenAI-compatible (generic)',
    wire: 'openai',
    seat: 'app',
    capabilities: httpCapabilities({})
  },
  llamacpp: {
    type: 'llamacpp',
    label: 'llama.cpp server',
    wire: 'openai',
    seat: 'app',
    defaultBaseUrl: 'http://localhost:8080',
    capabilities: httpCapabilities({
      engineTimings: MEASURED,
      contextLength: MEASURED,
      residency: unsupported('this driver does not query or change the loaded model')
    })
  },
  vllm: {
    type: 'vllm',
    label: 'vLLM (OpenAI-compatible)',
    wire: 'openai',
    seat: 'app',
    defaultBaseUrl: 'http://localhost:8000',
    capabilities: httpCapabilities({})
  },
  lemonade: {
    type: 'lemonade',
    label: 'Lemonade (OpenAI-compatible)',
    wire: 'openai',
    seat: 'app',
    defaultBaseUrl: 'http://localhost:13305',
    capabilities: httpCapabilities({})
  },
  omlx: {
    type: 'omlx',
    label: 'oMLX (OpenAI-compatible)',
    wire: 'openai',
    seat: 'app',
    capabilities: httpCapabilities({})
  },
  localai: {
    type: 'localai',
    label: 'LocalAI (OpenAI-compatible)',
    wire: 'openai',
    seat: 'app',
    capabilities: httpCapabilities({})
  },
  'llama-bench': {
    type: 'llama-bench',
    label: 'llama-bench (engine-native CLI)',
    wire: 'cli',
    seat: 'engine-native',
    capabilities: {
      streaming: unsupported('a CLI run, not a streamed request'),
      engineTimings: MEASURED,
      listModels: unsupported('takes a GGUF path, not a server'),
      contextLength: unsupported('depth is set with -d and not read back'),
      residency: unsupported('the model is loaded again for each test'),
      poolHeaders: unsupported('there is no HTTP exchange')
    }
  }
};

export class UnknownDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownDriverError';
  }
}

export function isDriverType(value: string): value is DriverType {
  return (DRIVER_TYPES as readonly string[]).includes(value);
}

/** Validates a driver name from the environment or a request. Throws, listing the valid names. */
export function parseDriverType(value: string): DriverType {
  const name = value.trim().toLowerCase();
  if (!isDriverType(name)) {
    throw new UnknownDriverError(`Unknown driver "${value}". Known drivers: ${DRIVER_TYPES.join(', ')}.`);
  }
  return name;
}

export function wireOf(driver: DriverType): Wire {
  return DRIVER_DESCRIPTORS[driver].wire;
}

/** The drivers a base URL can point at. llama-bench runs a local binary, so it is excluded. */
export function httpDriverTypes(): DriverType[] {
  return DRIVER_TYPES.filter(type => wireOf(type) !== 'cli');
}

/**
 * The driver named by BENCH_DRIVER, or by the legacy BENCH_TRANSPORT (ollama or openai).
 * Returns undefined when neither is set, which means the caller should detect it.
 */
export function resolveDriverFromEnv(env: NodeJS.ProcessEnv = process.env): DriverType | undefined {
  const explicit = (env.BENCH_DRIVER || '').trim();
  if (explicit) {
    const driver = parseDriverType(explicit);
    if (wireOf(driver) === 'cli') {
      throw new UnknownDriverError(`${driver} is a local benchmark run, not an endpoint. Run it with npm run strix-halo.`);
    }
    return driver;
  }
  const legacy = (env.BENCH_TRANSPORT || '').trim().toLowerCase();
  if (legacy === 'ollama' || legacy === 'openai') {
    return legacy;
  }
  if (legacy) {
    throw new UnknownDriverError(`Unknown BENCH_TRANSPORT "${env.BENCH_TRANSPORT}". Use ollama or openai, or set BENCH_DRIVER.`);
  }
  return undefined;
}

/** The public description of every HTTP driver, for the dashboard and the API. */
export function describeHttpDrivers(): DriverDescriptor[] {
  return httpDriverTypes().map(type => DRIVER_DESCRIPTORS[type]);
}
