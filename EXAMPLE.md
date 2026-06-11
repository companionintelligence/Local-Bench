# Example: running Local-Bench

A quick walkthrough of benchmarking local models and viewing the results.

## Prerequisites

1. Install [Ollama](https://ollama.ai/) and start it: `ollama serve`
2. Pull a few models you can run on your hardware:

```bash
ollama pull gemma3:4b
ollama pull qwen3:8b
ollama pull llama3.1:8b
```

## Step 1: Run the benchmark

```bash
npm install
npm run build

# Benchmark specific installed models...
node dist/benchmark.js gemma3:4b qwen3:8b llama3.1:8b

# ...or the whole curated catalog
npm run benchmark
```

Expected output:

```
=== Local LLM Benchmark Tool ===
Ollama API URL: http://localhost:11434

Models to benchmark: gemma3:4b, qwen3:8b, llama3.1:8b
✓ Connected to Ollama API

Benchmarking gemma3:4b...
  ✓ Completed in 5.25s
  ✓ Generated 412 tokens
  ✓ Speed: 78.42 tokens/second

Benchmarking qwen3:8b...
  ✓ Completed in 9.52s
  ✓ Generated 498 tokens
  ✓ Speed: 52.31 tokens/second

Results saved to benchmark_results.csv

=== Benchmark Summary ===

Ranking (by tokens/second):
  1. gemma3:4b: 78.42 tokens/s
  2. qwen3:8b: 52.31 tokens/s
  3. llama3.1:8b: 49.87 tokens/s

Done! Open the dashboard to view the results.
```

## Step 2: View results in the dashboard

```bash
npm start
# open http://localhost:3000
```

You'll see:

- Summary cards (catalog size, installed models, top intelligence, fastest measured)
- The **Model intelligence** catalog ranked by the Artificial Analysis Intelligence Index
- System specifications captured during the run
- A throughput bar chart and a detailed results table (with each model's `IQ` score)

## Step 3: Re-run and refresh

Run more benchmarks (CLI or the **Run benchmark** button in the UI), then click **Refresh** in the dashboard to reload the latest data.

## Custom configuration

```bash
# Point at a non-default Ollama
OLLAMA_API_URL=http://192.168.1.100:11434 npm run benchmark

# Custom dashboard port
PORT=8080 npm start
```

## Troubleshooting

- **Cannot connect to Ollama API** — make sure `ollama serve` is running; check `curl http://localhost:11434/api/tags`.
- **Model not found** — `ollama list` to see what's installed, then `ollama pull <model-name>`.
- **Benchmark times out** — the per-model timeout is 2 minutes; try smaller models or fewer at once.
