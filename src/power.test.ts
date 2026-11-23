import { drainPowermetrics, parseNvidiaSmiPower, startPowerSampling } from './power';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('power sampling', () => {
  it('sums the per-GPU draws of one nvidia-smi sample', () => {
    expect(parseNvidiaSmiPower('123.45\n130.10\n')).toBeCloseTo(253.55, 2);
    expect(parseNvidiaSmiPower('[N/A]\n')).toBeUndefined();
  });

  it('reads complete powermetrics samples and keeps the unfinished tail', () => {
    const readings: number[] = [];
    const tail = drainPowermetrics(
      'Combined Power (CPU + GPU + ANE): 1500 mW\nCombined Power (CPU + GPU + ANE): 2000 mW\nCombined Power (CPU',
      readings
    );
    expect(readings).toEqual([1.5, 2]);
    expect(tail.trim()).toBe('Combined Power (CPU');
  });

  it('says why there is no reading on a host with no power source', async () => {
    const session = await startPowerSampling({
      platform: 'linux',
      run: () => Promise.reject(new Error('not found'))
    });
    expect(await session.stop()).toMatchObject({ note: expect.stringContaining('no power source') });
  });

  it('says that powermetrics needs root when sudo would prompt', async () => {
    const session = await startPowerSampling({
      platform: 'darwin',
      run: () => Promise.reject(new Error('sudo: a password is required'))
    });
    expect(await session.stop()).toMatchObject({ note: expect.stringContaining('needs root') });
  });

  it('reads Apple Silicon power while powermetrics runs', async () => {
    const session = await startPowerSampling({
      platform: 'darwin',
      run: (command, args) => (command === 'nvidia-smi' ? Promise.reject(new Error('none')) : Promise.resolve(args.join(' '))),
      stream: (_command, _args, onData) => {
        onData('Combined Power (CPU + GPU + ANE): 1500 mW\nCombined Power (CPU + GPU + ANE): 2500 mW\n');
        return { kill: () => undefined };
      }
    });
    expect(await session.stop()).toEqual({ watts: 2, source: 'powermetrics' });
  });

  it('averages nvidia-smi samples taken during the run', async () => {
    const session = await startPowerSampling({
      platform: 'linux',
      intervalMs: 5,
      run: (command, args) => (args.includes('--version') ? Promise.resolve('ok') : Promise.resolve('100\n50\n')),
    });
    await wait(25);
    expect(await session.stop()).toEqual({ watts: 150, source: 'nvidia-smi' });
  });
});
