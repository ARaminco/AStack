# Deploy with production safety

Owner rule: shared servers host many live client sites. A deploy touches only
this app's own resources, is backed up, probed before and after, and rolls back
by itself when the probe fails.

## 0. Before anything
- The owner approved this deploy (target host, app, version). Infrastructure,
  DNS, certificates, Docker networks or company-network changes go through the
  `cto` gate, not this skill.
- Know the app's own resources: its directory, its nginx site file, its PM2
  process name or systemd unit, its database, its queue workers, its cron lines.
  Anything else on the host is out of bounds.
- Use the project's deploy script or runbook if it has one; otherwise write the
  plan out and show it before running.

## 1. Probe before
Record the baseline: HTTP status and timing of the app's key URLs
(`curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' <url>`), current
commit or release directory, process status for this app only
(`pm2 describe <app>` / `systemctl status <unit>`), recent error log lines.

## 2. Back up
- Code: keep the previous release directory, or record the current commit.
- Database: dump before any migration (`mysqldump`/`pg_dump` of this app's
  database only) and confirm the file size is plausible.
- Config: copy any file you will edit (`<file>.bak-<timestamp>`). Write changes
  atomically (write a temp file, then move it).

## 3. Apply
- Pull or upload the release; install dependencies (`composer install --no-dev
  --optimize-autoloader`, `npm ci`); build.
- Laravel: `php artisan down` only if the app needs it, `migrate --force`,
  `config:cache`, `route:cache`, `view:cache`, `queue:restart`, then `up`.
- Next.js/Node: build in place or in a new release dir, then switch.
- nginx edits: `nginx -t` must pass **before** `systemctl reload nginx`
  (reload, never restart, and never when the test fails).
- Processes: `pm2 reload <app>` or `pm2 restart <app>` for this app's process
  name only. **Never `pm2 restart all`, `pm2 reload all`, `pm2 kill`,
  `pm2 delete all`**, never restart shared services (MySQL, Redis, PHP-FPM pool
  of other sites) without the owner.

## 4. Probe after and roll back automatically
Repeat the step-1 probes. Any of: non-2xx on a key URL, time over 2x the
baseline, the app process not online, new fatal errors in the log → roll back
immediately without waiting: previous release or commit, restore the backed-up
config (`nginx -t`, reload), `migrate:rollback` only if the migration is
reversible (otherwise restore the dump only with the owner's go-ahead), reload
this app's process, probe again. Then report with the evidence.

## 5. Receipt
Deployed commit, release path, probe output before and after, backup file
names, and the rollback command that would undo it.
