# Gateway source qualification

This draft depends on the shared client profile API in SDK commit
`37bd5c481c5781cb9af44f51570222a4897955af` ([SDK PR #69](https://github.com/adapt-toolkit/ours-sdk/pull/69)).
The normal npm dependency pins do not yet contain that API. PR CI checks out this
immutable source, builds it, and explicitly substitutes its `dist` in installed SDK
copies before running every existing typecheck/build/test/package gate. This is
source compatibility evidence, not qualification of the currently published product.
Push/release gates do not use this substitution.

Reproduce from a clean checkout with Node 22, npm, and Git:

```sh
npm ci
mkdir -p .source-deps
git clone https://github.com/adapt-toolkit/ours-sdk.git .source-deps/sdk
git -C .source-deps/sdk checkout 37bd5c481c5781cb9af44f51570222a4897955af
npm --prefix .source-deps/sdk ci --ignore-scripts
npm --prefix .source-deps/sdk run build
node scripts/qualify-gateway-sdk.mjs
npm run typecheck
npm run build
npm test
```

Fleet additionally runs `npm run test:pack`. For machines running other suites
concurrently, Fleet's equivalent bounded run is
`npm test -- --maxWorkers=2 --minWorkers=1`.

Before merge: select approved published SDK/CLI/MCP versions containing these
changes, update package manifests and lockfiles (and the installer release manifest
and checksums), remove the draft source substitution, then rerun ordinary clean
`npm ci` CI and installed artifact qualification. No release is authorized by this PR.
