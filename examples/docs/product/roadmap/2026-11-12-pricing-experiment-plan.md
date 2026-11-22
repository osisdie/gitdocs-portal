---
name: pricing-experiment-plan
description: A/B test of usage-based pricing for the Team plan, with API quotas as the metered unit.
---
# Pricing experiment plan

## Hypothesis

Usage-based pricing (per 1,000 API calls above the quota) converts more Free teams to Team than the flat price,
without raising churn.

## Design

- 50/50 split of new Team sign-ups for six weeks; existing customers are not affected.
- Metered unit: API calls above the daily quota from the rate limits proposal.
- Success: +15% conversion, churn within ±1 point, support tickets about billing not up.

## Cost

Billing changes need two engineer-weeks; the experiment dashboard reuses the observability stack.
