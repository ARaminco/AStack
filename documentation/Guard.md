# Guard (3.5.0)

`bin/astack-guard.mjs` is a Claude Code PreToolUse hook that `astack setup`,
`astack update` and `astack interop sync` install in `.claude/settings.json`
(matcher `Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit`). It works in
every permission mode, `bypassPermissions` included. Rules adapted from
gstack's careful/freeze hooks (MIT, see `NOTICE`).

## Decisions

| Decision | Examples |
| --- | --- |
| deny | recursive delete of `/`, `~`, `$HOME`, `/home`, `/etc`, `/var`, `/var/www`, a drive root or the user profile; force-push or delete of `main`, `master`, `production`, `prod`; `pm2 restart\|reload\|stop\|delete all`, `pm2 kill`; `mkfs`, `format C:`, `dd of=/dev/…`; an agent running `astack approval approve\|decide` |
| ask | recursive delete outside build and temp folders; `git reset --hard`, `git clean -f`, `git checkout .`, `git branch -D`, other force-pushes; `DROP`, `TRUNCATE`, `DELETE` without `WHERE` in a database client; `migrate:fresh`, `db:wipe`; Docker prunes and `down -v`; service stops; firewall flushes; `crontab -r`; `astack guard off\|unfreeze`; edits to `.claude/settings*.json` or `.astack/guard/` |
| allow | everything else, including `rm -rf node_modules dist .next vendor`, lock files, `/tmp/…`, and dangerous phrases that are only mentioned (`echo`, `grep`, commit messages, heredocs) |

Commands are parsed, not pattern-matched: quotes, `;`, `&&`, `|`, heredocs,
`sudo`/`env`/`timeout` prefixes and wrappers (`bash -c`, `sh -c`, `ssh host
"…"`, `eval`, `docker exec`, `kubectl exec`, `powershell -Command`, `cmd /c`,
`xargs`) are unwrapped, and each inner command is judged by its program and
arguments.

Approvals are the owner's: the owner approves from the console, the gateway or
a terminal of their own; an agent's attempt is refused.

## Commands

```bash
astack guard status
astack guard check git push --force origin main     # the verdict for a command
astack guard freeze src/payments                    # edits only inside this folder
astack guard unfreeze
astack guard off | on                               # per project
astack guard log --limit 20
```

## Notes

- Freeze bounds the edit tools; shell commands are judged by the rules above
  (a redirect such as `echo > other/x` is not blocked by a freeze).
- Decisions are logged in `.astack/guard/events.jsonl` with passwords and
  tokens redacted; `.astack/guard/` is kept out of git.
- `guard.enabled: false` in `astack.config.yaml` removes the hook on the next
  sync. If node is missing the hook cannot run and Claude Code continues
  without it.
- Codex has no PreToolUse hook yet; there the contract's trust rules apply.
