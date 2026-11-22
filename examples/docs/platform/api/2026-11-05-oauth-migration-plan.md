---
name: oauth-migration-plan
description: Move API clients from static API keys to OAuth 2.1 client credentials.
---
# OAuth 2.1 migration plan

## Why

Static API keys cannot be scoped or rotated without downtime. OAuth client credentials give short-lived tokens,
per-scope access and a clean SSO story for the admin console.

## Phases

1. **Dual auth** (December): the API accepts both API keys and OAuth tokens. New clients get OAuth only.
2. **Migration** (January–February): tenants move; the Postman collection switches to OAuth.
3. **Sunset** (March): API keys stop working; rate limits move from keys to OAuth clients.

## Risks

- Mobile apps released before December keep sending API keys — keep a read-only exemption for 60 days.
- Token endpoint becomes a single point of failure: run it in both regions, add tests and an on-call alert.
