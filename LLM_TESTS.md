# Curated Companion model catalog

The models Local-Bench benchmarks and ranks by default. The **Intelligence** column
is the [Artificial Analysis Intelligence Index](https://artificialanalysis.ai/)
(higher = more capable; snapshot `2026-06`). `—` means the model is not individually
rated by the index (vision-only or very small models).

This table is generated from `SUPPORTED_OLLAMA_MODELS` in [`src/benchmark.ts`](src/benchmark.ts) —
edit the `intelligenceIndex` values there to override the scores.

| Model | Size | Context | Inputs | Intelligence |
| --- | --- | --- | --- | --- |
| gemma3:270m | 292MB | 32K | Text | — |
| qwen3:0.6b | 523MB | 40K | Text | — |
| gemma3:1b | 815MB | 32K | Text | — |
| deepseek-r1:1.5b | 1.1GB | 128K | Text | — |
| llama3.2:1b | 1.3GB | 128K | Text | — |
| qwen3:1.7b | 1.4GB | 40K | Text | 3 |
| qwen3-vl:2b | 1.9GB | 256K | Text, Image | — |
| llama3.2:3b | 2.0GB | 128K | Text | 4 |
| qwen3:4b | 2.5GB | 256K | Text | 6 |
| gemma3:4b | 3.3GB | 128K | Text, Image | 4 |
| qwen3-vl:4b | 3.3GB | 256K | Text, Image | — |
| deepseek-r1:7b | 4.7GB | 128K | Text | 8 |
| llama3.1:8b | 4.9GB | 128K | Text | 8 |
| deepseek-r1:8b | 5.2GB | 128K | Text | 9 |
| qwen3:8b | 5.2GB | 40K | Text | 9 |
| qwen3-vl:8b | 6.1GB | 256K | Text, Image | — |
| gemma3:12b | 8.1GB | 128K | Text, Image | 7 |
| deepseek-r1:14b | 9.0GB | 128K | Text | 13 |
| qwen3:14b | 9.3GB | 40K | Text | 11 |
| gpt-oss:20b | 14GB | 128K | Text | 24 |
| gemma3:27b | 17GB | 128K | Text, Image | 10 |
| qwen3-coder:latest | 19GB | 256K | Text | 20 |
| qwen3-coder:30b | 19GB | 256K | Text | 20 |
| qwen3:30b | 19GB | 256K | Text | 15 |
| deepseek-r1:32b | 20GB | 128K | Text | 18 |
| qwen3:32b | 20GB | 40K | Text | 15 |
| qwen3-vl:30b | 20GB | 256K | Text, Image | — |
| qwen3-vl:32b | 21GB | 256K | Text, Image | — |
| deepseek-r1:70b | 43GB | 128K | Text | 20 |
| llama3.1:70b | 43GB | 128K | Text | 16 |
| gpt-oss:120b | 65GB | 128K | Text | 33 |
| llama4:16x17b | 67GB | 10M | Text, Image | 13 |
| GLM-4.6:TQ1_0 | 84GB | 198K | Text | 30 |
| qwen3:235b | 142GB | 256K | Text | 45 |
| qwen3-vl:235b | 143GB | 256K | Text, Image | — |
| GLM-4.6:Q4_K_M | 216GB | 198K | Text | 30 |
| llama3.1:405b | 243GB | 128K | Text | 17 |
| llama4:128x17b | 245GB | 1M | Text, Image | 18 |
| qwen3-coder:480b | 290GB | 256K | Text | 24 |
| deepseek-v3.1:671b | 404GB | 160K | Text | 28 |
| deepseek-r1:671b | 404GB | 160K | Text | 27 |
| minmax m2 | 968GB | 200K | Text | 44 |
