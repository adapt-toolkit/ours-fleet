#!/usr/bin/env bash
#
# Publish the ours-fleet packages to npm from a local machine:
#   1. @ours.network/fleet             (the CLI — root package)
#   2. @ours.network/fleet-claude-code (the Claude Code plugin — integrations/claude-code)
#
# Stand-in for a GitHub `publish.yml` publish job while CI is unavailable.
# Mirrors its steps: clean install -> build -> test -> npm publish; the plugin
# is static files (skills + manifest), so it publishes without a build step.
# Reads the npm token from a gitignored .env (NPM_TOKEN=...; see .env.example).
# The token is written only to a throwaway npmrc that is deleted on exit, so it
# never touches a tracked file or your ~/.npmrc.
#
# Versioning is manual for BOTH packages: edit "version" in package.json and
# integrations/claude-code/package.json before publishing (npm refuses to
# republish an existing version; a package whose version is already on the
# registry is skipped, so you can bump and publish just one of them).
# Pass --dry-run to validate the tarballs without publishing.
#
#   ./publish-local.sh            # publish both
#   ./publish-local.sh --dry-run  # pack + validate only
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${NPM_TOKEN:?NPM_TOKEN not set — copy .env.example to .env and fill it in}"

NPMRC="$(mktemp)"; trap 'rm -f "$NPMRC"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$NPMRC"
export NPM_CONFIG_USERCONFIG="$NPMRC"

# Skip a package whose version is already on the registry (so bump-one-publish-one works).
published() {
  local name="$1" ver="$2"
  [ "$(npm view "${name}@${ver}" version 2>/dev/null || true)" = "$ver" ]
}

# --- 1. the CLI (root) --------------------------------------------------------
name=$(node -p "require('./package.json').name")
ver=$(node -p "require('./package.json').version")
if published "$name" "$ver" && [[ " $* " != *" --dry-run "* ]]; then
  echo "= ${name}@${ver} already on npm — skipping (bump the version to publish)"
else
  npm ci
  npm run build
  npm test
  npm publish --access public "$@"
  echo "✓ ${name}@${ver}"
fi

# --- 2. the Claude Code plugin (static files, no build) ------------------------
(
  cd integrations/claude-code
  name=$(node -p "require('./package.json').name")
  ver=$(node -p "require('./package.json').version")
  if published "$name" "$ver" && [[ " $* " != *" --dry-run "* ]]; then
    echo "= ${name}@${ver} already on npm — skipping (bump the version to publish)"
  else
    npm publish --access public "$@"
    echo "✓ ${name}@${ver}"
  fi
)
