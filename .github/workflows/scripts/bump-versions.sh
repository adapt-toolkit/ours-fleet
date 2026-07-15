#!/usr/bin/env bash
#
# Bumps all package versions (@ours.network/fleet, fleet-claude-code, and
# fleet-codex) in one [skip ci]
# commit and pushes. Each package bumps from max(local, npm-published) so a
# locally published version can never collide. The skill plugins have no npm
# dependency on the CLI, so no pin-sync is needed.
#
# Bump level comes from the HEAD commit subject (Conventional Commits):
#   feat: minor · fix: patch · !/BREAKING: major
#   refactor/perf/style/build/revert/other: patch · ci/test/docs/chore: none

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
CLI_PKG=package.json
PLUGIN_PKG=integrations/claude-code/package.json
CODEX_PLUGIN_PKG=integrations/codex/ours-fleet/package.json
CODEX_MANIFEST=integrations/codex/ours-fleet/.codex-plugin/plugin.json
CLI_NAME="@ours.network/fleet"
PLUGIN_NAME="@ours.network/fleet-claude-code"
CODEX_PLUGIN_NAME="@ours.network/fleet-codex"

emit() { [[ -n "${GITHUB_OUTPUT:-}" ]] && printf '%s\n' "$1" >> "$GITHUB_OUTPUT" || true; }
log()  { printf '[bump] %s\n' "$*"; }

no_bump() {
  log "no bump: $1"
  emit "bumped=false"
  emit "new-sha=${GITHUB_SHA:-$(git rev-parse HEAD)}"
  exit 0
}

msg=$(git log -1 --pretty=%B HEAD)
subject=$(printf '%s\n' "$msg" | head -n1)
body=$(printf '%s\n' "$msg" | tail -n +2)
log "head subject: $subject"

printf '%s\n' "$msg" | grep -qiE '\[skip ci\]|\[ci skip\]' && no_bump "[skip ci] marker present"

if printf '%s\n' "$subject" | grep -qE '^[a-z]+(\([^)]+\))?!:' \
   || printf '%s\n' "$body" | grep -qE '^BREAKING CHANGE:'; then
  level=major
else
  type=$(printf '%s\n' "$subject" | grep -oE '^[a-z]+' || true)
  case "$type" in
    feat)                                level=minor ;;
    fix)                                 level=patch ;;
    ci|test|docs|chore)                  level=none  ;;
    *)                                   level=patch ;;
  esac
fi
[[ "$level" == none ]] && no_bump "non-shipping commit type (${type:-<empty>})"
log "bump level: $level"

bump() { # <version> <level>
  local a b c; IFS=. read -r a b c <<<"$1"
  case "$2" in
    major) echo "$((a + 1)).0.0" ;;
    minor) echo "${a}.$((b + 1)).0" ;;
    patch) echo "${a}.${b}.$((c + 1))" ;;
  esac
}

next_for() { # <pkg-json> <npm-name>
  local local_v pub_v base
  local_v=$(jq -r .version "$1")
  pub_v=$(npm view "$2" version 2>/dev/null || echo "0.0.0")
  base=$(printf '%s\n%s\n' "$local_v" "$pub_v" | sort -V | tail -1)
  bump "$base" "$level"
}

patch_version() { # <pkg-json> <old> <new>
  local esc=${2//./\\.}
  sed -i -E "s|^(\\s*\"version\"\\s*:\\s*\")${esc}(\")|\\1${3}\\2|" "$1"
  grep -qE "^\\s*\"version\"\\s*:\\s*\"${3//./\\.}\"" "$1" \
    || { echo "[bump] failed to patch version in $1" >&2; exit 1; }
}

cli_old=$(jq -r .version "$CLI_PKG");    cli_new=$(next_for "$CLI_PKG" "$CLI_NAME")
plug_old=$(jq -r .version "$PLUGIN_PKG"); plug_new=$(next_for "$PLUGIN_PKG" "$PLUGIN_NAME")
codex_old=$(jq -r .version "$CODEX_PLUGIN_PKG"); codex_new=$(next_for "$CODEX_PLUGIN_PKG" "$CODEX_PLUGIN_NAME")
log "cli:    $cli_old -> $cli_new"
log "claude: $plug_old -> $plug_new"
log "codex:  $codex_old -> $codex_new"

patch_version "$CLI_PKG" "$cli_old" "$cli_new"
patch_version "$PLUGIN_PKG" "$plug_old" "$plug_new"
patch_version "$CODEX_PLUGIN_PKG" "$codex_old" "$codex_new"
patch_version "$CODEX_MANIFEST" "$codex_old" "$codex_new"

npm install --package-lock-only --ignore-scripts >/dev/null

git config user.name  "ours-ci-version-bump[bot]"
git config user.email "ours-ci-version-bump[bot]@users.noreply.github.com"
git add "$CLI_PKG" "$PLUGIN_PKG" "$CODEX_PLUGIN_PKG" "$CODEX_MANIFEST" package-lock.json
git diff --cached --quiet && no_bump "no changes after patch"

git commit -m "chore(release): fleet v${cli_new}, fleet-claude-code v${plug_new}, fleet-codex v${codex_new} [skip ci]

Triggered by $(git rev-parse --short HEAD): $(printf '%s' "$subject" | head -c 200)"
git push origin "HEAD:${GITHUB_REF_NAME:-main}"

emit "bumped=true"
emit "new-sha=$(git rev-parse HEAD)"
emit "cli-version=${cli_new}"
emit "plugin-version=${plug_new}"
emit "codex-plugin-version=${codex_new}"
