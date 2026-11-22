---
name: api-rate-limits
description: Per-tenant rate limits and quotas for the public Orders API.
---
# API rate limits

## Proposal

| Plan | Requests / minute | Burst | Daily quota |
|---|---|---|---|
| Free | 60 | 120 | 10,000 |
| Team | 600 | 1,200 | 500,000 |
| Enterprise | custom | custom | custom |

- Limits are enforced per API key at the gateway; responses carry `RateLimit-Remaining` and `Retry-After`.
- Throttled requests return `429` and never reach the orders database.
- Internal callers (checkout, billing) are exempt but still measured in the observability dashboards.

## Open questions

- Do we count failed requests against the quota?
- Pricing: does the Team plan include higher limits, or are they an add-on? (see the pricing experiment plan)
