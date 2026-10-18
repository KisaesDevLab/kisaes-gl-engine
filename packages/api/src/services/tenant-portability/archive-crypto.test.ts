// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Archive encryption (U-05 §4.5 group H and MT26): round trips, chunk
// boundaries, tamper detection, key check, closed parameter sets.

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CHUNK_BYTES, EntryDecryptor, EntryEncryptor, NoncePrefixRegistry, KDF_ITERATIONS, SALT_BYTES,
  createEnvelope, createEnvelopeAsync, validateEnvelope, openEnvelope, openEnvelopeAsync, encryptEntryBuffer, decryptEntryBuffer,
  deriveArchiveKey, deriveArchiveKeyAsync, assertPassphraseStrong, withScrubbedPassphrase, registerPassphrase, releasePassphrase,
} from './archive-crypto.js';
import { scrubSecrets } from '../../utils/secret-scrubber.js';
import { ArchiveError } from './errors.js';

const PASS = 'correct horse battery staple 42';
const ARCHIVE_ID = '11111111-2222-4333-8444-555555555555';

function key(): Buffer {
  return crypto.createHash('sha256').update('test key').digest();
}

async function encryptStreamed(k: Buffer, path: string, plain: Buffer, pieces: number[]): Promise<Buffer> {
  const enc = new EntryEncryptor(k, ARCHIVE_ID, path, new NoncePrefixRegistry());
  const parts: Buffer[] = [];
  let off = 0;
  for (const n of pieces) {
    parts.push(plain.subarray(off, off + n));
    off += n;
  }
  if (off < plain.length) parts.push(plain.subarray(off));
  const out: Buffer[] = [];
  for await (const chunk of Readable.from(parts).pipe(enc) as AsyncIterable<Buffer>) out.push(chunk);
  return Buffer.concat(out);
}

async function decryptStreamed(k: Buffer, path: string, blob: Buffer, pieceSize: number): Promise<Buffer> {
  const dec = new EntryDecryptor(k, ARCHIVE_ID, path);
  const parts: Buffer[] = [];
  for (let off = 0; off < blob.length; off += pieceSize) parts.push(blob.subarray(off, off + pieceSize));
  if (parts.length === 0) parts.push(Buffer.alloc(0));
  const out: Buffer[] = [];
  for await (const chunk of Readable.from(parts).pipe(dec) as AsyncIterable<Buffer>) out.push(chunk);
  return Buffer.concat(out);
}

function expectCorrupt(fn: () => unknown): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ArchiveError);
  expect((err as ArchiveError).code).toBe('ARCHIVE_CORRUPT');
}

/** Parses the frame list of an encrypted entry: [prefix, ...frames]. */
function frames(blob: Buffer): { prefix: Buffer; chunks: Buffer[] } {
  const prefix = blob.subarray(0, 8);
  const chunks: Buffer[] = [];
  let off = 8;
  while (off < blob.length) {
    const len = blob.readUInt32BE(off);
    const total = 5 + len + 16;
    chunks.push(Buffer.from(blob.subarray(off, off + total)));
    off += total;
  }
  return { prefix, chunks };
}

