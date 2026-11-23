/**
 * The conformance matrix: which engine drivers are checked on which dimension, and where.
 * Each covered cell names a real test; a conformance test fails if that test is renamed or
 * removed. Each skipped cell states why. `live` records whether the driver has been run
 * against a real engine on this host, which the stub tests cannot show.
 */
import type { DriverType } from './drivers';

/** The dimensions every driver is checked on. */
export const DIMENSIONS = [
  'streaming',
  'engine-timings',
  'usage-tokens',
  'context-window',
  'pool-headers',
  'auth',
  'error-surfacing',
  'depth-prompt',
  'stream-fallback',
  'model-listing'
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export type Cell =
  | { status: 'covered'; file: string; test: string; via?: string }
  | { status: 'skipped'; reason: string };

export interface LiveStatus {
  status: 'verified' | 'not-run';
  note: string;
}

const CONTRACT = 'contract.test.ts';
const SERVER = 'server.test.ts';
const OPENAI_WIRE = 'shared OpenAI-compatible wire';

const ollamaWire: Record<Dimension, Cell> = {
  streaming: { status: 'covered', file: CONTRACT, test: 'reads TTFT, Ollama eval timings and the cold load from a real captured stream' },
  'engine-timings': { status: 'covered', file: CONTRACT, test: 'reads TTFT, Ollama eval timings and the cold load from a real captured stream' },
  'usage-tokens': { status: 'covered', file: CONTRACT, test: 'reads TTFT, Ollama eval timings and the cold load from a real captured stream', via: 'eval_count' },
  'context-window': { status: 'skipped', reason: 'Ollama does not report the window per response; the server default applies' },
  'pool-headers': { status: 'covered', file: CONTRACT, test: 'records the Hub pool headers on every row' },
  auth: { status: 'covered', file: CONTRACT, test: 'sends the Bearer token the engine requires, and fails without it' },
  'error-surfacing': { status: 'covered', file: CONTRACT, test: 'surfaces an error line in the stream as a failed row' },
  'depth-prompt': { status: 'covered', file: CONTRACT, test: 'sends the prefilled depth to the engine, with the question last' },
  'stream-fallback': { status: 'skipped', reason: 'the Ollama wire has no plain-request fallback; the non-streamed reply is tested instead' },
  'model-listing': { status: 'covered', file: SERVER, test: 'should merge installed models with the supported catalog' }
};

/** The OpenAI-compatible wire, shared by the generic driver and the named profiles. */
function openaiWire(): Record<Dimension, Cell> {
  return {
    streaming: { status: 'covered', file: CONTRACT, test: 'counts tokens from the usage the engine returns' },
    'engine-timings': { status: 'skipped', reason: 'this wire carries usage counts only; the engine reports no timings' },
    'usage-tokens': { status: 'covered', file: CONTRACT, test: 'counts tokens from the usage the engine returns' },
    'context-window': { status: 'skipped', reason: 'the generic wire does not read the context window' },
    'pool-headers': { status: 'covered', file: CONTRACT, test: 'records the Hub pool headers and marks the row as routed through the pool' },
    auth: { status: 'covered', file: CONTRACT, test: 'sends the bearer token and fails loudly without it' },
    'error-surfacing': { status: 'covered', file: CONTRACT, test: 'surfaces an error chunk in the stream as a failed row' },
    'depth-prompt': { status: 'covered', file: CONTRACT, test: 'sends the prefilled depth through the OpenAI wire, with the question last' },
    'stream-fallback': { status: 'covered', file: CONTRACT, test: 'falls back to a plain request when the engine rejects streaming options' },
    'model-listing': { status: 'covered', file: SERVER, test: 'lists models from /v1/models when /api/tags is not served' }
  };
}

function viaSharedWire(cells: Record<Dimension, Cell>): Record<Dimension, Cell> {
  const out = {} as Record<Dimension, Cell>;
  for (const dimension of DIMENSIONS) {
    const cell = cells[dimension];
    out[dimension] = cell.status === 'covered' ? { ...cell, via: cell.via ?? OPENAI_WIRE } : cell;
  }
  return out;
}

const llamaCppExtras: Partial<Record<Dimension, Cell>> = {
  streaming: { status: 'covered', file: CONTRACT, test: 'detects llama-server, reads its timings and context window into the row' },
  'engine-timings': { status: 'covered', file: CONTRACT, test: 'detects llama-server, reads its timings and context window into the row' },
  'context-window': { status: 'covered', file: CONTRACT, test: 'detects llama-server, reads its timings and context window into the row' }
};

export const CONFORMANCE: Record<DriverType, { cells: Record<Dimension, Cell>; live: LiveStatus }> = {
  ollama: {
    cells: ollamaWire,
    live: { status: 'verified', note: 'run live on this host against gemma3:1b: smoke, burst with depths and repeats, constant and Poisson loads, a sweep, and the run route; the stream fixture is a capture from the same engine' }
  },
  openai: {
    cells: openaiWire(),
    live: { status: 'not-run', note: 'no OpenAI-compatible engine is running on this host' }
  },
  llamacpp: {
    cells: { ...viaSharedWire(openaiWire()), ...llamaCppExtras } as Record<Dimension, Cell>,
    live: { status: 'not-run', note: 'llama-server is not installed on this host' }
  },
  vllm: {
    cells: viaSharedWire(openaiWire()),
    live: { status: 'not-run', note: 'vLLM needs an NVIDIA host; none is attached here' }
  },
  lemonade: {
    cells: viaSharedWire(openaiWire()),
    live: { status: 'not-run', note: 'Lemonade needs an AMD or NPU host; none is attached here' }
  },
  omlx: {
    cells: viaSharedWire(openaiWire()),
    live: { status: 'not-run', note: 'oMLX needs an Apple Silicon host with the server running' }
  },
  localai: {
    cells: viaSharedWire(openaiWire()),
    live: { status: 'not-run', note: 'no LocalAI server is running on this host' }
  },
  'llama-bench': {
    cells: {
      streaming: { status: 'skipped', reason: 'a CLI run, not a streamed request' },
      'engine-timings': { status: 'covered', file: 'strixHaloBench.test.ts', test: 'reads the prompt and decode tests, with their repetitions' },
      'usage-tokens': { status: 'skipped', reason: 'llama-bench reports rates, not token counts per request' },
      'context-window': { status: 'skipped', reason: 'depth is set with -d and not read back' },
      'pool-headers': { status: 'skipped', reason: 'there is no HTTP exchange' },
      auth: { status: 'skipped', reason: 'there is no endpoint to authenticate to' },
      'error-surfacing': { status: 'covered', file: 'strixHaloBench.test.ts', test: 'reports a failed run with the error rather than a zero that looks like a result' },
      'depth-prompt': { status: 'covered', file: 'strixHaloBench.test.ts', test: 'uses on|off|auto for flash attention and sets the depth and repetitions' },
      'stream-fallback': { status: 'skipped', reason: 'llama-bench has no streamed or plain mode' },
      'model-listing': { status: 'skipped', reason: 'takes a GGUF path, not a server' }
    },
    live: { status: 'not-run', note: 'llama-bench is not installed here; its output parser is tested against the documented JSON schema' }
  }
};
