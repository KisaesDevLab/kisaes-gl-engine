// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-06: dedupe keys v1 reproduce __fixtures__/dedupe_v1.json exactly. The
// same file is read by the ClientLedger desktop's cargo tests through the
// engine submodule, so the keys and the OFX description assembly can't
// drift between the engine and a client.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalAmount, fitidKey, keyRows, norm, ofxDescription, rowKey } from './keys.js';

const golden = JSON.parse(readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'dedupe_v1.json'), 'utf8',
));

describe('dedupe keys v1 (golden)', () => {
  it('norm', () => {
    for (const c of golden.norm) expect(norm(c.input)).toBe(c.output);
  });

  it('canonical amount', () => {
    for (const c of golden.canonicalAmount) expect(canonicalAmount(c.input)).toBe(c.output);
  });

  it('row key, and its definition', () => {
    for (const c of golden.rowKey) {
      expect(canonicalAmount(c.amount)).toBe(c.canonicalAmount);
      expect(norm(c.description)).toBe(c.normDescription);
      expect(rowKey(c.date, c.canonicalAmount, c.normDescription, c.ordinal)).toBe(c.rowKey);
      const direct = createHash('sha256').update(`v1|row|${c.date}|${c.canonicalAmount}|${c.normDescription}|${c.ordinal}`, 'utf8').digest('hex');
      expect(direct).toBe(c.rowKey);
    }
  });

  it('ordinals count equal (date, amount, norm(description)) rows in request order', () => {
    const keyed = keyRows(golden.ordinals.rows);
    expect(keyed.map((k) => ({ ordinal: k.ordinal, rowKey: k.rowKey }))).toEqual(golden.ordinals.expected);
    expect(keyed.map((k) => k.ordinal)).toEqual([1, 2, 1, 1, 3]);
  });

  it('fitid key', () => {
    for (const c of golden.fitidKey) expect(fitidKey(c.fitid)).toBe(c.key);
    expect(golden.fitidKey[0].key).toBe(golden.fitidKey[1].key);
  });

  it('OFX description assembly', () => {
    for (const c of golden.ofxDescription) expect(ofxDescription(c.name, c.memo)).toBe(c.description);
  });
});
