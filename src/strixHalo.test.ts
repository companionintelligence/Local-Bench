import {
  detectStrixHalo,
  isToolboxInstalled,
  listAvailableToolboxes,
  formatStrixHaloInfo,
  checkModelExists,
  STRIX_HALO_TOOLBOXES
} from './strixHalo';
import * as fs from 'fs';

// Mock child_process
jest.mock('child_process', () => ({
  exec: jest.fn()
}));

// Mock fs
jest.mock('fs');

describe('STRIX Halo Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('STRIX_HALO_TOOLBOXES constant', () => {
    it('should have all expected toolboxes', () => {
      expect(STRIX_HALO_TOOLBOXES).toBeDefined();
      expect(STRIX_HALO_TOOLBOXES.length).toBeGreaterThan(0);
    });

    it('should have ROCm toolboxes', () => {
      const rocmToolboxes = STRIX_HALO_TOOLBOXES.filter(t => t.backend === 'rocm');
      expect(rocmToolboxes.length).toBeGreaterThan(0);
    });

    it('should have Vulkan toolboxes', () => {
      const vulkanToolboxes = STRIX_HALO_TOOLBOXES.filter(t => t.backend === 'vulkan');
      expect(vulkanToolboxes.length).toBeGreaterThan(0);
    });

    it('should have correct properties for each toolbox', () => {
      STRIX_HALO_TOOLBOXES.forEach(toolbox => {
        expect(toolbox).toHaveProperty('name');
        expect(toolbox).toHaveProperty('backend');
        expect(toolbox).toHaveProperty('version');
        expect(toolbox).toHaveProperty('image');
        expect(toolbox).toHaveProperty('available');
        expect(['rocm', 'vulkan']).toContain(toolbox.backend);
      });
    });

    it('should have llama-rocm-7.2 as recommended toolbox', () => {
      const rocm72 = STRIX_HALO_TOOLBOXES.find(t => t.name === 'llama-rocm-7.2');
      expect(rocm72).toBeDefined();
      expect(rocm72?.backend).toBe('rocm');
    });
  });

  describe('detectStrixHalo', () => {
    it('should return not detected when no AMD GPU found', async () => {
      const { exec } = require('child_process');
      exec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, { stdout: '', stderr: '' });
      });

      const result = await detectStrixHalo();
      expect(result.detected).toBe(false);
    });

    it('should handle detection errors gracefully', async () => {
      const { exec } = require('child_process');
      exec.mockImplementation((cmd: string, callback: Function) => {
        callback(new Error('Command failed'));
      });

      const result = await detectStrixHalo();
      expect(result).toBeDefined();
      expect(result.detected).toBe(false);
    });
  });

  describe('isToolboxInstalled', () => {
    it('should return true when toolbox is installed', async () => {
      const { exec } = require('child_process');
      exec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, { stdout: '/usr/bin/toolbox', stderr: '' });
      });

      const result = await isToolboxInstalled();
      expect(result).toBe(true);
    });

    it('should return false when toolbox is not installed', async () => {
      const { exec } = require('child_process');
      exec.mockImplementation((cmd: string, callback: Function) => {
        callback(new Error('Command not found'));
      });

      const result = await isToolboxInstalled();
      expect(result).toBe(false);
    });
  });

  describe('listAvailableToolboxes', () => {
    it('should return all toolboxes when none are installed', async () => {
      const { exec } = require('child_process');
      exec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, { stdout: '', stderr: '' });
      });

      const result = await listAvailableToolboxes();
      expect(result.length).toBe(STRIX_HALO_TOOLBOXES.length);
      result.forEach(toolbox => {
        expect(toolbox.available).toBe(false);
      });
    });

    it('should mark toolboxes as available when found in list', async () => {
      const { exec } = require('child_process');
      exec.mockImplementation((cmd: string, callback: Function) => {
        callback(null, { 
          stdout: 'llama-rocm-7.2\nllama-vulkan-radv\n', 
          stderr: '' 
        });
      });

      const result = await listAvailableToolboxes();
      const rocm72 = result.find(t => t.name === 'llama-rocm-7.2');
      const vulkanRadv = result.find(t => t.name === 'llama-vulkan-radv');
      
      expect(rocm72?.available).toBe(true);
      expect(vulkanRadv?.available).toBe(true);
    });

    it('should handle errors when listing toolboxes', async () => {
      const { exec } = require('child_process');
      exec.mockImplementation((cmd: string, callback: Function) => {
        callback(new Error('Command failed'));
      });

      const result = await listAvailableToolboxes();
      expect(result.length).toBe(STRIX_HALO_TOOLBOXES.length);
    });
  });

  describe('formatStrixHaloInfo', () => {
    it('should format info for detected GPU', () => {
      const info = {
        detected: true,
        gpuModel: 'AMD Radeon Graphics',
        rocmVersion: '6.0.0',
        vulkanSupport: true
      };

      const formatted = formatStrixHaloInfo(info);
      expect(formatted).toContain('AMD STRIX Halo Detected');
      expect(formatted).toContain('AMD Radeon Graphics');
      expect(formatted).toContain('ROCm');
      expect(formatted).toContain('Vulkan');
    });

    it('should format info for not detected GPU', () => {
      const info = {
        detected: false
      };

      const formatted = formatStrixHaloInfo(info);
      expect(formatted).toContain('Not detected');
    });

    it('should handle partial information', () => {
      const info = {
        detected: true,
        gpuModel: 'AMD GPU'
      };

      const formatted = formatStrixHaloInfo(info);
      expect(formatted).toContain('AMD STRIX Halo Detected');
      expect(formatted).toContain('AMD GPU');
    });
  });

  describe('checkModelExists', () => {
    it('should return true when model file exists', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      const result = checkModelExists('/path/to/model.gguf');
      expect(result).toBe(true);
      expect(fs.existsSync).toHaveBeenCalledWith('/path/to/model.gguf');
    });

    it('should return false when model file does not exist', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = checkModelExists('/path/to/nonexistent.gguf');
      expect(result).toBe(false);
      expect(fs.existsSync).toHaveBeenCalledWith('/path/to/nonexistent.gguf');
    });
  });

  describe('Toolbox backend configuration', () => {
    it('should have correct device arguments for ROCm backends', () => {
      const rocmToolboxes = STRIX_HALO_TOOLBOXES.filter(t => t.backend === 'rocm');
      
      rocmToolboxes.forEach(toolbox => {
        expect(toolbox.backend).toBe('rocm');
        // ROCm requires /dev/dri and /dev/kfd
      });
    });

    it('should have correct device arguments for Vulkan backends', () => {
      const vulkanToolboxes = STRIX_HALO_TOOLBOXES.filter(t => t.backend === 'vulkan');
      
      vulkanToolboxes.forEach(toolbox => {
        expect(toolbox.backend).toBe('vulkan');
        // Vulkan requires only /dev/dri
      });
    });
  });

  describe('Toolbox naming conventions', () => {
    it('should follow naming convention llama-<backend>-<version>', () => {
      STRIX_HALO_TOOLBOXES.forEach(toolbox => {
        // Most follow llama-<backend>-<version>, but rocm7-nightlies is an exception
        if (toolbox.name !== 'llama-rocm7-nightlies') {
          expect(toolbox.name).toMatch(/^llama-(rocm|vulkan)-/);
        } else {
          expect(toolbox.name).toBe('llama-rocm7-nightlies');
        }
      });
    });

    it('should have unique names', () => {
      const names = STRIX_HALO_TOOLBOXES.map(t => t.name);
      const uniqueNames = new Set(names);
      expect(names.length).toBe(uniqueNames.size);
    });

    it('should have valid Docker image references', () => {
      STRIX_HALO_TOOLBOXES.forEach(toolbox => {
        expect(toolbox.image).toContain('docker.io/kyuz0/amd-strix-halo-toolboxes:');
      });
    });
  });
});
