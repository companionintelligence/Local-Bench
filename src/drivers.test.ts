import {
  DRIVER_DESCRIPTORS,
  DRIVER_TYPES,
  HUB_POOL_BACKENDS,
  describeHttpDrivers,
  httpDriverTypes,
  isHubPoolBackend,
  parseDriverType,
  resolveDriverFromEnv,
  wireOf
} from './drivers';

describe('driver names', () => {
  it('accepts known names in any case and surrounding space', () => {
    expect(parseDriverType(' OLLAMA ')).toBe('ollama');
    expect(parseDriverType('llamacpp')).toBe('llamacpp');
  });

  it('rejects unknown names and lists the valid ones', () => {
    expect(() => parseDriverType('lucebox')).toThrow(/Unknown driver "lucebox"/);
    expect(() => parseDriverType('lucebox')).toThrow(/llamacpp/);
  });

  it('keeps the CLI driver out of the HTTP driver list', () => {
    expect(httpDriverTypes()).not.toContain('llama-bench');
    expect(describeHttpDrivers().map(d => d.type)).toEqual(httpDriverTypes());
    expect(wireOf('llama-bench')).toBe('cli');
    expect(wireOf('llamacpp')).toBe('openai');
    expect(wireOf('ollama')).toBe('ollama');
  });
});

describe('resolveDriverFromEnv', () => {
  it('returns undefined when nothing is set, so the caller detects the engine', () => {
    expect(resolveDriverFromEnv({})).toBeUndefined();
  });

  it('reads BENCH_DRIVER and lets it win over the legacy BENCH_TRANSPORT', () => {
    expect(resolveDriverFromEnv({ BENCH_DRIVER: 'vllm' })).toBe('vllm');
    expect(resolveDriverFromEnv({ BENCH_DRIVER: 'llamacpp', BENCH_TRANSPORT: 'ollama' })).toBe('llamacpp');
  });

  it('maps the legacy BENCH_TRANSPORT values onto drivers', () => {
    expect(resolveDriverFromEnv({ BENCH_TRANSPORT: 'openai' })).toBe('openai');
    expect(resolveDriverFromEnv({ BENCH_TRANSPORT: 'ollama' })).toBe('ollama');
  });

  it('rejects an unknown legacy transport rather than ignoring it', () => {
    expect(() => resolveDriverFromEnv({ BENCH_TRANSPORT: 'weird' })).toThrow(/Unknown BENCH_TRANSPORT/);
  });

  it('refuses the CLI driver as an endpoint', () => {
    expect(() => resolveDriverFromEnv({ BENCH_DRIVER: 'llama-bench' })).toThrow(/strix-halo/);
  });
});

describe('capabilities', () => {
  it('states a measured value or an unsupported reason for every capability', () => {
    for (const type of DRIVER_TYPES) {
      const capabilities = DRIVER_DESCRIPTORS[type].capabilities;
      for (const [name, capability] of Object.entries(capabilities)) {
        expect(capability.status === 'measured' || (capability.status === 'unsupported' && capability.reason.length > 0)).toBe(true);
        expect(name.length).toBeGreaterThan(0);
      }
    }
  });

  it('marks llama.cpp as reporting its own timings and context window', () => {
    expect(DRIVER_DESCRIPTORS.llamacpp.capabilities.engineTimings.status).toBe('measured');
    expect(DRIVER_DESCRIPTORS.llamacpp.capabilities.contextLength.status).toBe('measured');
  });

  it('marks the generic OpenAI driver as usage-only', () => {
    const timings = DRIVER_DESCRIPTORS.openai.capabilities.engineTimings;
    expect(timings.status).toBe('unsupported');
  });
});

describe('Hub pool backends', () => {
  it('lists the five engines the Hub routes to, and no removed ones', () => {
    expect([...HUB_POOL_BACKENDS]).toEqual(['ollama', 'vllm', 'lemonade', 'omlx', 'localai']);
    expect(isHubPoolBackend('omlx')).toBe(true);
    expect(isHubPoolBackend('lucebox')).toBe(false);
    expect(isHubPoolBackend(undefined)).toBe(false);
  });
});
