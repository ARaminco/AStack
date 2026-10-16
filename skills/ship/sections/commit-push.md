# Commit and push

## Commit
1. Check staged content before every commit:
   `git diff --cached --stat` and a scan for secrets (`.env`, keys, tokens,
   `credential` values, private keys, large binaries). Anything suspicious stops
   the commit.
2. Group changes so each commit works on its own: infrastructure → models and
   services → controllers and views; tests with the code they test; migrations
   alone or with their model. Under 50 lines in fewer than 4 files may be one
   commit.
3. Version and CHANGELOG go in the last commit.
4. Message: `<type>: <summary>` (feat, fix, chore, refactor, docs, test) and a
   short body; end with the attribution lines the runtime requires. No empty
   commits; never amend a commit that is already pushed.

## Push (after the owner's approval)
1. `git status` clean except files the owner keeps local; branch tracks the
   intended remote. Never push to a remote the project marks as public when the
   repository is private (check the project's rules and risks first).
2. `git push <remote> <branch>`; on a first push `-u`. **Never** `--force`,
   `--force-with-lease`, or `--no-verify`. A rejected push (non-fast-forward,
   hook failure, protection) is reported with its output; fix the cause, do not
   bypass it.
3. Receipt: the pushed SHA (`git rev-parse HEAD`) and `git ls-remote <remote>
   <branch>` showing the same SHA.
4. Pull request: create it only if the project uses them; title with the
   version; body with summary, test summary lines, review result, gate edits and
   docs status. Keep it a draft while any gate finding is open.
5. Tags or releases are separate irreversible actions: create them only when
   the owner asked for them.
