---
name: astack-setup
description: Install, set up, update or repair AStack in the current project so Claude Code and Codex share one contract, one memory, one journal and the Graphify code graph. A bare request to install or set up — "نصب شو", "راه‌اندازی شو", "نصبش کن", "راه‌اندازیش کن", "آپدیت شو", "install", "set up", "install yourself" — with no other object always means this skill; run it right away without asking what to install. Also use it for "AStack رو نصب کن", "update AStack" or "repair AStack", in a new project or an old one, with or without an existing AStack core.
---

# AStack setup

The owner's bare "نصب شو" / "راه‌اندازی شو" / "install" / "set up" is a request to run this — do not ask what to install or set up; run the steps and report.

One command does everything and is safe to repeat: it installs or upgrades the core, runs data migrations, wires Claude Code and Codex, trusts the project in Codex, installs Graphify with its git hooks and builds the code graph, builds the context index, and refreshes this skill.

## Steps

1. Find the project root: the git top level (`git rev-parse --show-toplevel`), or the current directory when it is not a git repository.
2. If `<root>/bin/astack.mjs` exists and `node <root>/bin/astack.mjs help` lists `setup`, run:

   ```bash
   node bin/astack.mjs setup --update
   ```

3. Otherwise (no AStack yet, or a core too old to know `setup`), refresh the canonical core and set the project up from it:

   ```bash
   # first time
   git clone --depth 1 https://github.com/ARaminco/AStack.git "$HOME/.astack/core"
   # later
   git -C "$HOME/.astack/core" pull --ff-only
   node "$HOME/.astack/core/bin/astack.mjs" setup --target "<root>"
   ```

   `$HOME` works in bash, zsh and PowerShell. Node 20 or newer and git are required; if either is missing, say so and stop.

4. Read the summary the command prints. Report to the owner in Persian: what was installed or upgraded (versions), each step's result, failed optional steps with their reason, and the remaining one-time manual steps it lists.

## Rules

- Never run `graphify claude install` or `graphify codex install`; AStack manages Graphify for both runtimes.
- Do not edit the managed block in `AGENTS.md` by hand; project rules go outside it.
- An existing project keeps its own `README.md`, `package.json`, `Dockerfile`, CI workflows, `AGENTS.md` and `CLAUDE.md` content; setup only adds the AStack block, the import and the wiring entries.
- Options when the owner asks for less: `--no-graphify`, `--no-trust-codex`, `--no-hooks`, `--no-index`, `--no-global-skill`.
