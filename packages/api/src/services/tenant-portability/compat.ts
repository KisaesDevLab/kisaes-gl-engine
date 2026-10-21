// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Schema compatibility for older archives (U-05, B8). Fails closed: an
 * archive table or column the live schema does not have, a retyped column,
 * or a live NOT NULL column without default that the archive lacks is an
 * error unless one of the versioned allowlists below covers it.
 *
 * Migration policy note: a non-additive migration (marker
 * `-- migration-policy: non-additive-exception` or an `allow-non-additive_`
 * file name) newer than the E5 baseline must add its DROPPED_TABLES /
 * DROPPED_COLUMNS / TYPE_CHANGES / BACKFILL / RELAXED_COLUMNS entry; compat.test.ts checks
 * this against the migrations journal.
 */

import { ArchiveError } from './errors.js';
import { TYPE_CHANGES, isAllowedWidening, type PortabilityPlan, type TablePlan } from './plan.js';
import type { ManifestTable } from './format.js';

/** Schema version (applied migration count) at which E5 landed (0218 included); older non-additive migrations need no entry. */
export const COMPAT_BASELINE_SCHEMA_VERSION = 219;

/** Archive tables that no longer exist live: skipped with a warning when the archive predates `droppedIn`. */
export const DROPPED_TABLES: Record<string, { droppedIn: number }> = {};

/** `table.column` dropped by migration `droppedIn` (schema version after it). */
export const DROPPED_COLUMNS: Record<string, { droppedIn: number }> = {};

/**
 * `table.column` -> SQL expression (over the inserted row alias `r`) that
 * mirrors the migration's own backfill for a NOT NULL column without a
 * default that older archives lack.
 */
export const BACKFILL: Record<string, { addedIn: number; expression: string }> = {};

/**
 * `table.column` whose NOT NULL was dropped by migration `relaxedIn` (schema
 * version after it). An older archive always carries a value, so nothing is
 * done on import; the entry records the non-additive step for the policy.
 * 0225 (templates, U-62): a schedule of a template made without posting has
 * no source transaction. A schedule imported from an archive older than
 * 0225 has no template_id; the runner adopts it on first use
 * (templates.service adoptOrphanSchedules), as 0225 did.
 */
export const RELAXED_COLUMNS: Record<string, { relaxedIn: number }> = {
  'recurring_schedules.template_transaction_id': { relaxedIn: 226 },
};

export interface TableCompat {
  table: string;
  /** Archive columns inserted (archive ∩ live, minus omit-pk/generated). */
  insertColumns: string[];
  /** Archive columns skipped (dropped live). */
  skippedColumns: string[];
  /** Live columns backfilled by expression. */
  backfill: Array<{ column: string; expression: string }>;
  /** Live columns absent from the archive that take their default. */
  defaulted: string[];
  /** Archive column -> live type when the pair is an allowed widening. */
  widened: Array<{ column: string; from: string; to: string }>;
}

export interface CompatResult {
  tables: TableCompat[];
  /** Archive tables skipped entirely (dropped live). */
  skippedTables: string[];
  warnings: string[];
}

function sameType(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/**
 * Compares the archive's tables with the live plan. `archiveSchemaVersion`
 * is the archive manifest's schema.version; `liveSchemaVersion` the applied
 * migration count.
 */
export function checkSchemaCompatibility(
  manifestTables: ManifestTable[],
  plan: PortabilityPlan,
  archiveSchemaVersion: number,
  liveSchemaVersion: number,
): CompatResult {
  if (archiveSchemaVersion > liveSchemaVersion) {
    throw new ArchiveError('ARCHIVE_TOO_NEW', 'This archive was made by a newer version. Update the application and try again.', {
      archiveSchemaVersion, liveSchemaVersion,
    });
  }
  const result: CompatResult = { tables: [], skippedTables: [], warnings: [] };
  for (const mt of manifestTables) {
    const live: TablePlan | undefined = plan.byName.get(mt.name);
    if (!live) {
      const dropped = DROPPED_TABLES[mt.name];
      if (dropped && dropped.droppedIn > archiveSchemaVersion && dropped.droppedIn <= liveSchemaVersion) {
        result.skippedTables.push(mt.name);
        result.warnings.push(`TABLE_DROPPED:${mt.name}`);
        continue;
      }
      throw new ArchiveError('ARCHIVE_TABLE_UNKNOWN', `The archive holds a table this version does not have: ${mt.name}.`, { table: mt.name });
    }
    // The pk shape and bucket drive id remapping, file rewriting and scope
    // on import; an archive may not redefine them (H2).
    if (mt.pk !== live.pk) {
      throw new ArchiveError('ARCHIVE_CORRUPT', `The archive is damaged (${mt.name}: pk shape ${mt.pk} differs from ${live.pk}).`, { table: mt.name });
    }
    if (mt.bucket !== live.bucket) {
      throw new ArchiveError('ARCHIVE_CORRUPT', `The archive is damaged (${mt.name}: bucket ${mt.bucket} differs from ${live.bucket}).`, { table: mt.name });
    }
    const liveCols = new Map(live.columns.map((c) => [c.name, c]));
    const tc: TableCompat = { table: mt.name, insertColumns: [], skippedColumns: [], backfill: [], defaulted: [], widened: [] };
    const archiveCols = new Set<string>();
    for (const [name, type] of mt.columns) {
      archiveCols.add(name);
      const lc = liveCols.get(name);
      const k = `${mt.name}.${name}`;
      if (!lc) {
        const dropped = DROPPED_COLUMNS[k];
        if (dropped && dropped.droppedIn > archiveSchemaVersion && dropped.droppedIn <= liveSchemaVersion) {
          tc.skippedColumns.push(name);
          result.warnings.push(`COLUMN_DROPPED:${k}`);
          continue;
        }
        throw new ArchiveError('ARCHIVE_COLUMN_UNKNOWN', `The archive holds a column this version does not have: ${k}.`, { table: mt.name, column: name });
      }
      if (!sameType(type, lc.type)) {
        const change = TYPE_CHANGES[k];
        if (change && sameType(change.from, type) && sameType(change.to, lc.type) && isAllowedWidening(change.from, change.to)) {
          tc.widened.push({ column: name, from: type, to: lc.type });
        } else {
          throw new ArchiveError('ARCHIVE_COLUMN_TYPE_CHANGED', `A column changed type since the archive was made: ${k}.`, {
            table: mt.name, column: name, archiveType: type, liveType: lc.type,
          });
        }
      }
      if (live.pk === 'omit-pk' && name === live.pkColumn) continue;
      tc.insertColumns.push(name);
    }
    for (const lc of live.columns) {
      if (archiveCols.has(lc.name)) continue;
      const k = `${mt.name}.${lc.name}`;
      if (live.pk === 'omit-pk' && lc.name === live.pkColumn) continue;
      if (!lc.nullable && !lc.hasDefault) {
        const bf = BACKFILL[k];
        if (!bf) {
          throw new ArchiveError('ARCHIVE_COLUMN_MISSING', `This version needs a value the archive does not carry: ${k}.`, { table: mt.name, column: lc.name });
        }
        tc.backfill.push({ column: lc.name, expression: bf.expression });
      } else {
        tc.defaulted.push(lc.name);
      }
    }
    result.tables.push(tc);
  }
  return result;
}
