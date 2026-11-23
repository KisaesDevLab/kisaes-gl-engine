// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Desktop change feed reader (U-294, changes-v1; migration 0289_change_feed).
 *
 * The cursor is opaque to clients: `<feedEpoch>.<horizon>`. The horizon is
 * pg_snapshot_xmin(pg_current_snapshot()) when the page was read: every
 * transaction below it had committed or aborted, so the next read returns
 * the rows with cursor <= xid < new horizon and never skips a late commit.
 * There is no counter row, so writers never wait on the feed (B4).
 *
 * One exception (U-296, ClientLedger Q-P34u): the open transaction of a test
 * restore (a backend whose application_name is TEST_RESTORE_APPLICATION_NAME)
 * does not hold the horizon back. That transaction always rolls back and
 * only writes a tenant that never becomes visible, so skipping it loses
 * nothing, and workstations keep seeing saves during a multi-minute test.
 * A real import still holds it (it runs under a maintenance hold anyway).
 *
 * `reset: true` (the client reloads everything): no or a malformed cursor, a
 * different epoch (a file-level restore, an archive import, an engine
 * upgrade), a cursor older than the 7-day retention, or more changes than one
 * page holds. Rows of another company are skipped, and the cursor moves past
 * them. A record the viewer can no longer see (a hidden account, or an entry
 * on one) comes as op `left`.
 */

import { sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/index.js';
import { isDesktop } from '../desktop/profile.js';

export interface FeedChange {
  kind: string;
  id: string;
  op: 'upsert' | 'delete' | 'left';
}

export interface FeedPage {
  cursor: string;
  feedEpoch: string;
  reset: boolean;
  changes: FeedChange[];
}

const PAGE = 1000;
const RETENTION_DAYS = 7;
let lastPrune = 0;

async function feedEpoch(): Promise<{ epoch: string; prunedBelow: string }> {
  const r = await db.execute(sql`SELECT s.epoch::text AS epoch, s.pruned_below::text AS pruned,
      (SELECT count(*) FROM drizzle.__drizzle_migrations)::text AS migrations
    FROM change_feed_state s WHERE s.id = 1`);
  const row = r.rows[0] as { epoch: string; pruned: string; migrations: string } | undefined;
  if (!row) throw new Error('change_feed_state is missing');
  // The applied migration count is part of the epoch: an engine upgrade resets clients.
  return { epoch: `${row.epoch.replace(/-/g, '')}m${row.migrations}`, prunedBelow: row.pruned };
}

/** New epoch: every client reloads (after a file-level restore or an archive import). */
export async function rotateFeedEpoch(): Promise<void> {
  await db.execute(sql`UPDATE change_feed_state SET epoch = gen_random_uuid() WHERE id = 1`);
}

/**
 * New epoch inside the caller's transaction, desktop only, when the set of
 * hidden accounts may have changed (an account marked or unmarked sensitive,
 * or re-parented in a company that has sensitive accounts): every client
 * reloads, so entries that left a viewer's sight go and entries that came
 * back return (P33 review M5). With `tenantId`, only when that tenant has a
 * sensitive account. Rotated in the same transaction, so no client reloads
 * before the change is visible.
 */
export async function rotateFeedEpochInTx(tx: DbOrTx, tenantId?: string): Promise<void> {
  if (!isDesktop()) return;
  const onlyIf = tenantId
    ? sql` AND EXISTS (SELECT 1 FROM accounts WHERE tenant_id = ${tenantId} AND is_sensitive = true)`
    : sql``;
  await tx.execute(sql`UPDATE change_feed_state SET epoch = gen_random_uuid() WHERE id = 1${onlyIf}`);
}

async function pruneMaybe(): Promise<void> {
  if (Date.now() - lastPrune < 60_000) return;
  lastPrune = Date.now();
  await db.execute(sql`WITH gone AS (
      DELETE FROM change_feed WHERE at < now() - make_interval(days => ${RETENTION_DAYS}) RETURNING xid
    )
    UPDATE change_feed_state SET pruned_below = greatest(pruned_below, (SELECT max(xid) FROM gone))
    WHERE id = 1 AND EXISTS (SELECT 1 FROM gone)`);
}

const XID = /^\d{1,20}$/;

/** Must equal import.service.ts TEST_RESTORE_APPLICATION_NAME (a test checks it). */
export const FEED_SKIPPED_APPLICATION_NAME = 'mybooks-test-restore';

/**
 * The feed horizon: the oldest transaction still running when the snapshot
 * was taken (pg_snapshot_xmin), except a test restore's (see above).
 */
export async function feedHorizon(exec: DbOrTx = db): Promise<string> {
  const h = await exec.execute(sql`
    SELECT COALESCE(
      (SELECT min(x) FROM pg_snapshot_xip(q.s) AS x
        WHERE xid(x) <> ALL (ARRAY(
          SELECT a.backend_xid FROM pg_stat_activity a
          WHERE a.application_name = ${FEED_SKIPPED_APPLICATION_NAME} AND a.backend_xid IS NOT NULL))),
      pg_snapshot_xmax(q.s))::text AS h
    FROM (SELECT pg_current_snapshot() AS s) q`);
  return (h.rows[0] as { h: string }).h;
}

function cmpXid(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * One page of changes for `tenantId` after `cursor`. `hidden`: account ids
 * the viewer may not see (their records come as `left`).
 */
export async function readChanges(tenantId: string, cursor: string | undefined, hidden: readonly string[]): Promise<FeedPage> {
  await pruneMaybe();
  const { epoch, prunedBelow } = await feedEpoch();
  const horizon = await feedHorizon();
  const page = (reset: boolean, changes: FeedChange[] = []): FeedPage => ({ cursor: `${epoch}.${horizon}`, feedEpoch: epoch, reset, changes });

  const m = typeof cursor === 'string' ? /^([0-9a-z]+)\.(\d{1,20})$/.exec(cursor) : null;
  if (!m || m[1] !== epoch || !XID.test(m[2]!)) return page(true);
  const from = m[2]!;
  if (cmpXid(from, prunedBelow) <= 0 && prunedBelow !== '0') return page(true);
  if (cmpXid(from, horizon) >= 0) return page(false);

  const r = await db.execute(sql`SELECT kind, entity_id::text AS id, op FROM change_feed
    WHERE xid >= ${from}::xid8 AND xid < ${horizon}::xid8 AND tenant_id = ${tenantId}
    ORDER BY xid, id LIMIT ${PAGE + 1}`);
  const rows = r.rows as Array<{ kind: string; id: string; op: 'upsert' | 'delete' }>;
  if (rows.length > PAGE) return page(true);

  // Latest op per record (a record changed twice is reported once).
  const latest = new Map<string, FeedChange>();
  for (const row of rows) latest.set(`${row.kind}:${row.id}`, { kind: row.kind, id: row.id, op: row.op });
  const changes = [...latest.values()];

  if (hidden.length > 0) {
    const hiddenSet = new Set(hidden);
    const txnIds = changes.filter((c) => c.kind === 'transactions' && c.op === 'upsert').map((c) => c.id);
    const onHidden = new Set<string>();
    if (txnIds.length > 0) {
      const q = await db.execute(sql`SELECT DISTINCT transaction_id::text AS id FROM journal_lines
        WHERE tenant_id = ${tenantId} AND transaction_id = ANY(${`{${txnIds.join(',')}}`}::uuid[])
          AND account_id = ANY(${`{${hidden.join(',')}}`}::uuid[])`);
      for (const x of q.rows as Array<{ id: string }>) onHidden.add(x.id);
    }
    for (const c of changes) {
      if ((c.kind === 'accounts' && hiddenSet.has(c.id)) || (c.kind === 'transactions' && onHidden.has(c.id))) c.op = 'left';
      // A hard delete (import undo, a range delete) leaves no row or lines to
      // tell whether the viewer could see it, so for a viewer with hidden
      // accounts every entry or account delete is `left`: the client drops it
      // either way, and the feed never reports a delete the viewer may not
      // see as one (P33 review M5). Soft deletes are updates, filtered above.
      if ((c.kind === 'transactions' || c.kind === 'accounts') && c.op === 'delete') c.op = 'left';
    }
  }
  return page(false, changes);
}
