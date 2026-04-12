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
