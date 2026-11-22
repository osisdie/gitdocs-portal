---
name: on-call-handbook
description: How the on-call rotation works — paging, escalation, handover and postmortems.
---
# On-call handbook

## Rotation

One primary and one secondary per week, handover on Monday 10:00. The pager webhook token for the alert router is
{{vault:ops/oncall-webhook-token}}.

## When you are paged

1. Acknowledge within 5 minutes.
2. Check the observability dashboards: error rate, p99 latency, saturation.
3. Use the runbooks (database failover, certificate rotation). If none fits, escalate to the secondary.
4. Declare an incident when customers are affected for more than 10 minutes.

## After the incident

Write a blameless postmortem within five working days; track action items in the platform backlog.
