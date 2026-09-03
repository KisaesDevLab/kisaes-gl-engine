## Security & Authentication

### Two-Factor Authentication (2FA)
Vibe MyBooks supports multiple 2FA methods, configured under **Settings → Security →**:

- **TOTP** — use an authenticator app (Google Authenticator, Authy, etc.) to generate
  time-based codes. This is the most common and recommended method.
- **Email** — receive a 6-digit code at your account email address.
- **SMS** — receive a 6-digit code via text message (must be enabled by the administrator
  under **Admin → System Settings →**).

When enabling 2FA for the first time, you'll be given **recovery codes** — 8–10 single-use
backup codes in XXXX-XXXX format. Store them somewhere safe (you can copy or download them
as a text file). If you lose your authenticator, these codes are the only way in. The system
warns you when fewer than 3 remain. You can regenerate codes under **Settings → Security →**,
but this invalidates all previous codes and requires your password.

**Trusted Devices:** After entering your 2FA code you can optionally check "Trust this
device for 30 days" to skip 2FA on that browser. This trust is per-device only.

### Passkeys (Passwordless Login)
Passkeys let you sign in with your fingerprint, face recognition, or a hardware security key
(YubiKey, etc.) instead of typing a password. To set up a passkey:

1. Go to **Settings → Security →** and find the Passkeys section.
2. Click **Register Passkey** and follow your browser's prompt.
3. Give it a name (e.g., "MacBook Touch ID" or "YubiKey 5").

Each passkey shows its creation date and last use. You can rename or remove passkeys at
any time. Your biometric data never leaves your device — Vibe MyBooks only stores a
cryptographic public key.

### Magic Links
Magic links let you sign in via an email link instead of a password. To enable:

1. Go to **Settings → Security →** and look for Login Methods.
2. Toggle **Magic Link Login** on. Note: you must already have TOTP or SMS 2FA configured.

When you click the magic link in your email, you'll still need to complete 2FA verification
for security.

### Team & User Management
Company owners can invite other users under **Settings → Team →**. Invited users receive
an email with a link to set up their account. Each user can have different roles and access
levels per company. Use **Admin → All Users →** (admin only) to manage users across the
entire system.

If a team member forgets their password, the owner can click **Reset** on their row on
the Team page to email them a password-reset link (valid 1 hour). Admins have the same
option in the Reset Password dialog on **Admin → All Users →** ("Send reset email"),
alongside the ability to set a password directly.

### Changing Your Own Password
Any signed-in user can change their password under **Settings → Security →** in the
**Password** card: enter the current password and a new one (at least 8 characters).
Changing it signs you out on every other device; the browser you changed it from stays
signed in. Passwords found in known data breaches are rejected.

### Changing a Team Member's Role
Owners can change a member's role (including removing a read-only designation): on
**Settings → Team →**, click **Edit** on the user's row and pick the new role (Owner,
Accountant, Bookkeeper, or Read-only). You cannot change your own role, and the last
owner cannot be demoted — a company always keeps at least one owner. Role changes take
effect within about 15 minutes. External (client) users don't use the role selector —
manage their access with the **Permissions** button instead.

### Per-Member Permissions
Owners can fine-tune what each **bookkeeper** can see and do under
**Settings → Team →**. Access is set per feature (Invoices, Bills, Banking, Reports,
Chart of Accounts, etc.) at one of three levels: **none** (hidden), **view**
(read-only), or **full** (read and write).

- Only the bookkeeper role is customizable. Owners and accountants always have full
  access; read-only users always have view access everywhere.
- A bookkeeper with no custom permissions keeps full access, so existing team members
  are unaffected until you restrict them.
- **Permission Templates** (button at the top of the Team page) define reusable
  permission sets — e.g., an "AR Clerk" template with full access to Invoices and
  Receive Payment and view access elsewhere. Assign a template to a bookkeeper, then
  optionally override individual features via the **Permissions** action on their row.
- Permissions are enforced by the server on every feature, not just hidden from the
  menu — restricted screens and API calls are blocked.

### Company Access Control
For tenants with multiple companies, administrators can limit which companies an
accountant or bookkeeper can see. Under **Admin → All Users →**, the **Company Access**
action lists every company with a Has Access / Excluded toggle. Excluded companies
disappear from that user's company switcher and cannot be opened.

### Peer Screen Sharing
When enabled by the appliance operator, users can share their MyBooks screen live with
other MyBooks users. Both entry points live on the **Help → Knowledge Base** page:
"Share my screen" starts a session, and viewers use "Join a screen share" with an
8-character code. It is view-only DOM mirroring of the MyBooks tab only — never
the desktop or other apps. All typed input is masked and SSN/EIN/routing/card numbers are
redacted on the sharer's machine before transmission; password/security/API-key screens
are blocked. A join code alone grants nothing: the sharer approves each viewer by name,
with an extra confirmation for viewers from another firm and a warning when the viewer
lacks access to the open company. Sessions auto-end after 60 minutes or 90 seconds of
inactivity; nothing is recorded; every session is logged for 3 years under Settings →
Screen Sharing (firm owners), where sharing can also be disabled per firm or per user.
Safety rule to relay to users: only approve a share request from someone you were already
talking to — deny anything unexpected.

### Account lockout — how a locked user gets back in
After too many failed sign-ins an account locks and the login page says to contact your
administrator. **Lockouts never expire on their own** — waiting does not help, by design
(an automatic release would just give a password guesser another window).

To release one:
- **Settings → Team** — a locked member shows a red **Locked** badge; an owner clicks
  **Unlock** on that row. This is tenant-scoped: owners can only unlock their own team.
- **Admin → Users** (super-admin) — locked rows show a red padlock button that unlocks
  after a confirmation.

Unlocking clears the failed-attempt counter and is written to the audit log
(`user_login_unlocked`). It does not change the password — pair it with **Reset** if the
user has forgotten theirs.

### Password requirements
Account passwords must be **at least 12 characters** (maximum 128). This is one policy
shared by every screen that sets a password: registration, forgot-password reset,
change-password in Settings, admin-created users, admin password resets, and the client
portal. Passwords are also checked against known-breach lists, so a long but widely
leaked password is refused.

Raising the minimum does not lock anyone out — existing shorter passwords keep working at
sign-in until their owner next changes one.
