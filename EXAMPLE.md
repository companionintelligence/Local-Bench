# Example: Running the Local LLM Benchmark

This example demonstrates how to use the Local-Bench tool.

## Prerequisites

1. Install Ollama: https://ollama.ai/
2. Download some models:
```bash
ollama pull llama2
ollama pull mistral
ollama pull phi
```

## Step 1: Run the Benchmark

```bash
# Benchmark default models
npm run benchmark

# Or benchmark specific models
node benchmark.js llama2 mistral phi codellama
```

Expected output:
```
=== Local LLM Benchmark Tool ===
Ollama API URL: http://localhost:11434

Models to benchmark: llama2, mistral, phi, codellama
✓ Connected to Ollama API

Benchmarking llama2...
  ✓ Completed in 2.65s
  ✓ Generated 120 tokens
  ✓ Speed: 45.23 tokens/second

Benchmarking mistral...
  ✓ Completed in 2.40s
  ✓ Generated 125 tokens
  ✓ Speed: 52.18 tokens/second

Results saved to benchmark_results.csv

=== Benchmark Summary ===

Ranking (by tokens/second):
  1. mistral: 52.18 tokens/s
  2. llama2: 45.23 tokens/s

Done! Open index.html in a browser to view the results.
```

## Step 2: View Results in Web Interface

```bash
# Start the web server
npm start

# Open in browser
# Navigate to http://localhost:3000
```

You should see:
- Statistics cards showing total models, successful tests, average speed, and fastest model
- A bar chart comparing model performance
- A detailed table with all benchmark results

## Step 3: Re-run and Refresh

After running new benchmarks:
1. Click the "Refresh Results" button in the web interface
2. The page will reload with updated data from the CSV file

## Custom Configuration

### Custom Ollama URL
```bash
OLLAMA_API_URL=http://192.168.1.100:11434 npm run benchmark
```

### Custom Port for Web Server
```bash
PORT=8080 npm start
```

## Troubleshooting

### Error: Cannot connect to Ollama API
- Make sure Ollama is running: `ollama serve`
- Check the API endpoint: `curl http://localhost:11434/api/tags`

### Error: Model not found
- List available models: `ollama list`
- Pull the missing model: `ollama pull <model-name>`

### Benchmark times out
- The default timeout is 2 minutes
- Some larger models may take longer
- Consider testing with smaller prompts or fewer models
