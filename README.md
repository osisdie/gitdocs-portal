# gitdocs-portal

A MantisBT-style document portal where **git is the database**. Drop HTML / Markdown / shell / Postman files into
`docs/`, run one build, and get a searchable, filterable portal with projects, keywords, sensitivity levels,
per-file git history — and a **vault** that keeps credentials out of git while the documents around them stay
versioned. The output is a static site; the reference deployment is Cloudflare Pages behind Cloudflare Access.

[繁體中文說明 → README.zh-TW.md](README.zh-TW.md)

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Engine repo vs. content repo](#engine-repo-vs-content-repo)
- [Vault: masked credentials](#vault-masked-credentials)
- [Sensitivity levels](#sensitivity-levels)
- [Catalog CLI and search syntax](#catalog-cli-and-search-syntax)
- [Deploying](#deploying)
- [Contributing](#contributing)

## Features

- **Projects / subprojects** from folders (`docs/<project>/<subproject>/…`), with a project switcher like Mantis.
- **Inferred metadata**: id, category, status, date, keywords (from a regex dictionary), sensitivity — all
  editable through a CLI and stored in a single `docs/catalog.json`.
- **Full-text search** with a small query language (`p:`, `cat:`, `s:`, `sens>=`, `k:`, `date>=`, `-exclude`, `"phrase"`),
  shared by the browser and the CLI.
- **Views**: list with sortable columns and saved filters, summary matrices, timeline, project pages, document
  pages with related / superseded / similar documents and git history.
- **Sensitivity**: `公開 / 內部 / 機密 / 極機密` (public / internal / confidential / secret); higher levels are
  kept out of the search index or out of the deployment entirely.
- **Vault**: `{{vault:name}}` placeholders render as `••••••••` with reveal / copy buttons; values are encrypted
  in `vault/vault.json` and decrypted only in the browser after entering a passphrase.
- **Postman**: environment and collection files are first-class documents; `npm run vault -- postman <file>`
  moves secret variables into the vault.
- No framework, no runtime dependencies. Node ≥ 20 for the build.

## Quick start

```bash
git clone https://github.com/osisdie/gitdocs-portal.git && cd gitdocs-portal
npm run build      # builds the demo content in examples/ into dist/
npm run dev        # http://localhost:8788  — demo vault passphrase: correct horse battery staple
```

## Engine repo vs. content repo

This repository is the **engine** (portal UI + build + CLIs) with demo content in `examples/`. Real documents
live in a separate, usually private, **content repo** that vendors the engine:

```
content repo (private)                      gitdocs-portal (this repo, public)
├── docs/            ← your documents       ├── site/        portal UI
│   └── catalog.json ← metadata             ├── scripts/     build, doc CLI, vault CLI, engine sync
├── vault/vault.json ← encrypted secrets    ├── examples/    demo content
├── .engine-ref      ← pinned engine commit └── templates/   CI for content repos
└── site/ scripts/ … ← vendored, read-only
```

- `npm run engine:update [ref]` copies the engine paths listed in `scripts/engine-paths.txt` from upstream and
  pins the commit in `.engine-ref`.
- `npm run engine:check` fails when vendored engine files differ from that commit — run it in CI
  (`templates/gitlab-ci.yml`, `templates/github-actions.yml`) so engine changes always go upstream as a pull
  request first.
- Content settings live in `docs/catalog.json → site`: `title`, `projectRoot` (a folder under `docs/` whose
  children are projects) and `readmeIndex` (a Markdown table that supplies titles / descriptions / URLs).

Starting a content repo:

```bash
mkdir my-docs && cd my-docs && git init
mkdir docs && echo '{ "site": { "title": "My docs" } }' > docs/catalog.json
git fetch https://github.com/osisdie/gitdocs-portal.git main
git checkout FETCH_HEAD -- scripts/engine.sh && bash scripts/engine.sh update
cp .env.example .env   # fill in, never commit
```

## Vault: masked credentials

Documents often need credentials next to the prose that explains them. Committing them is wrong; deleting them
loses the document. The vault keeps both:

```bash
npm run vault -- init                         # once; passphrase from VAULT_PASSPHRASE or a prompt
npm run vault -- set aws/prod/access-key      # value from a hidden prompt or stdin, never argv
# in any document:  The key is {{vault:aws/prod/access-key}}
npm run vault -- scan                         # find plaintext credentials in docs/
npm run vault -- scan --fix                   # seal them and rewrite the files to {{vault:…}}
npm run vault -- postman docs/api/prod.postman_environment.json
npm run vault -- ls | get <name> | rm <name> | mv <old> <new> | rekey | check
```

- `vault/vault.json` holds only ciphertext and is committed, so secret changes are versioned too.
  Crypto: PBKDF2-SHA256 (600k iterations) → AES-256-GCM, with the secret's name as additional data so a
  ciphertext cannot be moved to another name. The same module (`site/vault-core.js`) runs in Node and the browser.
- The portal masks placeholders in Markdown / text / JSON previews: **顯示** reveals for 30 s, **複製** copies
  without showing. The derived key is a non-extractable `CryptoKey` kept in memory only (gone on reload or
  **鎖定 vault**).
- Documents are treated as untrusted: `/docs/*` is served with `Content-Security-Policy: sandbox` (opaque origin)
  and previewed in a sandboxed iframe, so a document's scripts can never reach the portal, the key or the vault.
  HTML documents get a tiny inlined shim that masks fields and asks the portal (via `postMessage`) to show a value
  in the portal's own dialog — the plaintext never enters the document.
- Share builds (`--max-sensitivity=…`) and `--no-vault` leave the vault out: fields stay masked for everyone.
- The passphrase is the whole security of the deployed ciphertext — use a long one, and keep the site behind
  authentication anyway.

## Sensitivity levels

| Level | Detected when | Build effect |
|---|---|---|
| 公開 public | manual only | like internal |
| 內部 internal | default | deployed, body indexed |
| 機密 confidential | personal / company identifiers: e-mail, phone, registry / VAT / IBAN / national id, street address | deployed, body **not** indexed, preview behind a click |
| 極機密 secret | plaintext credentials (`api_key=`, `sk-…`, `AKIA…`, private keys, GitHub / GitLab / Slack / Google tokens) | **not deployed**; metadata only |

Detection only ever raises a level. Moving credentials into the vault (`vault scan --fix`) is the way to bring
a document back down: `npm run doc -- set <id> sensitivity=內部`.

## Catalog CLI and search syntax

```bash
npm run doc -- ls 'k:API cat:評估 -s:已發布'
npm run doc -- show 14
npm run doc -- set 12 status=審查中 category=稽核
npm run doc -- tag 14 +vendor -draft
npm run doc -- relate 9 11 13
npm run doc -- supersede 14 6 --archive
npm run doc -- project handbook/onboarding 'desc=First-week material'
npm run doc -- kw add Stripe stripe '金流'
npm run doc -- filter add 'This week' 'after:-7d'
```

Search: `api 成本` (AND) · `"release notes"` · `-封存` · `p:handbook/onboarding` · `cat:評估` · `s:已發布` ·
`sens>=機密` · `k:API` · `type:json` · `id:14` · `date:2026-11` · `after:-30d` · `before:2026-11-20`.

## Deploying

`npm run deploy` builds and uploads `dist/` with Wrangler (direct upload, so `極機密` files never reach a
third-party build). Needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_PAGES_PROJECT` in `.env`.

Protect the site with Cloudflare Access (or any auth proxy). Include `*.<project>.pages.dev` in the Access
application: every deployment also gets a permanent preview URL.

## Contributing

Issues and pull requests are welcome — UI, query language, detectors, vault, docs, translations. Keep it
dependency-free, make sure `npm run build` and `node scripts/vault.mjs check` pass on the demo content, and never
include real documents or secrets in examples. Licensed under MIT.
