# Local browser gateway

Build Fleet and the Messenger Fleet frontend, then run `node scripts/local-gateway.mjs /absolute/path/gateway.json` from the Fleet repository. This development entry point serves the frontend and Fleet's application API behind one browser origin. It uses the existing password/device/session configuration in `webStateDir/access.json`.

Example configuration (use absolute paths; keep the real file private when it contains service credentials):

```json
{
  "fleetConfig": "/workspace/config/fleet.yaml",
  "webStateDir": "/workspace/private/web",
  "staticRoot": "/workspace/ours-messenger-server/dist/web",
  "fleetPort": 49672,
  "port": 49671,
  "publicOrigin": "http://127.0.0.1:49671",
  "services": [
    { "prefix": "/messenger", "origin": "http://127.0.0.1:49673" }
  ]
}
```

Both Fleet listeners bind loopback. The service backend must also be isolated and configured for the same browser public origin. Configure an explicit SDK client profile through `OURS_CONFIG`; select the intended Fleet state with `OURS_FLEET_HOME`. Deep workspace layouts can opt into `OURS_FLEET_SOCKET_ROOT`, an absolute, owner-only 0700 directory with enough room for a 30-byte socket filename. Worker processes inherit these settings. Explicit Fleet configuration and CLI paths propagate to task member launches and external workers.

`/fleet/api/v1/...` reaches Fleet's existing application services. Each configured service prefix strips only the prefix and forwards the remaining raw method/path/query/body to its backend. Adding a backend endpoint requires no Fleet handler or schema. A registry entry can specify `headers` for a server-side service credential. Browser cookies, authorization and common CSRF tokens never become upstream credentials. Upstream status/content types, streaming bodies and WebSockets remain backend contracts. Logout closes authenticated service streams and WebSockets.

The browser boundary checks the configured Host, mutation Origin, session and CSRF. Cross-site top-level GET document navigation may open the static login page; API requests, frames and mutations do not receive that exception. Set `publicOrigin` to the exact HTTPS tunnel origin and configure backend browser origins identically. Never expose the inner API/backend listeners directly.

The transport also supports `auth: 'backend'` for a **separate loopback-only machine-client listener**: it preserves upstream credentials and rejects browser Origin/fetch-metadata requests. That listener is not the public browser perimeter and must not be tunnelled. A pinned SDK profile can target it when the SDK expects `/daemon` and `/cowork` prefixes.

This local integration does not implement central accounts, permanent tunnel provisioning or the entire future API inventory. Notifications in this frontend show current permission requests and unread messages; they are not a new centralized push service. Quick Tunnels buffer SSE, so the frontend also polls chat/history and role/task state. A normal local origin retains streaming transport support.

Validation: `npm run typecheck`, `npx vitest run test/web test/socket-path.test.ts test/rooms-tasks-provision.test.ts`. The transport tests exercise an unknown encoded route, a large binary body, incremental SSE, WebSockets, logout closure, partial upstream abort, external navigation and private machine-client browser rejection.
