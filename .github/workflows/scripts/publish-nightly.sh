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
  #
  # The root package — and only the root — carries `prepublishOnly`, which reruns
  # `npm run build && npm test`. The workflow has already built and gated this
  # source, and the suite asserts a release-only bare X.Y.Z that the ephemeral
  # `-nightly.N` version cannot satisfy, so letting npm rerun it here fails the
  # publish on a version this pipeline injected itself. The stable publish job
  # skips the same lifecycle for the same reason (publish.yml).
  if [[ "$dir" == "." ]]; then
    npm publish . --tag nightly --access public --ignore-scripts
  else
    npm publish . --tag nightly --access public
  fi
)
