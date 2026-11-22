---
name: incident-response
description: Severity levels, roles and the first 30 minutes of a security incident.
---
# Security incident response

## Severity

| Level | Example | Response |
|---|---|---|
| SEV1 | leaked production credentials, data exposure | page security on-call, all hands |
| SEV2 | suspicious login, vulnerable dependency in production | security on-call within 1 hour |
| SEV3 | phishing report, policy exception | next business day |

## First 30 minutes

1. Open an incident channel and name an incident commander.
2. Contain: rotate the affected credentials (they live in the vault, so rotation is one command) and revoke SSO sessions.
3. Write a timeline as you go; it becomes the postmortem.

Privacy: if personal data may be involved, notify the privacy lead within 24 hours (GDPR).

Every SEV1 / SEV2 incident gets a blameless postmortem within five working days; see the on-call handbook.
