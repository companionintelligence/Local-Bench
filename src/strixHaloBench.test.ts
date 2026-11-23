import * as fs from 'fs';
import * as path from 'path';
import {
  benchmarkWithToolbox,
  buildLlamaBenchArgs,
  parseLlamaBenchJson,
  summarizeLlamaBench
} from './strixHalo';

// The fixture follows the llama.cpp README's JSON schema. Its numbers are illustrative, not measured.
const SAMPLE = fs.readFileSync(path.join(__dirname, '__fixtures__', 'llama-bench-sample.json'), 'utf8');

jest.mock('child_process', () => ({
  exec: jest.fn(),
  execFile: jest.fn()
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const childProcess = require('child_process') as { execFile: jest.Mock };

describe('buildLlamaBenchArgs', () => {
  it('asks for JSON and never passes the removed -c or -mmp flags', () => {
    const args = buildLlamaBenchArgs({ modelPath: '/m/a.gguf', toolboxName: 'llama-rocm-7.2' });
    expect(args).toEqual(expect.arrayContaining(['-m', '/m/a.gguf', '-o', 'json', '-p', '512', '-n', '128', '-d', '0', '-r', '5', '-lm', 'none']));
    expect(args).not.toContain('-c');
    expect(args).not.toContain('-mmp');
  });

  it('uses on|off|auto for flash attention and sets the depth and repetitions', () => {
    const args = buildLlamaBenchArgs({ modelPath: 'm.gguf', toolboxName: 'x', flashAttention: true, depth: 4096, repetitions: 3, noWarmup: true });
    expect(args).toEqual(expect.arrayContaining(['-fa', 'on', '-d', '4096', '-r', '3', '--no-warmup']));
    expect(args).not.toContain('1');
  });

  it('keeps the model path as one argument, however many spaces it has', () => {
    const args = buildLlamaBenchArgs({ modelPath: '/models/my model; rm.gguf', toolboxName: 'x' });
    expect(args[args.indexOf('-m') + 1]).toBe('/models/my model; rm.gguf');
  });
});

describe('parseLlamaBenchJson', () => {
  it('reads the prompt and decode tests, with their repetitions', () => {
    const rows = parseLlamaBenchJson(SAMPLE);
    expect(rows.map(row => row.kind)).toEqual(['pp', 'tg']);
    expect(rows[1]).toMatchObject({ nGen: 128, nPrompt: 0, depth: 0, tokensPerSecond: 52.4, stddevTokensPerSecond: 0.4, backend: 'ROCm' });
    expect(rows[1].samplesTokensPerSecond).toHaveLength(5);
  });

  it('skips log lines printed before the array', () => {
    const rows = parseLlamaBenchJson(`build: 5163 (8cf427ff)\nload_backend: ROCm\n${SAMPLE}`);
    expect(rows).toHaveLength(2);
  });

  it('fails loudly when there is no JSON, rather than returning zero results', () => {
    expect(() => parseLlamaBenchJson('| model | t/s |\n| llama 7B | 52.4 |')).toThrow(/no JSON results/);
    expect(() => parseLlamaBenchJson('[not json')).toThrow(/not valid JSON/);
    expect(() => parseLlamaBenchJson('{"avg_ts": 1}')).toThrow(/not a list/);
  });
});

describe('summarizeLlamaBench', () => {
  it('takes the decode rate from the generation test and the prompt rate from the prompt test', () => {
    const summary = summarizeLlamaBench(parseLlamaBenchJson(SAMPLE));
    expect(summary).toMatchObject({ decodeTokensPerSecond: 52.4, promptTokensPerSecond: 1450.5, depth: 0, nGen: 128 });
    expect(summary.decodeSamples).toEqual([52.3, 52.5, 52.5, 52.2, 52.6]);
  });
});

describe('benchmarkWithToolbox', () => {
  beforeEach(() => {
    childProcess.execFile.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs toolbox without a shell and reports the decode rate', async () => {
    childProcess.execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, out: unknown) => void) => {
      cb(null, { stdout: SAMPLE, stderr: '' });
    });

    const result = await benchmarkWithToolbox({ modelPath: '/models/a b.gguf', toolboxName: 'llama-rocm-7.2', flashAttention: true });

    const [cmd, argv] = childProcess.execFile.mock.calls[0];
    expect(cmd).toBe('toolbox');
    expect(argv.slice(0, 8)).toEqual(['run', '-c', 'llama-rocm-7.2', '--', 'env', 'ROCBLAS_USE_HIPBLASLT=1', '/usr/local/bin/llama-bench', '-m']);
    expect(argv[argv.indexOf('-m') + 1]).toBe('/models/a b.gguf');
    expect(result).toMatchObject({ success: true, tokensPerSecond: 52.4, decodeTokensPerSecond: 52.4, promptTokensPerSecond: 1450.5, totalTokens: 128, model: 'a b' });
  });

  it('uses the Vulkan binary and no environment prefix for Vulkan toolboxes', async () => {
    childProcess.execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, out: unknown) => void) => {
      cb(null, { stdout: SAMPLE, stderr: '' });
    });

    await benchmarkWithToolbox({ modelPath: 'm.gguf', toolboxName: 'llama-vulkan-radv' });

    const argv = childProcess.execFile.mock.calls[0][1];
    expect(argv.slice(0, 6)).toEqual(['run', '-c', 'llama-vulkan-radv', '--', '/usr/sbin/llama-bench', '-m']);
  });

  it('reports a failed run with the error rather than a zero that looks like a result', async () => {
    childProcess.execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => {
      cb(new Error('toolbox: no such container'));
    });

    const result = await benchmarkWithToolbox({ modelPath: 'm.gguf', toolboxName: 'llama-rocm-7.2' });

    expect(result).toMatchObject({ success: false, tokensPerSecond: 0, error: 'toolbox: no such container' });
  });

  it('fails when the output has no decode test', async () => {
    const promptOnly = JSON.stringify([JSON.parse(SAMPLE)[0]]);
    childProcess.execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown, out: unknown) => void) => {
      cb(null, { stdout: promptOnly, stderr: '' });
    });

    const result = await benchmarkWithToolbox({ modelPath: 'm.gguf', toolboxName: 'llama-rocm-7.2' });

    expect(result).toMatchObject({ success: false, error: 'llama-bench reported no decode rate' });
  });
});
