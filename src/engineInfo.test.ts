import {
  mergeEngineInfo,
  parseLlamaCppProps,
  parseOllamaPs,
  parseOllamaTags,
  parseOllamaVersion,
  parseOpenAiModels,
  parseVllmVersion
} from './engineInfo';

describe('engine metadata', () => {
  const tags = {
    models: [{
      name: 'gemma3:1b',
      digest: '8648f39daa8f',
      details: { format: 'gguf', family: 'gemma3', parameter_size: '999.89M', quantization_level: 'Q4_K_M' }
    }]
  };

  it('reads the digest, family, format, size and quantization of the model', () => {
    expect(parseOllamaTags(tags, 'gemma3:1b')).toEqual({
      modelDigest: '8648f39daa8f', modelFamily: 'gemma3', modelFormat: 'gguf', parameterSize: '999.89M', quantization: 'Q4_K_M'
    });
  });

  it('matches a bare name to its :latest tag, and reports nothing for an unknown model', () => {
    expect(parseOllamaTags({ models: [{ name: 'llama3:latest', digest: 'abc' }] }, 'llama3').modelDigest).toBe('abc');
    expect(parseOllamaTags(tags, 'other')).toEqual({});
  });

  it('reads the Ollama version, and the loaded model bytes, GPU bytes and context', () => {
    expect(parseOllamaVersion({ version: '0.33.3' })).toBe('0.33.3');
    expect(parseOllamaPs({ models: [{ name: 'gemma3:1b', size: 1000, size_vram: 900, context_length: 4096 }] }, 'gemma3:1b'))
      .toEqual({ modelBytes: 1000, vramBytes: 900, contextWindow: 4096 });
  });

  it('reads the llama.cpp build, context window and slots from /props', () => {
    expect(parseLlamaCppProps({ build_info: 'b1b770d90', total_slots: 4, default_generation_settings: { n_ctx: 4096 } }))
      .toEqual({ engineVersion: 'b1b770d90', contextWindow: 4096, slots: 4 });
  });

  it('reads the model size from llama.cpp /v1/models meta, and vLLM version when served', () => {
    expect(parseOpenAiModels({ data: [{ id: 'm.gguf', meta: { size: 815000000 } }] })).toEqual({ modelBytes: 815000000 });
    expect(parseVllmVersion({ version: '0.11.0' })).toBe('0.11.0');
  });

  it('keeps the first value an endpoint reported for each field', () => {
    expect(mergeEngineInfo({ engineVersion: 'a' }, { engineVersion: 'b', slots: 2 })).toEqual({ engineVersion: 'a', slots: 2 });
  });
});
