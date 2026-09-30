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
