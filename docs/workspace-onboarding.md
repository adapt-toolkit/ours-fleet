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
these credentials.

### Browser link credentials

A linked browser holds two credentials with different jobs and lifetimes.

| Credential | Lifetime | Where it lives |
| --- | --- | --- |
| Access | 5 minutes | Page memory only. Sent on each request to this host. |
| Refresh | Single use; lapses after 7 days unused | `HttpOnly` cookie on the account origin. Never readable by a page. |
| Link (the family of refresh credentials) | 30 days from linking, fixed | The device row on this host. |

Rotation and expiry are separate. Every refresh replaces the refresh credential,
so an active browser changes it every few minutes; that is rotation. Expiry is
the two deadlines above: an unused refresh credential lapses after 7 days, and
no amount of rotation moves a link past the 30 days fixed when it was created.
After either deadline the browser needs a new link code.

No standard prescribes these numbers. RFC 9700 §4.14.2 requires rotation or
sender-constraining for public clients and says refresh credentials should
expire after inactivity; RFC 10017 §6.3.2.3 requires a maximum lifetime or
inactivity expiry and forbids extending a rotated credential past the initial one. The
values are this project's choice: 5 minutes bounds what a copied access
credential is worth, 7 days ends links on browsers that stopped being used, and
30 days (the same bound NIST SP 800-63B-4 suggests for its lowest assurance
level, used here only as a comparison) is the longest a link lasts, down from
the fixed 90-day bearer it replaces. A shorter maximum would send every browser
back to the host for a code more often, because linking needs a code from the
host or from another linked browser.

The cookie belongs to the account origin because this host is a different site
from the App: a cookie set here would be a third-party cookie, which browsers
block or partition. The account server therefore relays `devices/enroll`
(`credential: 2`), `devices/refresh`, `devices/exchange`, `devices/revoke` and
the refresh-proven form of `devices/link` to this host. Those requests are
accepted only without `Origin`, `Sec-Fetch-*` and `Cookie` headers, which every
browser sends, so no page can be handed a refresh credential. The account server
passes refresh credentials through and keeps none; pages keep talking to this
host directly, so workspace content never passes through the account server.
Script running in the App's page can still ask the account server for a fresh
access credential while the owning account is signed in; what it cannot do is
read or keep the refresh credential.

This is the token-mediating backend of RFC 10017 §6.2, not the full
backend-for-frontend that RFC prefers (§6.2.4.4). A full one would hide the
access credential from the page too, but only by carrying every request,
stream, socket, media range and voice session of every workspace through the
account server. Workspace content staying between the browser and its own host
is a property this design keeps; the cost is that an access credential copied
from a page is usable elsewhere until it expires, at most five minutes later.

A refresh credential has exactly one successor. Until the successor is seen in
use (it is presented itself, or an access credential issued with it
authenticates a request), presenting the spent credential again returns the
same successor and extends nothing: a lost answer, a closed tab or a restart all
converge on one value. Once the successor is in use, the spent credential is a
replay: the link, every credential of it and every link issued from it are
revoked, and their open transports close. This differs from revoking on the
first repeat; it is deliberate, so that an answer lost on the way does not cost
the user their link.

An access credential cannot create a link code: `devices/link` needs the link's
current refresh credential, which the account server sends only after a recent
reauthentication of the owning account. That requirement stops a copied access
credential from becoming a lasting one; it does not stop script that is running
in the page during those minutes. Making a code rotates the refresh credential
and counts its successor as in use at once, so a copy of the spent credential
is a replay on its next refresh, which also ends the link made from that code.
An answer lost while making a code is therefore not retried: the browser links
again.

A stream, socket or socket ticket ends when the access credential that opened
or minted it expires, whatever newer credentials the same link holds; the App
reconnects with its current one. Revocation, replay and sign-out
close everything the link has open at once.

Fixed bearers issued to earlier App versions are exchanged once through
`devices/exchange`: the device keeps its identity, the bearer stops working in
the same transaction, and the link ends no later than the bearer would have.
Fixed bearers are accepted, and issued to earlier App versions, for 30 days
after this host first runs a version with rotating credentials; after that they
are refused and those browsers need a new link code. Update hosts before the
App: an earlier App keeps working against an updated host inside that window,
while the current App needs a host with these routes.

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

Fleet releases contain no frontend. The App serves every workspace screen and
calls this host's API with the device credential; Fleet answers JSON only.

Enrollment stops only its previously recorded managed web service, checks the
recorded/default loopback port, and selects an OS-assigned free replacement when
occupied. A one-minute private enrollment marker permits recovery from a bind
race. The actual bound port is saved in private web metadata and the managed unit;
normal restarts do not silently relocate a retained tunnel. Cloudflare target
configuration uses a bounded receipt of the previously SDK-verified signed root
binding, never a client assertion of root identity. The app must expose the
matching workspace-tunnel-configure endpoint before this Fleet release is used.
