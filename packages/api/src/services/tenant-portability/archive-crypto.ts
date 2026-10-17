// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Tenant archive encryption (U-05, formatVersion 1).
 *
 * Key: PBKDF2-SHA512, 600,000 iterations (the engine's v2 setting,
 * derivePackageKey) over the passphrase and a per-archive salt.
 *
 * Entries: chunked AES-256-GCM. An entry is an 8-byte random nonce prefix
 * followed by chunks; chunk i uses nonce = prefix || u32(i) and
 * AAD = archiveId || 0 || entryPath || 0 || u32(i) || u8(isFinal). Each
 * chunk is framed as [u32 ciphertextLength][u8 isFinal][ciphertext][tag16].
 * Every non-final chunk carries exactly chunkBytes of plaintext; exactly
 * one final chunk ends the entry (an empty entry is one final chunk with 0
 * bytes); bytes after the final chunk are a corruption. The AAD binds every
 * chunk to its archive, entry and position, so reordered, truncated,
 * swapped or cross-archive chunks fail authentication.
 *
 * keyCheck: GCM over a fixed constant with its own prefix and
 * AAD = archiveId || "envelope/keyCheck" || 0 || 1, so a wrong passphrase
 * is detected before anything else is read, and a keyCheck copied from
 * another archive never validates.
 */

import crypto from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { derivePackageKey, validatePassphraseStrength } from '../portable-encryption.service.js';
import { registerSecret, unregisterSecret } from '../../utils/secret-scrubber.js';
import { ArchiveError } from './errors.js';
import { ARCHIVE_FORMAT, ARCHIVE_FORMAT_VERSION } from './format.js';

export const KDF = 'pbkdf2-sha512';
export const KDF_ITERATIONS = 600_000;
export const CIPHER = 'aes-256-gcm-chunked';
export const CHUNK_BYTES = 65_536;
export const SALT_BYTES = 32;
export const NONCE_PREFIX_BYTES = 8;
export const TAG_BYTES = 16;
const FRAME_HEADER_BYTES = 5;
const KEY_CHECK_PLAINTEXT = Buffer.from('mybooks-tenant-archive key check v1', 'utf8');
const KEY_CHECK_PATH = 'envelope/keyCheck';

/** Closed parameter sets accepted for formatVersion 1 (S-i). */
const ALLOWED_ITERATIONS = new Set([KDF_ITERATIONS]);
const ALLOWED_CHUNK_BYTES = new Set([CHUNK_BYTES]);
const MIN_SALT = 16;
const MAX_SALT = 64;

export interface ArchiveEnvelope {
  format: typeof ARCHIVE_FORMAT;
  formatVersion: number;
  archiveId: string;
  createdAt: string;
  encryption: { kdf: string; iterations: number; salt: string; cipher: string; chunkBytes: number };
  keyCheck: { noncePrefix: string; ciphertext: string; tag: string };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function aad(archiveId: string, entryPath: string, chunkIndex: number, isFinal: boolean): Buffer {
  const idx = Buffer.alloc(4);
  idx.writeUInt32BE(chunkIndex, 0);
  return Buffer.concat([Buffer.from(archiveId, 'utf8'), Buffer.from([0]), Buffer.from(entryPath, 'utf8'), Buffer.from([0]), idx, Buffer.from([isFinal ? 1 : 0])]);
}

function nonce(prefix: Buffer, chunkIndex: number): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0, 0, NONCE_PREFIX_BYTES);
  n.writeUInt32BE(chunkIndex, 8);
  return n;
}

/** Tracks nonce prefixes used within one archive so no two entries share one. */
export class NoncePrefixRegistry {
  private seen = new Set<string>();

  next(): Buffer {
    for (;;) {
      const p = crypto.randomBytes(NONCE_PREFIX_BYTES);
      const k = p.toString('hex');
      if (!this.seen.has(k)) {
        this.seen.add(k);
        return p;
      }
    }
  }

