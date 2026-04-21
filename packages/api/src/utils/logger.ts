// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Lightweight structured JSON logger. Writes one line per log event
// to stdout so Docker's json-file driver can capture it verbatim,
// and any log-aggregation pipeline (Loki, Splunk, Datadog) can parse
// fields without regex scraping.
//
// We intentionally do NOT pull in pino/winston here — one more
// runtime dep to maintain is strictly worse than 40 lines of code
// that cover 100% of what the schedulers and security-audit module
// need. If we grow to need transports/serializers/pretty-print in
// more than one place, revisit and pick pino then.

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function effectiveLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] || 'info').toLowerCase();
  return (LEVEL_WEIGHTS as Record<string, number>)[raw] !== undefined ? (raw as LogLevel) : 'info';
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_WEIGHTS[level] >= LEVEL_WEIGHTS[effectiveLevel()];
}

export interface LogFields {
  /** Short identifier for the emitting subsystem (e.g., 'backup-scheduler'). */
  component: string;
  /** Event name — stable snake_case string operators can alert on. */
  event: string;
  /** Freeform structured payload. */
  [key: string]: unknown;
}

function emit(level: LogLevel, fields: LogFields): void {
  if (!shouldEmit(level)) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    ...fields,
  };
  // Route warn+ to stderr so Docker keeps severity separation in the
  // json-file logs (useful when grepping through an incident). Trace/
  // debug/info go to stdout.
  const line = JSON.stringify(record);
  if (LEVEL_WEIGHTS[level] >= LEVEL_WEIGHTS.warn) {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  trace: (fields: LogFields): void => emit('trace', fields),
  debug: (fields: LogFields): void => emit('debug', fields),
  info: (fields: LogFields): void => emit('info', fields),
  warn: (fields: LogFields): void => emit('warn', fields),
  error: (fields: LogFields): void => emit('error', fields),
  fatal: (fields: LogFields): void => emit('fatal', fields),
};
