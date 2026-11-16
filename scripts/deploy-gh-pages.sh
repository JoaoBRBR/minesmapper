#!/usr/bin/env bash
# Builds the app and publishes it from `main` itself: the build goes into docs/, is committed,
# and is pushed. GitHub Pages serves it with: Settings -> Pages -> Deploy from a branch ->
# main -> /docs. No GitHub Actions needed.
set -euo pipefail
cd "$(dirname "$0")/.."

# The build comes from the working tree, so refuse to publish uncommitted source changes.
if [ -n "$(git status --porcelain -- . ':!docs')" ]; then
  echo "Uncommitted changes outside docs/. Commit them first, then run the deploy again." >&2
  exit 1
fi

npm run build
rm -rf docs
cp -r dist docs
touch docs/.nojekyll

rev="$(git rev-parse --short HEAD)"
git add -A docs
if git diff --cached --quiet; then
  echo "docs/ is already up to date for $rev."
else
  git commit -q -m "Deploy build of $rev"
  git push origin HEAD
  echo "Published build of $rev to docs/ on $(git branch --show-current)."
fi
