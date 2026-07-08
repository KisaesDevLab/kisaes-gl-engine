// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Minimal ambient types for archiver (zip writer) and unzipper (zip reader).
// Only the surface the tenant-export package util uses is declared, so we get
// full typing without pulling in @types packages or leaking `any`.

declare module 'archiver' {
  import type { Readable } from 'stream';
  interface Archiver extends Readable {
    append(source: Buffer | Readable | string, opts: { name: string }): this;
    finalize(): Promise<void>;
    pipe<T extends NodeJS.WritableStream>(dest: T): T;
    on(event: 'error' | 'warning', cb: (err: Error & { code?: string }) => void): this;
    on(event: string, cb: (...args: unknown[]) => void): this;
  }
  interface ArchiverOptions { store?: boolean; zlib?: { level?: number } }
  function archiver(format: 'zip' | 'tar', options?: ArchiverOptions): Archiver;
  export = archiver;
}

declare module 'unzipper' {
  interface OpenEntry {
    path: string;
    type: 'File' | 'Directory';
    uncompressedSize: number;
    buffer(): Promise<Buffer>;
  }
  interface CentralDirectory {
    files: OpenEntry[];
  }
  export const Open: {
    file(path: string): Promise<CentralDirectory>;
    buffer(buffer: Buffer): Promise<CentralDirectory>;
  };
}
