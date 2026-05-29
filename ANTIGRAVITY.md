# ANTIGRAVITY.md — Local-Bench

## Context

**Local-Bench** — **App/Agent** layer of the Companion Intelligence platform (Lifescope Inc).

Architecture: `CI-Engineering/architecture/architecture.md`
Roadmap: `CI-Engineering/architecture/roadmap.md`

## Purpose

Local LLM benchmark and test harness. Evaluates models running via Ollama or CI-Server's LLM facade against defined test cases.

## Stack

- Node.js / JavaScript
- Jest
- npm

## Commands

```bash
npm install
# start Ollama or CI-Server first, then:
npm test
```

## Rules

- Package manager: do not switch or mix.
- Destructive git operations (`reset --hard`, `clean -f`) require explicit user confirmation.
- Commits reference CI-Engineering issues.
- All content is **private and confidential** — Property of Lifescope Inc.
