// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Id map and NDJSON line tools (U-05 import steps 2-3).
 *
 * Rows never pass through JSON.parse: the id map substitutes every
 * uuid-shaped token it knows anywhere in a line (numeric literals can never
 * match), and the small tokenizer below rewrites or reads one top-level
 * field of a row object as text. Map keys are lower-case and lookups
 * lower-case the token (S7). ZERO_COMPANY_UUID and the nil uuid are never
 * keys (MT12).
 */

import crypto from 'node:crypto';
import { NEVER_REMAPPED_UUIDS } from './plan.js';
import type { ArchiveClient } from './session.js';

export const UUID_TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_EXACT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class IdMap {
  private readonly forward = new Map<string, string>();
  private readonly reverse = new Map<string, string>();

  get size(): number {
    return this.forward.size;
  }

  has(oldId: string): boolean {
    return this.forward.has(oldId.toLowerCase());
  }

  get(oldId: string): string | undefined {
    return this.forward.get(oldId.toLowerCase());
  }

  getOld(newId: string): string | undefined {
    return this.reverse.get(newId.toLowerCase());
  }

  /** Maps `oldId` to `newId` (both lower-cased). The map stays a bijection. */
  set(oldId: string, newId: string): void {
    const o = oldId.toLowerCase();
    const n = newId.toLowerCase();
    if (!UUID_EXACT_RE.test(o) || !UUID_EXACT_RE.test(n)) throw new Error('id map keys must be uuids');
    if (NEVER_REMAPPED_UUIDS.includes(o) || NEVER_REMAPPED_UUIDS.includes(n)) throw new Error('reserved uuid in id map');
    const existing = this.forward.get(o);
    if (existing !== undefined) {
      if (existing === n) return;
      throw new Error('id already mapped');
    }
    if (this.reverse.has(n)) throw new Error('new id already in use');
    this.forward.set(o, n);
    this.reverse.set(n, o);
  }

  /** Maps `oldId` to a fresh random uuid (regenerated on the astronomically unlikely collision). */
  fresh(oldId: string): string {
    const existing = this.get(oldId);
    if (existing) return existing;
    for (;;) {
      const n = crypto.randomUUID();
      if (!this.forward.has(n) && !this.reverse.has(n) && !NEVER_REMAPPED_UUIDS.includes(n)) {
        this.set(oldId, n);
        return n;
      }
    }
  }

  /** Replaces every mapped uuid token in `text` (old -> new). */
  substitute(text: string): string {
    return text.replace(UUID_TOKEN_RE, (m) => this.forward.get(m.toLowerCase()) ?? m);
  }

  /** Replaces every mapped uuid token in `text` (new -> old). */
  inverse(text: string): string {
    return text.replace(UUID_TOKEN_RE, (m) => this.reverse.get(m.toLowerCase()) ?? m);
  }

  entries(): IterableIterator<[string, string]> {
    return this.forward.entries();
  }

  /** Loads the map into TEMP TABLE cl_idmap(old uuid PRIMARY KEY, new uuid UNIQUE) ON COMMIT DROP. */
  async loadInto(client: ArchiveClient): Promise<void> {
    await client.query('CREATE TEMP TABLE cl_idmap (old uuid PRIMARY KEY, new uuid UNIQUE NOT NULL) ON COMMIT DROP');
    const olds: string[] = [];
    const news: string[] = [];
    const flush = async () => {
      if (olds.length === 0) return;
      await client.query('INSERT INTO cl_idmap (old, new) SELECT * FROM unnest($1::uuid[], $2::uuid[])', [olds, news]);
      olds.length = 0;
      news.length = 0;
    };
    for (const [o, n] of this.forward) {
      olds.push(o);
      news.push(n);
      if (olds.length >= 5000) await flush();
    }
    await flush();
  }
}

// ── Row-line tokenizer ───────────────────────────────────────────────

export interface FieldSpan {
  /** Start offset of the value token. */
  start: number;
  /** End offset (exclusive) of the value token. */
  end: number;
  /** The raw JSON value text. */
  raw: string;
}

