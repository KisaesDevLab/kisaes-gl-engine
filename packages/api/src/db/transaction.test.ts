// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// transactionWithRetry (U-197): the whole database transaction runs again
// once after a deadlock (40P01) or serialization failure (40001); anything
// else, and a second failure, is rethrown unchanged. A retried attempt
// leaves nothing behind: its rows and audit rows rolled back, its
// Idempotency-Key claim is made again on the new transaction. End to end, a
// void whose first attempt deadlocks is stored once, with one audit row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Tx } from './index.js';
import { auditLog, idempotencyKeys, journalLines, transactions } from './schema/index.js';
import { transactionWithRetry, isTransactionRetryable } from './transaction.js';
import { runWithIdemContext, type IdemCtx } from '../services/idempotency-context.js';
import { runWithExpectedStamp, checkExpectedStamp } from '../services/stale-context.js';
import { claimIdempotency, recordIdempotentEntity } from '../services/idempotency.service.js';
import * as ledger from '../services/ledger.service.js';
import { makeCompany, cleanTenant, type Co } from '../services/templates/templates.test-helpers.js';

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
const tenantIds: string[] = [];
let c: Co;
const sfx = Math.random().toString(36).slice(2, 8);
const seq = `u197_once_${sfx}`;
const fnName = `u197_deadlock_once_${sfx}`;
const trg = `u197_deadlock_once_${sfx}`;

beforeAll(async () => {
  c = await makeCompany('u197-retry', tenantIds);
}, 60_000);

afterAll(async () => {
  for (const s of ['', '_stamp']) {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trg}${s} ON audit_log`));
    await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fnName}${s}()`));
    await db.execute(sql.raw(`DROP SEQUENCE IF EXISTS ${seq}${s}`));
  }
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, c.tenantId));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

/** An `open` that fails the first `failures` attempts with `err` before running fn (no database). */
function failingOpen(failures: number, err: unknown) {
  let n = 0;
  return async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
    n++;
    const out = await fn({ attempt: n } as unknown as Tx);
    if (n <= failures) throw err;
    return out;
  };
}

