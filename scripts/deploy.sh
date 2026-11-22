#!/usr/bin/env bash
# Deploy dist/ to Cloudflare Pages. Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and CF_PAGES_PROJECT in .env.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
: "${CLOUDFLARE_API_TOKEN:?missing in .env}" "${CLOUDFLARE_ACCOUNT_ID:?missing in .env}"
PROJECT="${CF_PAGES_PROJECT:?set CF_PAGES_PROJECT in .env}"
[ -d dist ] || node scripts/build.mjs
npx --yes wrangler@4.166.0 pages deploy dist --project-name "$PROJECT" --branch main --commit-dirty=true
