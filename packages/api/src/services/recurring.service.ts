import { eq, and, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { recurringSchedules, transactions, journalLines } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';

function calculateNextOccurrence(current: string, frequency: string, interval: number): string {
  const d = new Date(current);
  switch (frequency) {
    case 'daily': d.setDate(d.getDate() + interval); break;
    case 'weekly': d.setDate(d.getDate() + 7 * interval); break;
    case 'monthly': d.setMonth(d.getMonth() + interval); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3 * interval); break;
    case 'annually': d.setFullYear(d.getFullYear() + interval); break;
    default: d.setMonth(d.getMonth() + interval);
  }
  return d.toISOString().split('T')[0]!;
}

export async function create(tenantId: string, templateTransactionId: string, schedule: {
  frequency: string; intervalValue?: number; mode?: string; startDate: string; endDate?: string;
}) {
  const [sched] = await db.insert(recurringSchedules).values({
    tenantId,
    templateTransactionId,
    frequency: schedule.frequency,
    intervalValue: schedule.intervalValue || 1,
    mode: schedule.mode || 'auto',
    startDate: schedule.startDate,
    endDate: schedule.endDate || null,
    nextOccurrence: schedule.startDate,
    isActive: 'true',
  }).returning();

  return sched;
}

export async function list(tenantId: string) {
  return db.select().from(recurringSchedules)
    .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.isActive, 'true')))
    .orderBy(recurringSchedules.nextOccurrence);
}

export async function getById(tenantId: string, id: string) {
  const sched = await db.query.recurringSchedules.findFirst({
    where: and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)),
  });
  if (!sched) throw AppError.notFound('Recurring schedule not found');
  return sched;
}

export async function update(tenantId: string, id: string, input: {
  frequency?: string; intervalValue?: number; mode?: string; endDate?: string | null;
}) {
  const [updated] = await db.update(recurringSchedules)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)))
    .returning();
  if (!updated) throw AppError.notFound('Recurring schedule not found');
  return updated;
}

export async function deactivate(tenantId: string, id: string) {
  await db.update(recurringSchedules)
    .set({ isActive: 'false', updatedAt: new Date() })
    .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)));
}

export async function postNext(tenantId: string, scheduleId: string) {
  const sched = await getById(tenantId, scheduleId);

  // Get template transaction
  const template = await ledger.getTransaction(tenantId, sched.templateTransactionId);

  // Clone lines from template
  const lines = template.lines.map((l) => ({
    accountId: l.accountId,
    debit: l.debit,
    credit: l.credit,
    description: l.description || undefined,
  }));

  // Post new transaction
  const txn = await ledger.postTransaction(tenantId, {
    txnType: template.txnType as any,
    txnDate: sched.nextOccurrence,
    contactId: template.contactId || undefined,
    memo: template.memo || undefined,
    total: template.total || undefined,
    lines,
  });

  // Update schedule
  const nextOcc = calculateNextOccurrence(sched.nextOccurrence, sched.frequency, sched.intervalValue ?? 1);

  // Check if past end date
  const isExpired = sched.endDate && new Date(nextOcc) > new Date(sched.endDate);

  await db.update(recurringSchedules).set({
    nextOccurrence: nextOcc,
    lastPostedAt: new Date(),
    isActive: isExpired ? 'false' : 'true',
    updatedAt: new Date(),
  }).where(eq(recurringSchedules.id, scheduleId));

  return txn;
}

export async function processAllDue() {
  const today = new Date().toISOString().split('T')[0]!;

  const dueSchedules = await db.select().from(recurringSchedules)
    .where(and(
      eq(recurringSchedules.isActive, 'true'),
      eq(recurringSchedules.mode, 'auto'),
      lte(recurringSchedules.nextOccurrence, today),
    ));

  let processed = 0;
  for (const sched of dueSchedules) {
    try {
      await postNext(sched.tenantId, sched.id);
      processed++;
    } catch (err) {
      console.error(`[Recurring] Failed to post schedule ${sched.id}:`, err);
    }
  }

  return { processed, total: dueSchedules.length };
}
