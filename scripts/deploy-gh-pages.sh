#!/usr/bin/env bash
# Builds the app locally and publishes dist/ to the `gh-pages` branch (no GitHub Actions needed).
# Then set the repo's Pages source to: Deploy from a branch -> gh-pages -> / (root).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
npm run build
remote="$(git remote get-url origin)"
rev="$(git rev-parse --short HEAD)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -r dist/. "$tmp/"
touch "$tmp/.nojekyll"
cd "$tmp"
git init -q -b gh-pages
git add -A
git -c user.name="$(git -C "$root" config user.name)" -c user.email="$(git -C "$root" config user.email)" \
  commit -q -m "Deploy $rev"
git push -f "$remote" gh-pages
echo "Published build of $rev to branch gh-pages."
