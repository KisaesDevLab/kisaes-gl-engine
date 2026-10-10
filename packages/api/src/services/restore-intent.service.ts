// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import fs from 'fs';
import path from 'path';
import { writeAtomicSync } from '../utils/atomic-write.js';

/**
 * `/data/.restore-intent` — an operator's recorded decision to rebuild this
 * installation from a backup (or start over) after a DATABASE_RESET_DETECTED
 * block. Written by the diagnostic app's prepare-restore endpoint, which
 * also removes the sentinel and the `.initialized` marker but deliberately
 * KEEPS `/data/.host-id` so the subsequent restore is recognised as
 * same-host (credentials stay readable, the recovery key stays valid).
 *
 * Without this file the validator would classify "host-id present, no
 * sentinel, empty DB" as ORPHANED_DATA and block again. The file is removed
 * when setup or a restore completes (`markInitialized`), or when the
 * operator starts fresh.
 */

export interface RestoreIntent {
  requestedAt: string;
  previousInstallationId: string | null;
  hostId: string | null;
  source: string;
}

export function getRestoreIntentPath(): string {
  return path.join(process.env['DATA_DIR'] || '/data', '.restore-intent');
}

export function restoreIntentExists(): boolean {
  return fs.existsSync(getRestoreIntentPath());
}

export function readRestoreIntent(): RestoreIntent | null {
  const p = getRestoreIntentPath();
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<RestoreIntent>;
    return {
      requestedAt: typeof parsed.requestedAt === 'string' ? parsed.requestedAt : '',
      previousInstallationId: typeof parsed.previousInstallationId === 'string' ? parsed.previousInstallationId : null,
      hostId: typeof parsed.hostId === 'string' ? parsed.hostId : null,
      source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
    };
  } catch {
    // A corrupt intent file still records intent — the operator deliberately
    // asked for a restore; treat it as present.
    return { requestedAt: '', previousInstallationId: null, hostId: null, source: 'unknown' };
  }
}

export function writeRestoreIntent(intent: Omit<RestoreIntent, 'requestedAt'>): void {
  const payload: RestoreIntent = { requestedAt: new Date().toISOString(), ...intent };
  writeAtomicSync(getRestoreIntentPath(), JSON.stringify(payload, null, 2), 0o600);
}

export function clearRestoreIntent(): void {
  const p = getRestoreIntentPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
