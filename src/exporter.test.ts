import { buildExport, EXPORT_SCHEMA, ExportHardware, toExportRow } from './exporter';

const run = {
  model: 'gemma3:1b', tokensPerSecond: 40, totalTokens: 16, durationSeconds: 0.4, timestamp: '2026-11-23T00:00:00Z', success: true,
  prompt: 'SECRET PROMPT TEXT', response: 'SECRET RESPONSE', servedBy: 'core-4.tailnet.ts.net', requestId: 'req-9',
  targetUrl: 'http://100.115.174.32:5002/api/inference/pool', error: 'connect ECONNREFUSED 100.115.174.32:5002',
  scenario: 'pp1024+tg16', finishReason: 'length', vramBytes: 900, engine: { engineVersion: '0.33.3', modelDigest: '8648f39daa8f' }
};

describe('shareable export', () => {
  it('keeps the measurements and the run settings', () => {
    expect(toExportRow(run)).toMatchObject({ model: 'gemma3:1b', scenario: 'pp1024+tg16', finishReason: 'length', vramBytes: 900, engine: { engineVersion: '0.33.3' } });
  });

  it('leaves out prompts, responses, hostnames, addresses and request IDs', () => {
    const text = JSON.stringify(toExportRow(run));
    for (const secret of ['SECRET PROMPT TEXT', 'SECRET RESPONSE', 'core-4', '100.115.174.32', 'req-9', 'ECONNREFUSED']) {
      expect(text).not.toContain(secret);
    }
  });

  it('keeps the host name out of the hardware block, whatever it is passed', () => {
    const specs = { serverName: 'mac-host.local', cpuModel: 'Apple M4', totalMemoryGB: 16 } as unknown as ExportHardware;
    const out = buildExport({ results: [run], hardware: specs, generatedAt: new Date('2026-11-23T00:00:00Z') });
    expect(out.schema).toBe(EXPORT_SCHEMA);
    expect(out.hardware).toEqual({ cpuModel: 'Apple M4', totalMemoryGB: 16 });
    expect(JSON.stringify(out)).not.toContain('mac-host');
  });
});
