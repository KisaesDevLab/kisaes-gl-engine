// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Loads the bundled OFL font files (packages/api/assets/fs-fonts) for PDF
// embedding. Resolved from FS_FONT_DIR, else relative to this module in
// both src (tsx) and dist layouts. Base64 is cached per file.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FS_FONT_FILES, fsFont, type FsFontKey } from '@kis-books/shared';

let fontDir: string | null = null;

export function fsFontDir(): string {
  if (fontDir) return fontDir;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env['FS_FONT_DIR'],
    path.resolve(here, '../../../../assets/fs-fonts'),      // src/services/tb/fs → packages/api/assets
    path.resolve(here, '../../../../../assets/fs-fonts'),   // dist/src/... layouts
    path.resolve(process.cwd(), 'assets/fs-fonts'),
    path.resolve(process.cwd(), 'packages/api/assets/fs-fonts'),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (existsSync(path.join(c, 'LiberationSerif-Regular.ttf'))) {
      fontDir = c;
      return c;
    }
  }
  throw new Error(`Financial-statement fonts not found (looked in ${candidates.join(', ')})`);
}

const bytesCache = new Map<string, Buffer>();

export function fsFontBytes(file: string): Buffer {
  if (!FS_FONT_FILES.has(file)) throw new Error(`Unknown font file ${file}`);
  let b = bytesCache.get(file);
  if (!b) {
    b = readFileSync(path.join(fsFontDir(), file));
    bytesCache.set(file, b);
  }
  return b;
}

export function fsFontDataFiles(key: FsFontKey): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fsFont(key).faces) out[f.file] = fsFontBytes(f.file).toString('base64');
  return out;
}
