#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

packages=(
  ".:@ours.network/fleet"
  "integrations/claude-code:@ours.network/fleet-claude-code"
  "integrations/codex/ours-fleet:@ours.network/fleet-codex"
)

# Nightlies target the next minor after the highest stable @latest in the suite.
base="0.0.0"
for entry in "${packages[@]}"; do
  dir="${entry%%:*}"; name="${entry#*:}"
  local_v="$(jq -r .version "$dir/package.json")"
  latest_v="$(npm view "$name" dist-tags.latest 2>/dev/null || echo 0.0.0)"
  base="$(printf '%s\n%s\n%s\n' "$base" "$local_v" "$latest_v" | sed 's/-.*//' | sort -V | tail -1)"
done
IFS=. read -r major minor _patch <<<"$base"
minor_base="${major}.$((minor + 1)).0"

# Choose one collision-free nightly index across all three package histories.
max_index=0
for entry in "${packages[@]}"; do
  name="${entry#*:}"
  index="$(npm view "$name" versions --json 2>/dev/null | node -e '
    let input=""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {
      let versions=[]; try { versions=JSON.parse(input || "[]"); } catch {}
      if (!Array.isArray(versions)) versions=[versions];
      const prefix=process.argv[1].replace(/[.]/g, "\\.");
      const re=new RegExp("^" + prefix + "-nightly\\.(\\d+)$");
      let max=0; for (const version of versions) { const match=String(version).match(re); if (match) max=Math.max(max, Number(match[1])); }
      process.stdout.write(String(max));
    });
  ' "$minor_base")"
  (( index > max_index )) && max_index="$index"
done
version="${minor_base}-nightly.$((max_index + 1))"

for entry in "${packages[@]}"; do
  dir="${entry%%:*}"
  node -e '
    const fs=require("fs"), path=require("path");
    const file=path.join(process.argv[1], "package.json");
    const pkg=JSON.parse(fs.readFileSync(file, "utf8"));
    pkg.version=process.argv[2];
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' "$dir" "$version"
done
node -e '
  const fs=require("fs"), file="integrations/codex/ours-fleet/.codex-plugin/plugin.json";
  const manifest=JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.version=process.argv[1];
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
' "$version"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "version=$version"
    echo "cli-version=$version"
    echo "claude-plugin-version=$version"
    echo "codex-plugin-version=$version"
  } >> "$GITHUB_OUTPUT"
fi
echo "nightly version: $version (ephemeral; not committed)"
