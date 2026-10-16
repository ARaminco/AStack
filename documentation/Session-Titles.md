# Chat Titles

AStack keeps Claude Code chat titles clear and consistent, so the owner can find
the chat that already holds a client, a case or a system and continue it,
instead of opening a new one.

## How it works

1. **Watching.** `astack setup` / `astack interop sync` add a `UserPromptSubmit`
   hook to `.claude/settings.json` (`bin/astack-title-hook.mjs`, a light entry
   point that loads only this engine and the configuration). On every
   prompt it updates a few counters per session under
   `~/.astack/session-titles/sessions/`. It reads the transcript only when a
   step could be due, so long chats stay fast.
2. **Naming.** After `first_after_turns` prompts (or `first_after_minutes`) a chat
   that is still on Claude Code's automatic title gets a short instruction in
   front of the agent. The agent already knows what the chat is about, so it
   names the chat itself with the `astack_session_title` MCP tool or
   `astack session title`. A reminder that is not acted on is repeated a few
   prompts later, at most `max_nudges` times.
3. **Re-checking.** At each of `recheck_turns` the agent is asked once whether
   the title still fits; it changes it only when the subject has moved. An
   ignored check is not repeated.
4. **Earlier chats.** On the first prompt of a new chat the hook compares the
   request with the titles of the project's other chats. When a client name, a
   case number or another rare subject word matches, the agent tells the owner
   in one line which earlier chat holds that subject.
5. **Phone and web.** A chat opened through Remote Control also exists on
   claude.ai, and the phone shows *that* title. AStack updates it through the
   same endpoint Claude Code's own `/rename` uses, with the Claude Code sign-in
   on this machine (`~/.claude/.credentials.json`, read only inside the call,
   never printed or stored). `astack session sync` re-sends every AStack title;
   a chat the owner renamed since is left alone.

## Every chat on the machine

Projects without AStack (or with an older core) have no project hook. One
user-level hook covers them all:

```bash
astack session hook install      # adds it to ~/.claude/settings.json (backup first)
astack session hook status
astack session hook remove
```

It runs the canonical core (`~/.astack/core`, kept current by `astack update`)
with `--scope=user`. In a project whose `.claude/settings.json` has AStack's own
prompt hook, the user hook stays silent and the project hook (with the
project's `hint`) answers, so no chat is counted twice. Without the astack MCP
server the agent uses the CLI command printed in the reminder.

## Title rules

- `«<subject> · <what is being done>»`, plain language (`session_titles.language`),
  3–8 words, at most `max_length` (60) characters.
- The subject is what the owner would search for: project, client, case, site or
  system, spelled the way the owner spells it.
- Legal work: the party or case label first; a court or case number only with a
  short label next to it and only when it appears in the chat; never an amount.
- Latin only for domains, repository names and IDs, never as the first or last
  word. No passwords, tokens, card or account numbers (refused by the engine).
- `session_titles.hint` adds a project-specific rule, for example in a legal
  practice: `"client or party · court number · task"`.

## Safety

- The engine appends the same `{"type":"custom-title"}` record that `/rename`
  writes. It never edits or truncates a transcript line, and it keeps the file's
  dates so chat lists keep their order.
- A custom title AStack did not write is the owner's and is never replaced
  without `--force`.
- Every rename is recorded in `~/.astack/session-titles/history.jsonl`;
  `astack session undo --batch=<id>` or `--session=<id>` restores the old titles
  (and only those phone copies). A chat renamed since is left as it is, and a
  restored owner title is the owner's again.
- Sessions belong to the machine, not to one project: every AStack install on
  the machine shares the same history, so a title written from one project is
  recognised by all.

## Renaming existing chats

```bash
astack session list --weak --all                  # automatic or missing titles
astack session digest --weak --project <slug> --out digest.json
# the agent reads digest.json and writes titles.json: [{ "id": "...", "title": "..." }]
astack session apply titles.json --dry-run
astack session apply titles.json                  # also updates the phone copies
```

## Limits

- Claude Code only. Codex threads are not renamed yet.
- The phone copy needs a valid Claude Code sign-in on this machine; when it has
  expired, open Claude Code once and run `astack session sync`.
- The endpoint is the one the Claude Code client uses; if it changes, local titles
  still work and `sync` reports the server's answer.
