#!/usr/bin/env bash
# Materialize immutable, unpublished review dependencies; no registry publication.
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
artifact_dir=$(cd -- "${1:-$repo_root/..}" && pwd)
source_root=$(mktemp -d)
trap 'rm -rf -- "$source_root"' EXIT
mcp_revision=5f68d2491f7e40d6aa71d45c643c3c3aeb3bdb67
source_dir="$source_root/ours-mcp"
git init -q "$source_dir"
git -C "$source_dir" remote add origin https://github.com/adapt-toolkit/ours-mcp.git
git -c credential.helper='!gh auth git-credential' -C "$source_dir" fetch --depth=1 origin "$mcp_revision"
git -C "$source_dir" checkout --detach FETCH_HEAD
test "$(git -C "$source_dir" rev-parse HEAD)" = "$mcp_revision"
bash "$source_dir/scripts/prepare-supervisor-sdk.sh" "$source_root"
(
  cd -- "$source_dir"
  unset GH_TOKEN
  npm ci --ignore-scripts
  npm run build --workspace @ours.network/mcp
  npm pack --ignore-scripts --workspace @ours.network/mcp --pack-destination "$artifact_dir"
)
cp -- "$source_root/ours.network-sdk-3.8.1-supervisor.0.tgz" "$artifact_dir/"
