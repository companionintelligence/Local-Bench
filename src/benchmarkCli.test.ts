import { MAX_NOTE_LENGTH, parseCliArgs, parseNote } from './benchmark';

describe('workload, note, scaling and export flags', () => {
  it('parses the workload, note, levels and export flags', () => {
    const args = parseCliArgs([
      '--scenario=pp1024+tg16,pp64+tg1024',
      '--note=laptop on battery',
      '--profile=scaling',
      '--levels=1,2,4',
      '--export=out.json',
      'gemma3:1b'
    ]);
    expect(args).toMatchObject({
      models: ['gemma3:1b'],
      profile: 'scaling',
      levels: [1, 2, 4],
      note: 'laptop on battery',
      exportPath: 'out.json'
    });
    expect(args.scenarios.map(scenario => scenario.name)).toEqual(['pp1024+tg16', 'pp64+tg1024']);
  });

  it('defaults the scaling levels to 1, 2, 4 and 8', () => {
    expect(parseCliArgs(['--profile=scaling']).levels).toEqual([1, 2, 4, 8]);
  });

  it('rejects a context depth alongside a scenario', () => {
    expect(() => parseCliArgs(['--scenario=pp16+tg8', '--depth=4096'])).toThrow(/cannot be combined with --depth/);
  });

  it('rejects an unknown scenario, listing the valid forms', () => {
    expect(() => parseCliArgs(['--scenario=pp16+tg0'])).toThrow(/Unknown scenario/);
  });

  it('rejects concurrency levels above the ceiling', () => {
    expect(() => parseCliArgs(['--levels=1,32'])).toThrow(/whole numbers from 1 to 16/);
  });

  it('rejects an export without a file path', () => {
    expect(() => parseCliArgs(['--export='])).toThrow(/needs a file path/);
  });

  it('rejects a note longer than the limit', () => {
    expect(() => parseCliArgs([`--note=${'x'.repeat(MAX_NOTE_LENGTH + 1)}`])).toThrow(/280 characters or fewer/);
  });

  it('trims a note and drops an empty one', () => {
    expect(parseNote('  on battery  ')).toBe('on battery');
    expect(parseNote('   ')).toBeUndefined();
    expect(parseNote(undefined)).toBeUndefined();
  });

  it('refuses a note that is not text', () => {
    expect(() => parseNote(42)).toThrow(/must be text/);
  });
});
