#!/usr/bin/env bash
set -euo pipefail

channel="${1:?usage: publish-guard.sh <nightly|stable> <package.json> <tag>}"
pkg="${2:?missing package.json}"
tag="${3:-}"

[[ -f "$pkg" ]] || { echo "GUARD FAIL: no such package.json: $pkg" >&2; exit 1; }
ver="$(jq -r .version "$pkg")"
name="$(jq -r .name "$pkg")"
fail() { echo "GUARD FAIL [$channel] $name@$ver (tag='${tag:-<default>}'): $1" >&2; exit 1; }

case "$channel" in
  nightly)
    [[ "${GITHUB_REF:-}" == "refs/heads/prerelease" ]] \
      || fail "nightly publishes only from prerelease"
    [[ "$ver" == *-nightly.* ]] || fail "version is not a -nightly.N prerelease"
    [[ "$tag" == "nightly" ]] || fail "nightly must use --tag nightly"
    ;;
  stable)
    [[ "${GITHUB_REF:-}" == "refs/heads/main" ]] || fail "stable publishes only from main"
    [[ "$ver" != *-* ]] || fail "stable version must not contain a prerelease suffix"
    [[ -z "$tag" || "$tag" == "latest" ]] || fail "stable must publish to latest"
    ;;
  *) fail "unknown release channel" ;;
esac

echo "guard ok: [$channel] $name@$ver -> ${tag:-latest}"
