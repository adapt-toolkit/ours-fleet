#!/usr/bin/env bash
#
# Publish @ours.network/fleet to npm from a local machine.
#
# Stand-in for a GitHub `publish.yml` publish job while CI is unavailable.
# Mirrors its steps: clean install -> build -> test -> npm publish.
# Reads the npm token from a gitignored .env (NPM_TOKEN=...; see .env.example).
# The token is written only to a throwaway npmrc that is deleted on exit, so it
# never touches a tracked file or your ~/.npmrc.
#
# Versioning is manual: edit "version" in package.json before publishing (npm
# refuses to republish an existing version). Pass --dry-run to validate the
# package tarball without publishing.
#
#   ./publish-local.sh            # publish
#   ./publish-local.sh --dry-run  # pack + validate only
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${NPM_TOKEN:?NPM_TOKEN not set — copy .env.example to .env and fill it in}"

NPMRC="$(mktemp)"; trap 'rm -f "$NPMRC"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$NPMRC"
export NPM_CONFIG_USERCONFIG="$NPMRC"

npm ci
npm run build
npm test
npm publish --access public "$@"

name=$(node -p "require('./package.json').name")
ver=$(node -p "require('./package.json').version")
echo "✓ ${name}@${ver}"
