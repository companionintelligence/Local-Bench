/**
 * An in-process stand-in for an inference engine, for contract tests. It serves the route
 * shapes Local-Bench reads (Ollama's /api/generate, /api/tags, /api/version and /api/ps, the
 * OpenAI-compatible /v1/chat/completions and /v1/models, and llama.cpp's /props) over real HTTP.
 * Test-only: jest does not match this path, and nothing in the product imports it.
 */
import * as fs from 'fs';
import * as http from 'http';

/** What the stub's Ollama /api/version reports. */
export const STUB_OLLAMA_VERSION = '0.33.3';
/** The digest the stub's Ollama /api/tags reports for gemma3:1b. */
export const STUB_OLLAMA_DIGEST = 'sha256:8648f39daa8f5c0e1b2d3f4a5b6c7d8e9f00112233445566778899aabbccdd';
/** What the stub's Ollama /api/ps reports for the loaded model: GPU bytes and runtime context. */
export const STUB_OLLAMA_VRAM_BYTES = 1400000000;
export const STUB_OLLAMA_CONTEXT = 4096;
/** What the stub's llama.cpp /props reports as its build and slot count. */
export const STUB_LLAMACPP_BUILD = 'b8751-stub';
export const STUB_LLAMACPP_SLOTS = 4;

