import { getSystemSpecs, formatSystemSpecs, SystemSpecs } from './systemSpecs';
import * as os from 'os';

// Mock systeminformation module
jest.mock('systeminformation');

describe('SystemSpecs Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getSystemSpecs', () => {
    it('should return system specs with all fields', async () => {
      const specs = await getSystemSpecs();

      expect(specs).toHaveProperty('serverName');
      expect(specs).toHaveProperty('cpuModel');
      expect(specs).toHaveProperty('cpuCores');
      expect(specs).toHaveProperty('cpuThreads');
      expect(specs).toHaveProperty('totalMemoryGB');
      expect(specs).toHaveProperty('osType');
      expect(specs).toHaveProperty('osVersion');
      expect(specs).toHaveProperty('gpus');
      
      expect(typeof specs.serverName).toBe('string');
      expect(typeof specs.cpuModel).toBe('string');
      expect(typeof specs.cpuCores).toBe('number');
      expect(typeof specs.cpuThreads).toBe('number');
      expect(typeof specs.totalMemoryGB).toBe('number');
      expect(typeof specs.osType).toBe('string');
      expect(typeof specs.osVersion).toBe('string');
      expect(Array.isArray(specs.gpus)).toBe(true);
    });

    it('should have at least one GPU entry', async () => {
      const specs = await getSystemSpecs();
      
      expect(specs.gpus.length).toBeGreaterThan(0);
      expect(specs.gpus[0]).toHaveProperty('model');
    });

    it('should use fallback values on error', async () => {
      // Even with errors, the fallback should work using os module
      const specs = await getSystemSpecs();
      
      expect(specs.serverName).toBe(os.hostname());
      expect(specs.totalMemoryGB).toBeGreaterThan(0);
    });
  });

  describe('formatSystemSpecs', () => {
    it('should format system specs correctly', () => {
      const specs: SystemSpecs = {
        serverName: 'test-server',
        cpuModel: 'Test CPU',
        cpuCores: 8,
        cpuThreads: 16,
        totalMemoryGB: 32.5,
        osType: 'linux',
        osVersion: 'Ubuntu 22.04',
        motherboard: 'Test Motherboard',
        gpus: [
          { model: 'GPU 1', vram: 8000 },
          { model: 'GPU 2' }
        ]
      };

      const formatted = formatSystemSpecs(specs);

      expect(formatted).toContain('System Specifications');
      expect(formatted).toContain('test-server');
      expect(formatted).toContain('Test CPU');
      expect(formatted).toContain('8');
      expect(formatted).toContain('16');
      expect(formatted).toContain('32.5');
      expect(formatted).toContain('linux');
      expect(formatted).toContain('Ubuntu 22.04');
      expect(formatted).toContain('Test Motherboard');
      expect(formatted).toContain('GPU 1');
      expect(formatted).toContain('8000 MB');
      expect(formatted).toContain('GPU 2');
    });

    it('should handle specs without motherboard', () => {
      const specs: SystemSpecs = {
        serverName: 'test-server',
        cpuModel: 'Test CPU',
        cpuCores: 4,
        cpuThreads: 8,
        totalMemoryGB: 16,
        osType: 'linux',
        osVersion: 'Ubuntu 22.04',
        gpus: [{ model: 'Test GPU' }]
      };

      const formatted = formatSystemSpecs(specs);

      expect(formatted).toContain('System Specifications');
      expect(formatted).not.toContain('Motherboard:');
      expect(formatted).toContain('Test GPU');
    });

    it('should handle GPU without VRAM', () => {
      const specs: SystemSpecs = {
        serverName: 'test-server',
        cpuModel: 'Test CPU',
        cpuCores: 4,
        cpuThreads: 8,
        totalMemoryGB: 16,
        osType: 'linux',
        osVersion: 'Ubuntu 22.04',
        gpus: [{ model: 'Test GPU' }]
      };

      const formatted = formatSystemSpecs(specs);

      expect(formatted).toContain('Test GPU');
      expect(formatted).not.toContain('MB)');
    });
  });
});
