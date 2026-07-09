# Enterprise Audit

## Architecture
The repository contains explicit layers for Core, Runtime, Orchestrator, Departments, Roles, Providers, Knowledge Packs, Plugins, Memory Engine, Workflow Engine, Localization Engine, Configuration Engine, Event Bus, Permission System, CLI, Installer, Documentation, Testing, and Telemetry.

## Scalability
Providers, plugins, workflows, roles, departments, and Knowledge Packs are manifest-driven. New entries can be added without editing the Orchestrator core.

## Maintainability
The runtime composition lives in `runtime/astack-runtime.mjs`. Each subsystem has a narrow responsibility and is verified by `tests/verify-astack.mjs`.

## Security
Telemetry is disabled by default. The permission policy rejects secret-writing actions and documents environment-variable based secret handling.

## Claude Code Readiness
`CLAUDE.md` defines the startup order, communication policy, coordination rule, and verification command for Claude Code.

## Localization
Owner-facing communication is Persian by default. Generated software assets remain English.

## Installer
Windows, Linux, macOS-compatible shell, and Claude Code install entry points verify the system through `astack doctor`.
