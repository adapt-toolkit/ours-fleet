#!/usr/bin/env bash
set -euo pipefail
fleet_repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
review_root=$(dirname -- "$fleet_repo")
(
  cd -- "$review_root/ours-sdk"
  npm ci --ignore-scripts
  git submodule update --init --recursive
  npm rebuild better-sqlite3
  bash scripts/compile-mufl.sh
  npm run build:all
  npm pack --ignore-scripts --pack-destination "$review_root"
)
(
  cd -- "$review_root/ours-mcp"
  npm ci --ignore-scripts
  npm run build --workspace @ours.network/mcp
  npm pack --ignore-scripts --workspace @ours.network/mcp --pack-destination "$review_root"
)
cd -- "$fleet_repo"
npm ci --ignore-scripts
npm run build