describe('chunked entries', () => {
  it('round-trips sizes 0, 64K-1, 64K, 64K+1 and 5 MB byte-exactly across random stream boundaries', async () => {
    const k = key();
    for (const size of [0, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 5 * 1024 * 1024]) {
      const plain = crypto.randomBytes(size);
      const pieces: number[] = [];
      let left = size;
      while (left > 0) {
        const n = Math.min(left, 1 + Math.floor(Math.random() * 100_000));
        pieces.push(n);
        left -= n;
      }
      const blob = await encryptStreamed(k, 'data/x.ndjson', plain, pieces);
      const back = await decryptStreamed(k, 'data/x.ndjson', blob, 1 + Math.floor(Math.random() * 70_000));
      expect(back.equals(plain), `size ${size}`).toBe(true);
      const f = frames(blob);
      // Every non-final chunk is full; exactly one final chunk, last.
      expect(f.chunks.filter((c) => c.readUInt8(4) === 1)).toHaveLength(1);
      expect(f.chunks[f.chunks.length - 1]!.readUInt8(4)).toBe(1);
      for (const c of f.chunks.slice(0, -1)) expect(c.readUInt32BE(0)).toBe(CHUNK_BYTES);
      expect(f.chunks[f.chunks.length - 1]).toBeDefined();
      expect(f.chunks.length).toBe(Math.max(1, Math.ceil(size / CHUNK_BYTES)));
    }
  }, 60_000);

  it('an empty entry is a single final chunk with 0 bytes', () => {
    const blob = encryptEntryBuffer(key(), ARCHIVE_ID, 'data/empty.ndjson', Buffer.alloc(0), new NoncePrefixRegistry());
    const f = frames(blob);
    expect(f.chunks).toHaveLength(1);
    expect(f.chunks[0]!.readUInt32BE(0)).toBe(0);
    expect(f.chunks[0]!.readUInt8(4)).toBe(1);
    expect(decryptEntryBuffer(key(), ARCHIVE_ID, 'data/empty.ndjson', blob).length).toBe(0);
  });

  it('rejects a flipped ciphertext byte, a swapped entry path and another archive id', () => {
    const k = key();
    const plain = crypto.randomBytes(3 * CHUNK_BYTES + 17);
    const blob = encryptEntryBuffer(k, ARCHIVE_ID, 'data/a.ndjson', plain, new NoncePrefixRegistry());
    const flipped = Buffer.from(blob);
    flipped[8 + 5 + 100] = flipped[8 + 5 + 100]! ^ 0x01;
    expectCorrupt(() => decryptEntryBuffer(k, ARCHIVE_ID, 'data/a.ndjson', flipped));
    expectCorrupt(() => decryptEntryBuffer(k, ARCHIVE_ID, 'data/b.ndjson', blob));
    expectCorrupt(() => decryptEntryBuffer(k, '22222222-2222-4333-8444-555555555555', 'data/a.ndjson', blob));
    expectCorrupt(() => decryptEntryBuffer(crypto.randomBytes(32), ARCHIVE_ID, 'data/a.ndjson', blob));
  });

  it('rejects reordered chunks, a truncated final chunk, a dropped final chunk, bytes after the final chunk and a second final chunk (MT26)', () => {
    const k = key();
    const plain = crypto.randomBytes(3 * CHUNK_BYTES + 17);
    const blob = encryptEntryBuffer(k, ARCHIVE_ID, 'data/a.ndjson', plain, new NoncePrefixRegistry());
    const { prefix, chunks } = frames(blob);
    expect(chunks).toHaveLength(4);
    const join = (cs: Buffer[]) => Buffer.concat([prefix, ...cs]);
    // Reordered.
    expectCorrupt(() => decryptEntryBuffer(k, ARCHIVE_ID, 'data/a.ndjson', join([chunks[1]!, chunks[0]!, chunks[2]!, chunks[3]!])));
    // Truncated final chunk.
    expectCorrupt(() => decryptEntryBuffer(k, ARCHIVE_ID, 'data/a.ndjson', join(chunks).subarray(0, blob.length - 3)));
    // Dropped final chunk.
    expectCorrupt(() => decryptEntryBuffer(k, ARCHIVE_ID, 'data/a.ndjson', join(chunks.slice(0, 3))));
    // Extra bytes after the final chunk (a whole valid chunk appended again).
    expectCorrupt(() => decryptEntryBuffer(k, ARCHIVE_ID, 'data/a.ndjson', join([...chunks, chunks[3]!])));
    // Second chunk flagged final.
    const second = Buffer.from(chunks[1]!);
    second.writeUInt8(1, 4);
    expectCorrupt(() => decryptEntryBuffer(k, ARCHIVE_ID, 'data/a.ndjson', join([chunks[0]!, second, chunks[2]!, chunks[3]!])));
    // A non-final chunk that is not full.
    const shortBlob = encryptEntryBuffer(k, ARCHIVE_ID, 'data/s.ndjson', crypto.randomBytes(10), new NoncePrefixRegistry());
    const sf = frames(shortBlob);
    const notFinal = Buffer.from(sf.chunks[0]!);
    notFinal.writeUInt8(0, 4);
    expectCorrupt(() => decryptEntryBuffer(k, ARCHIVE_ID, 'data/s.ndjson', Buffer.concat([sf.prefix, notFinal])));
  });

  it('an entry copied between archives sharing a passphrase does not open', () => {
    const r1 = new NoncePrefixRegistry();
    const a = createEnvelope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', PASS, r1);
    const b = createEnvelope('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', PASS, new NoncePrefixRegistry());
    const blob = encryptEntryBuffer(a.key, a.envelope.archiveId, 'data/a.ndjson', Buffer.from('x'), r1);
    expectCorrupt(() => decryptEntryBuffer(b.key, b.envelope.archiveId, 'data/a.ndjson', blob));
  });

  it('nonce prefixes are unique within an archive', () => {
    const r = new NoncePrefixRegistry();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(r.next().toString('hex'));
    expect(seen.size).toBe(1000);
    expect(r.size).toBe(1000);
  });
});

