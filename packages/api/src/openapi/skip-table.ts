// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Registrations the OpenAPI export deliberately leaves out (U-04).
 *
 * OpenAPI paths cannot express Express wildcards (`*` spanning several
 * segments), optional or regexp parameters, RegExp mount paths, or
 * `route.all()`. Every such registration must be listed here with the
 * reason it is acceptable to leave it undocumented. The export fails on
 * any unlisted one, and on any stale entry, so a new wildcard route is a
 * conscious decision rather than a silent gap in the spec.
 *
 * Keys are the recorder's `SkippedRegistration.key` values.
 */

import type { SkippedRegistration } from './recorder.js';

export const SKIP_TABLE: Readonly<Record<string, string>> = {
  'GET /api/v1/backup/remote/download/*':
    'Remote backup download; the wildcard is a remote file key that may contain slashes.',
  'DELETE /api/v1/backup/remote/*':
    'Remote backup delete; the wildcard is a remote file key that may contain slashes.',
  'ALL /api/v1/tax-estimator/snapshots/:snapshotId':
    'Guard that rejects PUT/PATCH/DELETE on an immutable snapshot; the GET is documented separately.',
};

/** Throws when the recorded skips and the table disagree. */
export function checkSkipped(skipped: SkippedRegistration[]): void {
  const keys = new Set(skipped.map((s) => s.key));
  const unlisted = [...keys].filter((k) => !(k in SKIP_TABLE)).sort();
  const stale = Object.keys(SKIP_TABLE).filter((k) => !keys.has(k)).sort();
  if (unlisted.length === 0 && stale.length === 0) return;
  const lines: string[] = [];
  if (unlisted.length > 0) {
    lines.push(
      'Routes the OpenAPI spec cannot express (rename them to plain :param paths, ' +
        'or add them with a reason to packages/api/src/openapi/skip-table.ts):',
      ...unlisted.map((k) => `  ${k}`),
    );
  }
  if (stale.length > 0) {
    lines.push('Stale entries in packages/api/src/openapi/skip-table.ts:', ...stale.map((k) => `  ${k}`));
  }
  throw new Error(lines.join('\n'));
}
