// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { canonicalize } from './canonical-json.js';

describe('canonicalize', () => {
  it('serializes primitives', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('hello')).toBe('"hello"');
  });

  it('sorts object keys lexicographically', () => {
    const a = canonicalize({ b: 1, a: 2, c: 3 });
    const b = canonicalize({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('recurses into nested objects', () => {
    const out = canonicalize({ z: { b: 2, a: 1 }, a: [3, 2, 1] });
    expect(out).toBe('{"a":[3,2,1],"z":{"a":1,"b":2}}');
  });

  it('skips undefined object values', () => {
    const out = canonicalize({ a: 1, b: undefined, c: 3 });
    expect(out).toBe('{"a":1,"c":3}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('produces identical output for semantically equal objects', () => {
    const obj1 = { foo: 'bar', nested: { x: 1, y: 2 } };
    const obj2 = { nested: { y: 2, x: 1 }, foo: 'bar' };
    expect(canonicalize(obj1)).toBe(canonicalize(obj2));
  });

  it('throws on non-finite numbers', () => {
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize(Infinity)).toThrow();
  });

  it('escapes strings via JSON.stringify rules', () => {
    expect(canonicalize('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });

  it('handles deeply nested objects', () => {
    const input = { a: { b: { c: { d: [1, 2, { e: 'f' }] } } } };
    const out = canonicalize(input);
    expect(out).toBe('{"a":{"b":{"c":{"d":[1,2,{"e":"f"}]}}}}');
  });

  it('serializes empty object and empty array', () => {
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
  });

  it('throws on a raw function', () => {
    expect(() => canonicalize(() => 1)).toThrow();
  });

  it('throws on a raw Symbol', () => {
    expect(() => canonicalize(Symbol('s') as unknown as string)).toThrow();
  });

  it('detects circular references via overflow', () => {
    const cycle: any = { a: 1 };
    cycle.self = cycle;
    // canonicalize recurses forever on cycles — we catch the stack overflow
    // here rather than pretending to support them. The real callers pass
    // plain JSON data anyway.
    expect(() => canonicalize(cycle)).toThrow();
  });

  it('object with string numeric keys sorts lexicographically not numerically', () => {
    // Canonical JSON sorts by string comparison: "10" < "2" because '1' < '2'
    expect(canonicalize({ '2': 'a', '10': 'b', '1': 'c' })).toBe('{"1":"c","10":"b","2":"a"}');
  });
});
