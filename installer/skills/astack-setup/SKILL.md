---
name: astack-setup
description: Install, set up, update or repair AStack in the current project so Claude Code and Codex share one contract, one memory, one journal and the Graphify code graph. A bare request to install, set up or update — "نصب شو", "راه‌اندازی شو", "نصبش کن", "راه‌اندازیش کن", "آپدیت شو", "آپدیت کن", "install", "set up", "update" — with no other object always means this skill; run it right away without asking. Also use it for "AStack رو نصب کن", "AStack رو آپدیت کن", "ای‌استک رو آپدیت کن", "update AStack" or "repair AStack", in a new project or an old one, with or without an existing AStack core.
---

# AStack setup and update

The owner's bare "نصب شو" / "راه‌اندازی شو" / "آپدیت کن" / "install" / "set up" / "update" is a request to run this — do not ask what to install or update; run the steps and report.

Everything goes through the canonical core at `~/.astack/core`, a git clone of the AStack repository (https://github.com/ARaminco/AStack.git). Node 20+ and git are required; if either is missing, say so and stop.

## 1. Refresh the canonical core

```bash
# only when ~/.astack/core does not exist
git clone --depth 1 https://github.com/ARaminco/AStack.git "$HOME/.astack/core"
# every time (works on a branch or a detached release)
git -C "$HOME/.astack/core" fetch --depth 1 origin main
git -C "$HOME/.astack/core" checkout -q --force --detach FETCH_HEAD
```

`$HOME` works in bash, zsh and PowerShell.

## 2. Find the project root

The git top level (`git rev-parse --show-toplevel`), or the current directory when it is not a git repository.

## 3. Run one of the two commands

- **Install / set up** (no AStack yet, or the owner asked to install or set up):

  ```bash
  node "$HOME/.astack/core/bin/astack.mjs" setup --target "<root>"
  ```

- **Update** (the project already has AStack and the owner asked to update):

  ```bash
  node "$HOME/.astack/core/bin/astack.mjs" update --target "<root>"
  ```

  The update pipeline takes the newest release from the git repository and runs preflight → fetch → plan → apply (with backup) → setup → verify → record, rolling back automatically if verification fails. Add `--check` to only show the plan, `--version X.Y.Z` to pin a release, `--channel main` for the branch head, `--test` to also run the test suites.

  If the project is the AStack source repository itself, the pipeline refuses; update it with `git pull` instead.

## 4. Report

In Persian: the versions before and after, each stage or step with its result, the CHANGELOG titles the update brought, failed optional steps with their reason, and the remaining one-time manual steps the command lists.

## Rules

- Never run `graphify claude install` or `graphify codex install`; AStack manages Graphify for both runtimes.
- Do not edit the managed block in `AGENTS.md` by hand; project rules go outside it.
- An existing project keeps its own `README.md`, `package.json`, `Dockerfile`, CI workflows, `AGENTS.md` and `CLAUDE.md` content; setup only adds the AStack block, the import and the wiring entries.
- Options when the owner asks for less: `--no-graphify`, `--no-trust-codex`, `--no-hooks`, `--no-index`, `--no-global-skill`.
- `node <root>/bin/astack.mjs update history` lists past updates; `update rollback` restores the last backup.
