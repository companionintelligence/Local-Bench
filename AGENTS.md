# AGENTS.md — Local-Bench

## Platform context

Local-Bench is the **App/Agent** layer component of the Companion Intelligence platform — a private, local-first digital memory system.

Full architecture: `CI-Engineering/architecture/architecture.md`

## Repo summary

Local LLM benchmark and test harness. Evaluates models running via Ollama or CI-Server's LLM facade against defined test cases.

## Stack

- Node.js / JavaScript
- Jest
- npm

## Setup & commands

```bash
npm install   # install
# start Ollama or CI-Server first, then:   # dev
npm test   # test
# no build — runs directly   # build
```

## Running benchmarks

See LLM_TESTS.md and STRIX_HALO.md for specific test suites and hardware notes.

## Git discipline

- Never `git reset --hard` or `git clean -f` without user confirmation.
- Commit messages: imperative mood, ≤ 72 chars.
- Reference CI-Engineering issues in PRs (e.g. `Closes companionintelligence/CI-Engineering#32`).

## Confidentiality

Private & Confidential — Property of Lifescope Inc. Do not distribute.