export interface StubOptions {
  engine: 'ollama' | 'openai' | 'llamacpp';
  /** Bearer token every request must present. Anything else gets 401. */
  requireToken?: string;
  /** Headers added to completion responses, e.g. the X-Hub-Pool-* set. */
  headers?: Record<string, string>;
  /** Refuse requests that carry stream_options, as a strict engine does (400). */
  rejectStreamOptions?: boolean;
  /** Send this error instead of a completion. */
  streamError?: string;
  /** Leave the usage object out, as engines that ignore stream_options do. */
  omitUsage?: boolean;
  /** Add a llama.cpp `timings` block to the completion. */
  timings?: boolean;
  /** Replay this captured Ollama NDJSON stream instead of generating one. */
  ollamaFixture?: string;
  /** Replay this captured OpenAI-style SSE stream instead of generating one. */
  chatFixture?: string;
  /** Ollama: the load_duration to report, in nanoseconds (a cold start). */
  loadDurationNs?: number;
  /** The text the engine answers with. */
  reply?: string;
  /**
   * Generate this many tokens per answer instead of the reply's words. A cap in the request
   * (Ollama's num_predict, or the OpenAI-style max_tokens) cuts the answer short and gives
   * finish reason 'length'; an answer that ends by itself gives 'stop'.
   */
  generateTokens?: number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface StubEngine {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const LLAMACPP_TIMINGS = { prompt_n: 9, prompt_per_second: 310.2, predicted_n: 4, predicted_per_second: 52.5 };

function lastUserText(body: any): string {
  const messages: Array<{ role: string; content: string }> = Array.isArray(body?.messages) ? body.messages : [];
  const user = messages.filter(message => message.role === 'user').pop();
  return typeof user?.content === 'string' ? user.content : '';
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** A numeric cap from a request body, or undefined when the request sets none. */
function capOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function startStubEngine(options: StubOptions): Promise<StubEngine> {
  const requests: RecordedRequest[] = [];
  const reply = options.reply ?? 'Hello there friend';
  const words = reply.split(' ');

  const send = (res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...options.headers, ...extra });
    res.end(JSON.stringify(body));
  };

  /** The tokens one answer carries, and why it ended: 'length' when the cap cut it short. */
  const answer = (cap: number | undefined): { tokens: string[]; finish: 'stop' | 'length' } => {
    const full = options.generateTokens !== undefined
      ? Array.from({ length: options.generateTokens }, (_, i) => `tok${i}`)
      : words;
    if (cap === undefined || cap >= full.length) {
      return { tokens: full, finish: 'stop' };
    }
    return { tokens: full.slice(0, Math.max(0, cap)), finish: 'length' };
  };

  const ollamaStats = (tokens: number, body: any) => ({
    eval_count: tokens,
    eval_duration: 50_000_000,
    prompt_eval_count: countWords(String(body?.prompt ?? '')),
    prompt_eval_duration: 20_000_000,
    load_duration: options.loadDurationNs ?? 0
  });

  const ollamaGenerate = (res: http.ServerResponse, body: any): void => {
    const { tokens, finish } = answer(capOf(body?.options?.num_predict));
    if (body?.stream === false) {
      if (options.streamError) {
        send(res, 200, { error: options.streamError });
        return;
      }
      send(res, 200, { response: tokens.join(' '), done: true, done_reason: finish, ...ollamaStats(tokens.length, body) });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', ...options.headers });
    if (options.streamError) {
      res.end(JSON.stringify({ error: options.streamError }) + '\n');
      return;
    }
    if (options.ollamaFixture) {
      res.end(fs.readFileSync(options.ollamaFixture, 'utf8'));
      return;
    }
    for (const token of tokens) {
      res.write(JSON.stringify({ model: body?.model, response: `${token} `, done: false }) + '\n');
    }
    res.end(JSON.stringify({ model: body?.model, response: '', done: true, done_reason: finish, ...ollamaStats(tokens.length, body) }) + '\n');
  };

  const chat = (res: http.ServerResponse, body: any): void => {
    if (options.rejectStreamOptions && body?.stream_options) {
      send(res, 400, { error: 'stream_options is not supported by this engine' });
      return;
    }
    const promptTokens = countWords(lastUserText(body));
    const timings = options.timings ? LLAMACPP_TIMINGS : undefined;
    const { tokens, finish } = answer(capOf(body?.max_tokens));
    if (!body?.stream) {
      send(res, 200, {
        choices: [{ message: { content: tokens.join(' ') }, finish_reason: finish }],
        usage: options.omitUsage ? undefined : { completion_tokens: tokens.length, prompt_tokens: promptTokens },
        ...(timings ? { timings } : {})
      });
      return;
    }
    if (options.chatFixture) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', ...options.headers });
      res.end(fs.readFileSync(options.chatFixture, 'utf8'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', ...options.headers });
    if (options.streamError) {
      res.write(`data: ${JSON.stringify({ error: { message: options.streamError } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    for (const token of tokens) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${token} ` } }] })}\n\n`);
    }
    const final: Record<string, unknown> = { choices: [{ delta: {}, finish_reason: finish }] };
    if (body?.stream_options?.include_usage && !options.omitUsage) {
      final.usage = { completion_tokens: tokens.length, prompt_tokens: promptTokens };
    }
    if (timings) {
      final.timings = timings;
    }
    res.write(`data: ${JSON.stringify(final)}\n\n`);
    res.end('data: [DONE]\n\n');
  };

  const route = (req: http.IncomingMessage, res: http.ServerResponse, body: any): void => {
    const path = (req.url ?? '/').split('?')[0];
    if (options.requireToken !== undefined && req.headers.authorization !== `Bearer ${options.requireToken}`) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    if (req.method === 'GET' && path === '/api/tags') {
      if (options.engine === 'ollama') {
        send(res, 200, {
          models: [{
            name: 'gemma3:1b',
            model: 'gemma3:1b',
            digest: STUB_OLLAMA_DIGEST,
            details: { format: 'gguf', family: 'gemma3', parameter_size: '999.89M', quantization_level: 'Q4_K_M' }
          }]
        });
      } else {
        send(res, 404, { error: 'not found' });
      }
      return;
    }
    if (req.method === 'GET' && path === '/api/version') {
      if (options.engine === 'ollama') {
        send(res, 200, { version: STUB_OLLAMA_VERSION });
      } else {
        send(res, 404, { error: 'not found' });
      }
      return;
    }
    if (req.method === 'GET' && path === '/api/ps') {
      if (options.engine === 'ollama') {
        send(res, 200, {
          models: [{ name: 'gemma3:1b', model: 'gemma3:1b', size: 1500000000, size_vram: STUB_OLLAMA_VRAM_BYTES, context_length: STUB_OLLAMA_CONTEXT }]
        });
      } else {
        send(res, 404, { error: 'not found' });
      }
      return;
    }
    if (req.method === 'GET' && path === '/props') {
      if (options.engine === 'llamacpp') {
        send(res, 200, {
          build_info: STUB_LLAMACPP_BUILD,
          total_slots: STUB_LLAMACPP_SLOTS,
          default_generation_settings: { n_ctx: 4096 }
        });
      } else {
        send(res, 404, { error: 'not found' });
      }
      return;
    }
    if (req.method === 'GET' && path === '/v1/models') {
      if (options.engine === 'ollama') {
        send(res, 404, { error: 'not found' });
      } else if (options.engine === 'llamacpp') {
        send(res, 200, { data: [{ id: 'stub-model', object: 'model', meta: { size: 1100000000 } }] });
      } else {
        send(res, 200, { data: [{ id: 'stub-model', object: 'model' }] });
      }
      return;
    }
    if (req.method === 'POST' && path === '/api/generate' && options.engine === 'ollama') {
      ollamaGenerate(res, body);
      return;
    }
    if (req.method === 'POST' && path === '/v1/chat/completions' && options.engine !== 'ollama') {
      chat(res, body);
      return;
    }
    send(res, 404, { error: 'not found' });
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      let body: any = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body });
      route(req, res, body);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>(done => server.close(() => done()))
      });
    });
  });
}
