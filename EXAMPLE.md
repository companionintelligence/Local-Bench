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
Target: http://localhost:11434 (ollama, direct)
✓ Connected to Ollama API

Models to benchmark: gemma3:4b, qwen3:8b, llama3.1:8b
Concurrency: 1, streaming: on

Benchmarking gemma3:4b (1 concurrent, streaming, ollama → http://localhost:11434)...
  ✓ gemma3:4b: 5.25s, 412 tokens, 78.42 tokens/second
    78.42 tok/s wall, 84.10 tok/s decode, TTFT 310ms
  = aggregate 78.42 tok/s over 5.25s, 1/1 ok, median TTFT 310ms, median decode 84.1 tok/s

Benchmarking qwen3:8b (1 concurrent, streaming, ollama → http://localhost:11434)...
  ✓ qwen3:8b: 9.52s, 498 tokens, 52.31 tokens/second
    52.31 tok/s wall, 55.02 tok/s decode, TTFT 412ms
  = aggregate 52.31 tok/s over 9.52s, 1/1 ok, median TTFT 412ms, median decode 55.02 tok/s

Results saved to benchmark_results.csv
System specs saved to database (ID: 1)
Benchmark results saved to database
3 batch aggregates saved to database

=== Benchmark Summary ===

Ranking (by tokens/second):
  1. gemma3:4b: aggregate 78.42 tok/s over 5.25s, 1/1 ok, median TTFT 310ms, median decode 84.1 tok/s
  2. qwen3:8b: aggregate 52.31 tok/s over 9.52s, 1/1 ok, median TTFT 412ms, median decode 55.02 tok/s
  3. llama3.1:8b: aggregate 49.87 tok/s over 10.10s, 1/1 ok, median TTFT 380ms, median decode 52.4 tok/s

Done! Open index.html in a browser to view the results.
```

Against a CI-Hub pool, each row also names the node and engine that served it, and `--concurrency=N` makes the aggregate line meaningful:

```bash
OLLAMA_API_URL=http://100.115.174.32:5002/api/inference/pool node dist/benchmark.js gemma3:1b --concurrency=4
```

```
Target: http://100.115.174.32:5002/api/inference/pool (ollama, pool)
Benchmarking gemma3:1b (4 concurrent, streaming, ollama → http://100.115.174.32:5002/api/inference/pool)...
  ✓ gemma3:1b: 2.13s, 107 tokens, 50.19 tokens/second
  ✓ gemma3:1b: 3.73s, 109 tokens, 29.25 tokens/second
  ✓ gemma3:1b: 5.88s, 84 tokens, 14.27 tokens/second
  ✓ gemma3:1b: 7.92s, 103 tokens, 13.01 tokens/second
    13.01 tok/s wall, 150.43 tok/s decode, TTFT 7231ms, served by beta-1.capybara-ulmer.ts.net, backend ollama
    50.19 tok/s wall, 89.94 tok/s decode, TTFT 945ms, served by core-4.capybara-ulmer.ts.net, backend ollama
    14.27 tok/s wall, 52.26 tok/s decode, TTFT 4281ms, served by fzzy.capybara-ulmer.ts.net, backend ollama
    29.25 tok/s wall, 95.8 tok/s decode, TTFT 2591ms, served by core-17.capybara-ulmer.ts.net, backend ollama
  = aggregate 50.92 tok/s over 7.92s, 4/4 ok, median TTFT 3436ms, median decode 92.87 tok/s, served by beta-1.capybara-ulmer.ts.net×1 core-4.capybara-ulmer.ts.net×1 fzzy.capybara-ulmer.ts.net×1 core-17.capybara-ulmer.ts.net×1, backends ollama×4
```

See [Benchmarking a CI-Hub pool](README.md#benchmarking-a-ci-hub-pool) in the README for what TTFT, decode, and aggregate mean.

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

# Point at a CI-Hub pool, four requests at a time
OLLAMA_API_URL=http://hub.example.ts.net:5002/api/inference/pool node dist/benchmark.js gemma3:4b --concurrency=4

# Point at a vLLM / Lemonade / Lucebox engine directly (OpenAI-compatible, no /api/generate)
CI_LLM_BASE_URL=http://strix:8000/v1 node dist/benchmark.js Qwen/Qwen3-8B

# Custom dashboard port
PORT=8080 npm start
```

## Troubleshooting

- **Cannot connect to Ollama API** — make sure `ollama serve` is running; check `curl http://localhost:11434/api/tags`.
- **Model not found** — `ollama list` to see what's installed, then `ollama pull <model-name>`.
- **Benchmark times out** — the per-model timeout is 2 minutes; try smaller models or fewer at once.