  get size(): number {
    return this.seen.size;
  }
}

export function deriveArchiveKey(passphrase: string, salt: Buffer): Buffer {
  return derivePackageKey(passphrase, salt);
}

/** Creates the plaintext envelope and the archive key for a new archive. */
export function createEnvelope(archiveId: string, passphrase: string, registry: NoncePrefixRegistry, createdAt = new Date()): { envelope: ArchiveEnvelope; key: Buffer } {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = deriveArchiveKey(passphrase, salt);
  const prefix = registry.next();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce(prefix, 0));
  cipher.setAAD(aad(archiveId, KEY_CHECK_PATH, 0, true));
  const ciphertext = Buffer.concat([cipher.update(KEY_CHECK_PLAINTEXT), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    key,
    envelope: {
      format: ARCHIVE_FORMAT,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      archiveId,
      createdAt: createdAt.toISOString(),
      encryption: { kdf: KDF, iterations: KDF_ITERATIONS, salt: salt.toString('base64'), cipher: CIPHER, chunkBytes: CHUNK_BYTES },
      keyCheck: { noncePrefix: prefix.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: tag.toString('base64') },
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function b64(v: unknown, what: string, min: number, max: number): Buffer {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) throw new ArchiveError('ARCHIVE_UNSUPPORTED', `${what} is not base64`);
  const b = Buffer.from(v, 'base64');
  if (b.length < min || b.length > max) throw new ArchiveError('ARCHIVE_UNSUPPORTED', `${what} has an unsupported length`);
  return b;
}

/**
 * Validates an envelope against the closed parameter sets. Anything else
 * is refused BEFORE any key derivation, so a crafted envelope cannot force
 * a weak or huge KDF.
 */
export function validateEnvelope(raw: unknown): ArchiveEnvelope {
  if (!isObject(raw)) throw new ArchiveError('ARCHIVE_UNSUPPORTED', 'envelope is not an object');
  if (raw['format'] !== ARCHIVE_FORMAT) throw new ArchiveError('ARCHIVE_UNSUPPORTED', 'not a tenant archive');
  if (raw['formatVersion'] !== ARCHIVE_FORMAT_VERSION) throw new ArchiveError('ARCHIVE_UNSUPPORTED', `unsupported formatVersion`);
  if (typeof raw['archiveId'] !== 'string' || !UUID_RE.test(raw['archiveId'])) throw new ArchiveError('ARCHIVE_UNSUPPORTED', 'archiveId is not a uuid');
  if (typeof raw['createdAt'] !== 'string' || Number.isNaN(Date.parse(raw['createdAt']))) throw new ArchiveError('ARCHIVE_UNSUPPORTED', 'createdAt is not a date');
  const enc = raw['encryption'];
  if (!isObject(enc)) throw new ArchiveError('ARCHIVE_UNSUPPORTED', 'encryption parameters missing');
  if (enc['kdf'] !== KDF || !ALLOWED_ITERATIONS.has(enc['iterations'] as number)) throw new ArchiveError('ARCHIVE_UNSUPPORTED', 'unsupported key derivation parameters');
  if (enc['cipher'] !== CIPHER || !ALLOWED_CHUNK_BYTES.has(enc['chunkBytes'] as number)) throw new ArchiveError('ARCHIVE_UNSUPPORTED', 'unsupported cipher parameters');
  b64(enc['salt'], 'salt', MIN_SALT, MAX_SALT);
  const kc = raw['keyCheck'];
  if (!isObject(kc)) throw new ArchiveError('ARCHIVE_UNSUPPORTED', 'keyCheck missing');
  b64(kc['noncePrefix'], 'keyCheck.noncePrefix', NONCE_PREFIX_BYTES, NONCE_PREFIX_BYTES);
  b64(kc['ciphertext'], 'keyCheck.ciphertext', KEY_CHECK_PLAINTEXT.length, KEY_CHECK_PLAINTEXT.length);
  b64(kc['tag'], 'keyCheck.tag', TAG_BYTES, TAG_BYTES);
  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    archiveId: raw['archiveId'],
    createdAt: raw['createdAt'],
    encryption: {
      kdf: KDF, iterations: enc['iterations'] as number, salt: enc['salt'] as string, cipher: CIPHER, chunkBytes: enc['chunkBytes'] as number,
    },
    keyCheck: { noncePrefix: kc['noncePrefix'] as string, ciphertext: kc['ciphertext'] as string, tag: kc['tag'] as string },
  };
}

/** Derives the key and proves the passphrase against the envelope's keyCheck (422 ARCHIVE_PASSPHRASE_INVALID). */
export function openEnvelope(envelope: ArchiveEnvelope, passphrase: string): Buffer {
  const key = deriveArchiveKey(passphrase, Buffer.from(envelope.encryption.salt, 'base64'));
  const prefix = Buffer.from(envelope.keyCheck.noncePrefix, 'base64');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(prefix, 0));
    d.setAAD(aad(envelope.archiveId, KEY_CHECK_PATH, 0, true));
    d.setAuthTag(Buffer.from(envelope.keyCheck.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(envelope.keyCheck.ciphertext, 'base64')), d.final()]);
    if (!plain.equals(KEY_CHECK_PLAINTEXT)) throw new Error('key check mismatch');
  } catch {
    throw new ArchiveError('ARCHIVE_PASSPHRASE_INVALID', 'The passphrase does not open this archive.');
  }
  return key;
}

