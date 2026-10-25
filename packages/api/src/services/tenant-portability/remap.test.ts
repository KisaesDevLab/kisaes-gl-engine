// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// jsonb key order after id substitution (U-91): the import gives rows new
// ids, PostgreSQL re-sorts the keys of an id-keyed jsonb object by the new
// ids, and the verification must put them back in the order the export saw.

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { IdMap, compareJsonbKeys, isJsonbType, reorderJsonKeys, reorderJsonbFields } from './remap.js';
import { sameJson } from './verify.js';

/** n old ids in ascending order, each mapped to a new id so the new ids sort in the opposite order. */
function reversedMap(n: number): { map: IdMap; olds: string[] } {
  const map = new IdMap();
  const id = (k: number, tail: string) => `${String(k).padStart(8, '0')}-${tail}`;
  const olds = Array.from({ length: n }, (_, i) => id(i + 1, '0000-4000-8000-000000000000'));
  olds.forEach((o, i) => map.set(o, id(n - i, '1111-4111-8111-111111111111')));
  return { map, olds };
}

async function pgText(jsonbText: string): Promise<string> {
  const r = await db.execute(sql`SELECT row_to_json(c)::text AS j FROM (SELECT ${jsonbText}::jsonb AS s) c`);
  const j = (r.rows[0] as { j: string }).j;
  return j.slice('{"s":'.length, -1);
}

describe('compareJsonbKeys', () => {
  it('orders by UTF-8 byte length first, then bytewise', () => {
    expect(['format', 'zz', 'defaultBankAccountId', 'a', 'é', 'b'].sort(compareJsonbKeys)).toEqual(['a', 'b', 'zz', 'é', 'format', 'defaultBankAccountId']);
  });
});

describe('reorderJsonKeys', () => {
  it('is the identity on jsonb text printed by PostgreSQL', () => {
    const pg = '{"a": {"b": 2, "longkey": [1, {"b": 1.50, "q": "x\\"{\\u0001é", "y": 2}]}, "e": [], "n": {}, "zz": 1, "format": "v", "defaultBankAccountId": null}';
    expect(reorderJsonKeys(pg)).toBe(pg);
  });

  it('sorts nested objects, keeps array order, separators, numbers and strings verbatim', () => {
    expect(reorderJsonKeys('{"zz": [3, 1, {"b": 1, "a": -0.0001e5}], "a": "}{\\"[,"}')).toBe('{"a": "}{\\"[,", "zz": [3, 1, {"a": -0.0001e5, "b": 1}]}');
    expect(reorderJsonKeys('{"b":999999999999999.9999,"a":{}}')).toBe('{"a":{},"b":999999999999999.9999}');
    expect(reorderJsonKeys('[{"b": 1, "a": 2},{"d": 1}]')).toBe('[{"a": 2, "b": 1},{"d": 1}]');
    expect(reorderJsonKeys('{ }')).toBe('{ }');
    expect(reorderJsonKeys('null')).toBe('null');
    expect(reorderJsonKeys('"x"')).toBe('"x"');
  });

  it('throws on malformed JSON', () => {
    for (const bad of ['{"a": 1', '{"a" 1}', '[1, 2', '{"a": 1} x', '', '{a: 1}']) expect(() => reorderJsonKeys(bad), bad).toThrow();
  });
});

describe('reorderJsonbFields', () => {
  it('restores the export text of an id-keyed map after substitute, re-sort and inverse (the U-91 bug)', () => {
    const { map, olds } = reversedMap(3);
    const exported = `{"id":"${olds[0]}","check_settings":{"format": "voucher", "nextCheckNumbers": {"${olds[0]}": 1001, "${olds[1]}": 2001, "${olds[2]}": 3001}},"amount":999999999999999.9999,"memo":"{\\"z\\": 1, \\"a\\": 2}"}`;
    // What PostgreSQL holds after the import: new ids, keys sorted by them.
    const substituted = map.substitute(exported);
    const stored = reorderJsonbFields(substituted, ['check_settings']);
    expect(stored).not.toBe(substituted);
    const mappedBack = map.inverse(stored);
    expect(mappedBack).not.toBe(exported);
    expect(reorderJsonbFields(mappedBack, ['check_settings'])).toBe(exported);
  });

  it('leaves other fields, null, absent and malformed fields untouched', () => {
    const line = '{"j":{"b": 1, "a": 2},"t":"{\\"b\\": 1, \\"a\\": 2}","n":null}';
    expect(reorderJsonbFields(line, ['j'])).toBe('{"j":{"a": 2, "b": 1},"t":"{\\"b\\": 1, \\"a\\": 2}","n":null}');
    expect(reorderJsonbFields(line, ['n', 'missing'])).toBe(line);
    expect(reorderJsonbFields('{"j":{"b": 1, "a"}}', ['j'])).toBe('{"j":{"b": 1, "a"}}');
  });

  it('matches PostgreSQL for random id-keyed maps mapped to new ids and back', async () => {
    for (let run = 0; run < 20; run++) {
      const map = new IdMap();
      const obj: Record<string, unknown> = { format: 'voucher', zz: 1, 'é': [1, { y: 2, b: '1.50' }] };
      const keys: Record<string, number> = {};
      for (let i = 0; i < 5; i++) {
        const o = crypto.randomUUID();
        map.fresh(o);
        keys[o] = 1000 * (i + 1);
      }
      obj['nextCheckNumbers'] = keys;
      const exported = await pgText(JSON.stringify(obj));
      const stored = await pgText(map.substitute(exported));
      expect(reorderJsonKeys(map.inverse(stored))).toBe(exported);
    }
  });
});

describe('isJsonbType', () => {
  it('is true for jsonb and jsonb arrays only', () => {
    expect(['jsonb', 'jsonb[]'].map(isJsonbType)).toEqual([true, true]);
    expect(['json', 'json[]', 'text', 'uuid[]', 'numeric(19,4)'].map(isJsonbType)).toEqual([false, false, false, false, false]);
  });
});

describe('sameJson', () => {
  it('ignores object key order only', () => {
    expect(sameJson({ a: 1, b: { d: [1, 2], c: null } }, { b: { c: null, d: [1, 2] }, a: 1 })).toBe(true);
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: 1 })).toBe(false);
    expect(sameJson({ a: '1' }, { a: 1 })).toBe(false);
    expect(sameJson(null, null)).toBe(true);
    expect(sameJson(undefined, null)).toBe(false);
  });
});
