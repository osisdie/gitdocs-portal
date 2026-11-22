---
name: kubernetes-upgrade-plan
description: Upgrade plan for the staging and production Kubernetes clusters, node pool by node pool.
---
# Kubernetes upgrade plan

## Scope

Both clusters (staging, production) move two minor versions. Helm charts are pinned and tested against the new
API versions first.

## Steps

1. Upgrade staging; run the end-to-end tests and a load test for the orders API.
2. Production control plane during the Tuesday maintenance window.
3. Node pools one by one with surge upgrades; watch the observability dashboards (error rate, p99 latency).
4. Roll back a node pool if the error budget burns faster than 2× for 15 minutes.

## Cost

Surge nodes add about 6% to the monthly infra cost for the two upgrade weeks.
