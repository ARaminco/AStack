# Architecture Decisions

- AStack is modular by default: skills, roles, workflows, templates, memory, browser, config, plugins, documentation, tests, scripts, system policy, locales, and lib remain independently usable.
- Instructions stay Markdown-first so Claude Code, OpenAI Codex, ChatGPT, and future agents can read them without custom runtime dependencies.
- User-facing agent communication is Persian by default while generated software assets remain English.
