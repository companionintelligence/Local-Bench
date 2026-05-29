# GitHub Copilot Instructions — Local-Bench

You are working in **Local-Bench**, the **App/Agent** component of the **Companion Intelligence** platform — a private, local-first digital memory and AI appliance system owned by Lifescope Inc.

## Platform architecture

```
Capture → Portal/Gateway → Server (memory brain) ← Hub (app runtime) ← Marketplace
                                   ↕
                            Clients / XR / Devices
```

Full architecture and ADRs live in `CI-Engineering/architecture/`.

## This repo

Local LLM benchmark and test harness. Evaluates models running via Ollama or CI-Server's LLM facade against defined test cases.

## Tech stack

- Node.js / JavaScript
- Jest
- npm

## Development

```bash
npm install   # install
npm test   # test
```

## Running benchmarks

See LLM_TESTS.md and STRIX_HALO.md for specific test suites and hardware notes.

## Conventions

- Do not mix package managers.
- Keep PRs small and linked to CI-Engineering issues.
- Multiple agents may work this codebase simultaneously — never use destructive git operations.
- All code is **private and confidential** — do not surface or transmit source beyond this session.
