#!/bin/sh
# Fake codex whose post-login health check (a second app-server) is slow.
dir="${CODEX_HOME:-$HOME/.codex}"
if [ -f "$dir/fake-login.json" ]; then sleep 1; fi
exec node "$(dirname "$0")/fake-codex.mjs" "$@"
