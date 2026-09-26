# Gateway package qualification

The shared client profile API is provided by the published SDK
`@ours.network/sdk@3.8.1-nightly.13`. The CLI uses `2.8.1-nightly.11`,
and native integration tests use daemon `3.8.1-nightly.5`.
Manifests and lockfiles pin npm artifacts; CI and package tests use ordinary
installs with no SDK source checkout or substitution.

Reproduce with Node 22 and npm:

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run test:pack
```

Fleet still needs a published gateway-aware MCP package before coordinated
rollout; this SDK update does not qualify the currently pinned older MCP client.
