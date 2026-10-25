// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Request hash of Idempotency-Key records (U-18): E1 canonical JSON, E2 the
// secret strip.

import { describe, it, expect } from 'vitest';
import { canonicalize } from './canonical-json.js';
import { requestHash, requestHashInput } from './request-hash.js';

const base = {
  method: 'POST', route: '/transactions', params: {}, query: {}, companyId: 'c1', ifMatch: null,
};

/** Deterministic PRNG (mulberry32), so a failure is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The same value with every object's keys inserted in a random order. */
function shuffleKeys(value: unknown, rand: () => number): unknown {
  if (Array.isArray(value)) return value.map((v) => shuffleKeys(v, rand));
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [keys[i], keys[j]] = [keys[j]!, keys[i]!];
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = shuffleKeys((value as Record<string, unknown>)[k], rand);
    return out;
  }
  return value;
}

/** A random JSON body: nested objects and arrays of strings, numbers, booleans and null. */
function randomBody(rand: () => number, depth = 0): unknown {
  const pick = rand();
  if (depth > 3 || pick < 0.3) {
    const s = rand();
    if (s < 0.25) return `${Math.floor(rand() * 1e6) / 100}`;
    if (s < 0.5) return Math.floor(rand() * 1000);
    if (s < 0.65) return rand() < 0.5;
    if (s < 0.75) return null;
    return ['Café', 'Zoë & Co', '日本', '\u{1F600}', 'a"b\\c'][Math.floor(rand() * 5)];
  }
  if (pick < 0.55) return Array.from({ length: Math.floor(rand() * 4) }, () => randomBody(rand, depth + 1));
  const obj: Record<string, unknown> = {};
  const n = 1 + Math.floor(rand() * 6);
  for (let i = 0; i < n; i++) obj[`k${Math.floor(rand() * 50)}${['', 'É', 'z', 'A'][i % 4]}`] = randomBody(rand, depth + 1);
  return obj;
}

describe('E1 canonical JSON', () => {
  it('sorts keys recursively, keeps array order, no whitespace', () => {
    expect(canonicalize({ b: 1, a: { d: [3, 1, { z: 1, y: 2 }], c: 'x' } }))
      .toBe('{"a":{"c":"x","d":[3,1,{"y":2,"z":1}]},"b":1}');
  });

  it('orders keys by UTF-16 code unit and escapes strings as JSON.stringify', () => {
    expect(canonicalize({ 'é': 1, z: 2, Z: 3, '\u{1F600}': 4 })).toBe('{"Z":3,"z":2,"é":1,"\u{1F600}":4}');
    expect(canonicalize({ s: 'a"b\\c\n' })).toBe(`{"s":${JSON.stringify('a"b\\c\n')}}`);
  });

  it('drops undefined keys (as JSON does) and keeps amount strings as sent', () => {
    const h1 = requestHash({ ...base, body: { amount: '10.50', memo: undefined } });
    const h2 = requestHash({ ...base, body: { amount: '10.50' } });
    const h3 = requestHash({ ...base, body: { amount: '10.5' } });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('array order matters, key order does not', () => {
    expect(requestHash({ ...base, body: { lines: [1, 2] } })).not.toBe(requestHash({ ...base, body: { lines: [2, 1] } }));
    expect(requestHash({ ...base, body: { a: 1, b: 2 } })).toBe(requestHash({ ...base, body: { b: 2, a: 1 } }));
  });

  it('property: random key permutations give an identical hash (500 bodies)', () => {
    const rand = rng(18);
    for (let i = 0; i < 500; i++) {
      const body = randomBody(rand);
      const reordered = shuffleKeys(body, rand);
      expect(requestHash({ ...base, body: reordered })).toBe(requestHash({ ...base, body }));
    }
  });

  it('method, route, params, query, company and If-Match are all in the hash', () => {
    const h = requestHash({ ...base, body: {} });
    expect(requestHash({ ...base, method: 'PUT', body: {} })).not.toBe(h);
    expect(requestHash({ ...base, route: '/checks', body: {} })).not.toBe(h);
    expect(requestHash({ ...base, params: { id: 'x' }, body: {} })).not.toBe(h);
    expect(requestHash({ ...base, query: { version: '2' }, body: {} })).not.toBe(h);
    expect(requestHash({ ...base, companyId: 'c2', body: {} })).not.toBe(h);
    expect(requestHash({ ...base, ifMatch: '"3"', body: {} })).not.toBe(h);
    // A DELETE without a body hashes as {}.
    expect(requestHash({ ...base, body: undefined })).toBe(h);
    expect(requestHash({ ...base, body: null })).toBe(h);
  });
});

describe('E2 secret keys are not hashed', () => {
  it('closingPassword and secret-pattern keys leave the hash unchanged', () => {
    const body = { txnType: 'expense', amount: '12.00', lines: [{ accountId: 'a', debit: '12.00' }] };
    const h = requestHash({ ...base, body });
    expect(requestHash({ ...base, body: { ...body, closingPassword: 'hunter2' } })).toBe(h);
    expect(requestHash({ ...base, body: { ...body, apiKey: 'sk-1', nested: undefined } })).toBe(h);
    expect(requestHash({ ...base, body: { ...body, lines: [{ accountId: 'a', debit: '12.00', accessToken: 't' }] } })).toBe(h);
    expect(requestHashInput({ ...base, body: { ...body, closingPassword: 'hunter2' } })).not.toContain('hunter2');
  });

  it('overrideConfirmed stays in the hash', () => {
    expect(requestHash({ ...base, body: { overrideConfirmed: true } })).not.toBe(requestHash({ ...base, body: {} }));
  });
});
