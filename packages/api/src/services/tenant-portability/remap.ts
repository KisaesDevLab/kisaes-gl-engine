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

// ── jsonb key order (U-91) ───────────────────────────────────────────

/**
 * PostgreSQL stores jsonb object keys sorted by UTF-8 byte length, then
 * bytewise, and prints them in that order. An object keyed by ids (for
 * example companies.check_settings.nextCheckNumbers, keyed by bank
 * account id) is therefore re-sorted when the import substitutes new ids,
 * and mapping the ids back on the text leaves the keys in new-id order.
 * Same keys and values, other order: a content digest of the raw text
 * differs. These helpers put the members back in PostgreSQL's order.
 */
export function compareJsonbKeys(a: string, b: string): number {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length - bb.length || Buffer.compare(ab, bb);
}

const JSON_WS = new Set([' ', '\t', '\n', '\r']);

/**
 * Reorders the members of every object in a JSON text into jsonb key order,
 * recursively. Everything else is kept verbatim: array order, number
 * literals (never parsed, so numeric precision is untouched), string
 * escapes and the separators the text used. For a jsonb value printed by
 * PostgreSQL whose keys are already in jsonb order this is the identity.
 * Throws on malformed JSON.
 */
export function reorderJsonKeys(text: string): string {
  const s = text;
  const ws = (i: number): number => {
    while (i < s.length && JSON_WS.has(s[i]!)) i++;
    return i;
  };
  const value = (i: number): { end: number; out: string } => {
    const ch = s[i];
    if (ch === '"') {
      const end = scanString(s, i);
      if (s[end - 1] !== '"' || end - 1 === i) throw new Error('unterminated JSON string');
      return { end, out: s.slice(i, end) };
    }
    if (ch === '{' || ch === '[') {
      const isObject = ch === '{';
      const close = isObject ? '}' : ']';
      const lead = ws(i + 1);
      const parts: Array<{ key: string; out: string; sep: string }> = [];
      let j = lead;
      let tail = '';
      if (s[j] === close) {
        return { end: j + 1, out: s.slice(i, j + 1) };
      }
      for (;;) {
        let key = '';
        let head = '';
        if (isObject) {
          if (s[j] !== '"') throw new Error('expected JSON object key');
          const keyEnd = scanString(s, j);
          key = JSON.parse(s.slice(j, keyEnd)) as string;
          let k = ws(keyEnd);
          if (s[k] !== ':') throw new Error('expected ":" in JSON object');
          k = ws(k + 1);
          head = s.slice(j, k);
          j = k;
        }
        const v = value(j);
        const after = ws(v.end);
        if (s[after] === ',') {
          const next = ws(after + 1);
          parts.push({ key, out: head + v.out, sep: s.slice(v.end, next) });
          j = next;
          continue;
        }
        if (s[after] !== close) throw new Error('expected "," or a closing bracket in JSON');
        parts.push({ key, out: head + v.out, sep: '' });
        tail = s.slice(v.end, after);
        j = after + 1;
        break;
      }
      const open = s.slice(i, lead);
      if (!isObject) {
        return { end: j, out: open + parts.map((p) => p.out + p.sep).join('') + tail + close };
      }
      const sep = parts[0]!.sep || ', ';
      const sorted = [...parts].sort((a, b) => compareJsonbKeys(a.key, b.key));
      return { end: j, out: open + sorted.map((p) => p.out).join(sep) + tail + close };
    }
    let j = i;
    while (j < s.length && !JSON_WS.has(s[j]!) && s[j] !== ',' && s[j] !== '}' && s[j] !== ']') j++;
    if (j === i) throw new Error('expected a JSON value');
    return { end: j, out: s.slice(i, j) };
  };
  const start = ws(0);
  const v = value(start);
  if (ws(v.end) !== s.length) throw new Error('trailing text after JSON value');
  return s.slice(0, start) + v.out + s.slice(v.end);
}

/** True for a declared (format_type) type whose values PostgreSQL re-sorts: jsonb and jsonb arrays. */
export function isJsonbType(type: string): boolean {
  return /^jsonb(\[\])*$/.test(type.trim());
}

/**
 * Puts the object keys of the named top-level fields of a row line back in
 * jsonb key order (see compareJsonbKeys). Apply after IdMap.inverse so the
 * order is taken over the original ids. A field that is absent or does not
 * parse is left as it is, so the digest still differs and the check fails.
 */
export function reorderJsonbFields(line: string, columns: readonly string[]): string {
  let out = line;
  for (const c of columns) {
    const span = topLevelField(out, c);
    if (!span || span.raw === 'null') continue;
    let raw: string;
    try {
      raw = reorderJsonKeys(span.raw);
    } catch {
      continue;
    }
    if (raw !== span.raw) out = `${out.slice(0, span.start)}${raw}${out.slice(span.end)}`;
  }
  return out;
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
