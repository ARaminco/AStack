# Security scan: hermes

Static scan by `skill-hub/scanner.mjs` (patterns only; nothing was executed).
Risk is the worst finding of a skill: low, medium, high (needs review) or blocked (never selectable).

| Risk | Skills |
| --- | --- |
| low | 187 |
| medium | 7 |
| high | 17 |
| blocked | 0 |

Skills with scripts: 61. Every one of them is marked `requiresReview`; scripts are never run by import or selection.

## High and blocked findings (101)

| Skill | Severity | Rule | File:line | Excerpt |
| --- | --- | --- | --- | --- |
| actual-setup | high | pipe.curl-sh | SKILL.md:41 | ('curl -fsSL "https://actual.inc/install" \| bash') and completed device |
| antigravity-cli | high | pipe.curl-sh | references/cli-docs.md:9 | - macOS/Linux: 'curl -fsSL https://antigravity.google/cli/install.sh \| bash' |
| antigravity-cli | high | pipe.iwr-iex | references/cli-docs.md:10 | - Windows PowerShell: 'irm https://antigravity.google/cli/install.ps1 \| iex' |
| axolotl | high | pipe.curl-sh | references/other.md:310 | curl -LsSf https://astral.sh/uv/install.sh \| sh |
| claude-code | high | destructive.fork-bomb | SKILL.md:641 | "hooks": [{"type": "command", "command": "if echo \"$CLAUDE_TOOL_INPUT\" \| grep -qE 'rm -r |
| godmode | high | injection.jailbreak | references/jailbreak-templates.md:1,5,10,126 | # GODMODE CLASSIC — Jailbreak System Prompt Templates |
| godmode | high | injection.jailbreak | scripts/auto_jailbreak.py:3,5,391,424,429,470,471,472,473,479,481,503,… (18 lines) | Auto-Jailbreak Pipeline |
| godmode | high | injection.jailbreak | scripts/godmode_race.py:313,401,403 | jailbreak_system: Optional jailbreak system prompt (from GODMODE CLASSIC) |
| godmode | high | injection.jailbreak | SKILL.md:10,34,39,41,56,70,79,115,133,184,295,334,… (20 lines) | tags: [jailbreak, red-teaming, G0DM0D3, Parseltongue, GODMODE, uncensoring, safety-bypass, |
| godmode | high | injection.you-are-now | SKILL.md:347 | forget, pretend, roleplay, act as, you are now, new identity |
| grok | high | pipe.curl-sh | SKILL.md:37 | - The official installer 'curl -fsSL https://x.ai/cli/install.sh \| bash' also |
| hermes-agent | high | exfil.capture-service | references/troubleshooting.md:44 | - "*.ngrok-free.app" |
| hermes-agent | high | pipe.curl-sh | SKILL.md:49 | curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash |
| huggingface-hub | high | pipe.curl-sh | SKILL.md:18 | * **Installation:** 'curl -LsSf https://hf.co/cli/install.sh \| bash -s' |
| inference-sh-cli | high | pipe.curl-sh | references/authentication.md:6,44 | curl -fsSL https://cli.inference.sh \| sh |
| inference-sh-cli | high | pipe.curl-sh | references/cli-reference.md:6 | curl -fsSL https://cli.inference.sh \| sh |
| inference-sh-cli | high | pipe.curl-sh | SKILL.md:40 | curl -fsSL https://cli.inference.sh \| sh |
| lambda-labs | high | pipe.curl-sh | references/troubleshooting.md:148,196 | wget -nv -O- https://lambdalabs.com/install-lambda-stack.sh \| sh - |
| notion | high | pipe.curl-sh | SKILL.md:39 | curl -fsSL https://ntn.dev \| bash |
| obliteratus | high | injection.jailbreak | references/analysis-modules.md:159 | # jailbreak — Refusal circuit localization |
| obliteratus | high | injection.jailbreak | references/methods-guide.md:48,52 | - **Directions:** 8+ (whitened SVD + jailbreak-contrastive) |
| obliteratus | high | injection.jailbreak | SKILL.md:118,126 | \| Stubborn refusals persist \| 'aggressive' \| Whitened SVD + head surgery + jailbreak \| |
| obliteratus | high | injection.jailbreak | templates/analysis-study.yaml:2,16 | # Usage: obliteratus run this-file.yaml --preset jailbreak |
| parallel-cli | high | pipe.curl-sh | SKILL.md:67 | curl -fsSL https://parallel.ai/install.sh \| bash |
| qmd | high | pipe.curl-sh | SKILL.md:44 | curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - |
| unsloth | high | pipe.curl-sh | references/llms-full.md:1029,7590,7843,8062,8385,8708,8929,9277,9557,9625,10012,10312,… (16 lines) | wget -qO- https://raw.githubusercontent.com/unslothai/unsloth/main/unsloth/_auto_install.p |
| unsloth | high | pipe.curl-sh | references/llms-txt.md:188,1263,3543,3754,3975,4475,4594,5291,5927,7141,7814,11481 | curl -fsSL https://ollama.com/install.sh \| sh |
| web-pentest | high | exfil.capture-service | SKILL.md:247 | webhook.site for sensitive engagements — exfil paths). |
| xurl | high | pipe.curl-sh | SKILL.md:59 | curl -fsSL https://raw.githubusercontent.com/xdevplatform/xurl/main/install.sh \| bash |

## Skills that need review before use

- claude-code (high)
- hermes-agent (high)
- notion (high)
- xurl (high)
- antigravity-cli (high)
- grok (high)
- actual-setup (high)
- inference-sh-cli (high)
- lambda-labs (high)
- huggingface-hub (high)
- obliteratus (high)
- axolotl (high)
- unsloth (high)
- parallel-cli (high)
- qmd (high)
- godmode (high)
- web-pentest (high)

## Local overrides

`OVERRIDES.json` (written by the AStack maintainers, kept across re-imports) blocks these skills. Their files stay in the folder
but they are never listed, searched or offered to an agent:

- godmode: LLM jailbreak toolkit (GODMODE / Parseltongue): its purpose is to bypass model safety rules. Blocked by the AStack 3.0 security review.
- obliteratus: Removes refusal behaviour from model weights (abliteration). Blocked by the AStack 3.0 security review.
