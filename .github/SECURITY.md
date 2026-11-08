# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the Kisaes GL Engine, please report it responsibly.

**Email:** security@kisaes.com

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and aim to provide a fix within 7 days for critical issues.

The engine runs inside Kisaes products (MyBooks Online and ClientLedger). A report about the
engine's code belongs here; if you are unsure whether an issue is in the engine or in one of
those products, send it to the same address and we will route it.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Older releases | Best effort |

## Security Best Practices

When hosting the engine (for example, the server deployment behind MyBooks Online):

1. **Change default secrets** — Never use the default `JWT_SECRET` or `ENCRYPTION_KEY` in production
2. **Enable HTTPS** — Use a reverse proxy (Caddy, Nginx, Traefik) with TLS
3. **Enable 2FA** — Require two-factor authentication for all admin accounts
4. **Save your recovery key** — Store the 25-character recovery key shown during setup in a secure location
5. **Regular backups** — Enable automated backups with passphrase encryption
6. **Restrict ports** — Don't expose database or Redis ports to the public internet
7. **Keep updated** — Pull the latest version regularly to get security patches
