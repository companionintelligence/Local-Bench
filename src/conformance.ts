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
  'model-listing',
  'generation-cap',
  'engine-metadata',
  'loaded-memory'
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
const WORKLOAD = 'workloadContract.test.ts';
const ENGINE_INFO = 'engineInfo.test.ts';

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
  'model-listing': { status: 'covered', file: SERVER, test: 'should merge installed models with the supported catalog' },
  'generation-cap': { status: 'covered', file: WORKLOAD, test: 'stops at the generation cap and reports done_reason length' },
  'engine-metadata': { status: 'covered', file: WORKLOAD, test: 'reads the engine version, model digest and quantization from its own endpoints' },
  'loaded-memory': { status: 'covered', file: WORKLOAD, test: 'reads GPU memory and runtime context from /api/ps after the run' }
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
    'model-listing': { status: 'covered', file: SERVER, test: 'lists models from /v1/models when /api/tags is not served' },
    'generation-cap': { status: 'covered', file: WORKLOAD, test: 'caps generation with max_tokens and reports finish_reason' },
    'engine-metadata': { status: 'skipped', reason: 'the generic wire has no endpoint that names the engine version or model digest' },
    'loaded-memory': { status: 'skipped', reason: 'the generic wire does not query the loaded model' }
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
  'context-window': { status: 'covered', file: CONTRACT, test: 'detects llama-server, reads its timings and context window into the row' },
  'generation-cap': { status: 'covered', file: WORKLOAD, test: 'sends ignore_eos to llama-server so a capped run reaches the cap' },
  'engine-metadata': { status: 'covered', file: WORKLOAD, test: 'reads llama-server build, context window and slot count from /props' },
  'loaded-memory': { status: 'skipped', reason: 'llama-server is not asked which model is loaded, so no GPU memory is read' }
};

export const CONFORMANCE: Record<DriverType, { cells: Record<Dimension, Cell>; live: LiveStatus }> = {
  ollama: {
    cells: ollamaWire,
    live: { status: 'verified', note: 'run live on this host against gemma3:1b: smoke, burst with depths and repeats, constant and Poisson loads, a sweep, and the run route; the stream fixture is a capture from the same engine. Also run live: a fixed workload (pp1024+tg16, finish length at 16 of 16 tokens), a scaling curve at 1, 2, 4 and 8, the JSON export, and a dashboard run with a workload and a note; the loaded model\'s GPU bytes and context came from /api/ps' }
  },
  openai: {
    cells: openaiWire(),
    live: { status: 'not-run', note: 'no OpenAI-compatible engine is running on this host' }
  },
  llamacpp: {
    cells: { ...viaSharedWire(openaiWire()), ...llamaCppExtras } as Record<Dimension, Cell>,
    live: { status: 'verified', note: 'run live on this host: llama-server (build b12359) on port 8080 with four slots and the gemma3:1b GGUF. Detection, smoke, a depth run, and a streamed completion captured as the fixture. Also run live: ignore_eos on the chat route (without it the reply stopped at 12 tokens; with it, at the 64-token cap), a fixed workload, and a scaling curve at 1 and 4 slots' }
  },
  vllm: {
    cells: { ...viaSharedWire(openaiWire()), 'engine-metadata': { status: 'covered', file: ENGINE_INFO, test: 'reads the model size from llama.cpp /v1/models meta, and vLLM version when served' } },
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
      'model-listing': { status: 'skipped', reason: 'takes a GGUF path, not a server' },
      'generation-cap': { status: 'skipped', reason: 'llama-bench generates the tokens it is given with -n and reports no finish reason' },
      'engine-metadata': { status: 'skipped', reason: 'the CLI run does not read the build from its output' },
      'loaded-memory': { status: 'skipped', reason: 'the model is loaded again for each test' }
    },
    live: { status: 'verified', note: 'run live on this host with llama-bench 1.0.0: the tool\'s arguments were accepted and their effect is reported in the output. The toolbox invocation itself was not run' }
  }
};
