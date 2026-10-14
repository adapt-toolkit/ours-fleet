# Backend tests

Install the pinned dependencies before running tests:

```sh
npm ci --ignore-scripts
npm test -- --maxWorkers=1 --minWorkers=1
npm run typecheck
```

The Vitest global setup builds the CLI once, creates a short private temporary directory outside the package, and supplies an isolated home and XDG directories to workers and child fixtures. It restores the original environment and removes its scratch directory after the run. Tests must not use an operator's credentials or installed service state. Keep synthetic service adapters scoped to the unit being tested; process-generation checks still need the real process table.

Short external scratch matters on macOS: Unix sockets have a small path limit, generated CommonJS executables must not inherit this package's ESM scope, and temporary homes must not sit inside an isolation mount.

File readers and rooted file publication use Linux `/proc` descriptor semantics. Their kernel integrations run only on Linux; the portable policy tests and unsupported-host rejection assertions also run on macOS. Run the actual Linux integration cases in an isolated Linux container with copied source, pinned Linux dependencies, and no host service sockets:

```sh
node node_modules/vitest/vitest.mjs run \
  test/file-delivery.test.ts test/web/file-delivery-routes.test.ts \
  --maxWorkers=1 --minWorkers=1
```

These tests do not require an operator account, a live agent, or a real network login. Synthetic Claude login tests use the host's `script` utility, including the BSD terminal adapter on macOS and util-linux on Linux. Give the test environment permission to create private local sockets and synthetic child processes.
