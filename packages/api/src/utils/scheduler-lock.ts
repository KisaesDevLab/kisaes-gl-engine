import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

// Postgres advisory-lock wrapper so only one API instance runs a given
// scheduled cycle at a time. Without this, horizontal scale (two api pods,
// two prod restarts overlapping) duplicates the work: both instances hit
// `processAllDue` at the same tick, both race against the claim pattern,
// and while correctness holds the DB does 2× the useless SELECT/UPDATE
// traffic.
//
// `pg_try_advisory_lock(bigint)` returns false immediately if another
// session holds the same key, so missing a cycle when another node has
// the lock is the intended failure mode. The lock is released by
// `pg_advisory_unlock` in `finally` so a crash before release still
// clears at session end (connection reuse via the pool auto-releases).
//
// Keys are derived via Postgres' `hashtext(name)` cast to bigint so each
// scheduler has a stable, collision-unlikely 64-bit identifier without
// us having to manually allocate from a central registry.

export async function withSchedulerLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const acquired = await db.execute(
    sql`SELECT pg_try_advisory_lock(hashtext(${name})::bigint) AS ok`,
  );
  const ok = (acquired.rows as { ok: boolean }[])[0]?.ok === true;
  if (!ok) return null;

  try {
    return await fn();
  } finally {
    try {
      await db.execute(
        sql`SELECT pg_advisory_unlock(hashtext(${name})::bigint)`,
      );
    } catch {
      // best-effort — session close releases the lock anyway
    }
  }
}
