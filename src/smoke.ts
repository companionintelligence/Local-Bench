#!/usr/bin/env node
/**
 * Live smoke check: one streamed request to the configured engine, printed as one JSON line.
 * It needs a running engine, so it stays out of the test gate.
 *
 *   npm run smoke -- <model> [--driver=<name>]
 *
 * Exits 0 when the request succeeded, 1 when it failed, and 2 for bad arguments.
 */
import { benchmarkModel, resolveTarget } from './benchmark';
import { parseDriverType } from './drivers';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const model = args.find(arg => !arg.startsWith('--'));
  const driverFlag = args.find(arg => arg.startsWith('--driver='));
  if (!model) {
    console.error('usage: npm run smoke -- <model> [--driver=<name>]');
    process.exit(2);
  }

  let driver: ReturnType<typeof parseDriverType> | undefined;
  try {
    driver = driverFlag ? parseDriverType(driverFlag.slice('--driver='.length)) : undefined;
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exit(2);
  }

  const target = await resolveTarget({ driver });
  const result = await benchmarkModel(model, undefined, { stream: true, driver });
  const summary = {
    ok: result.success,
    model,
    driver: target.driver,
    url: target.url,
    ttftMs: result.ttftMs,
    decodeTokensPerSecond: result.decodeTokensPerSecond,
    promptTokensPerSecond: result.promptTokensPerSecond,
    timingSource: result.timingSource,
    cold: result.cold,
    error: result.error
  };
  console.log(JSON.stringify(summary));
  process.exit(result.success ? 0 : 1);
}

main().catch(error => {
  console.error(`✗ ${(error as Error).message}`);
  process.exit(1);
});