describe('transactionWithRetry (U-197)', () => {
  it('runs the transaction again once after 40P01 or 40001', async () => {
    for (const code of ['40P01', '40001']) {
      let calls = 0;
      const r = await transactionWithRetry(async () => ++calls, { open: failingOpen(1, pgError(code)) });
      expect(r).toBe(2);
      expect(calls).toBe(2);
    }
  });

  it('reads the code Drizzle wraps as cause', async () => {
    const wrapped = Object.assign(new Error('Failed query'), { cause: pgError('40P01') });
    expect(isTransactionRetryable(wrapped)).toBe(true);
    let calls = 0;
    await transactionWithRetry(async () => ++calls, { open: failingOpen(1, wrapped) });
    expect(calls).toBe(2);
  });

  it('rethrows the second failure unchanged (the 409 RETRY mapping still answers it)', async () => {
    const err = pgError('40P01');
    let calls = 0;
    await expect(transactionWithRetry(async () => ++calls, { open: failingOpen(5, err) })).rejects.toBe(err);
    expect(calls).toBe(2);
  });

  it('never retries other errors, a lock timeout (55P03) included', async () => {
    for (const err of [pgError('55P03'), pgError('23505'), new Error('plain')]) {
      let calls = 0;
      await expect(transactionWithRetry(async () => ++calls, { open: failingOpen(1, err) })).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });

  it('attempts: 1 is a plain transaction', async () => {
    let calls = 0;
    await expect(transactionWithRetry(async () => ++calls, { attempts: 1, open: failingOpen(1, pgError('40P01')) }))
      .rejects.toMatchObject({ code: '40P01' });
    expect(calls).toBe(1);
  });

  it('rolls the first attempt back and claims the Idempotency-Key again on the retry', async () => {
    const ctx: IdemCtx = {
      tenantId: c.tenantId, companyId: c.companyId, userId: c.userId, key: `u197-${sfx}`,
      requestHash: 'a'.repeat(64), route: 'POST /test/u197', successStatus: 200, closed: false,
    };
    const txs: Tx[] = [];
    const result = await runWithIdemContext(ctx, () => transactionWithRetry(async (tx) => {
      txs.push(tx);
      await claimIdempotency(tx);
      await recordIdempotentEntity(tx, 'transaction', c.bank);
      await tx.insert(auditLog).values({ tenantId: c.tenantId, action: 'update', entityType: 'u197_probe', entityId: c.bank });
      if (txs.length === 1) {
        // A real 40P01 from Postgres, so the transaction is aborted as a deadlock leaves it.
        await tx.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END $$`);
      }
      return 'done';
    }));
    expect(result).toBe('done');
    expect(txs).toHaveLength(2);
    expect(ctx.failed).toBeUndefined();
    expect(ctx.claimTx).toBe(txs[1]);
    expect(ctx.entity).toEqual({ type: 'transaction', id: c.bank });
    const keys = await db.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, c.tenantId), eq(idempotencyKeys.idempotencyKey, ctx.key)));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.id).toBe(ctx.rowId);
    const probes = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'u197_probe')));
    expect(probes).toHaveLength(1);
  });

  it('a void whose first attempt deadlocks is stored once, with one audit row', async () => {
    const posted = await ledger.postTransaction(c.tenantId, {
      txnType: 'journal_entry', txnDate: '2026-03-02', memo: 'U-197 retry',
      lines: [
        { accountId: c.bank, debit: '12.3400', credit: '0' },
        { accountId: c.income, debit: '0', credit: '12.3400' },
      ],
    } as Parameters<typeof ledger.postTransaction>[1], c.userId, c.companyId);

    // The first 'void' audit row of this tenant fails with a deadlock; a
    // sequence is not rolled back, so the retry's insert goes through.
    await db.execute(sql.raw(`CREATE SEQUENCE ${seq}`));
    await db.execute(sql.raw(`
      CREATE FUNCTION ${fnName}() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF nextval('${seq}') = 1 THEN
          RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01';
        END IF;
        RETURN NEW;
      END $f$`));
    await db.execute(sql.raw(`
      CREATE TRIGGER ${trg} BEFORE INSERT ON audit_log FOR EACH ROW
      WHEN (NEW.tenant_id = '${c.tenantId}' AND NEW.action = 'void')
      EXECUTE FUNCTION ${fnName}()`));

    await ledger.voidTransaction(c.tenantId, posted.id, 'U-197', c.userId, { companyId: c.companyId });

    const [seqRow] = (await db.execute(sql.raw(`SELECT last_value::int AS n FROM ${seq}`))).rows as Array<{ n: number }>;
    expect(seqRow!.n).toBe(2); // two attempts reached the audit insert
    const [txn] = await db.select().from(transactions).where(eq(transactions.id, posted.id));
    expect(txn!.status).toBe('void');
    const voids = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.action, 'void'), eq(auditLog.entityId, posted.id)));
    expect(voids).toHaveLength(1);
    // One set of reversing lines, not two: the first attempt's rolled back.
    const lines = await db.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, c.tenantId), eq(journalLines.transactionId, posted.id)));
    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.isVoidReversal)).toHaveLength(2);
  });

  // U-291 race fix (ClientLedger P33 soak): an attempt compares the request's
  // expected stamp once; the retry must compare it again, or a save that
  // committed between the attempts is overwritten (a lost update).
  it('a retried attempt compares the expected stamp again', async () => {
    const read = new Date('2026-03-02T10:00:00.000Z');
    const moved = new Date('2026-03-02T10:00:00.007Z');
    let calls = 0;
    await expect(runWithExpectedStamp('transactions', c.bank, read.toISOString(), () => transactionWithRetry(async () => {
      calls++;
      // Attempt 1 locks the row as read; before attempt 2 another save moved it.
      checkExpectedStamp('transactions', c.bank, { updatedAt: calls === 1 ? read : moved });
      return 'saved';
    }, { open: failingOpen(1, pgError('40P01')) }))).rejects.toMatchObject({ code: 'STALE' });
    expect(calls).toBe(2);
    // Unchanged in between: the retry compares again and saves.
    calls = 0;
    const ok = await runWithExpectedStamp('transactions', c.bank, read.toISOString(), () => transactionWithRetry(async () => {
      calls++;
      checkExpectedStamp('transactions', c.bank, { updatedAt: read });
      // A later lock of the same record in the same attempt does not compare again.
      checkExpectedStamp('transactions', c.bank, { updatedAt: moved });
      return 'saved';
    }, { open: failingOpen(1, pgError('40P01')) }));
    expect(ok).toBe('saved');
    expect(calls).toBe(2);
  });

  it('an edit whose first attempt deadlocks while another save commits is 409 STALE; the other save stays', async () => {
    const lines = (amount: string) => [
      { accountId: c.bank, debit: amount, credit: '0' },
      { accountId: c.income, debit: '0', credit: amount },
    ];
    const posted = await ledger.postTransaction(c.tenantId, {
      txnType: 'journal_entry', txnDate: '2026-03-02', memo: 'U-291 race', lines: lines('5.0000'),
    } as Parameters<typeof ledger.postTransaction>[1], c.userId, c.companyId);
    const [row] = await db.select({ updatedAt: transactions.updatedAt }).from(transactions).where(eq(transactions.id, posted.id));
    const read = row!.updatedAt!.toISOString();

    // The edit's first 'update' audit row fails with a deadlock (after its
    // stamp check passed and its lines and balances were written).
    await db.execute(sql.raw(`CREATE SEQUENCE ${seq}_stamp`));
    await db.execute(sql.raw(`
      CREATE FUNCTION ${fnName}_stamp() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF nextval('${seq}_stamp') = 1 THEN
          RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01';
        END IF;
        RETURN NEW;
      END $f$`));
    await db.execute(sql.raw(`
      CREATE TRIGGER ${trg}_stamp BEFORE INSERT ON audit_log FOR EACH ROW
      WHEN (NEW.entity_id = '${posted.id}' AND NEW.action = 'update')
      EXECUTE FUNCTION ${fnName}_stamp()`));

    let attempt = 0;
    const open = async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
      attempt++;
      if (attempt === 2) {
        // Another workstation's save of the same entry commits in between.
        await db.update(transactions).set({ memo: 'saved by B', updatedAt: sql`${transactions.updatedAt} + interval '1 second'` })
          .where(eq(transactions.id, posted.id));
      }
      return db.transaction(fn);
    };
    await expect(runWithExpectedStamp('transactions', posted.id, read, () => transactionWithRetry(
      (tx) => ledger.updateTransaction(c.tenantId, posted.id, {
        txnType: 'journal_entry', txnDate: '2026-03-02', memo: 'saved by A', lines: lines('6.0000'),
      } as Parameters<typeof ledger.updateTransaction>[2], c.userId, c.companyId, tx),
      { open },
    ))).rejects.toMatchObject({ code: 'STALE' });
    expect(attempt).toBe(2);
    const [after] = await db.select().from(transactions).where(eq(transactions.id, posted.id));
    expect(after!.memo).toBe('saved by B');
    const kept = await db.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, c.tenantId), eq(journalLines.transactionId, posted.id)));
    expect(kept.map((l) => l.debit).sort()).toEqual(['0.0000', '5.0000']);
  });
});
