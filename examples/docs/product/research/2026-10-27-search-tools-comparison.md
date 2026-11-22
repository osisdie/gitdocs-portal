---
name: search-tools-comparison
description: Three ways to add order search — database full-text, a search engine, or a hosted service.
---
# Order search: options compared

| | Database full-text | Self-hosted search engine | Hosted search service |
|---|---|---|---|
| Latency (p99) | 400 ms | 60 ms | 80 ms |
| Monthly cost | none | medium | high |
| Ops effort | low | high (cluster, upgrades) | low |
| Facets / typo tolerance | limited | yes | yes |

Recommendation: start with database full-text on a read replica (no new infra, cost stays flat), measure latency
with the observability stack, and revisit when the order table passes 50M rows.

Customer interviews ranked search by customer and SKU first; date range second.
