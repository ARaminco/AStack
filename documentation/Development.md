# Development

## Requirements
- Node.js 20 or newer.

## Commands
- `npm test`: verify required AStack modules, localization, skill packs, config, and CLI behavior.
- `npm run list:skills`: list installed skills.
- `node bin/astack.mjs /security-review`: print the localized protocol for a command.

## Adding A Skill
1. Create `skills/<id>/SKILL.md`.
2. Create `examples.md`, `rules.md`, and `checklist.md`.
3. Reference `../../system/language-policy.md`.
4. Keep user-facing skill instructions Persian.
5. Keep software assets and code comments English.
6. Add or update tests.
