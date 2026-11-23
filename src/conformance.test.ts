import * as fs from 'fs';
import * as path from 'path';
import { CONFORMANCE, Cell, DIMENSIONS } from './conformance';
import { DRIVER_TYPES } from './drivers';

describe('Conformance matrix', () => {
  it('has a row for every driver and a cell for every dimension', () => {
    expect(Object.keys(CONFORMANCE).sort()).toEqual([...DRIVER_TYPES].sort());
    for (const driver of DRIVER_TYPES) {
      for (const dimension of DIMENSIONS) {
        expect(CONFORMANCE[driver].cells[dimension]).toBeDefined();
      }
    }
  });

  it('points every covered cell at a test that still exists', () => {
    const missing: string[] = [];
    for (const driver of DRIVER_TYPES) {
      for (const dimension of DIMENSIONS) {
        const cell: Cell = CONFORMANCE[driver].cells[dimension];
        if (cell.status !== 'covered') continue;
        const file = path.join(__dirname, cell.file);
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (!text.includes(`'${cell.test}'`)) {
          missing.push(`${driver}/${dimension}: '${cell.test}' not found in ${cell.file}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('states a reason for every skipped cell', () => {
    for (const driver of DRIVER_TYPES) {
      for (const dimension of DIMENSIONS) {
        const cell = CONFORMANCE[driver].cells[dimension];
        if (cell.status === 'skipped') {
          expect(cell.reason.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('says whether each driver has run against a real engine on this host', () => {
    for (const driver of DRIVER_TYPES) {
      const live = CONFORMANCE[driver].live;
      expect(['verified', 'not-run']).toContain(live.status);
      expect(live.note.length).toBeGreaterThan(0);
    }
  });
});
