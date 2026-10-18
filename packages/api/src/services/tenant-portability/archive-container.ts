// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Zip container primitives for tenant archives: a writer that encrypts and
 * hashes every part as it streams into the zip (archiver, stored entries,
 * zip64 automatic), and a reader over unzipper's central directory.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import * as unzipper from 'unzipper';
import { EntryEncryptor, NoncePrefixRegistry } from './archive-crypto.js';
import { ENVELOPE_ENTRY, zipEntryName } from './format.js';
import { ArchiveError } from './errors.js';

export interface WrittenPart {
  /** Plaintext SHA-256, hex. */
  sha256: string;
  /** Plaintext bytes. */
  bytes: number;
}

/**
 * Writes an archive zip. `envelope.json` goes first (plaintext); every other
 * part is encrypted under the archive key and hashed in plaintext.
 */
export class ArchiveZipWriter {
  private readonly archive = archiver('zip', { store: true, zlib: { level: 0 } });
  private readonly out: fs.WriteStream;
  private readonly done: Promise<void>;
  private readonly registry = new NoncePrefixRegistry();
  private readonly names = new Set<string>();
  private failure: Error | null = null;

  constructor(filePath: string, private readonly key: Buffer, private readonly archiveId: string) {
    this.out = fs.createWriteStream(filePath, { flags: 'wx' });
    this.done = new Promise<void>((resolve, reject) => {
      this.out.on('close', resolve);
      this.out.on('error', reject);
      this.archive.on('error', (err: Error) => {
        this.failure = err;
        reject(err);
      });
      this.archive.on('warning', (err: Error) => {
        this.failure = err;
        reject(err);
      });
    });
    this.archive.pipe(this.out);
  }

  get noncePrefixes(): number {
    return this.registry.size;
  }

  /** The plaintext envelope; must be the first entry. */
  async writeEnvelope(envelope: object): Promise<void> {
    if (this.names.size > 0) throw new Error('envelope.json must be the first entry');
    await this.append(ENVELOPE_ENTRY, Readable.from([Buffer.from(JSON.stringify(envelope), 'utf8')]));
  }

  /** Encrypts and appends a part; resolves once archiver has consumed it. */
  async writePart(partName: string, source: Readable | Buffer): Promise<WrittenPart> {
    const entry = zipEntryName(partName);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const hasher = new PassThrough();
    hasher.on('data', (d: Buffer) => {
      hash.update(d);
      bytes += d.length;
    });
    const enc = new EntryEncryptor(this.key, this.archiveId, partName, this.registry);
    const input = Buffer.isBuffer(source) ? Readable.from([source]) : source;
    const appended = this.append(entry, enc);
    await pipeline(input, hasher, enc);
    await appended;
    return { sha256: hash.digest('hex'), bytes };
  }

  private append(name: string, stream: Readable): Promise<void> {
    if (this.names.has(name)) throw new Error(`duplicate archive entry ${name}`);
    this.names.add(name);
    return new Promise<void>((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      const emitter = this.archive as unknown as NodeJS.EventEmitter;
      const onEntry = (data: { name: string }) => {
        if (data.name === name) {
          emitter.off('entry', onEntry);
          resolve();
        }
      };
      emitter.on('entry', onEntry);
      this.done.catch(reject);
      this.archive.append(stream, { name });
    });
  }

  async finalize(): Promise<void> {
    await this.archive.finalize();
    await this.done;
  }

  /** Abort: destroys the output stream; the caller removes the partial file. */
  abort(): void {
    (this.archive as unknown as { abort: () => void }).abort();
    this.out.destroy();
  }
}

export interface ZipEntry {
  name: string;
  /** Declared (attacker-controlled) size; the decryptor bounds the real one. */
  declaredSize: number;
  stream(): NodeJS.ReadableStream;
}

interface UnzipperFile {
  path: string;
  uncompressedSize?: number;
  type?: string;
  stream?: () => NodeJS.ReadableStream;
}

/** Opens the zip's central directory and lists its entries. */
export async function openArchiveZip(filePath: string): Promise<ZipEntry[]> {
  let dir: { files: UnzipperFile[] };
  try {
    dir = (await unzipper.Open.file(filePath)) as unknown as { files: UnzipperFile[] };
  } catch {
    throw new ArchiveError('ARCHIVE_CORRUPT', 'The file is not a readable archive.');
  }
  const entries: ZipEntry[] = [];
  for (const f of dir.files) {
    if (f.type === 'Directory') throw new ArchiveError('ARCHIVE_CORRUPT', 'The archive contains a directory entry.');
    if (typeof f.stream !== 'function') throw new ArchiveError('ARCHIVE_CORRUPT', 'The archive entry cannot be streamed.');
    const stream = f.stream;
    entries.push({ name: f.path, declaredSize: f.uncompressedSize ?? 0, stream: () => stream.call(f) });
  }
  return entries;
}

/** Reads a stream fully with a hard byte cap. */
export async function readBounded(stream: NodeJS.ReadableStream, maxBytes: number, what: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      throw new ArchiveError('ARCHIVE_TOO_LARGE', `${what} exceeds its size limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** SHA-256 (hex) of a file's bytes, streamed. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), async function* (source) {
    for await (const chunk of source) hash.update(chunk as Buffer);
  });
  return hash.digest('hex');
}
