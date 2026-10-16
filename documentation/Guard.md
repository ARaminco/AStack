# Guard (3.5.0)

`bin/astack-guard.mjs` is a Claude Code PreToolUse hook that `astack setup`,
`astack update` and `astack interop sync` install in `.claude/settings.json`
(matcher `Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit`). It works in
every permission mode, `bypassPermissions` included. Rules adapted from
gstack's careful/freeze hooks (MIT, see `NOTICE`).

## Decisions

| Decision | Examples |
| --- | --- |
| deny | recursive delete of `/`, `~`, `$HOME`, `/home/<user>`, `/etc`, `/var`, `/var/www`, a drive root (`C:\`, Git Bash `/c/`, WSL `/mnt/c/`) or the user profile (`C:\Users\<user>`, `/c/Users/<user>`, `~\`, `$HOME\*`), also through `Get-ChildItem … \| Remove-Item`; force-push or delete of `main`, `master`, `production`, `prod`; `pm2 restart\|reload\|stop\|delete\|sendSignal all` or a `/regex/` name, `pm2 kill`; disk formatting and erasing (`mkfs`, `format C:`, `Format-Volume`, `Clear-Disk`, `wipefs -a`, `sgdisk -Z`, `parted … rm\|mklabel`, `shred`/`blkdiscard`/`dd of=`/any redirect or `tee` to `/dev/sd*`, `/dev/nvme*` …); a fork bomb; an agent running `astack approval approve\|decide` or writing `.astack/approvals/` |
| ask | recursive delete outside build and temp folders; `git reset --hard`, `git clean -f`, `git checkout .`, `git restore .`, `git branch -D`, other force-pushes; `DROP`, `TRUNCATE`, `DELETE` without `WHERE` in a database client, MongoDB `dropDatabase()`/`drop()`/`deleteMany({})`, `redis-cli FLUSHALL\|FLUSHDB`, `mysqladmin drop`, `dropdb`; `migrate:fresh\|refresh\|reset\|rollback`, `db:wipe`; `pm2 update`; partitioning tools; Docker prunes and `down -v`; service stops; firewall flushes; `crontab -r`; `astack guard off\|unfreeze`; edits to `.claude/settings*.json` or `.astack/guard/` |
| allow | everything else, including `rm -rf node_modules dist .next vendor`, lock files, `/tmp/…`, `git restore --staged .`, `astack approval reject`, and dangerous phrases that are only mentioned (`echo`, `grep`, commit messages, heredocs given to programs that are not shells) |

Commands are parsed, not pattern-matched: quotes, chains, pipes, groups, shell
keywords (`if`, `for`, `while`, `case`, functions), heredocs, command
substitution (`$(…)`, backticks), prefixes (`sudo`, `env`, `timeout`, `setsid`,
`flock`, `systemd-run`, `busybox`, `command -p` …) and wrappers (`bash -c`,
`su -c`, `ssh host "…"` with switches before or after the host, `eval`,
`docker exec`, `kubectl exec`, `wsl`, PowerShell `-Command`/`-EncodedCommand`
in any prefix or `-Name:value` form and with `& { … }` script blocks, `iex`,
`Start-Process`, `cmd /c`, `xargs`, `find -exec`/`-delete`,
`npx`/`pnpm exec`/`npm run`, `echo … | sh`) are unwrapped, paths are
normalised (`/tmp/..` is `/`), and each inner command is judged by its program
and arguments. A heredoc or here-string is data for most programs, but its
body is judged as commands when it feeds a shell: `bash <<EOF`, `sh -s <<EOF`,
`ssh srv <<EOF`, `ssh srv bash -s <<EOF`, `docker exec -i app sh <<EOF`,
`cat <<EOF | sh`, `bash <<< '…'`. SQL piped or heredoc'd into a database client
is checked too.

Approvals are the owner's: the owner approves from the console, the gateway or
a terminal of their own; an agent's attempt is refused, and so is any shell
write or edit under `.astack/approvals/` (forging an approval record).
Rejecting (`astack approval reject`) is always allowed.

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

- The guard is a safety net against mistakes, not a sandbox. It cannot judge
  reliably, and lets through or only asks about:
  - scripts run from a file: a script written now and run later, `bash
    deploy.sh`, `ssh srv 'bash -s' < deploy.sh` (a file redirect, not a
    heredoc), `powershell -File x.ps1`;
  - code in other interpreters: `python -c`, `node -e`, `perl -e`, `php -r`,
    `ruby -e`, and .NET calls such as `[IO.Directory]::Delete('C:\', $true)`;
  - downloaded code: `curl … | bash`, `iwr … | iex`;
  - indirection: shell aliases and functions defined elsewhere, git aliases,
    `trap '…' EXIT`, and dangerous values hidden in variables (`X=/; rm -rf
    $X` asks because the target is unknown);
  - expansions: brace and glob forms such as `rm -rf {/,x}` or `rm -rf /?*`
    ask rather than deny, because the guard does not expand them.

  The contract's trust rules still apply.

- Freeze bounds the edit tools; shell commands are judged by the rules above
  (a redirect such as `echo > other/x` is not blocked by a freeze).
- Decisions are logged in `.astack/guard/events.jsonl` with passwords and
  tokens redacted; `.astack/guard/` is kept out of git.
- `guard.enabled: false` in `astack.config.yaml` removes the hook on the next
  sync. If node is missing the hook cannot run and Claude Code continues
  without it.
- Codex has no PreToolUse hook yet; there the contract's trust rules apply.
