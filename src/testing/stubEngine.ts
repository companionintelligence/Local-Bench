/**
 * An in-process stand-in for an inference engine, for contract tests. It serves the route
 * shapes Local-Bench reads (Ollama's /api/generate and /api/tags, the OpenAI-compatible
 * /v1/chat/completions and /v1/models, and llama.cpp's /props) over real HTTP. Test-only:
 * jest does not match this path, and nothing in the product imports it.
 */
import * as fs from 'fs';
import * as http from 'http';

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

export function startStubEngine(options: StubOptions): Promise<StubEngine> {
  const requests: RecordedRequest[] = [];
  const reply = options.reply ?? 'Hello there friend';
  const words = reply.split(' ');

  const send = (res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...options.headers, ...extra });
    res.end(JSON.stringify(body));
  };

  const ollamaStats = (body: any) => ({
    eval_count: words.length,
    eval_duration: 50_000_000,
    prompt_eval_count: countWords(String(body?.prompt ?? '')),
    prompt_eval_duration: 20_000_000,
    load_duration: options.loadDurationNs ?? 0
  });

  const ollamaGenerate = (res: http.ServerResponse, body: any): void => {
    if (body?.stream === false) {
      if (options.streamError) {
        send(res, 200, { error: options.streamError });
        return;
      }
      send(res, 200, { response: reply, done: true, ...ollamaStats(body) });
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
    for (const word of words) {
      res.write(JSON.stringify({ model: body?.model, response: `${word} `, done: false }) + '\n');
    }
    res.end(JSON.stringify({ model: body?.model, response: '', done: true, ...ollamaStats(body) }) + '\n');
  };

  const chat = (res: http.ServerResponse, body: any): void => {
    if (options.rejectStreamOptions && body?.stream_options) {
      send(res, 400, { error: 'stream_options is not supported by this engine' });
      return;
    }
    const promptTokens = countWords(lastUserText(body));
    const timings = options.timings ? LLAMACPP_TIMINGS : undefined;
    if (!body?.stream) {
      send(res, 200, {
        choices: [{ message: { content: reply } }],
        usage: options.omitUsage ? undefined : { completion_tokens: words.length, prompt_tokens: promptTokens },
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
    for (const word of words) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${word} ` } }] })}\n\n`);
    }
    const final: Record<string, unknown> = { choices: [{ delta: {}, finish_reason: 'stop' }] };
    if (body?.stream_options?.include_usage && !options.omitUsage) {
      final.usage = { completion_tokens: words.length, prompt_tokens: promptTokens };
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
        send(res, 200, { models: [{ name: 'gemma3:1b' }] });
      } else {
        send(res, 404, { error: 'not found' });
      }
      return;
    }
    if (req.method === 'GET' && path === '/props') {
      if (options.engine === 'llamacpp') {
        send(res, 200, { default_generation_settings: { n_ctx: 4096 } });
      } else {
        send(res, 404, { error: 'not found' });
      }
      return;
    }
    if (req.method === 'GET' && path === '/v1/models') {
      if (options.engine === 'ollama') {
        send(res, 404, { error: 'not found' });
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
