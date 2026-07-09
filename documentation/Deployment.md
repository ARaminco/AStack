# Deployment

AStack is currently a local Markdown-first agent operating system. Deployment means distributing the repository to the machine or agent environment that will use it.

## Release Checklist
- Run `npm test`.
- Confirm `astack.config.yaml` has no secrets.
- Confirm `locales/` includes all supported locales.
- Confirm memory files contain intentional project facts.
- Tag the release in git.
- Publish or copy the repository to the target agent environment.
