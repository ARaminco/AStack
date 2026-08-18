# Departments

Departments are declared in `departments/departments.json` and are activated only by the Orchestrator — they never coordinate directly. Version 2 ships 33 departments across every practice area.

## Catalog

**Software and platform:** `engineering`, `ai-engineering`, `backend`, `frontend`, `mobile`, `devops`, `infrastructure`, `networking`, `cyber-security`, `database`, `architecture`, `qa`, `automation`

**Design and growth:** `ui`, `ux`, `seo`, `marketing`, `content`, `sales`, `customer-success`, `analytics`

**Business and professional practice:** `product`, `business`, `finance`, `accounting`, `tax`, `legal` (compliance and privacy), `legal-practice` (cases, contracts, litigation), `hr`, `operations`, `research`, `documentation`, `delivery`

## Structure
```json
{
  "id": "legal-practice",
  "name": "Legal Practice",
  "roles": ["case-manager", "litigation-counsel", "contract-counsel", "legal-researcher", "paralegal"]
}
```

Role identifiers reference the richer catalog in `roles/enterprise-roles.json` (219 entries with title, specialization, and communication policy). Domain blueprints in `domains/domains.json` pick departments and roles when a team is assembled.

## Selection
`Orchestrator.analyzeIntent` merges two signals:
1. **Domain detection** — the domain's department list (Persian or English request text).
2. **Keyword scoring** — direct matches against department ids, names, and role names.

The merged set (up to six departments) drives `astack review` output and `astack project scaffold`. When nothing matches, the generalist trio `business`, `research`, `documentation` is used.

## Extending
Add a department entry (and its roles) in the two JSON files, reference it from a domain in `domains/domains.json` if it should participate in team blueprints, and update the count assertion in `tests/verify-astack.mjs`. If you customize these files in an embedded install, list them under `upgrade.keep` to protect them from core upgrades.
