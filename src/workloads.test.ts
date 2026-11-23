import { buildScenarioPrompt, parseScenario, SCENARIO_QUESTION, SCENARIOS } from './workloads';

describe('fixed workloads', () => {
  it('carries the nine published budgets', () => {
    expect(SCENARIOS.map(s => s.name)).toEqual([
      'pp16+tg1536', 'pp64+tg1024', 'pp384+tg1152', 'pp1024+tg16', 'pp1024+tg1024',
      'pp1280+tg3072', 'pp2048+tg256', 'pp2048+tg768', 'pp4096+tg256'
    ]);
    expect(parseScenario('pp1024+tg16')).toEqual({ name: 'pp1024+tg16', promptTokens: 1024, genTokens: 16 });
  });

  it('accepts any ppN+tgM within the limits, and names it canonically', () => {
    expect(parseScenario(' pp300+tg40 ')).toEqual({ name: 'pp300+tg40', promptTokens: 300, genTokens: 40 });
  });

  it('rejects anything else, listing the valid forms', () => {
    expect(() => parseScenario('nonsense')).toThrow(/Unknown scenario "nonsense"/);
    expect(() => parseScenario('pp0+tg5')).toThrow(/Unknown scenario/);
    expect(() => parseScenario('pp5000000+tg1')).toThrow(/up to 32768/);
    expect(() => parseScenario('pp100+tg99999')).toThrow(/up to 8192/);
  });

  it('builds a prompt that starts with the nonce and ends with the question', () => {
    const scenario = parseScenario('pp64+tg1024');
    const prompt = buildScenarioPrompt(scenario, 'nonce-1');
    expect(prompt.startsWith('Session nonce-1.')).toBe(true);
    expect(prompt.endsWith(SCENARIO_QUESTION)).toBe(true);
    expect(buildScenarioPrompt(scenario, 'nonce-2').slice(0, 16)).not.toBe(prompt.slice(0, 16));
  });
});
