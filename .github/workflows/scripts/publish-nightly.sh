#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
dir="${1:?usage: publish-nightly.sh <package-directory>}"
pkg="$dir/package.json"

bash .github/workflows/scripts/publish-guard.sh nightly "$pkg" nightly
npm publish "$dir" --tag nightly --access public
