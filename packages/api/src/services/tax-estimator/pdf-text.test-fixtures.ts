// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Test helper: the text a pdf-lib document drew, in drawing order, with the page and
// the baseline y of every string. pdf-lib writes standard-font text as hex strings
// (`<..> Tj`) after a `1 0 0 1 x y Tm`, in Flate-compressed content streams, so this
// small reader is enough for our own renderers (it is NOT a general PDF parser).

import { inflateSync } from 'node:zlib';

export interface DrawnText { page: number; x: number; y: number; text: string }

export function pdfDrawnText(bytes: Uint8Array): DrawnText[] {
  const b = Buffer.from(bytes);
  const s = b.toString('latin1');
  const out: DrawnText[] = [];
  let pos = 0;
  let page = 0;
  for (;;) {
    const i = s.indexOf('stream', pos);
    if (i < 0) break;
    if (s.slice(i - 3, i) === 'end') { pos = i + 6; continue; }
    let start = i + 6;
    if (s[start] === '\r') start++;
    if (s[start] === '\n') start++;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    const raw = b.subarray(start, end);
    let body: string;
    try { body = inflateSync(raw).toString('latin1'); } catch { body = raw.toString('latin1'); }
    pos = end + 9;
    const items = [...body.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)> Tj/g)];
    if (items.length === 0) continue;
    page++;
    for (const m of items) out.push({ page, x: Number(m[1]), y: Number(m[2]), text: Buffer.from(m[3]!, 'hex').toString('latin1') });
  }
  return out;
}

/** All drawn strings joined by newlines (one string per line). */
export function pdfText(bytes: Uint8Array): string {
  return pdfDrawnText(bytes).map((t) => t.text).join('\n');
}
