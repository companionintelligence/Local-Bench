/**
 * A shareable export of benchmark results. It is voluntary and local: the file is written
 * where you ask, and nothing is uploaded. It leaves out everything that identifies the person
 * or the machine's network: prompts, responses, hostnames, target URLs, request IDs, served-by
 * names and error text (which can carry addresses). Hardware, engine versions, model digests
 * and the run settings stay in.
 */

export const EXPORT_SCHEMA = 'local-bench-export/1';

const RUN_FIELDS = [
  'model', 'tokensPerSecond', 'totalTokens', 'durationSeconds', 'timestamp', 'success',
  'transport', 'path', 'backend', 'ttftMs', 'promptTokens', 'loadMs', 'promptEvalMs', 'evalMs',
  'decodeTokensPerSecond', 'promptTokensPerSecond', 'concurrency', 'batchId', 'driver', 'seat',
  'timingSource', 'contextDepth', 'contextWindow', 'repeatIndex', 'profile', 'cold', 'scenario',
  'requestedPromptTokens', 'requestedGenTokens', 'finishReason', 'vramBytes', 'powerWatts',
  'powerSource', 'powerNote', 'note'
] as const;

const AGGREGATE_FIELDS = [
  'batchId', 'model', 'concurrency', 'wallSeconds', 'aggregateTokensPerSecond',
  'medianTtftMs', 'medianDecodeTokensPerSecond', 'successes', 'failures'
] as const;

export interface ExportHardware {
  cpuModel?: string;
  cpuCores?: number;
  cpuThreads?: number;
  totalMemoryGB?: number;
  osType?: string;
  osVersion?: string;
  motherboard?: string;
  gpus?: Array<{ model: string; vram?: number }>;
}

function pick(source: object, fields: readonly string[]): Record<string, unknown> {
  const record = source as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (record[field] !== undefined) {
      out[field] = record[field];
    }
  }
  return out;
}

/** One run, with the engine metadata it was measured against. */
export function toExportRow(result: object): Record<string, unknown> {
  const row = pick(result, RUN_FIELDS);
  const engine = (result as { engine?: unknown }).engine;
  if (engine !== undefined) {
    row.engine = engine;
  }
  return row;
}

/** The whole export. `hardware` is taken field by field, so the host's name is never included. */
export function buildExport(input: {
  results: object[];
  aggregates?: object[];
  hardware?: ExportHardware;
  generatedAt?: Date;
}): Record<string, unknown> {
  const hardware = input.hardware
    ? pick(input.hardware, ['cpuModel', 'cpuCores', 'cpuThreads', 'totalMemoryGB', 'osType', 'osVersion', 'motherboard', 'gpus'])
    : undefined;
  return {
    schema: EXPORT_SCHEMA,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    hardware,
    runs: input.results.map(toExportRow),
    aggregates: (input.aggregates ?? []).map(aggregate => pick(aggregate, AGGREGATE_FIELDS)),
    excluded: 'prompts, responses, hostnames, target URLs, request IDs, served-by names and error text'
  };
}
