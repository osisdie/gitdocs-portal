#!/usr/bin/env bash
# Keep the engine (portal UI + scripts) in a content repo identical to the gitdocs-portal upstream.
#   engine.sh update [ref]   copy the engine paths from upstream <ref> (default: main), record the commit in .engine-ref
#   engine.sh check          fail when the engine paths differ from the commit in .engine-ref (run it in CI)
# Changes to the engine go to upstream as a pull request; content repos only pull them in.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
UPSTREAM="${ENGINE_UPSTREAM:-https://github.com/osisdie/gitdocs-portal.git}"
[ -d docs ] || { echo "no docs/ here — this looks like the engine repo itself, nothing to sync" >&2; exit 0; }

fetch() { git fetch --quiet --no-tags "$UPSTREAM" "$1" && git rev-parse FETCH_HEAD; }
paths() { git show "$1:scripts/engine-paths.txt" | sed -e '/^#/d' -e '/^[[:space:]]*$/d'; }

case "${1:-}" in
  update)
    sha=$(fetch "${2:-main}")
    mapfile -t P < <(paths "$sha")
    git rm -r -q -f --ignore-unmatch -- "${P[@]}" >/dev/null   # drop files that upstream deleted (update overwrites them anyway)
    git checkout "$sha" -- "${P[@]}"
    echo "$sha" > .engine-ref
    git add -- .engine-ref "${P[@]}"
    echo "engine → ${sha:0:12} ($UPSTREAM). Review: git diff --cached --stat ; then: git commit -m \"chore(engine): sync gitdocs-portal@${sha:0:12}\""
    ;;
  check)
    [ -f .engine-ref ] || { echo "missing .engine-ref — run: npm run engine:update" >&2; exit 1; }
    sha=$(cat .engine-ref)
    fetch "$sha" >/dev/null
    mapfile -t P < <(paths "$sha")
    if ! git diff --quiet "$sha" -- "${P[@]}"; then
      echo "✗ engine files differ from gitdocs-portal@${sha:0:12}:" >&2
      git diff --stat "$sha" -- "${P[@]}" >&2
      echo "Engine changes belong upstream ($UPSTREAM) as a pull request; then run npm run engine:update here." >&2
      exit 1
    fi
    echo "✓ engine matches gitdocs-portal@${sha:0:12}"
    ;;
  *) sed -n '2,5p' "$0"; exit 1 ;;
esac
