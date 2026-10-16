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
  ["git status", "allow"], ["crontab -l", "allow"], ["astack approval pending", "allow"], ["composer install", "allow"], ["npm test", "allow"]
];
