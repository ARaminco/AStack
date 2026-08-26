# Tool System

Every capability an agent can use is a manifest in one registry.

## Manifest

```json
{
  "id": "browser",
  "capabilities": ["browse", "login", "form-fill", "extract", "screenshot"],
  "status": "implemented",
  "riskLevel": "L3",
  "permissions": ["network", "filesystem-workspace"],
  "requiredCredentials": [],
  "costClass": "medium",
  "latencyClass": "slow",
  "supportsDryRun": true,
  "supportsRollback": false,
  "actions": [{ "name": "run", "risk": "L3", "params": ["profile", "url", "steps"] }]
}
```

`status` is honest by contract: `implemented`, `experimental`, `adapter-ready`,
`mock-only` or `future`. Invoking an adapter-ready tool returns a clear refusal,
never a fabricated result.

## Progressive discovery

```bash
astack tool catalog --budget 500   # one line per tool
astack tool search "form-fill"     # capability search
astack tool inspect browser        # full manifest, on demand
```

## Gated invocation

`ToolRegistry.invoke()` is the only path to a tool, so every call passes through
the same gates: tool status, authority evaluation, approval requirement, dry run
handling, execution, then an audit record with duration and result.

## Adding an integration

```js
tools.register({ id: "crm", status: "implemented", riskLevel: "L3",
  capabilities: ["contacts"], actions: [{ name: "find", risk: "L1" }] });
tools.registerHandler("crm", "find", async (params) => ({ ok: true, data: await lookup(params) }));
```

Custom manifests live in `.astack/tools/` and survive upgrades.

## Shipped tools

| Tool | Status |
| --- | --- |
| context, memory, graph, scheduler, agents, project | implemented |
| browser, http, filesystem, shell | implemented |
| documents, email, messaging, database, ssh | adapter-ready |
| computer (desktop control) | future |
