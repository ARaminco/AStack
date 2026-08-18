# Roles

Enterprise roles are declared in `roles/enterprise-roles.json` — 219 entries covering every department. A role entry:

```json
{
  "id": "tax-vat-specialist",
  "department": "tax",
  "title": "VAT Specialist",
  "specialization": "VAT",
  "communication": "Persian for owner-facing work, English for professional assets",
  "extension": "Add or override roles through plugins without core changes"
}
```

## Families
- **Software:** engineering (Laravel, PHP, Node.js, TypeScript, Go, Java, Python, clean architecture), AI engineering (prompting, RAG, agent systems, evaluation), DevOps and infrastructure (Docker, Kubernetes, Terraform, VMware, Proxmox, MikroTik, WireGuard), databases, security, QA, mobile, frontend.
- **Growth:** SEO (technical, programmatic, entity), marketing, content, sales, analytics, customer success.
- **Professional practice (new in v2):** legal (case management, litigation, contract law, legal research, paralegal operations, intellectual property), accounting (general ledger, bookkeeping, payroll, auditing, financial control, receivables), tax (advisory, corporate tax, VAT, compliance), finance (planning, treasury, cost analysis, unit economics), HR (people operations, recruitment, onboarding), operations (management, process improvement, logistics).
- **Delivery:** delivery management, program management, Scrum, agile coaching.

## How Roles Are Used
- Domain blueprints select lead and member roles when `astack lead team` assembles a team.
- Each agent is created **as** a role; the role defines the specialization and quality bar the runtime adopts when executing that agent's work orders.
- Markdown role charters for flagship roles live in `roles/*.md`.

Owner-facing role communication is Persian; generated assets remain English. Extend or override roles through plugins, or edit the catalog and protect it with `upgrade.keep`.
