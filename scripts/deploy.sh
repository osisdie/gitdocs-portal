#!/usr/bin/env bash
# Deploy dist/ to Cloudflare Pages. Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and CF_PAGES_PROJECT in .env.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
: "${CLOUDFLARE_API_TOKEN:?missing in .env}" "${CLOUDFLARE_ACCOUNT_ID:?missing in .env}"
PROJECT="${CF_PAGES_PROJECT:?set CF_PAGES_PROJECT in .env}"
[ -d dist ] || node scripts/build.mjs
# server mode (wrangler.toml with a D1 binding): apply pending migrations before the new functions go live
if [ -f wrangler.toml ] && grep -q '^\[\[d1_databases\]\]' wrangler.toml; then
  npx --yes wrangler@4.166.0 d1 migrations apply DB --remote
fi
npx --yes wrangler@4.166.0 pages deploy dist --project-name "$PROJECT" --branch main --commit-dirty=true
