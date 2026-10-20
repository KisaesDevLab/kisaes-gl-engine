// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Path containment for file names that come from the database or from an
 * archive. A stored path is data, not an instruction: before the engine
 * reads, writes or unlinks it, the resolved (realpath) location must sit
 * inside the directory the column is defined against, e.g.
 * UPLOAD_DIR/signatures/<tenant> for a check signature.
 *
 * `resolveInside` returns null (never throws) so callers that clean up
 * best-effort can simply skip a path that escapes; `assertInside` throws a
 * plain Error for callers that must refuse.
 */

import fs from 'node:fs';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isInside(root: string, full: string): boolean {
  return full === root || full.startsWith(root + path.sep);
}

/**
 * Resolves `candidate` (relative to `root`, or absolute) and returns its
 * real path when it exists as a regular file inside `root`; otherwise null.
 * Symlinks are followed on both sides so a link that points outside is
 * refused. NUL bytes and empty candidates are refused.
 */
export function resolveInside(root: string, candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) return null;
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    return null;
  }
  const full = path.resolve(rootReal, candidate);
  if (!isInside(rootReal, full)) return null;
  let real: string;
  try {
    real = fs.realpathSync(full);
  } catch {
    return null;
  }
  if (!isInside(rootReal, real)) return null;
  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

/** `resolveInside`, throwing `Error(message)` instead of returning null. */
export function assertInside(root: string, candidate: string | null | undefined, message = 'file path escapes its directory'): string {
  const real = resolveInside(root, candidate);
  if (!real) throw new Error(message);
  return real;
}

/**
 * Whether a storage key may be used on behalf of `tenantId`. Keys are
 * `<tenant>/<domain>/...` (current layout) or `<domain>/<tenant>/...`
 * (legacy layout). A key whose first or second segment is a uuid of a
 * different tenant, or whose root is the reserved `_system` folder, is
 * another tenant's (or the appliance's) file and is refused. Keys without
 * any tenant segment (very old rows) pass; the provider's own root
 * containment still applies to them.
 */
export function keyBelongsToTenant(key: string, tenantId: string): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) return false;
  const segments = key.replace(/^\/+/, '').split('/');
  const want = tenantId.toLowerCase();
  if (segments[0] === '_system') return want === '_system';
  for (const seg of segments.slice(0, 2)) {
    if (UUID_RE.test(seg) && seg.toLowerCase() !== want) return false;
  }
  return true;
}
