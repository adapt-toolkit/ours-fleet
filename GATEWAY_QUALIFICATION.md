# Gateway package qualification

The shared client profile API is provided by the published SDK
`@ours.network/sdk@3.8.1-nightly.13`. The CLI uses `2.8.1-nightly.11`,
MCP uses `1.2.0-nightly.8`, and native integration tests use daemon
`3.8.1-nightly.5`.
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

The SDK, CLI and MCP now resolve to one published SDK version. After Fleet
is published, the installer can select the resulting Fleet artifact.