// ── Streaming entry encryption ───────────────────────────────────────

/** Transform: plaintext in, framed chunk ciphertext out. */
export class EntryEncryptor extends Transform {
  private buffer: Buffer[] = [];
  private buffered = 0;
  private index = 0;
  private readonly prefix: Buffer;
  private started = false;

  constructor(private readonly key: Buffer, private readonly archiveId: string, private readonly entryPath: string, registry: NoncePrefixRegistry, private readonly chunkBytes = CHUNK_BYTES) {
    super();
    this.prefix = registry.next();
  }

  private emitChunk(plain: Buffer, isFinal: boolean): void {
    if (!this.started) {
      this.push(this.prefix);
      this.started = true;
    }
    const c = crypto.createCipheriv('aes-256-gcm', this.key, nonce(this.prefix, this.index));
    c.setAAD(aad(this.archiveId, this.entryPath, this.index, isFinal));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt32BE(ct.length, 0);
    header.writeUInt8(isFinal ? 1 : 0, 4);
    this.push(Buffer.concat([header, ct, c.getAuthTag()]));
    this.index++;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.buffer.push(chunk);
    this.buffered += chunk.length;
    while (this.buffered > this.chunkBytes) {
      const all = Buffer.concat(this.buffer);
      this.emitChunk(all.subarray(0, this.chunkBytes), false);
      const rest = all.subarray(this.chunkBytes);
      this.buffer = [rest];
      this.buffered = rest.length;
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    const all = Buffer.concat(this.buffer);
    // Exactly one final chunk, holding at most chunkBytes (an entry whose
    // length is a multiple of chunkBytes ends with a full final chunk).
    this.emitChunk(all, true);
    this.buffer = [];
    this.buffered = 0;
    cb();
  }
}

/** Synchronous chunk parser shared by the stream and buffer decryptors. */
class ChunkParser {
  private pending: Buffer = Buffer.alloc(0);
  private prefix: Buffer | null = null;
  private index = 0;
  finished = false;

  constructor(private readonly key: Buffer, private readonly archiveId: string, private readonly entryPath: string, private readonly chunkBytes = CHUNK_BYTES) {}

  corrupt(why: string): ArchiveError {
    return new ArchiveError('ARCHIVE_CORRUPT', `The archive is damaged (${this.entryPath}: ${why}).`);
  }

