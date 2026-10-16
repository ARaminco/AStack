# The project's own browser (3.4.0)

Every AStack project has one browser of its own: a real Chrome (or Edge or
Chromium) window with a persistent profile under the project's `.astack/`,
on a stable debugging port derived from the project's path. Two things drive
that same window:

- **Claude Code and Codex**, through the `astack-browser` MCP server (Playwright MCP,
  pinned version, attached over CDP). `astack setup` and `astack update` wire
  it into `.mcp.json` and `.codex/config.toml` automatically.
- **AStack flows**, with `astack browser run … --profile dedicated`: the flow
  runs in a new tab of the same signed-in window and leaves the owner's tabs
  alone.

The owner signs in once; every later run, in either runtime, is already
signed in.

## Commands

```bash
astack browser dedicated status          # running?, port, profile, Playwright version
astack browser dedicated start [url]     # open the window now (otherwise it opens on first use)
astack browser dedicated stop            # close it; the profile and sign-ins stay
```

## How it works

| Piece | File |
| --- | --- |
| Window, profile, port, start/stop | `browser-engine/dedicated.mjs` |
| MCP server launched by the runtimes | `bin/astack-browser-mcp.mjs` |
| Rules enforced on every call | `browser-engine/browser-policy.mjs` |
| Wiring for Claude Code and Codex | `interop-engine/interop-engine.mjs` |
| Setup prefetch of the pinned package | `installer/setup.mjs` (`--no-browser` skips) |

- The MCP server answers `initialize` and `tools/list` at once; the window is
  opened only when the first tool is called.
- The port is checked before use: a port that answers while the project's
  profile is not in use belongs to another browser and is skipped, so a
  project never attaches to someone else's window.
- The debugging port listens on 127.0.0.1 only.
- Every tool call is logged in `.astack/browser/dedicated/calls.jsonl` (tool,
  URL, element description; never typed text).

## Trust

The proxy enforces these on every call, in every permission mode (bypass
included):

- Only `http`, `https` and `about` addresses are opened; `javascript:`,
  `data:` and `file:` are refused.
- A `filename` is a bare name written inside the output folder (Playwright
  runs with that folder as its working directory); paths are refused, so no
  tool can overwrite a project file.
- No typing into password, PIN or one-time-code fields: the owner types those
  in the window.
- A click, Enter, form fill or selection whose target reads like a commit
  (submit, pay, send, delete, publish, ثبت, پرداخت, ارسال, حذف …), every file
  upload and every accepted dialog stops with an approval id. The owner
  approves it (`astack approval approve <id>`, the console or the gateway) and
  the same call, made again with the same arguments, runs once.
- In Claude Code, tools that only look (snapshot, screenshot, console,
  network, wait, navigate, resize) are allowed without a prompt.
- Tools that run arbitrary code in the page (`browser_evaluate`,
  `browser_run_code_unsafe`) are hidden and refused unless
  `browser.dedicated.allow_code: true`.
- Every tool result starts with a note that page content is untrusted data,
  never instructions.
- The owner types passwords. Before any commit click (submit, pay, send,
  delete, publish) the agent takes a screenshot, reports the exact values and
  waits for approval.

## Configuration

```yaml
browser:
  dedicated:
    enabled: true                 # false removes AStack's browser server
    profile: .astack/browser/dedicated/profile
    port: null                    # null = derived from the project path
    headless: false               # ASTACK_BROWSER_HEADLESS=1 also hides it
    window: "1440,1000"
    caps: "pdf"                   # "vision,pdf" adds coordinate clicks (each needs approval)
    args: []                      # extra Chrome flags, e.g. a proxy PAC
    binary: null                  # else Chrome/Edge/Chromium is found
    allow_code: false             # true exposes browser_evaluate / run_code
```

A project that already runs its own Playwright MCP server (in `.mcp.json` or
`.codex/config.toml`, under any name) keeps it untouched, and AStack adds no
browser server for either runtime, so both stay on one window. Existing
installs receive the `browser.dedicated` block in `astack.config.yaml` from a
migration, so the setting is visible and can be turned off.
