### Skill hub (P4)

- New `skill-hub/` engine (`runtime.skillHub`): imports agentskills.io / Anthropic
  `SKILL.md` skills from a local folder, a git URL or a GitHub `owner/repo/path`
  into auxiliary packs under the new managed directory `skill-packs/`.
- Static security scanner (`skill-hub/scanner.mjs`): prompt injection, hidden
  text, pipe-to-shell, credential access, exfiltration, destructive commands,
  obfuscation and binaries, with `file:line` findings and a `low | medium | high |
  blocked` risk per skill. Scripts are never executed; a skill with scripts
  requires review.
- Skill catalog integration (append-only): pack skills carry
  `source: "pack:<pack>"`, rank below built-in and learned skills
  (`skills.packs.weight`, default 0.6), blocked skills are never selectable, and
  `skills.packs.enabled: false` restores the previous output byte for byte.
- `astack ask` lists catalog skills with auxiliary pack skills below built-ins
  while packs are enabled.
- New commands: `astack skill pack list|search|show|import|scan|remove|updates`,
  `astack skill catalog --packs`, `astack skill curate [--apply]`.
- Skill curator: usage, last use, success rate, cross-source duplicates and
  keep / refine / retire recommendations; changes only with `--apply`, never
  touches built-in skills, never deletes files.
- `skill-hub/service.mjs` for the daemon: optional update check of git-sourced
  packs (check only).
- New auxiliary pack `skill-packs/hermes/`: 211 skills from NousResearch/hermes-agent
  (MIT), with `PACK.md`, `SCAN.md`, `LICENSE` and `compat: hermes-runtime` labels.
- Doctor prints a `Skill packs:` line. New test suite `tests/verify-skillhub.mjs`.
