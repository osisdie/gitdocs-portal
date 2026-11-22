---
name: getting-started
description: How the demo content is laid out, and how vault fields work.
---
# Getting started

Every folder under `docs/` is a **project**; a second level is a **subproject**.
Drop `.html`, `.md`, `.sh` or Postman `.json` files in, run `npm run build`, and the portal assigns ids,
infers category / status / sensitivity, and indexes the text for search.

## Credentials stay out of git

The staging API token is {{vault:demo/api-token}} — in the portal that renders as `••••••••` with
**顯示** (reveal) and **複製** (copy) buttons. The value is decrypted in the browser after you enter the
vault passphrase (demo passphrase: `correct horse battery staple`).

Inside code blocks, too:

```bash
curl -H "Authorization: Bearer {{vault:demo/api-token}}" https://api.example.com/v1/health
```

Add or change a secret with `npm run vault -- set demo/api-token`, then reference it as
`{{vault:demo/api-token}}`. Changes to the encrypted `vault/vault.json` are versioned like any other file.
