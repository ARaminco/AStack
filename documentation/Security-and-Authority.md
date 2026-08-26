# Security and Authority

## Authority levels

| Level | Meaning |
| --- | --- |
| L0 | no external action |
| L1 | read and search only |
| L2 | create a draft |
| L3 | modify or fill, never commit |
| L4 | commit only with owner approval |
| L5 | approved autonomous execution |

The **ceiling** is the highest level that may run on its own in a scope.
Anything above it is escalated to the owner, not silently dropped. A level on
the **deny** list is refused outright.

```bash
astack authority show
astack authority default L3
astack authority set domains legal L1
astack authority set sites portal.example.gov L3
astack authority check "submit the return" --level L4 --site portal.example.gov
```

## Automation policy

Background jobs and webhook reactions run unattended, so they are the strictest
surface:

- shell commands are denied unless allowlisted (`node`, `npm`, `git`, `astack`
  by default; `rm`, `curl`, `powershell` and similar are always denied),
- private network targets are denied by default,
- reactions are limited to an allowlist of actions.

```bash
astack schedule policy
astack schedule policy allow-command ffmpeg
astack schedule policy allow-host portal.example.gov
```

## Secret broker

Agents, skills, memories, prompts and logs only ever see a reference:

```bash
astack secret register credential://portal/company-a --site portal.example.gov
# value goes in the environment, never in a file AStack writes
export ASTACK_CRED_PORTAL_COMPANY_A="..."
astack secret check credential://portal/company-a
```

The value is resolved at the moment of use, inside the tool that needs it, and
every resolution is audited with a fingerprint rather than the value.

## Untrusted content and prompt injection

The trust hierarchy is explicit:

1. system policy,
2. owner instruction,
3. trusted skill instruction,
4. external content — web pages, documents, inbound messages.

External content is data. It is redacted, scanned for instruction shaped
patterns and quarantined before it can reach memory, a skill or another agent.
Nothing in category 4 can raise its own authority.

## Boundaries

- Filesystem access is scoped to the workspace; path escapes are refused.
- Every external action produces an audit record.
- High risk writes require approval by default.
- Dry run is available for missions, browser flows and tool calls.
