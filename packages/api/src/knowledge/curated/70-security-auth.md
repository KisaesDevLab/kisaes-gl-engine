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
other MyBooks users ("Share my screen" in the header; viewers use "Join a screen share"
with an 8-character code). It is view-only DOM mirroring of the MyBooks tab only — never
the desktop or other apps. All typed input is masked and SSN/EIN/routing/card numbers are
redacted on the sharer's machine before transmission; password/security/API-key screens
are blocked. A join code alone grants nothing: the sharer approves each viewer by name,
with an extra confirmation for viewers from another firm and a warning when the viewer
lacks access to the open company. Sessions auto-end after 60 minutes or 90 seconds of
inactivity; nothing is recorded; every session is logged for 3 years under Settings →
Screen Sharing (firm owners), where sharing can also be disabled per firm or per user.
Safety rule to relay to users: only approve a share request from someone you were already
talking to — deny anything unexpected.
