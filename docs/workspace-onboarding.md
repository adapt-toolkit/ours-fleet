# Workspace enrollment and devices

Build the matching task installer, Messenger and Fleet commits together; published
packages do not contain these features until released. Full setup and the account
server's source selection are documented in ours-app `server/DEPLOYMENT.md`.

Use `ours-fleet workspace-enroll --file /absolute/private/workspace.payload` with an
owned 0600 payload and the supported explicit managed gateway client profile.
The command verifies the Messenger's structural Human root and retained room Owner
CID before consuming the private enrollment challenge. Disabled automatic Owner
attachment is refused. Repeats preserve the root, manifest and Owner invitation
file while submitting a new expiring challenge. Do not replay consumed invitations.

Enrollment configures a named tunnel connector and protects the workspace gateway
at port 49271. `/fleet/api`, `/daemon`, `/cowork` and `/messenger` require per-device
credentials; private machine credentials remain on the host. Cloudflare management
credentials belong only to the account server. A usable tunnel requires actual
provider configuration and an active connector, not merely an enrollment receipt.

Run `ours-fleet link-device` on the enrolled host, or use Devices
on a connected browser. The terminal prints a QR/copyable five-minute single-use
code; consuming it creates a distinct device credential. Treat codes as private.
Devices lists metadata, never raw bearers. Revoking a device invalidates its requests
and open transports while other devices continue. The account server cannot recover
these credentials. Browser credentials are scoped to account/workspace in IndexedDB.

The wizard reads real harness prerequisites, active subscription-profile health and
this Fleet artifact's supported model catalogue. It saves configuration using a
revision guard and starts FleetCoordinator through the ordinary lifecycle. An
accepted start does not establish provider authentication or actual model access.
Owner invitations attach the same active native Human seat to new task rooms;
CID comparisons tolerate hexadecimal casing. Existing room defaults remain intact.

The account launcher supports the exact production origin https://app.ours.network
and controlled test origin https://app.ours-tunnel.com. Enrollment persists one
trusted origin; CORS/CSP/bearer checks use it without granting access to the other.
To switch the same account/workspace after moving the account server, obtain a
fresh private setup file and run `ours-fleet workspace-enroll --file /private/new.payload
--migrate-app-origin`. The server identity and Human Owner are retained, and local
trust changes only after the fresh challenge has a confirmed signed root receipt.
Default enrollment refuses an origin change. The runtime restarts, device records
remain local, and each browser signs in and links a new device on the new account
origin. Follow ours-app/server/DEPLOYMENT.md; do not edit private binding files.

Workspace releases include the pinned standalone frontend under `dist/web-app`.
Hosted builds first build the immutable ours-app commit in `web-source.json`,
then copy its complete entry/assets/service worker before stamping and packing
Fleet. Source-only API builds can omit it; they do not qualify workspace UI delivery.

Enrollment stops only its previously recorded managed web service, checks the
recorded/default loopback port, and selects an OS-assigned free replacement when
occupied. A one-minute private enrollment marker permits recovery from a bind
race. The actual bound port is saved in private web metadata and the managed unit;
normal restarts do not silently relocate a retained tunnel. Cloudflare target
configuration uses a bounded receipt of the previously SDK-verified signed root
binding, never a client assertion of root identity. The app must expose the
matching workspace-tunnel-configure endpoint before this Fleet release is used.
