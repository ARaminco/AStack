# API

AStack exposes a local CLI rather than a network API.

## CLI Contract
```bash
node bin/astack.mjs <command>
```

Commands return:
- command name
- localized purpose
- skill files to load
- localized execution protocol

Supported commands are defined in `astack.config.yaml` under `cli.commands` and mirrored in the CLI runtime.
