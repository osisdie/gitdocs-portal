---
name: access-policy
description: SSO everywhere, enforced MFA, and reviewed production access.
---
# Access and SSO policy

This policy replaces the per-tool accounts of v1.

## Rules

1. **SSO everywhere.** Every internal tool signs in through the company identity provider (OAuth / SAML).
   Tools that cannot do SSO need an exception from the security team.
2. **MFA is enforced.** Accounts without MFA are suspended after 24 hours.
3. **Production access is reviewed.** Request it in the access portal; a manager and the security on-call approve it.
   Access expires after 90 days unless renewed.
4. **Quarterly access review.** Managers confirm their team's access every quarter.

## Offboarding

Disabling the SSO account removes access to every tool within 15 minutes.

Questions: ask in the #security channel.
