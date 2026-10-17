// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Structured startup failure for desktop mode. Instead of the appliance's
 * fallback web apps (env-missing / diagnostic, which listen on every
 * interface without auth), the desktop engine writes ONE JSON line to
 * stderr and exits:
 *
 *   {"event":"fatal","code":"CL_BIND_NOT_LOOPBACK","message":"..."}
 *
 * Exit 78 (EX_CONFIG) = configuration or preflight problem, restarting
 * will not help; exit 1 = runtime failure. The message is scrubbed.
 * Env-free: usable before env.ts loads.
 */

import fs from 'node:fs';
import { scrubSecrets } from '../utils/secret-scrubber.js';
import { EXIT_CONFIG } from './profile.js';

type LineSink = (line: string) => void;
let extraSink: LineSink | null = null;

/** The log tee registers itself here so fatal lines also reach the log file. */
export function setFatalLineSink(sink: LineSink | null): void {
  extraSink = sink;
}

export function formatFatalLine(code: string, message: string): string {
  return `${JSON.stringify({ event: 'fatal', code, message: scrubSecrets(message) })}\n`;
}

export function desktopFatal(code: string, message: string, exitCode: number = EXIT_CONFIG): never {
  const line = formatFatalLine(code, message);
  // writeSync: process.exit right after an async pipe write can drop the
  // line on Windows, and the supervisor needs it.
  try {
    fs.writeSync(2, line);
  } catch {
    /* stderr closed — nothing else to do */
  }
  try {
    extraSink?.(line);
  } catch {
    /* never fail the exit path on logging */
  }
  process.exit(exitCode);
}

/** One-line JSON warning on stderr (desktop mode). */
export function desktopWarning(code: string, message: string): void {
  console.warn(JSON.stringify({ event: 'warning', code, message: scrubSecrets(message) }));
}
