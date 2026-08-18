# Installation

## Fresh Install
```bash
git clone https://github.com/ARaminco/AStack.git
cd AStack
npm test                      # no dependencies to install; verifies the platform
node bin/astack.mjs doctor
```

Requirements: Node.js 20+ and git. The core has zero npm dependencies.

## Embedding In A Project
Copy the repository (or `git clone`) into the project that should be operated by AStack, keep `.astack/` out of version control, and adjust `astack.config.yaml` for the engagement. From then on the embedded core updates itself with `astack upgrade` — see [Upgrade.md](Upgrade.md).

## Agent Use
Point Claude Code (primary), OpenAI Codex, ChatGPT, or another agent runtime at the repository. The agent starts from `CLAUDE.md`, which chains into `astack.config.yaml`, the language policy, and the engines. See [Claude-Code.md](Claude-Code.md) for the operating loop.

## First Commands
```bash
node bin/astack.mjs domain detect "اظهارنامه مالیات ارزش افزوده"
node bin/astack.mjs lead plan "پرونده حقوقی قرارداد ملکی"
node bin/astack.mjs project templates
node bin/astack.mjs help
```

## Updating An Existing Install
- Current cores: `astack upgrade` (dry run with `--check`).
- Cores older than the upgrade engine: copy `scripts/astack-upgrade.mjs` into the project and run `node astack-upgrade.mjs`.
