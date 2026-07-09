# Migration Guide

## From Prompt Collections To AStack Enterprise
1. Treat AStack Enterprise as an AI Engineering Operating System, not a prompt library.
2. Route every task through the Orchestrator.
3. Add new capabilities through providers, plugins, departments, workflows, or Knowledge Packs.
4. Keep user-facing communication Persian.
5. Keep generated software assets English.
6. Verify every change with `npm test` and `node bin/astack.mjs doctor`.

## Claude Code Migration
Claude Code should start from the root `CLAUDE.md` file, then load `astack.config.yaml`, the language policy, runtime, orchestrator, departments, workflows, providers, memory, and Knowledge Packs.
