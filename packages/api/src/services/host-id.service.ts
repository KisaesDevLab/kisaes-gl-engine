import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { writeAtomicSync } from '../utils/atomic-write.js';

/**
 * Volume-pinned host identity. A random UUID written once to `/data/.host-id`
 * on first boot and never regenerated as long as the file exists. The value
 * survives container rebuilds (the file lives on the bind-mounted `./data`
 * volume), so repeated `docker compose up --force-recreate` does not look
 * like a "new host" to the installation validator.
 *
 * This is the signal used by the validator and the restore flow to tell
 * "same volume, same install" apart from "restored a backup onto a fresh
 * volume" — see plans/serialized-watching-moler.md F8. The name is
 * deliberately "host ID" even though it is really a "storage volume ID":
 * from the app's perspective, the storage volume IS the host identity.
 *
 * NOT derived from /etc/machine-id — that would regenerate on every
 * container recreate inside Docker, producing false mismatches.
 */

export function getHostIdPath(): string {
  return path.join(process.env['DATA_DIR'] || '/data', '.host-id');
}

export function hostIdExists(): boolean {
  return fs.existsSync(getHostIdPath());
}

/**
 * Read the current host ID, creating it atomically if the file is missing.
 * Idempotent. Throws if the data directory is not writable.
 */
export function ensureHostId(): string {
  const p = getHostIdPath();
  if (fs.existsSync(p)) {
    const existing = fs.readFileSync(p, 'utf8').trim();
    if (isValidUuid(existing)) return existing;
    // File exists but contents are garbage — overwrite with a fresh UUID.
    // This is the right call over throwing: the alternative would be to
    // block startup on a one-byte corruption in a dotfile that has no
    // backups.
  }
  const fresh = crypto.randomUUID();
  writeAtomicSync(p, fresh, 0o600);
  return fresh;
}

/** Read the host ID without creating one. Returns null if the file is absent. */
export function readHostId(): string | null {
  const p = getHostIdPath();
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8').trim();
  return isValidUuid(raw) ? raw : null;
}

function isValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
