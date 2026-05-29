# CLAUDE.md — Local-Bench

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

## Platform role

**Local-Bench** sits in the **App/Agent** layer of the Companion Intelligence platform.

Architecture: `CI-Engineering/architecture/architecture.md`
Roadmap: `CI-Engineering/architecture/roadmap.md`
Issues: <https://github.com/companionintelligence/CI-Engineering/issues>

## What this repo does

Local LLM benchmark and test harness. Evaluates models running via Ollama or CI-Server's LLM facade against defined test cases.

## Stack

- Node.js / JavaScript
- Jest
- npm

## Key commands

```bash
# Install dependencies
npm install

# Start development server / service
# start Ollama or CI-Server first, then:

# Run tests
npm test

# Build for production
# no build — runs directly
```

## Package manager

**npm** — use exclusively; do not mix with npm/yarn/pnpm/bun unless the repo explicitly requires it.

## Cross-repo connections

- Calls CI-Server /v1/chat/completions (OpenAI-compatible endpoint)
- Or calls Ollama directly

## Running benchmarks

See LLM_TESTS.md and STRIX_HALO.md for specific test suites and hardware notes.

## Multi-agent safety

Multiple AI agents work these repos in parallel. Never use `git reset --hard`, `git clean -f`, or any destructive git command without explicit confirmation from the user.

## Confidentiality

Private & Confidential — Property of Lifescope Inc. Do not distribute.
