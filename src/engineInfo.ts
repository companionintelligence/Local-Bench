/**
 * What an engine reports about itself and the loaded model, read from its own endpoints.
 * Every field is optional: an engine that does not report one leaves it out, rather than a
 * placeholder that could be mistaken for a value. The parsers are pure, so they can be tested
 * against recorded responses.
 */

export interface EngineInfo {
  /** Engine version: Ollama's /api/version, llama.cpp's build_info, vLLM's /version. */
  engineVersion?: string;
  /** Ollama's digest for the model, as the server reports it. */
  modelDigest?: string;
  modelFamily?: string;
  modelFormat?: string;
  /** Parameter count as the engine states it, e.g. "999.89M". */
  parameterSize?: string;
  /** Quantization as the engine states it, e.g. "Q4_K_M". */
  quantization?: string;
  /** Runtime context window in tokens (Ollama's /api/ps context_length, llama.cpp's /props n_ctx). */
  contextWindow?: number;
  /** Parallel slots llama.cpp was started with (/props total_slots). */
  slots?: number;
  /** Bytes of the model held in GPU memory (Ollama's /api/ps size_vram). */
  vramBytes?: number;
  /** Bytes the model occupies (Ollama's /api/ps size, or llama.cpp's /v1/models meta.size). */
  modelBytes?: number;
}

type Json = Record<string, any>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The entry for `model` in a list, also matching the bare name against its :latest tag. */
function findEntry(list: unknown, model: string): Json | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  const wanted = [model, `${model}:latest`];
  return list.find(item => isRecord(item) && wanted.includes(String(item.name ?? item.model ?? '')));
}

/** Ollama's /api/tags: digest, family, format, parameter count and quantization for the model. */
export function parseOllamaTags(data: unknown, model: string): EngineInfo {
  const entry = findEntry(isRecord(data) ? data.models : undefined, model);
  if (!entry) {
    return {};
  }
  const details: Json = isRecord(entry.details) ? entry.details : {};
  return {
    modelDigest: text(entry.digest),
    modelFamily: text(details.family),
    modelFormat: text(details.format),
    parameterSize: text(details.parameter_size),
    quantization: text(details.quantization_level)
  };
}

/** Ollama's /api/version, e.g. "0.33.3". */
export function parseOllamaVersion(data: unknown): string | undefined {
  return isRecord(data) ? text(data.version) : undefined;
}

/** Ollama's /api/ps for a loaded model: the GPU bytes it holds and the context it runs with. */
export function parseOllamaPs(data: unknown, model: string): EngineInfo {
  const entry = findEntry(isRecord(data) ? data.models : undefined, model);
  if (!entry) {
    return {};
  }
  return {
    vramBytes: finite(entry.size_vram),
    modelBytes: finite(entry.size),
    contextWindow: finite(entry.context_length)
  };
}

/** llama-server's /props: build, runtime context window and slot count. */
export function parseLlamaCppProps(data: unknown): EngineInfo {
  if (!isRecord(data)) {
    return {};
  }
  const settings: Json = isRecord(data.default_generation_settings) ? data.default_generation_settings : {};
  return {
    engineVersion: text(data.build_info),
    contextWindow: finite(settings.n_ctx),
    slots: finite(data.total_slots)
  };
}

/** llama-server's /v1/models: the model's size, from its first entry's meta block. */
export function parseOpenAiModels(data: unknown): EngineInfo {
  const first = isRecord(data) && Array.isArray(data.data) ? data.data[0] : undefined;
  const meta: Json = isRecord(first) && isRecord(first.meta) ? first.meta : {};
  return { modelBytes: finite(meta.size) };
}

/** vLLM's /version, if it serves one. Not verified on a running vLLM here. */
export function parseVllmVersion(data: unknown): string | undefined {
  return isRecord(data) ? text(data.version) : undefined;
}

/** Merges what several endpoints reported. The first endpoint to answer for a field keeps it. */
export function mergeEngineInfo(...infos: EngineInfo[]): EngineInfo {
  const merged: EngineInfo = {};
  for (const info of infos) {
    for (const [key, value] of Object.entries(info)) {
      if (value !== undefined && merged[key as keyof EngineInfo] === undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}
