# Welcome to Northwind Docs

Northwind Labs is a fictional company; everything in this portal is demo content for gitdocs-portal.

Every folder under `docs/` is a **project** and a second level is a **subproject**:

| Project | Subprojects | What lives there |
|---|---|---|
| handbook | onboarding, security | first week, developer environment, access and SSO policy, incident response |
| platform | infra, api | Kubernetes upgrade plan, observability evaluation, deploy script, Orders API, rate limits, OAuth migration |
| product | roadmap, research | 2027 roadmap, pricing experiment, customer interviews, search tools comparison, onboarding UX mockups |
| ops | runbooks, postmortems | database failover, on-call handbook, certificate rotation, postmortems, vendor escalation contacts |

## Conventions

- File names start with the date: `2026-10-11-checkout-latency-postmortem.html`.
- Credentials never go into git. Write `{{vault:<name>}}` instead and store the value with `npm run vault -- set <name>`.
- Workflow: new docs start as 待處理 (new), move to 待確認 (feedback) when a reviewer is set, then 已確認 (confirmed)
  and 已發布 (published). Superseded docs are archived.
- Ask in the #docs channel (fictional).