describe('envelope and key check', () => {
  it('opens with the right passphrase and refuses a wrong one', () => {
    const { envelope, key: k } = createEnvelope(ARCHIVE_ID, PASS, new NoncePrefixRegistry());
    expect(validateEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
    expect(openEnvelope(envelope, PASS).equals(k)).toBe(true);
    let err: unknown;
    try {
      openEnvelope(envelope, 'wrong passphrase here');
    } catch (e) {
      err = e;
    }
    expect((err as ArchiveError).code).toBe('ARCHIVE_PASSPHRASE_INVALID');
    expect(JSON.stringify(envelope)).not.toContain(PASS);
  }, 30_000);

  it('a keyCheck copied from another archive with the same passphrase never validates', () => {
    const a = createEnvelope('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', PASS, new NoncePrefixRegistry());
    const b = createEnvelope('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', PASS, new NoncePrefixRegistry());
    const forged = { ...b.envelope, keyCheck: a.envelope.keyCheck };
    let err: unknown;
    try {
      openEnvelope(validateEnvelope(forged), PASS);
    } catch (e) {
      err = e;
    }
    expect((err as ArchiveError).code).toBe('ARCHIVE_PASSPHRASE_INVALID');
  }, 30_000);

  it('refuses unsupported parameters before any key derivation', () => {
    const { envelope } = createEnvelope(ARCHIVE_ID, PASS, new NoncePrefixRegistry());
    const cases: Array<Record<string, unknown>> = [
      { ...envelope, encryption: { ...envelope.encryption, iterations: 1000 } },
      { ...envelope, encryption: { ...envelope.encryption, iterations: 10_000_000 } },
      { ...envelope, encryption: { ...envelope.encryption, chunkBytes: 1 } },
      { ...envelope, encryption: { ...envelope.encryption, kdf: 'scrypt' } },
      { ...envelope, encryption: { ...envelope.encryption, cipher: 'aes-128-gcm' } },
      { ...envelope, encryption: { ...envelope.encryption, salt: Buffer.alloc(8).toString('base64') } },
      { ...envelope, formatVersion: 2 },
      { ...envelope, format: 'other' },
      { ...envelope, keyCheck: { ...envelope.keyCheck, tag: 'AAAA' } },
    ];
    for (const c of cases) {
      const t0 = process.hrtime.bigint();
      let err: unknown;
      try {
        validateEnvelope(c);
      } catch (e) {
        err = e;
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      expect((err as ArchiveError)?.code, JSON.stringify(c['encryption'] ?? c)).toBe('ARCHIVE_UNSUPPORTED');
      expect(ms).toBeLessThan(50);
    }
    expect(KDF_ITERATIONS).toBe(600_000);
  }, 30_000);
});

describe('passphrase handling', () => {
  it('refuses weak passphrases with PASSPHRASE_TOO_WEAK', () => {
    let err: unknown;
    try {
      assertPassphraseStrong('short');
    } catch (e) {
      err = e;
    }
    expect((err as ArchiveError).code).toBe('PASSPHRASE_TOO_WEAK');
    expect((err as ArchiveError).statusCode).toBe(400);
    expect(() => assertPassphraseStrong(PASS)).not.toThrow();
  });

  it('is scrubbed from logs for the duration of the request and never afterwards referenced', async () => {
    const canary = 'canary passphrase 9f8e7d6c';
    await withScrubbedPassphrase(canary, async () => {
      expect(scrubSecrets(`passphrase=${canary} ok`)).not.toContain(canary);
    });
    expect(scrubSecrets(`passphrase=${canary} ok`)).toContain(canary);
  });

  it('stays scrubbed until the last holder releases it (reference counted, M3)', async () => {
    const canary = 'shared passphrase 1a2b3c4d';
    let releaseInner: () => void = () => undefined;
    const inner = new Promise<void>((r) => { releaseInner = r; });
    const outer = withScrubbedPassphrase(canary, () => inner);
    await withScrubbedPassphrase(canary, async () => undefined); // a second, shorter holder comes and goes
    expect(scrubSecrets(canary)).not.toContain(canary); // the first holder still runs
    registerPassphrase(canary);
    releaseInner();
    await outer;
    expect(scrubSecrets(canary)).not.toContain(canary); // one explicit holder left
    releasePassphrase(canary);
    expect(scrubSecrets(canary)).toContain(canary);
    releasePassphrase(canary); // over-release is harmless
    expect(scrubSecrets(canary)).toContain(canary);
  });
});

describe('async key derivation (M3)', () => {
  it('derives the same key as the synchronous path and opens envelopes either way', async () => {
    const salt = crypto.randomBytes(SALT_BYTES);
    expect((await deriveArchiveKeyAsync(PASS, salt)).equals(deriveArchiveKey(PASS, salt))).toBe(true);
    const id = crypto.randomUUID();
    const a = await createEnvelopeAsync(id, PASS, new NoncePrefixRegistry());
    expect(openEnvelope(a.envelope, PASS).equals(a.key)).toBe(true);
    expect((await openEnvelopeAsync(a.envelope, PASS)).equals(a.key)).toBe(true);
    const s = createEnvelope(id, PASS, new NoncePrefixRegistry());
    expect((await openEnvelopeAsync(s.envelope, PASS)).equals(s.key)).toBe(true);
    await expect(openEnvelopeAsync(a.envelope, 'not the passphrase 1')).rejects.toMatchObject({ code: 'ARCHIVE_PASSPHRASE_INVALID' });
  }, 60_000);
});
