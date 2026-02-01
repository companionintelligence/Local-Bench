# AMD STRIX Halo Integration Guide

This guide explains how to use Local-Bench with AMD Ryzen AI Max "Strix Halo" GPUs using the STRIX Halo toolbox integration.

## Overview

Local-Bench now supports benchmarking LLMs on AMD STRIX Halo GPUs through integration with the [AMD STRIX Halo Llama.cpp Toolboxes](https://github.com/kyuz0/amd-strix-halo-toolboxes). This provides optimized llama.cpp builds with both ROCm and Vulkan backends specifically tuned for STRIX Halo hardware.

## Prerequisites

### Hardware Requirements
- AMD Ryzen AI Max "Strix Halo" APU with integrated GPU

### Software Requirements
- **Operating System**: Fedora 42/43 or Ubuntu 24.04 (Debian-based systems supported)
- **Linux Kernel**: 6.18.3-200 or compatible (recommended for stability)
- **Linux Firmware**: 20251111 or newer (avoid 20251125 - known to cause issues)
- **Toolbox**: Container management system (podman-toolbox)

### Installation

#### Fedora
```bash
sudo dnf install toolbox
```

#### Ubuntu/Debian
```bash
sudo apt install podman-toolbox
```

## Quick Start

### 1. Detect STRIX Halo GPU

First, verify that your STRIX Halo GPU is detected:

```bash
npm run strix-halo detect
```

This command will:
- Detect AMD STRIX Halo GPU
- Check for ROCm installation
- Check for Vulkan support
- Display system specifications

### 2. List Available Toolboxes

View all available STRIX Halo toolboxes:

```bash
npm run strix-halo list-toolboxes
```

Available toolboxes include:

**ROCm Backends:**
- `llama-rocm-6.4.4` - ROCm 6.4.4
- `llama-rocm-7.1.1` - ROCm 7.1.1
- `llama-rocm-7.2` - ROCm 7.2 (recommended)
- `llama-rocm7-nightlies` - ROCm 7 nightly builds

**Vulkan Backends:**
- `llama-vulkan-radv` - RADV Vulkan driver
- `llama-vulkan-amdvlk` - AMDVLK Vulkan driver

### 3. Setup a Toolbox

Create and configure a toolbox (recommended: ROCm 7.2):

```bash
npm run strix-halo setup llama-rocm-7.2
```

Or setup all toolboxes at once:

```bash
npm run strix-halo setup-all
```

**Note**: Setting up toolboxes requires downloading container images, which may take several minutes depending on your internet connection.

### 4. Download a Model

Download a GGUF model from HuggingFace. Example using Qwen model:

```bash
# Create models directory
mkdir -p models/qwen3-coder-30B

# Download model (requires huggingface-cli)
pip install huggingface-hub hf-transfer

# Download with accelerated transfer
HF_HUB_ENABLE_HF_TRANSFER=1 huggingface-cli download \
  unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF \
  BF16/Qwen3-Coder-30B-A3B-Instruct-BF16-00001-of-00002.gguf \
  --local-dir models/qwen3-coder-30B/
```

### 5. Run Benchmark

Benchmark the model with STRIX Halo optimizations:

```bash
npm run strix-halo benchmark models/qwen3-coder-30B/BF16/Qwen3-Coder-30B-A3B-Instruct-BF16-00001-of-00002.gguf \
  --toolbox llama-rocm-7.2 \
  --flash-attention
```

## Command Reference

### Detection Command

```bash
npm run strix-halo detect
```

Detects AMD STRIX Halo GPU and displays system information including:
- GPU model
- ROCm availability
- Vulkan support
- CPU, memory, and OS details

### List Toolboxes

```bash
npm run strix-halo list-toolboxes
```

Shows all available STRIX Halo toolboxes and their installation status.

### Setup Toolbox

```bash
npm run strix-halo setup <toolbox-name>
```

Creates and configures a specific toolbox. Example:

```bash
npm run strix-halo setup llama-rocm-7.2
```

### Setup All Toolboxes

```bash
npm run strix-halo setup-all
```

Creates all STRIX Halo toolboxes. Useful for testing across different backends.

### Benchmark Model

```bash
npm run strix-halo benchmark <model-path> [options]
```

**Options:**
- `--toolbox <name>` - Specify which toolbox to use (default: llama-rocm-7.2)
- `--context <size>` - Context size (default: 8192)
- `--flash-attention` - Enable flash attention (recommended, enabled by default)
- `--no-mmap` - Disable memory mapping (recommended, enabled by default)

**Examples:**

```bash
# Basic benchmark with default settings
npm run strix-halo benchmark models/model.gguf

# Benchmark with specific toolbox
npm run strix-halo benchmark models/model.gguf --toolbox llama-vulkan-radv

# Benchmark with custom context size
npm run strix-halo benchmark models/model.gguf --context 16384

# Benchmark with Vulkan backend
npm run strix-halo benchmark models/model.gguf --toolbox llama-vulkan-radv
```

## Performance Optimization

### Critical Settings for STRIX Halo

STRIX Halo requires specific settings for optimal performance and stability:

1. **Flash Attention**: Must be enabled (`-fa 1`)
2. **No Memory Mapping**: Must be disabled (`--no-mmap`)
3. **GPU Layers**: Offload maximum layers to GPU (`-ngl 99` or `-ngl 999`)

These settings are enabled by default in the STRIX Halo benchmark commands.

### Backend Selection

**ROCm Backends** (recommended):
- Better performance for most workloads
- Supports more advanced features
- Use `llama-rocm-7.2` for best stability

**Vulkan Backends**:
- Better compatibility
- Easier setup (no ROCm driver required)
- Use `llama-vulkan-radv` for best performance

### Context Size Recommendations

- **8K context**: Good balance for most tasks
- **16K context**: For longer conversations
- **32K+ context**: For very long documents (requires more VRAM)

## Troubleshooting

### GPU Not Detected

If STRIX Halo GPU is not detected:

1. Check GPU is properly installed:
   ```bash
   lspci | grep -i vga
   ```

2. Ensure drivers are loaded:
   ```bash
   lsmod | grep amdgpu
   ```

3. Update firmware if needed (avoid 20251125):
   ```bash
   sudo dnf downgrade linux-firmware
   ```

### Toolbox Creation Fails

If toolbox creation fails:

1. Check podman is running:
   ```bash
   systemctl --user status podman
   ```

2. Ensure you have network connectivity to pull images

3. Check disk space for container images

### Benchmark Crashes or Hangs

If benchmarks crash or hang:

1. Ensure flash attention is enabled
2. Enable no-mmap mode
3. Reduce context size
4. Try a different toolbox/backend
5. Check system logs:
   ```bash
   journalctl -xe
   ```

### ROCm Not Working

If ROCm backend doesn't work:

1. Check ROCm installation:
   ```bash
   rocm-smi
   ```

2. Verify kernel version compatibility (6.18.3-200 recommended)

3. Try Vulkan backend as alternative:
   ```bash
   npm run strix-halo setup llama-vulkan-radv
   ```

### Firmware Issues

**Critical**: Do not use linux-firmware-20251125 - it breaks ROCm support.

To downgrade firmware on Fedora:
```bash
sudo dnf downgrade linux-firmware
# Select version 20251111 or earlier
```

## Integration with Local-Bench

STRIX Halo benchmarks are automatically integrated with Local-Bench:

- Results are saved to the same database as Ollama benchmarks
- System specifications include STRIX Halo detection
- Web interface displays all benchmark results together

To view results:

```bash
npm start
# Open http://localhost:3000
```

## Advanced Usage

### Manual Toolbox Commands

You can run commands directly in toolboxes:

```bash
# Enter toolbox shell
toolbox enter llama-rocm-7.2

# Inside the toolbox, you can run llama.cpp commands directly
llama-cli --list-devices
llama-server -m /path/to/model.gguf -c 8192 -ngl 999 -fa 1 --no-mmap
```

### Custom Benchmark Scripts

You can create custom benchmark scripts using the STRIX Halo module:

```typescript
import { benchmarkWithToolbox } from './strixHalo';

const result = await benchmarkWithToolbox({
  modelPath: '/path/to/model.gguf',
  toolboxName: 'llama-rocm-7.2',
  contextSize: 8192,
  flashAttention: true,
  noMmap: true
});

console.log(`Tokens/sec: ${result.tokensPerSecond}`);
```

## Resources

- [AMD STRIX Halo Toolboxes GitHub](https://github.com/kyuz0/amd-strix-halo-toolboxes)
- [AMD STRIX Halo Toolboxes Documentation](https://kyuz0.github.io/amd-strix-halo-toolboxes/)
- [llama.cpp GitHub](https://github.com/ggerganov/llama.cpp)
- [ROCm Documentation](https://rocm.docs.amd.com/)

## System Requirements Summary

### Stable Configuration
- **OS**: Fedora 42/43 (recommended) or Ubuntu 24.04
- **Kernel**: 6.18.3-200
- **Firmware**: 20251111 (avoid 20251125)
- **Toolbox**: Latest version via dnf/apt

### Tested Hardware
- AMD Ryzen AI Max (STRIX Halo) APU
- Integrated RDNA GPU (16GB+ unified memory recommended)

## Support

For issues specific to:
- **STRIX Halo toolboxes**: See [kyuz0/amd-strix-halo-toolboxes](https://github.com/kyuz0/amd-strix-halo-toolboxes/issues)
- **Local-Bench integration**: Create an issue in this repository
- **llama.cpp**: See [ggerganov/llama.cpp](https://github.com/ggerganov/llama.cpp/issues)
