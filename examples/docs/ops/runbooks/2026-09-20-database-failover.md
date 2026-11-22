---
name: database-failover
description: Promote the orders database replica when the primary is down.
---
# Database failover runbook

Use this when the orders database primary is unreachable for more than 2 minutes and the on-call alert fired.

## 1. Confirm

```bash
nw db status orders --region eu-1
```

If the replica lag is under 30 s, fail over. Otherwise page the database owner first.

## 2. Promote the replica

Admin user `nw_admin`, password {{vault:ops/db-admin-password}} — reveal it in the portal, never paste it in chat.

```bash
nw db promote orders-replica-1 --confirm
kubectl -n orders rollout restart deploy/orders
```

## 3. Verify

- Checkout p99 latency back under 500 ms on the observability dashboard.
- Error rate under 0.5% for 10 minutes.
- Post in the incident channel and start the postmortem timeline.
