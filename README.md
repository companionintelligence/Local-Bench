# Local-Bench 🚀

A tool for benchmarking local LLM (Large Language Model) performance via the Ollama API and AMD STRIX Halo GPUs. This tool measures the token generation speed of different models and presents the results in an interactive web interface with tables and charts.
<img width="1280" height="1432" alt="image" src="https://github.com/user-attachments/assets/ce2bfe4f-4fd5-437f-8283-0ac2507f6cf1" />


## Features

- 📊 Benchmark multiple LLM models with a single command
- ⚡ Measure tokens per second for each model
- 🧪 Run a broader benchmark library with coding, reasoning, extraction, planning, summarization, translation, and instruction-following prompts
- 💾 Store results in CSV format and SQLite database
- 🌐 Beautiful web interface with:
  - Installed vs. supported Ollama model catalog
  - Benchmark prompt library with benchmark types
  - Interactive bar charts
  - Detailed results table
  - Performance statistics
  - Real-time refresh capability
- 🎮 **NEW: AMD STRIX Halo GPU support** for llama.cpp benchmarking

## Prerequisites

- [Node.js](https://nodejs.org/) (v14 or higher)
- **For Ollama benchmarks:**
  - [Ollama](https://ollama.ai/) installed and running locally
  - At least one LLM model downloaded in Ollama
- **For AMD STRIX Halo benchmarks:**
  - AMD Ryzen AI Max "Strix Halo" APU
  - Fedora 42/43 or Ubuntu 24.04
  - Toolbox (podman-toolbox) installed
  - See [STRIX_HALO.md](STRIX_HALO.md) for detailed requirements

## Installation

1. Clone this repository:
```bash
git clone https://github.com/companionintelligence/Local-Bench.git
cd Local-Bench
```

2. Install dependencies:
```bash
npm install
```

3. Make sure Ollama is running:
```bash
# Ollama should be running on http://localhost:11434
# Start it if it's not already running
ollama serve
```

4. Download some models (if you haven't already):
```bash
ollama pull llama2
ollama pull mistral
ollama pull codellama
```

## Usage

### Ollama Benchmarks

#### Running Benchmarks

**Default models:**
```bash
npm run benchmark
```

This benchmarks the curated Ollama support catalog defined in `src/benchmark.ts`. You can also run a smaller selection by passing model names on the command line.

**Custom models:**
```bash
node dist/benchmark.js llama3.2:3b qwen3:8b gemma3:4b
```

You can specify any models you have installed in Ollama.

**Custom Ollama API URL:**
```bash
OLLAMA_API_URL=http://localhost:11434 npm run benchmark
```

### AMD STRIX Halo Benchmarks

For AMD Ryzen AI Max "Strix Halo" GPU benchmarking with llama.cpp:

**Detect STRIX Halo GPU:**
```bash
npm run strix-halo detect
```

**Setup toolbox (one-time):**
```bash
npm run strix-halo setup llama-rocm-7.2
```

**Run benchmark:**
```bash
npm run strix-halo benchmark /path/to/model.gguf --toolbox llama-rocm-7.2
```

**See full documentation:**
[STRIX_HALO.md](STRIX_HALO.md) - Complete guide for AMD STRIX Halo integration

### Viewing Results

1. Start the web server:
```bash
npm start
```

2. Open your browser and navigate to:
```
http://localhost:3000
```

3. The web interface will display:
   - Installed and supported Ollama model catalog entries
   - A richer benchmark prompt library with prompt categories and benchmark types
   - Summary statistics (total models, average speed, fastest model)
   - Interactive bar chart comparing model performance
   - Detailed results table with all benchmark data

You can also directly open `index.html` in your browser if the CSV file is in the same directory.

### Custom Port

```bash
PORT=8080 npm start
```

## Output

Results are saved to `benchmark_results.csv` in the following format:

```csv
Model,Tokens Per Second,Total Tokens,Duration (s),Timestamp,Status
llama2,45.23,120,2.65,2024-01-15T10:30:00.000Z,Success
mistral,52.18,125,2.40,2024-01-15T10:32:30.000Z,Success
```

## Configuration

You can customize the following by editing `src/benchmark.ts`:

- `OLLAMA_API_URL`: Ollama API endpoint (default: `http://localhost:11434`)
- `TEST_PROMPTS`: The benchmark prompt library used by the CLI and UI
- `SUPPORTED_OLLAMA_MODELS`: The curated Ollama support catalog and default benchmark targets

## Troubleshooting

**Cannot connect to Ollama API:**
- Make sure Ollama is running: `ollama serve`
- Check that the API is accessible at `http://localhost:11434`
- Try setting a custom URL: `OLLAMA_API_URL=http://your-url npm run benchmark`

**Model not found:**
- List available models: `ollama list`
- Pull the model: `ollama pull <model-name>`

**Benchmark takes too long:**
- Some models are slower than others
- The tool has a 2-minute timeout per model
- Consider benchmarking fewer models at once

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

# Supported Ollama Catalog

| Name | Size | Context | Input |
| --- | --- | --- | --- |
| gemma3:270m | 292MB | 32K | Text |
| qwen3:0.6b | 523MB | 40K | Text |
| gemma3:1b | 815MB | 32K | Text |
| deepseek-r1:1.5b | 1.1GB | 128K | Text |
| llama3.2:1b | 1.3GB | 128K | Text |
| qwen3:1.7b | 1.4GB | 40K | Text |
| qwen3-vl:2b | 1.9GB | 256K | Text, Image |
| llama3.2:3b latest | 2.0GB | 128K | Text |
| qwen3:4b | 2.5GB | 256K | Text |
| gemma3:4b latest | 3.3GB | 128K | Text, Image |
| qwen3-vl:4b | 3.3GB | 256K | Text, Image |
| deepseek-r1:7b | 4.7GB | 128K | Text |
| llama3.1:8b latest | 4.9GB | 128K | Text |
| deepseek-r1:8b latest | 5.2GB | 128K | Text |
| qwen3:8b latest | 5.2GB | 40K | Text |
| qwen3-vl:8b latest | 6.1GB | 256K | Text, Image |
| gemma3:12b | 8.1GB | 128K | Text, Image |
| deepseek-r1:14b | 9.0GB | 128K | Text |
| qwen3:14b | 9.3GB | 40K | Text |
| gpt-oss:20b | 14GB | 128K | Text |
| gemma3:27b | 17GB | 128K | Text, Image |
| qwen3-coder:latest | 19GB | 256K | Text |
| qwen3-coder:30b latest | 19GB | 256K | Text |
| qwen3:30b | 19GB | 256K | Text |
| deepseek-r1:32b | 20GB | 128K | Text |
| qwen3:32b | 20GB | 40K | Text |
| qwen3-vl:30b | 20GB | 256K | Text, Image |
| qwen3-vl:32b | 21GB | 256K | |
| deepseek-r1:70b | 43GB | 128K | Text |
| llama3.1:70b | 43GB | 128K | Text |
| gpt-oss:120b | 65GB | 128K | Text |
| llama4:16x17b latest | 67GB | 10M | Text, Image |
| GLM-4.6:TQ1_0 | 84GB | 198K | Text |
| qwen3:235b | 142GB | 256K | Text |
| qwen3-vl:235b | 143GB | 256K | |
| GLM-4.6:Q4_K_M | 216GB | 198K | Text |
| llama3.1:405b | 243GB | 128K | Text |
| llama4:128x17b | 245GB | 1M | Text, Image |
| qwen3-coder:480b | 290GB | 256K | Text |
| deepseek-v3.1:671b latest | 404GB | 160K | Text |
| deepseek-r1:671b | 404GB | 160K | Text |
| minmax m2 | 968GB | 200K | Text |
