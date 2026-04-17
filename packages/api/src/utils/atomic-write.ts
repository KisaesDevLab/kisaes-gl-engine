// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import fs from 'fs';
import path from 'path';

/**
 * Atomically writes a buffer to `destPath`. Writes to a sibling `.tmp` file,
 * fsyncs, then renames over the destination. A crash mid-write leaves either
 * the previous file or the new file — never a truncated one.
 *
 * Used for the installation sentinel, host-id, and any other file where a
 * partial write would produce an unrecoverable "stuck in blocked state" on
 * next boot (F4).
 *
 * POSIX rename is atomic; on Windows dev boxes it is best-effort (the rename
 * may fail if another process has the destination open), which is acceptable
 * for this codebase — production runs on Linux inside Docker.
 */
export function writeAtomicSync(destPath: string, data: Buffer | string, mode: number = 0o600): void {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = destPath + '.tmp';
  const fd = fs.openSync(tmpPath, 'w', mode);
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, destPath);
}
