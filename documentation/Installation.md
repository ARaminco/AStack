# Installation

Requirements: Node.js 20+ and git. The core has zero npm dependencies. Graphify additionally needs Python with `uv`, `pipx` or `pip`; without it, setup reports the step and carries on.

## One command, any project

```bash
# Bash / zsh / Git Bash
git clone --depth 1 https://github.com/ARaminco/AStack.git ~/.astack/core   # later: git -C ~/.astack/core pull --ff-only
node ~/.astack/core/bin/astack.mjs setup --target /path/to/project

# or the bootstrap scripts, which do the same
sh installer/install.sh /path/to/project
powershell -File installer/install.ps1 C:\path\to\project
```

`astack setup` works the same for every starting point and is safe to repeat:

| Starting point | What happens |
| --- | --- |
| Empty directory | Full AStack project: core, configuration, README, package.json, CI workflows, knowledge packs. |
| Existing project without AStack | Core embedded beside the project's own files; its `README.md`, `package.json`, `Dockerfile` and CI are kept, its `AGENTS.md` keeps its rules and gains the AStack block, its `CLAUDE.md` gains the import. Recorded in `.astack/install.json` so later upgrades respect it. |
| Project on an older core (any 2.x) | Upgraded with backups, configuration sections merged, data migrations run with the new code. |
| Current core | Nothing to install; the local steps repair whatever is missing. |

Then, inside the project, with the new code:

1. data migrations;
2. `.gitignore` rules for machine-local state;
3. the contract block in `AGENTS.md` and the wiring for Claude Code and Codex ([details](Codex-and-Claude-Code.md));
4. Codex project trust in `~/.codex/config.toml` (backup kept);
5. Graphify: install, git hooks, first code graph ([details](Graphify.md));
6. the context index;
7. the global `astack-setup` skill for Claude Code (`~/.claude/skills`) and Codex (`~/.agents/skills`).

Opt out of any optional step with `--no-graphify`, `--no-trust-codex`, `--no-hooks`, `--no-index` or `--no-global-skill`. Two steps stay manual because they are trust decisions: trusting the two astack hooks with `/hooks` in Codex, and accepting the workspace trust dialog in Claude Code.

## Asking the runtime instead

Once the global skill is installed (by any setup), telling Claude Code or Codex "install", "set up", "نصب شو" or "راه‌اندازی شو" in any project runs the same setup. Inside an AStack project the contract carries the same rule.

## Updating

```bash
node bin/astack.mjs setup --update     # refresh ~/.astack/core, upgrade this project, run every setup step
node bin/astack.mjs upgrade            # upgrade from the canonical repository; setup runs afterwards automatically
```

Cores older than the upgrade engine can also copy `scripts/astack-upgrade.mjs` into the project and run `node astack-upgrade.mjs`; `setup --target` from a current core is simpler and does the same.

## Developing AStack itself

```bash
git clone https://github.com/ARaminco/AStack.git
cd AStack
npm test
node bin/astack.mjs setup
```

## First Commands
```bash
node bin/astack.mjs standup
node bin/astack.mjs ask "پرونده حقوقی قرارداد ملکی"
node bin/astack.mjs graphify query "how does a mission resume after approval"
node bin/astack.mjs help
```
