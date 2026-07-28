#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
dir="${1:?usage: publish-nightly.sh <package-directory>}"
pkg="$dir/package.json"

bash .github/workflows/scripts/publish-guard.sh nightly "$pkg" nightly
(
  cd "$dir"
  # Publish the current local package. Passing a bare relative directory such as
  # `integrations/claude-code` to `npm publish` is parsed as a GitHub shorthand
  # (`github.com/integrations/claude-code.git`) instead of a filesystem path.
  npm publish . --tag nightly --access public
)
