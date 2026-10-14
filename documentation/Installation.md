# Installation

Requirements: Node.js 20+ and git. The core has zero npm dependencies. Graphify additionally needs Python with `uv`, `pipx` or `pip`; without it, setup reports the step and carries on.

Optional, for the 3.0 engines (each one says clearly when its piece is missing):

| Piece | Needed for | Without it |
| --- | --- | --- |
| Node.js 22.5+ (`node:sqlite`) | the SQLite FTS5 search index | search falls back to an in-memory BM25 index and says so |
| Claude Code CLI (`claude`) and/or Codex CLI (`codex`) | unattended runs with those engines | `astack runner engines` reports them unavailable |
| [Ollama](https://ollama.com) on `127.0.0.1:11434` | free local runs, `bge-m3` embeddings for semantic search | lexical search only; `auto` routes to Claude |
| Python with `faster-whisper` | local Persian voice notes in the gateway | voice notes are not transcribed |
| Docker | `astack sandbox` | sandbox reports unavailable; routed commands fail closed |
| npm (once) | the WhatsApp linked-device bridge (`astack gateway whatsapp setup`) | use Telegram, wapi or the Cloud API |

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

## Turning on the always-on assistant (3.0)

Nothing below happens on its own: every 3.0 engine is off or read-only until
you run these steps. Commands are shown as `astack …`; inside a project that is
`node bin/astack.mjs …`.

### 1. Runner

```bash
astack schedule policy allow-command claude    # once: the runner may start Claude Code (same for codex)
astack runner engines                          # what is installed, reachable and allowed
astack run "summarize today's open missions" --dry-run
astack run "summarize today's open missions"
```

Budgets default to $5 a day and $1 a run (`runner.daily_budget_usd`,
`runner.per_run_budget_usd`). See [Runner and Daemon](Runner-and-Daemon.md).

### 2. Daemon and the operating-system service

```bash
astack daemon start                       # runner queue, scheduler, hooks, gateway, search, board, console
astack daemon status
astack daemon install-service --dry-run   # prints exactly what would be created
astack daemon install-service             # start at logon
astack daemon service-status
```

| System | Service |
| --- | --- |
| Windows | Task Scheduler task `AStack Daemon <workspace-id>`, at logon, hidden, restarted on failure |
| macOS | `~/Library/LaunchAgents/com.astack.daemon.<id>.plist` (`RunAtLoad`, `KeepAlive`) |
| Linux | `~/.config/systemd/user/astack-daemon-<id>.service`; run `loginctl enable-linger` yourself to keep it after logout |

Stop or remove it with `astack daemon stop` and `astack daemon uninstall-service`.

### 3. Aramin console

```bash
astack console open            # daemon running: the browser opens signed in
astack console start --open    # no daemon: run it in this terminal
astack console token           # manual sign-in at http://127.0.0.1:7717
```

Phone access, installing as an app and the security model:
[Aramin Console](Aramin-Console.md#how-to-sign-in).

### 4. Gateway (Telegram)

1. Create a bot with @BotFather and copy its token.
2. Store the token outside every file AStack writes in plaintext:
   ```bash
   astack secret vault set credential://telegram/bot     # hidden prompt (Windows DPAPI by default on Windows)
   ```
   or register it as an environment variable:
   `astack secret register credential://telegram/bot`, then set
   `ASTACK_CRED_TELEGRAM_BOT` in the daemon's environment.
3. Allowlist your numeric Telegram user id (not your @username):
   `astack gateway owner add telegram <id>`. Add every account you use; each is
   the owner.
4. Turn it on in `astack.config.yaml`:
   ```yaml
   gateway:
     enabled: true
     channels:
       telegram:
         enabled: true
   ```
5. Check and restart:
   ```bash
   astack gateway test telegram
   astack daemon stop && astack daemon start      # or: astack gateway serve (foreground)
   ```

WhatsApp works through a self-hosted wapi-compatible gateway
(`whatsapp-wapi`), AStack's own linked-device bridge (`whatsapp-bridge`, pair a
separate bot number with `astack gateway whatsapp setup` and
`astack gateway whatsapp pair`) or the Meta Cloud API (`whatsapp-cloud`). For
voice notes: `astack schedule policy allow-command python`, then
`astack gateway voice setup`. Everything is in [Gateway](Gateway.md).

### 5. Search, skills and the rest

```bash
astack search reindex                 # first index; the daemon refreshes it every 15 minutes
ollama pull bge-m3                    # optional: semantic search
astack skill pack list                # the shipped Hermes pack, below the built-in skills
astack secret vault status            # which vault backends are real on this machine
astack sandbox status                 # Docker available?
```

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
