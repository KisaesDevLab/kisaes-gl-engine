// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Desktop log tee (CL_MODE=desktop). Wraps process.stdout/stderr so that
 *   - every chunk is passed through scrubSecrets() before it is written
 *     anywhere (console AND file), and
 *   - when CL_LOG_FILE is set, the scrubbed text is also appended to that
 *     file, rotated by size: file -> file.1 -> ... -> file.<CL_LOG_KEEP>.
 *
 * Retention by age/total size is the desktop app's job (it deletes closed
 * rotated files). Writes are synchronous so lines are not lost when the
 * process exits right after logging; any file error is swallowed — logging
 * must never take the engine down.
 */

import fs from 'node:fs';
import path from 'node:path';
import { scrubSecrets } from '../utils/secret-scrubber.js';
import { setFatalLineSink } from './fatal.js';
import type { DesktopProfile } from './profile.js';

export interface LogSink {
  write(text: string): void;
  close(): void;
}

export function createRotatingFileSink(file: string, maxBytes: number, keep: number): LogSink {
  let fd: number | null = null;
  let size = 0;
  // After a failed rotation (e.g. the file is locked by another process on
  // Windows) keep appending and try again only after another maxBytes.
  let rotateAt = maxBytes;

  const open = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fd = fs.openSync(file, 'a', 0o600);
      size = fs.fstatSync(fd).size;
      rotateAt = maxBytes;
    } catch {
      fd = null;
    }
  };

  const rotate = () => {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = null;
    }
    try {
      fs.rmSync(`${file}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i--) {
        if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      }
      fs.renameSync(file, `${file}.1`);
    } catch {
      /* fall through: reopen and keep appending to the current file */
    }
    open();
    if (size >= maxBytes) rotateAt = size + maxBytes;
  };

  open();
  return {
    write(text: string) {
      const buf = Buffer.from(text, 'utf8');
      if (size > 0 && size + buf.length > rotateAt) rotate();
      if (fd === null) return;
      try {
        fs.writeSync(fd, buf);
        size += buf.length;
      } catch {
        /* never fail on logging */
      }
    },
    close() {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        fd = null;
      }
    },
  };
}

type WriteFn = (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean;

function chunkToText(chunk: unknown, encoding: unknown): string {
  if (typeof chunk === 'string') {
    if (typeof encoding === 'string' && encoding !== 'utf8' && encoding !== 'utf-8' && Buffer.isEncoding(encoding)) {
      return Buffer.from(chunk, encoding).toString('utf8');
    }
    return chunk;
  }
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

/**
 * Replace `stream.write` with a scrubbing tee. Returns a function that
 * restores the original write.
 */
export function teeStream(
  stream: { write: (...args: never[]) => boolean },
  sink: ((text: string) => void) | null,
): () => void {
  const target = stream as unknown as { write: WriteFn };
  const original = target.write;
  target.write = function teeWrite(chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
    const clean = scrubSecrets(chunkToText(chunk, encoding));
    if (sink) {
      try {
        sink(clean);
      } catch {
        /* never fail on logging */
      }
    }
    const callback = typeof encoding === 'function' ? encoding : cb;
    return original.call(stream, clean, 'utf8', callback);
  };
  return () => {
    target.write = original;
  };
}

let installed: { restore: () => void; sink: LogSink | null } | null = null;

/** Install the scrubbing tee on stdout/stderr (desktop mode, once). */
export function installLogTee(profile: Pick<DesktopProfile, 'logFile' | 'logMaxBytes' | 'logKeep'>): void {
  if (installed) return;
  const sink = profile.logFile ? createRotatingFileSink(profile.logFile, profile.logMaxBytes, profile.logKeep) : null;
  const write = sink ? (t: string) => sink.write(t) : null;
  const restoreOut = teeStream(process.stdout, write);
  const restoreErr = teeStream(process.stderr, write);
  if (write) setFatalLineSink(write);
  installed = {
    sink,
    restore: () => {
      restoreOut();
      restoreErr();
      setFatalLineSink(null);
      sink?.close();
    },
  };
}

/** Test hook. */
export function _uninstallLogTeeForTests(): void {
  installed?.restore();
  installed = null;
}
