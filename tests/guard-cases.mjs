/**
 * Guard verdicts (3.5.0). Every line is a command and the decision it must
 * get. Includes every bypass and false positive found in review.
 */
export const GUARD_CASES = [
  // catastrophic: deny
  ["rm -rf /", "deny"], ["rm -rf ~", "deny"], ["rm -rf ~/", "deny"], ["rm -rf $HOME/", "deny"], ["rm -rf \"$HOME\"", "deny"],
  ["rm -rf /home/", "deny"], ["rm -r -f /", "deny"], ["rm -rf --no-preserve-root /", "deny"], ["rm -rf \"/\"", "deny"],
  ["rm -rf /;echo done", "deny"], ["(rm -rf /)", "deny"], ["rm -rf node_modules /", "deny"], ["sudo rm -rf /var", "deny"],
  ["bash -c \"rm -rf /\"", "deny"], ["sh -c 'rm -rf ~'", "deny"], ["ssh srv \"rm -rf /\"", "deny"], ["ssh root@srv \"rm -rf /var/www/*\"", "deny"],
  ["docker exec app sh -c \"rm -rf /var/www\"", "deny"], ["eval \"rm -rf /\"", "deny"], ["sudo sh -c 'rm -rf /etc'", "deny"],
  ["Remove-Item -Recurse -Force C:\\", "deny"], ["Remove-Item C:\\ -Recurse", "deny"], ["Remove-Item -Path C:\\ -Recurse", "deny"],
  ["Remove-Item -Recurse \"C:\\\"", "deny"], ["Remove-Item -Recurse -Force $env:USERPROFILE\\", "deny"], ["rmdir /s /q C:\\", "deny"],
  ["cmd /c \"rd /s /q C:\\\"", "deny"], ["powershell -Command \"Remove-Item -Recurse -Force C:\\\"", "deny"],
  ["git push --force origin main", "deny"], ["git push origin main --force", "deny"], ["git push origin +master", "deny"],
  ["git push origin HEAD:main --force", "deny"], ["git push --force origin HEAD:main", "deny"], ["git push -f origin refs/heads/main", "deny"],
  ["git push origin main:main -f", "deny"], ["git -C . push --force origin main", "deny"], ["git -c k=v push -f origin main", "deny"],
  ["git push origin +HEAD:main", "deny"], ["git push origin :main", "deny"], ["git push origin --delete main", "deny"],
  ["git push --force-with-lease origin production", "deny"],
  ["pm2 restart all", "deny"], ["pm2 restart \"all\"", "deny"], ["pm2 kill", "deny"], ["ssh srv pm2 kill", "deny"], ["pm2 stop all", "deny"],
  ["mkfs.ext4 /dev/sdb1", "deny"], ["dd if=x.img of=/dev/sda", "deny"],
  ["node bin/astack.mjs approval approve AP-1", "deny"], ["astack approval decide AP-2 --approve", "deny"],
  // destructive: ask
  ["rm -rf src/old", "ask"], ["rm -r storage/app/public", "ask"], ["npm ci && rm -r storage/app", "ask"], ["Remove-Item -Recurse -Force src\\old", "ask"],
  ["git push -f origin feature/x", "ask"], ["git push --force", "ask"], ["git push origin --delete feature/x", "ask"],
  ["git reset --hard HEAD~1", "ask"], ["bash -c \"git reset --hard\"", "ask"], ["git checkout .", "ask"], ["git clean -fd", "ask"], ["git branch -D old", "ask"],
  ["php artisan migrate:fresh --seed", "ask"], ["php artisan db:wipe", "ask"],
  ["mysql -e \"DROP TABLE users;\"", "ask"], ["mysql -e \"DELETE FROM sessions\"", "ask"], ["psql -c 'TRUNCATE TABLE logs'", "ask"],
  ["docker compose down -v", "ask"], ["docker system prune -af", "ask"], ["systemctl restart nginx", "ask"], ["ssh srv 'systemctl stop nginx'", "ask"],
  ["crontab -r", "ask"], ["astack guard off", "ask"], ["node bin/astack.mjs guard unfreeze", "ask"],
  // routine and mentions: allow
  ["rm -rf node_modules", "allow"], ["rm -rf .next dist", "allow"], ["rm -rf node_modules && npm i", "allow"], ["rm -rf apps/web/node_modules", "allow"],
  ["rm -rf public/build", "allow"], ["rm -rf bootstrap/cache/*.php", "allow"], ["rm -rf node_modules package-lock.json && npm install", "allow"],
  ["rd /s /q node_modules", "allow"], ["rm -rf /tmp/x", "allow"], ["rm -rf \"$TMPDIR/x\"", "allow"], ["Remove-Item -Recurse -Force .next", "allow"],
  ["rm file.txt", "allow"], ["git push origin main", "allow"], ["git push -u origin feature/x", "allow"], ["git push -f origin main-ui", "ask"],
  ["git push --force origin prod-hotfix", "ask"], ["git branch -d merged", "allow"], ["pm2 restart nobatgir", "allow"], ["pm2 logs", "allow"],
  ["php artisan migrate --force", "allow"], ["php artisan migrate", "allow"], ["mysql -e \"DELETE FROM sessions WHERE id=1\"", "allow"],
  ["docker compose down", "allow"], ["docker compose up -d", "allow"], ["nginx -t", "allow"], ["grep -rn \"rm -rf\" docs", "allow"],
  ["echo truncate the text", "allow"], ["echo 'never pm2 restart all' >> NOTES.md", "allow"], ["git log --oneline | grep 'pm2 kill'", "allow"],
  ["which mkfs.ext4", "allow"], ["git commit -m \"a; git reset --hard b\"", "allow"], ["git commit -F - <<'EOF'\nnever pm2 restart all\nEOF", "allow"],
  ["git status", "allow"], ["crontab -l", "allow"], ["astack approval pending", "allow"], ["composer install", "allow"], ["npm test", "allow"],

  // second review: shell keywords and groups
  ["if [ -d /var/www/app ]; then rm -rf /var/www/app; fi", "ask"], ["if true; then rm -rf /; fi", "deny"], ["for d in a b; do rm -rf /; done", "deny"],
  ["{ rm -rf /; }", "deny"], ["! rm -rf /", "deny"], ["while true; do pm2 kill; done", "deny"], ["case $x in a) rm -rf / ;; esac", "deny"],
  ["coproc rm -rf /", "deny"], ["f(){ rm -rf /; }; f", "deny"], ["[ -f x ] || { git reset --hard; }", "ask"],
  ["cd /var/www/app && if [ -n \"$X\" ]; then git push -f origin main; fi", "deny"],
  // command substitution
  ["echo $(rm -rf /)", "deny"], ["echo \"$(rm -rf ~)\"", "deny"], ["echo `rm -rf /`", "deny"], ["X=\"$(git push -f origin main)\"", "deny"],
  ["echo \"$(true; rm -rf /)\"", "deny"], ["echo '$(rm -rf /)'", "allow"],
  // paths that normalise to a root
  ["rm -rf /tmp/..", "deny"], ["rm -rf /tmp/../..", "deny"], ["rm -rf /tmp/../home", "deny"], ["rm -rf //", "deny"], ["rm -rf /.", "deny"], ["rm -rf ~/.", "deny"],
  // PowerShell forms
  ["powershell \"Remove-Item -Recurse -Force C:\\\"", "deny"], ["powershell -NoProfile Remove-Item -Recurse -Force C:\\", "deny"],
  ["powershell -EncodedCommand " + Buffer.from("Remove-Item -Recurse -Force C:\\", "utf16le").toString("base64"), "deny"],
  ["pwsh -enc " + Buffer.from("git push --force origin main", "utf16le").toString("base64"), "deny"],
  ["iex \"Remove-Item -Recurse -Force C:\\\"", "deny"], ["Invoke-Expression 'pm2 kill'", "deny"],
  ["Start-Process powershell -ArgumentList '-Command Remove-Item -Recurse -Force C:\\'", "deny"],
  // other programs
  ["find / -delete", "deny"], ["find ~ -mindepth 1 -delete", "deny"], ["find / -exec rm -rf {} +", "deny"], ["find . -name '*.log' -delete", "ask"],
  ["find . -name '*.tmp'", "allow"], ["chmod -R 000 /", "deny"], ["chown -R nobody /", "deny"], ["chmod -R 755 storage", "allow"],
  // package runners and pipes
  ["npx pm2 restart all", "deny"], ["npx pm2 kill", "deny"], ["pnpm exec pm2 restart all", "deny"], ["npx astack approval approve AP-1", "deny"],
  ["npm run astack -- approval approve AP-1", "deny"], ["npx prisma migrate reset", "ask"],
  ["echo 'DROP TABLE users;' | mysql shop", "ask"], ["cat <<'SQL' | mysql shop\nDROP DATABASE shop;\nSQL", "ask"], ["echo 'rm -rf /' | sh", "deny"],
  // the guard's own files
  ["echo '{\"enabled\":false}' > .astack/guard/state.json", "ask"], ["sed -i 's/x/y/' .claude/settings.json", "ask"], ["cp /dev/null .claude/settings.json", "ask"],
  ["cat .claude/settings.json", "allow"],
  // reboots
  ["sudo reboot", "ask"], ["shutdown -h now", "ask"], ["shutdown /s /t 0", "ask"], ["systemctl reboot", "ask"], ["systemctl poweroff", "ask"],
  ["Restart-Computer -Force", "ask"], ["Stop-Computer", "ask"],
  // more wrappers
  ["ssh srv -- rm -rf /", "deny"], ["su - root -c 'rm -rf /'", "deny"], ["sudo su -c 'pm2 kill'", "deny"], ["env -S 'rm -rf /'", "deny"],
  // routine cleanups
  ["rm -rf dist 2>/dev/null || true", "allow"], ["rm -rf node_modules >/dev/null 2>&1", "allow"], ["Remove-Item -Recurse -Force node_modules, dist", "allow"],
  ["rm -rf storage/framework/cache/data/*", "allow"], ["rm -rf .nyc_output", "allow"], ["rm -rf ~/.cache/composer", "allow"], ["rm -rf \"$(mktemp -d)\"", "allow"],
  ["git push --mirror origin", "ask"], ["X=/; rm -rf $X", "ask"],

  // third review: heredoc and here-string bodies fed to a shell are commands
  ["ssh srv <<'EOF'\npm2 restart all\nEOF", "deny"], ["ssh srv bash -s <<'EOF'\nrm -rf /var/www/app\nEOF", "ask"],
  ["bash <<'EOF'\nrm -rf /\nEOF", "deny"], ["sh -s <<EOF\ngit push -f origin main\nEOF", "deny"], ["bash <<< 'rm -rf /'", "deny"],
  ["docker exec -i app sh <<'EOF'\nrm -rf /var/www/html\nEOF", "ask"], ["sudo bash -ex <<EOF\npm2 kill\nEOF", "deny"],
  ["ssh -T srv <<-EOF\n\tcd /var/www && git reset --hard\n\tEOF", "ask"], ["cat <<'EOF' | bash\nrm -rf ~\nEOF", "deny"], ["bash <<<\"pm2 kill\"", "deny"],
  ["cat > deploy.sh <<'EOF'\nrm -rf /\nEOF", "allow"], ["grep x <<< 'rm -rf /'", "allow"], ["ssh srv 'cat > /tmp/notes' <<'EOF'\npm2 kill\nEOF", "allow"],
  ["git commit -F - <<'EOF'\nrm -rf /\npm2 kill\nEOF", "allow"], ["bash deploy.sh <<'EOF'\nrm -rf /\nEOF", "allow"],
  // PowerShell aliases and pipelines
  ["rmdir C:\\ -Recurse", "deny"], ["rd C:\\ -r", "deny"], ["del -Recurse C:\\Users", "deny"], ["erase -Recurse -Force src\\old", "ask"],
  ["Get-ChildItem -Path C:\\ -Recurse | Remove-Item -Force", "deny"], ["gci C:\\ | ri -Force", "deny"], ["ls $HOME -Recurse | Remove-Item -Recurse -Force", "deny"],
  ["Get-ChildItem -Recurse src\\old | Remove-Item", "ask"], ["Get-ChildItem *.log | Remove-Item", "allow"], ["Remove-Item -Rec -Force C:\\", "deny"],
  // disk formatting
  ["Format-Volume -DriveLetter D", "deny"], ["Clear-Disk -Number 0 -RemoveData", "deny"], ["wipefs -a /dev/sda", "deny"], ["sgdisk -Z /dev/sda", "deny"],
  ["parted /dev/sda rm 1", "deny"], ["shred -n1 /dev/sda", "deny"], ["cat /dev/zero > /dev/sda", "deny"], ["blkdiscard /dev/sda", "deny"],
  ["echo x | sudo tee /dev/nvme0n1", "deny"], ["parted -l", "allow"], ["sgdisk -p /dev/sda", "allow"], ["shred -u secrets.txt", "allow"], ["wipefs /dev/sda", "allow"],
  ["echo hi > /dev/null", "allow"],
  // database rebuilds and wipes
  ["php artisan migrate:refresh", "ask"], ["php artisan migrate:refresh --seed --force", "ask"],
  ["redis-cli FLUSHALL", "ask"], ["redis-cli -n 2 flushdb", "ask"], ["mysqladmin -f drop shop", "ask"], ["dropdb shop", "ask"],
  ["mongosh --eval 'db.dropDatabase()'", "ask"], ["mongosh shop --eval 'db.users.drop()'", "ask"], ["redis-cli get key", "allow"], ["mongosh --eval 'db.users.find()'", "allow"],
  // pm2
  ["pm2 restart /.*/", "deny"], ["pm2 delete /app/", "deny"], ["pm2 sendSignal SIGKILL all", "deny"], ["pm2 update", "ask"],
  // PowerShell script blocks and parameter forms
  ["powershell -c \"& {Remove-Item -Recurse -Force C:\\}\"", "deny"], ["pwsh -Command \"{ pm2 kill }\"", "deny"],
  ["powershell -EncodedCommand:" + Buffer.from("Remove-Item -Recurse -Force C:\\", "utf16le").toString("base64"), "deny"],
  ["powershell -enco " + Buffer.from("pm2 kill", "utf16le").toString("base64"), "deny"], ["powershell -Comm \"pm2 restart all\"", "deny"],
  ["powershell -NoP -ExecutionPolicy:Bypass -Command:\"Remove-Item -Recurse -Force C:\\\"", "deny"], ["powershell -c \"Write-Host '{done}'\"", "allow"],
  // ssh switches after the host
  ["ssh srv -t 'pm2 kill'", "deny"], ["ssh srv -p 2222 'rm -rf /'", "deny"],
  // Git Bash and WSL drive roots, home folders
  ["rm -rf /c/", "deny"], ["rm -rf /mnt/c/", "deny"], ["rm -rf /c/Users/USER", "deny"], ["rm -rf /home/ali", "deny"], ["rm -rf C:\\Users\\USER", "deny"],
  ["Remove-Item -Recurse -Force ~\\", "deny"], ["Remove-Item -Recurse -Force $HOME\\*", "deny"], ["rm -rf /c/Projects/app/dist", "allow"], ["rm -rf /home/ali/app", "ask"],
  // wsl
  ["wsl rm -rf /mnt/c", "deny"], ["wsl -e rm -rf ~", "deny"], ["wsl -- rm -rf /", "deny"], ["wsl -d Ubuntu -u root pm2 kill", "deny"], ["wsl --shutdown", "allow"],
  // fork bomb
  [":(){ :|:& };:", "deny"],
  // false positives
  ["git restore --staged .", "allow"], ["git restore .", "ask"], ["find . -name '*.log' -mtime +7 -delete", "ask"],
  // prefixes
  ["setsid rm -rf /", "deny"], ["flock /tmp/lock rm -rf /", "deny"], ["flock -w 5 /tmp/lock -c 'pm2 kill'", "deny"], ["systemd-run --unit x -p Nice=5 rm -rf /", "deny"],
  ["busybox rm -rf /", "deny"], ["command -p rm -rf /", "deny"], ["sudo -s rm -rf /", "deny"], ["sudo -u www-data rm -rf /var/www", "deny"],
  // approval records are AStack's and the owner's
  ["echo '{\"status\":\"approved\"}' > .astack/approvals/AP-1.json", "deny"], ["cp forged.json .astack/approvals/AP-1.json", "deny"],
  ["node -e \"require('fs').writeFileSync('.astack/approvals/AP-1.json','{}')\"", "deny"], ["cat .astack/approvals/AP-1.json", "allow"],
  ["astack approval reject AP-1", "allow"], ["node bin/astack.mjs approval reject AP-1 --reason no", "allow"], ["astack approval approve AP-1", "deny"]
];