/**
 * Finds the value span of top-level field `name` in a JSON object line
 * produced by row_to_json. Nested objects and arrays are skipped; string
 * escapes are honored. Returns null when the field is absent.
 */
export function topLevelField(line: string, name: string): FieldSpan | null {
  const n = line.length;
  let i = 0;
  // Skip to the opening brace.
  while (i < n && line[i] !== '{') i++;
  if (i >= n) return null;
  i++;
  let depth = 1;
  while (i < n) {
    const ch = line[i]!;
    if (ch === '"') {
      // Key string at depth 1.
      const keyEnd = scanString(line, i);
      const key = line.slice(i + 1, keyEnd - 1);
      i = keyEnd;
      while (i < n && line[i] !== ':') i++;
      i++;
      while (i < n && line[i] === ' ') i++;
      const valueEnd = scanValue(line, i);
      if (depth === 1 && unescapeKey(key) === name) return { start: i, end: valueEnd, raw: line.slice(i, valueEnd) };
      i = valueEnd;
      while (i < n && (line[i] === ',' || line[i] === ' ')) i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) return null;
    }
    i++;
  }
  return null;
}

function unescapeKey(key: string): string {
  return key.includes('\\') ? (JSON.parse(`"${key}"`) as string) : key;
}

/** Returns the offset just past the string starting at `start` (which must be a quote). */
function scanString(line: string, start: number): number {
  let i = start + 1;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  return i;
}

/** Returns the offset just past the JSON value starting at `start`. */
function scanValue(line: string, start: number): number {
  const ch = line[start];
  if (ch === '"') return scanString(line, start);
  if (ch === '{' || ch === '[') {
    let depth = 0;
    let i = start;
    while (i < line.length) {
      const c = line[i];
      if (c === '"') {
        i = scanString(line, i);
        continue;
      }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  let i = start;
  while (i < line.length && line[i] !== ',' && line[i] !== '}') i++;
  return i;
}

/** The field's scalar value as text (a JSON string decoded, a number or boolean as its literal); null when absent or null. */
export function fieldString(line: string, name: string): string | null {
  const span = topLevelField(line, name);
  if (!span || span.raw === 'null') return null;
  if (span.raw.startsWith('"')) return JSON.parse(span.raw) as string;
  if (span.raw.startsWith('{') || span.raw.startsWith('[')) throw new Error(`field ${name} is not a scalar`);
  return span.raw;
}

/** Rewrites the field's raw JSON value. The field must exist. */
export function rewriteField(line: string, name: string, rawJson: string): string {
  const span = topLevelField(line, name);
  if (!span) throw new Error(`field ${name} not found`);
  return `${line.slice(0, span.start)}${rawJson}${line.slice(span.end)}`;
}

/** The pk uuid of a row line. */
export function pkOfLine(line: string, pkColumn: string): string {
  const v = fieldString(line, pkColumn);
  if (!v || !UUID_EXACT_RE.test(v)) throw new Error(`row has no uuid ${pkColumn}`);
  return v.toLowerCase();
}

// ── Digests ──────────────────────────────────────────────────────────

/** SHA-256 over the canonical lines joined by "\n", in order (uuid-pk tables). */
export class OrderedDigest {
  private readonly hash = crypto.createHash('sha256');
  private first = true;

  add(line: string): void {
    if (!this.first) this.hash.update('\n');
    this.first = false;
    this.hash.update(line, 'utf8');
  }

  hex(): string {
    return this.hash.digest('hex');
  }
}

const MOD = 1n << 256n;

/** Σ SHA-256(line) mod 2^256 as 64 hex: order-independent (omit-pk and no-pk tables). */
export class MultisetDigest {
  private sum = 0n;

  add(line: string): void {
    const h = crypto.createHash('sha256').update(line, 'utf8').digest('hex');
    this.sum = (this.sum + BigInt(`0x${h}`)) % MOD;
  }

  hex(): string {
    return this.sum.toString(16).padStart(64, '0');
  }
}

export function digestFor(pk: 'uuid' | 'omit-pk' | 'no-pk'): OrderedDigest | MultisetDigest {
  return pk === 'uuid' ? new OrderedDigest() : new MultisetDigest();
}
