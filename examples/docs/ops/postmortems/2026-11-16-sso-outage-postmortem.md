---
name: sso-outage-postmortem
description: Draft postmortem — SSO logins failed for 25 minutes after a certificate rotation.
---
# Postmortem (draft): SSO outage

**SEV2 · 2026-11-14 · 25 minutes**

## What happened

The monthly certificate rotation replaced the SAML signing certificate, but the identity provider still trusted the old
one. Every SSO login failed; existing sessions kept working, so on-call only noticed when the security alert fired.

## Timeline

- 09:00 rotation job runs
- 09:12 first support ticket: "cannot log in"
- 09:18 incident declared; on-call finds the certificate mismatch
- 09:37 old certificate restored, logins recover

## Action items (draft)

- Exclude the SAML signing certificate from the automatic rotation; rotate it by hand with the identity team.
- Add a synthetic SSO login test every 5 minutes with an alert.
