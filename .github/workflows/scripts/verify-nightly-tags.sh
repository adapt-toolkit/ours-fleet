#!/usr/bin/env bash
set -euo pipefail

expected="${1:?usage: verify-nightly-tags.sh <expected-version>}"
# npm may keep a successfully accepted package in processing for several
# minutes. Sixty attempts fit comfortably inside the job's 20-minute timeout
# while preserving a bounded failure if the registry never converges.
attempts="${NIGHTLY_VERIFY_ATTEMPTS:-60}"
delay="${NIGHTLY_VERIFY_DELAY_SECONDS:-5}"
packages=(
  "@ours.network/fleet"
  "@ours.network/fleet-claude-code"
  "@ours.network/fleet-codex"
)

if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::NIGHTLY_VERIFY_ATTEMPTS must be a positive integer" >&2
  exit 2
fi
if ! [[ "$delay" =~ ^[0-9]+$ ]]; then
  echo "::error::NIGHTLY_VERIFY_DELAY_SECONDS must be a non-negative integer" >&2
  exit 2
fi

for (( attempt=1; attempt<=attempts; attempt++ )); do
  ready=true
  observations=()

  for package in "${packages[@]}"; do
    # npm publication and dist-tag reads can reach different registry/CDN
    # replicas briefly. Prefer an online response and retry the complete set.
    nightly="$(npm --prefer-online view "$package" dist-tags.nightly 2>/dev/null || true)"
    latest="$(npm --prefer-online view "$package" dist-tags.latest 2>/dev/null || true)"
    observations+=("$package nightly=${nightly:-<missing>} latest=${latest:-<missing>}")

    if [[ -n "$latest" && "$latest" == *-* ]]; then
      echo "::error::$package latest unexpectedly points to $latest" >&2
      exit 1
    fi
    if [[ "$nightly" != "$expected" ]]; then
      # npm publish can return successfully while a package is still being
      # processed. In that state the version may become readable without the
      # requested dist-tag moving. Repair only the prerelease channel, and only
      # after the exact version this run published is visible in the registry.
      published="$(npm --prefer-online view "$package@$expected" version 2>/dev/null || true)"
      if [[ "$published" == "$expected" ]]; then
        if npm dist-tag add "$package@$expected" nightly >/dev/null 2>&1; then
          observations+=("$package nightly repair requested for $expected")
        fi
      fi
      ready=false
    fi
    if [[ -z "$latest" ]]; then
      ready=false
    fi
  done

  if [[ "$ready" == true ]]; then
    printf 'verified npm tags after attempt %d/%d:\n' "$attempt" "$attempts"
    printf '  %s\n' "${observations[@]}"
    exit 0
  fi

  if (( attempt < attempts )); then
    echo "::warning::npm tags have not propagated yet (attempt $attempt/$attempts)"
    printf '  %s\n' "${observations[@]}"
    sleep "$delay"
  fi
done

echo "::error::npm tags did not converge to nightly=$expected after $attempts attempts" >&2
printf '  %s\n' "${observations[@]}" >&2
exit 1