  /** Feeds ciphertext bytes and returns the plaintext chunks completed so far. */
  push(chunk: Buffer): Buffer[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const out: Buffer[] = [];
    if (!this.prefix) {
      if (this.pending.length < NONCE_PREFIX_BYTES) return out;
      this.prefix = Buffer.from(this.pending.subarray(0, NONCE_PREFIX_BYTES));
      this.pending = this.pending.subarray(NONCE_PREFIX_BYTES);
    }
    for (;;) {
      if (this.pending.length === 0) return out;
      if (this.finished) throw this.corrupt('bytes after the final chunk');
      if (this.pending.length < FRAME_HEADER_BYTES) return out;
      const len = this.pending.readUInt32BE(0);
      const finalFlag = this.pending.readUInt8(4);
      if (finalFlag !== 0 && finalFlag !== 1) throw this.corrupt('bad chunk flag');
      const isFinal = finalFlag === 1;
      if (len > this.chunkBytes || (!isFinal && len !== this.chunkBytes)) throw this.corrupt('bad chunk length');
      const total = FRAME_HEADER_BYTES + len + TAG_BYTES;
      if (this.pending.length < total) return out;
      const ct = this.pending.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + len);
      const tag = this.pending.subarray(FRAME_HEADER_BYTES + len, total);
      let plain: Buffer;
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', this.key, nonce(this.prefix, this.index));
        d.setAAD(aad(this.archiveId, this.entryPath, this.index, isFinal));
        d.setAuthTag(tag);
        plain = Buffer.concat([d.update(ct), d.final()]);
      } catch {
        throw this.corrupt('authentication failed');
      }
      out.push(plain);
      this.index++;
      this.pending = this.pending.subarray(total);
      if (isFinal) this.finished = true;
    }
  }

  /** End of input: exactly one final chunk must have been seen. */
  finish(): void {
    if (!this.finished) throw this.corrupt(this.prefix ? 'no final chunk' : 'entry too short');
  }
}

/** Transform: framed chunk ciphertext in, plaintext out. Fails with ARCHIVE_CORRUPT on any deviation. */
export class EntryDecryptor extends Transform {
  private readonly parser: ChunkParser;

  constructor(key: Buffer, archiveId: string, entryPath: string, chunkBytes = CHUNK_BYTES) {
    super();
    this.parser = new ChunkParser(key, archiveId, entryPath, chunkBytes);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      for (const plain of this.parser.push(chunk)) this.push(plain);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      this.parser.finish();
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}

export function encryptEntryBuffer(key: Buffer, archiveId: string, entryPath: string, plain: Buffer, registry: NoncePrefixRegistry): Buffer {
  const enc = new EntryEncryptor(key, archiveId, entryPath, registry);
  const out: Buffer[] = [];
  enc.on('data', (d: Buffer) => out.push(d));
  enc.end(plain);
  // Transform streams flush synchronously when driven by end() with no backpressure.
  return Buffer.concat(out);
}

export function decryptEntryBuffer(key: Buffer, archiveId: string, entryPath: string, blob: Buffer): Buffer {
  const parser = new ChunkParser(key, archiveId, entryPath);
  const out = parser.push(blob);
  parser.finish();
  return Buffer.concat(out);
}

// ── Passphrase handling ──────────────────────────────────────────────

/** 400 PASSPHRASE_TOO_WEAK unless the engine's strength check passes (floor 12 characters). */
export function assertPassphraseStrong(passphrase: string): void {
  const r = validatePassphraseStrength(passphrase);
  if (!r.valid) throw new ArchiveError('PASSPHRASE_TOO_WEAK', r.message);
}

/** Registers the passphrase with the log scrubber for the duration of `fn`. It is never stored. */
export async function withScrubbedPassphrase<T>(passphrase: string, fn: () => Promise<T>): Promise<T> {
  registerSecret(passphrase);
  try {
    return await fn();
  } finally {
    unregisterSecret(passphrase);
  }
}
