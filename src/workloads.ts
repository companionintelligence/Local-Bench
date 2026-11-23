/**
 * Fixed workloads: a prompt of a stated token count and a generation capped at a stated
 * token count, so runs on different machines do the same work. The named budgets are the
 * test table LocalScore publishes (github.com/cjpais/LocalScore, Apache-2.0), so the numbers
 * can be lined up against it. Any ppN+tgM within the limits is accepted too.
 */
import { buildDepthPrompt, MAX_CONTEXT_DEPTH } from './measure';

export interface Scenario {
  name: string;
  promptTokens: number;
  genTokens: number;
}

export const MAX_GEN_TOKENS = 8192;

export const SCENARIOS: readonly Scenario[] = [
  { name: 'pp16+tg1536', promptTokens: 16, genTokens: 1536 },
  { name: 'pp64+tg1024', promptTokens: 64, genTokens: 1024 },
  { name: 'pp384+tg1152', promptTokens: 384, genTokens: 1152 },
  { name: 'pp1024+tg16', promptTokens: 1024, genTokens: 16 },
  { name: 'pp1024+tg1024', promptTokens: 1024, genTokens: 1024 },
  { name: 'pp1280+tg3072', promptTokens: 1280, genTokens: 3072 },
  { name: 'pp2048+tg256', promptTokens: 2048, genTokens: 256 },
  { name: 'pp2048+tg768', promptTokens: 2048, genTokens: 768 },
  { name: 'pp4096+tg256', promptTokens: 4096, genTokens: 256 }
];

const SCENARIO_PATTERN = /^pp(\d+)\+tg(\d+)$/;

/** A named scenario, or any ppN+tgM within the limits. Throws, listing the valid forms, otherwise. */
export function parseScenario(value: string): Scenario {
  const name = value.trim();
  const known = SCENARIOS.find(scenario => scenario.name === name);
  if (known) {
    return known;
  }
  const match = SCENARIO_PATTERN.exec(name);
  const promptTokens = match ? Number(match[1]) : Number.NaN;
  const genTokens = match ? Number(match[2]) : Number.NaN;
  if (!match || promptTokens < 1 || promptTokens > MAX_CONTEXT_DEPTH || genTokens < 1 || genTokens > MAX_GEN_TOKENS) {
    throw new Error(
      `Unknown scenario "${value}". Use one of ${SCENARIOS.map(s => s.name).join(', ')}, or ppN+tgM with N up to ${MAX_CONTEXT_DEPTH} and M up to ${MAX_GEN_TOKENS}.`
    );
  }
  return { name: `pp${promptTokens}+tg${genTokens}`, promptTokens, genTokens };
}

export const SCENARIO_QUESTION = 'Continue the text above with a detailed, flowing passage.';

/** The prompt for one request of a scenario. The nonce keeps an engine from reusing an earlier prefill. */
export function buildScenarioPrompt(scenario: Scenario, nonce: string): string {
  return buildDepthPrompt(SCENARIO_QUESTION, scenario.promptTokens, nonce);
}
