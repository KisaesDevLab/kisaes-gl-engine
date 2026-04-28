// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  portalQuestions,
  portalQuestionMessages,
  portalContacts,
  portalContactCompanies,
  portalQuestionTemplates,
  portalRecurringQuestionSchedules,
  companies,
  transactions,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 10 — Question System Core.
// CRUD + threading for transaction-scoped (and non-transaction)
// questions between bookkeeper staff and portal contacts.

export interface CreateQuestionInput {
  companyId: string;
  body: string;
  transactionId?: string | null;
  splitLineId?: string | null;
  assignedContactId?: string | null;
}

function currentClosePeriod(now: Date = new Date()): string {
  // YYYY-MM, used as a soft tag for filtering & rollover (10.8).
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${m}`;
}

async function ensureCompanyInTenant(tenantId: string, companyId: string): Promise<void> {
  const co = await db.query.companies.findFirst({
    where: and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)),
  });
  if (!co) throw AppError.notFound('Company not found');
}

async function ensureContactLinkedToCompany(
  tenantId: string,
  contactId: string,
  companyId: string,
): Promise<void> {
  const link = await db
    .select({ contactId: portalContactCompanies.contactId })
    .from(portalContactCompanies)
    .innerJoin(portalContacts, eq(portalContacts.id, portalContactCompanies.contactId))
    .where(
      and(
        eq(portalContactCompanies.contactId, contactId),
        eq(portalContactCompanies.companyId, companyId),
        eq(portalContacts.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (link.length === 0) {
    throw AppError.badRequest('Contact is not linked to this company', 'CONTACT_NOT_LINKED');
  }
}

// 10.2 — bookkeeper creates a question. notified_at stays null on
// purpose so the deferred-notification queue (10.3) can batch
// outbound emails per-contact.
export async function createQuestion(
  tenantId: string,
  bookkeeperUserId: string,
  input: CreateQuestionInput,
): Promise<{ id: string }> {
  if (!input.body || !input.body.trim()) {
    throw AppError.badRequest('Question body is required', 'BODY_REQUIRED');
  }

  await ensureCompanyInTenant(tenantId, input.companyId);

  if (input.assignedContactId) {
    await ensureContactLinkedToCompany(tenantId, input.assignedContactId, input.companyId);
  }

  const inserted = await db
    .insert(portalQuestions)
    .values({
      tenantId,
      companyId: input.companyId,
      transactionId: input.transactionId ?? null,
      splitLineId: input.splitLineId ?? null,
      assignedContactId: input.assignedContactId ?? null,
      body: input.body.trim(),
      status: 'open',
      createdBy: bookkeeperUserId,
      currentClosePeriod: currentClosePeriod(),
    })
    .returning({ id: portalQuestions.id });

  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed', 'INSERT_FAILED');

  await auditLog(
    tenantId,
    'create',
    'portal_question',
    row.id,
    null,
    { companyId: input.companyId, transactionId: input.transactionId ?? null },
    bookkeeperUserId,
  );
  return { id: row.id };
}

// Bookkeeper-side list. Filters: status, companyId, contactId, transactionId.
export async function listForBookkeeper(
  tenantId: string,
  opts: {
    status?: 'open' | 'viewed' | 'responded' | 'resolved' | 'unresolved' | 'all';
    companyId?: string;
    assignedContactId?: string;
    transactionId?: string;
    closePeriod?: string;
  } = {},
): Promise<Array<{
  id: string;
  companyId: string;
  companyName: string;
  body: string;
  status: string;
  transactionId: string | null;
  assignedContactId: string | null;
  contactEmail: string | null;
  createdAt: Date;
  notifiedAt: Date | null;
  respondedAt: Date | null;
  closePeriod: string | null;
  messageCount: number;
}>> {
  const filters: ReturnType<typeof eq>[] = [eq(portalQuestions.tenantId, tenantId)];
  if (opts.status === 'unresolved') {
    filters.push(sql`${portalQuestions.status} != 'resolved'` as unknown as ReturnType<typeof eq>);
  } else if (opts.status && opts.status !== 'all') {
    filters.push(eq(portalQuestions.status, opts.status));
  }
  if (opts.companyId) filters.push(eq(portalQuestions.companyId, opts.companyId));
  if (opts.assignedContactId) filters.push(eq(portalQuestions.assignedContactId, opts.assignedContactId));
  if (opts.transactionId) filters.push(eq(portalQuestions.transactionId, opts.transactionId));
  if (opts.closePeriod) filters.push(eq(portalQuestions.currentClosePeriod, opts.closePeriod));

  const rows = await db
    .select({
      id: portalQuestions.id,
      companyId: portalQuestions.companyId,
      companyName: companies.businessName,
      body: portalQuestions.body,
      status: portalQuestions.status,
      transactionId: portalQuestions.transactionId,
      assignedContactId: portalQuestions.assignedContactId,
      contactEmail: portalContacts.email,
      createdAt: portalQuestions.createdAt,
      notifiedAt: portalQuestions.notifiedAt,
      respondedAt: portalQuestions.respondedAt,
      closePeriod: portalQuestions.currentClosePeriod,
    })
    .from(portalQuestions)
    .innerJoin(companies, eq(portalQuestions.companyId, companies.id))
    .leftJoin(portalContacts, eq(portalQuestions.assignedContactId, portalContacts.id))
    .where(and(...filters))
    .orderBy(desc(portalQuestions.createdAt))
    .limit(200);

  if (rows.length === 0) return [];

  const counts = await db
    .select({
      questionId: portalQuestionMessages.questionId,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(portalQuestionMessages)
    .where(inArray(portalQuestionMessages.questionId, rows.map((r) => r.id)))
    .groupBy(portalQuestionMessages.questionId);

  const countMap = new Map(counts.map((c) => [c.questionId, Number(c.n)]));
  return rows.map((r) => ({ ...r, messageCount: countMap.get(r.id) ?? 0 }));
}

// Detail load. Includes message thread.
export async function getQuestionForBookkeeper(
  tenantId: string,
  questionId: string,
): Promise<{
  id: string;
  companyId: string;
  companyName: string;
  body: string;
  status: string;
  transactionId: string | null;
  splitLineId: string | null;
  assignedContactId: string | null;
  contactEmail: string | null;
  createdAt: Date;
  notifiedAt: Date | null;
  viewedAt: Date | null;
  respondedAt: Date | null;
  resolvedAt: Date | null;
  closePeriod: string | null;
  messages: Array<{
    id: string;
    senderType: string;
    senderId: string;
    body: string;
    createdAt: Date;
  }>;
}> {
  const rows = await db
    .select({
      id: portalQuestions.id,
      companyId: portalQuestions.companyId,
      companyName: companies.businessName,
      body: portalQuestions.body,
      status: portalQuestions.status,
      transactionId: portalQuestions.transactionId,
      splitLineId: portalQuestions.splitLineId,
      assignedContactId: portalQuestions.assignedContactId,
      contactEmail: portalContacts.email,
      createdAt: portalQuestions.createdAt,
      notifiedAt: portalQuestions.notifiedAt,
      viewedAt: portalQuestions.viewedAt,
      respondedAt: portalQuestions.respondedAt,
      resolvedAt: portalQuestions.resolvedAt,
      closePeriod: portalQuestions.currentClosePeriod,
    })
    .from(portalQuestions)
    .innerJoin(companies, eq(portalQuestions.companyId, companies.id))
    .leftJoin(portalContacts, eq(portalQuestions.assignedContactId, portalContacts.id))
    .where(and(eq(portalQuestions.tenantId, tenantId), eq(portalQuestions.id, questionId)))
    .limit(1);

  const head = rows[0];
  if (!head) throw AppError.notFound('Question not found');

  const messages = await db
    .select({
      id: portalQuestionMessages.id,
      senderType: portalQuestionMessages.senderType,
      senderId: portalQuestionMessages.senderId,
      body: portalQuestionMessages.body,
      createdAt: portalQuestionMessages.createdAt,
    })
    .from(portalQuestionMessages)
    .where(eq(portalQuestionMessages.questionId, questionId))
    .orderBy(portalQuestionMessages.createdAt);

  return { ...head, messages };
}

export async function bookkeeperReply(
  tenantId: string,
  bookkeeperUserId: string,
  questionId: string,
  body: string,
): Promise<{ messageId: string }> {
  if (!body || !body.trim()) throw AppError.badRequest('Reply body is required');
  const q = await db.query.portalQuestions.findFirst({
    where: and(eq(portalQuestions.tenantId, tenantId), eq(portalQuestions.id, questionId)),
  });
  if (!q) throw AppError.notFound('Question not found');

  const inserted = await db
    .insert(portalQuestionMessages)
    .values({
      questionId,
      senderType: 'bookkeeper',
      senderId: bookkeeperUserId,
      body: body.trim(),
    })
    .returning({ id: portalQuestionMessages.id });

  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed');
  return { messageId: row.id };
}

export async function resolveQuestion(
  tenantId: string,
  bookkeeperUserId: string,
  questionId: string,
): Promise<void> {
  const q = await db.query.portalQuestions.findFirst({
    where: and(eq(portalQuestions.tenantId, tenantId), eq(portalQuestions.id, questionId)),
  });
  if (!q) throw AppError.notFound('Question not found');
  if (q.status === 'resolved') return;
  await db
    .update(portalQuestions)
    .set({ status: 'resolved', resolvedAt: new Date() })
    .where(eq(portalQuestions.id, questionId));
  await auditLog(tenantId, 'update', 'portal_question', questionId, q, { status: 'resolved' }, bookkeeperUserId);
}

// 10.3 — flush deferred-notification batch. Returns per-contact
// payloads the email job will turn into "you have N new questions"
// messages. Does NOT send mail itself — the caller (BullMQ job or
// Practice admin "Send now" button) drives delivery.
export interface PendingBatch {
  contactId: string;
  email: string;
  firstName: string | null;
  questionIds: string[];
}

export async function listPendingBatches(tenantId: string): Promise<PendingBatch[]> {
  const rows = await db
    .select({
      questionId: portalQuestions.id,
      contactId: portalQuestions.assignedContactId,
      email: portalContacts.email,
      firstName: portalContacts.firstName,
    })
    .from(portalQuestions)
    .innerJoin(portalContacts, eq(portalQuestions.assignedContactId, portalContacts.id))
    .where(
      and(
        eq(portalQuestions.tenantId, tenantId),
        isNull(portalQuestions.notifiedAt),
        eq(portalContacts.status, 'active'),
      ),
    );

  const map = new Map<string, PendingBatch>();
  for (const row of rows) {
    if (!row.contactId) continue;
    const existing = map.get(row.contactId);
    if (existing) {
      existing.questionIds.push(row.questionId);
    } else {
      map.set(row.contactId, {
        contactId: row.contactId,
        email: row.email,
        firstName: row.firstName,
        questionIds: [row.questionId],
      });
    }
  }
  return [...map.values()];
}

export async function markBatchNotified(
  tenantId: string,
  questionIds: string[],
): Promise<void> {
  if (questionIds.length === 0) return;
  await db
    .update(portalQuestions)
    .set({ notifiedAt: new Date() })
    .where(
      and(
        eq(portalQuestions.tenantId, tenantId),
        inArray(portalQuestions.id, questionIds),
      ),
    );
}

// ── Portal-side (contact) ────────────────────────────────────────

// 10.5 — list questions for the signed-in contact for a given
// company. Returns open + answered groups so the portal can render
// both tabs in one round-trip.
export async function listForContact(args: {
  tenantId: string;
  contactId: string;
  companyId: string;
}): Promise<{
  open: Array<{
    id: string;
    body: string;
    status: string;
    transactionId: string | null;
    askedAt: Date;
  }>;
  answered: Array<{
    id: string;
    body: string;
    status: string;
    transactionId: string | null;
    respondedAt: Date | null;
    resolvedAt: Date | null;
  }>;
}> {
  await ensureContactLinkedToCompany(args.tenantId, args.contactId, args.companyId);

  const rows = await db
    .select({
      id: portalQuestions.id,
      body: portalQuestions.body,
      status: portalQuestions.status,
      transactionId: portalQuestions.transactionId,
      createdAt: portalQuestions.createdAt,
      respondedAt: portalQuestions.respondedAt,
      resolvedAt: portalQuestions.resolvedAt,
    })
    .from(portalQuestions)
    .where(
      and(
        eq(portalQuestions.tenantId, args.tenantId),
        eq(portalQuestions.companyId, args.companyId),
        // Only show questions assigned to this contact OR unassigned questions
        // for the company. Contacts never see questions explicitly assigned
        // to a peer.
        sql`(${portalQuestions.assignedContactId} IS NULL OR ${portalQuestions.assignedContactId} = ${args.contactId})`,
        // Don't show unsent questions (notified_at IS NULL means the
        // bookkeeper hasn't released them yet via 10.3).
        sql`${portalQuestions.notifiedAt} IS NOT NULL`,
      ),
    )
    .orderBy(desc(portalQuestions.createdAt));

  const open: Array<{
    id: string;
    body: string;
    status: string;
    transactionId: string | null;
    askedAt: Date;
  }> = [];
  const answered: Array<{
    id: string;
    body: string;
    status: string;
    transactionId: string | null;
    respondedAt: Date | null;
    resolvedAt: Date | null;
  }> = [];

  for (const r of rows) {
    if (r.status === 'open' || r.status === 'viewed') {
      open.push({
        id: r.id,
        body: r.body,
        status: r.status,
        transactionId: r.transactionId,
        askedAt: r.createdAt,
      });
    } else {
      answered.push({
        id: r.id,
        body: r.body,
        status: r.status,
        transactionId: r.transactionId,
        respondedAt: r.respondedAt,
        resolvedAt: r.resolvedAt,
      });
    }
  }
  return { open, answered };
}

export async function getQuestionForContact(args: {
  tenantId: string;
  contactId: string;
  questionId: string;
}): Promise<{
  id: string;
  body: string;
  status: string;
  transactionId: string | null;
  askedAt: Date;
  messages: Array<{
    id: string;
    senderType: string;
    body: string;
    createdAt: Date;
  }>;
  // Light transaction context for the portal — amount + memo only,
  // never any internal account info or other contacts' data.
  transactionContext: { amount: string; memo: string | null; date: Date | null } | null;
}> {
  const q = await db.query.portalQuestions.findFirst({
    where: and(
      eq(portalQuestions.tenantId, args.tenantId),
      eq(portalQuestions.id, args.questionId),
    ),
  });
  if (!q) throw AppError.notFound('Question not found');
  // Authorization: contact must be assigned, OR question is unassigned
  // for a company they're linked to.
  if (q.assignedContactId && q.assignedContactId !== args.contactId) {
    throw AppError.forbidden('You are not assigned this question');
  }
  if (!q.assignedContactId) {
    await ensureContactLinkedToCompany(args.tenantId, args.contactId, q.companyId);
  }
  if (!q.notifiedAt) {
    throw AppError.notFound('Question not found');
  }

  // First-load: mark viewed.
  if (q.status === 'open') {
    await db
      .update(portalQuestions)
      .set({ status: 'viewed', viewedAt: new Date() })
      .where(eq(portalQuestions.id, q.id));
  }

  const messages = await db
    .select({
      id: portalQuestionMessages.id,
      senderType: portalQuestionMessages.senderType,
      body: portalQuestionMessages.body,
      createdAt: portalQuestionMessages.createdAt,
    })
    .from(portalQuestionMessages)
    .where(eq(portalQuestionMessages.questionId, q.id))
    .orderBy(portalQuestionMessages.createdAt);

  let transactionContext: { amount: string; memo: string | null; date: Date | null } | null = null;
  if (q.transactionId) {
    const txn = await db.query.transactions.findFirst({
      where: and(eq(transactions.tenantId, args.tenantId), eq(transactions.id, q.transactionId)),
    });
    if (txn) {
      transactionContext = {
        amount: txn.total ?? '0',
        memo: txn.memo,
        // txnDate is a date column (string in Drizzle); coerce to Date
        // for the portal payload so the client can render with locale.
        date: txn.txnDate ? new Date(`${txn.txnDate}T00:00:00Z`) : null,
      };
    }
  }

  return {
    id: q.id,
    body: q.body,
    status: q.status === 'open' ? 'viewed' : q.status,
    transactionId: q.transactionId,
    askedAt: q.createdAt,
    messages,
    transactionContext,
  };
}

// 10.6 — contact submits an answer.
export async function contactAnswer(args: {
  tenantId: string;
  contactId: string;
  questionId: string;
  body: string;
}): Promise<{ messageId: string }> {
  if (!args.body || !args.body.trim()) {
    throw AppError.badRequest('Answer body is required');
  }
  const q = await db.query.portalQuestions.findFirst({
    where: and(eq(portalQuestions.tenantId, args.tenantId), eq(portalQuestions.id, args.questionId)),
  });
  if (!q) throw AppError.notFound('Question not found');
  if (q.assignedContactId && q.assignedContactId !== args.contactId) {
    throw AppError.forbidden('You are not assigned this question');
  }
  if (!q.notifiedAt) throw AppError.notFound('Question not found');
  if (q.status === 'resolved') {
    throw AppError.badRequest('This question has already been resolved.', 'RESOLVED');
  }

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(portalQuestionMessages)
      .values({
        questionId: q.id,
        senderType: 'contact',
        senderId: args.contactId,
        body: args.body.trim(),
      })
      .returning({ id: portalQuestionMessages.id });

    await tx
      .update(portalQuestions)
      .set({ status: 'responded', respondedAt: new Date() })
      .where(eq(portalQuestions.id, q.id));

    const row = inserted[0];
    if (!row) throw AppError.badRequest('Insert failed');
    return { messageId: row.id };
  });
}

// 11.1 — bulk-ask: create the same body against many transactions.
// Honors the deferred-notification pattern (no notified_at set).
export interface BulkAskInput {
  companyId: string;
  body: string;
  transactionIds: string[];
  assignedContactId?: string | null;
}

export async function bulkAsk(
  tenantId: string,
  bookkeeperUserId: string,
  input: BulkAskInput,
): Promise<{ created: number }> {
  if (!input.body || !input.body.trim()) throw AppError.badRequest('Body required');
  if (!input.transactionIds || input.transactionIds.length === 0) {
    throw AppError.badRequest('Select at least one transaction');
  }
  if (input.transactionIds.length > 200) {
    throw AppError.badRequest('Bulk ask is limited to 200 transactions per batch');
  }
  await ensureCompanyInTenant(tenantId, input.companyId);
  if (input.assignedContactId) {
    await ensureContactLinkedToCompany(tenantId, input.assignedContactId, input.companyId);
  }
  const period = currentClosePeriod();
  const rows = input.transactionIds.map((txnId) => ({
    tenantId,
    companyId: input.companyId,
    transactionId: txnId,
    splitLineId: null,
    assignedContactId: input.assignedContactId ?? null,
    body: input.body.trim(),
    status: 'open',
    createdBy: bookkeeperUserId,
    currentClosePeriod: period,
  }));
  const inserted = await db.insert(portalQuestions).values(rows).returning({ id: portalQuestions.id });
  await auditLog(tenantId, 'create', 'portal_question_bulk', null, null, { count: inserted.length, companyId: input.companyId });
  return { created: inserted.length };
}

// 11.6 — bookkeeper follow-up after client responded. Reply +
// flip status back to 'open' so it shows as actionable on the
// client side.
export async function bookkeeperFollowUp(
  tenantId: string,
  bookkeeperUserId: string,
  questionId: string,
  body: string,
): Promise<{ messageId: string }> {
  const result = await bookkeeperReply(tenantId, bookkeeperUserId, questionId, body);
  await db
    .update(portalQuestions)
    .set({ status: 'open' })
    .where(and(eq(portalQuestions.tenantId, tenantId), eq(portalQuestions.id, questionId)));
  return result;
}

// 11.7 — contact-initiated question (Questions-for-Us). Created
// with status='responded' so it lands directly in the bookkeeper
// "needs attention" view, with the contact's body as the first
// message rather than the question text (the question body is
// generated as a one-line summary).
export interface ContactAskInput {
  companyId: string;
  body: string;
  transactionId?: string | null;
}

export async function contactAsk(
  tenantId: string,
  contactId: string,
  input: ContactAskInput,
): Promise<{ id: string }> {
  if (!input.body || !input.body.trim()) throw AppError.badRequest('Body required');
  await ensureContactLinkedToCompany(tenantId, contactId, input.companyId);

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(portalQuestions)
      .values({
        tenantId,
        companyId: input.companyId,
        transactionId: input.transactionId ?? null,
        assignedContactId: contactId,
        body: input.body.trim().slice(0, 200),
        status: 'responded',
        createdBy: contactId,
        currentClosePeriod: currentClosePeriod(),
        // Already "released" — bookkeeper can see immediately.
        notifiedAt: new Date(),
        respondedAt: new Date(),
      })
      .returning({ id: portalQuestions.id });

    const row = inserted[0];
    if (!row) throw AppError.badRequest('Insert failed');

    await tx.insert(portalQuestionMessages).values({
      questionId: row.id,
      senderType: 'contact',
      senderId: contactId,
      body: input.body.trim(),
    });

    return { id: row.id };
  });
}

// ── Templates (11.2) ─────────────────────────────────────────────

export interface TemplateInput {
  title: string;
  body: string;
  companyId?: string | null;
  variables?: string[];
}

export async function listTemplates(tenantId: string, companyId?: string) {
  const filters: ReturnType<typeof eq>[] = [eq(portalQuestionTemplates.tenantId, tenantId)];
  if (companyId) {
    // company-scoped query: include practice templates (companyId IS NULL) and
    // company-specific overrides.
    filters.push(
      sql`(${portalQuestionTemplates.companyId} IS NULL OR ${portalQuestionTemplates.companyId} = ${companyId})` as unknown as ReturnType<typeof eq>,
    );
  }
  return db
    .select()
    .from(portalQuestionTemplates)
    .where(and(...filters))
    .orderBy(portalQuestionTemplates.title);
}

export async function createTemplate(
  tenantId: string,
  bookkeeperUserId: string,
  input: TemplateInput,
): Promise<{ id: string }> {
  if (!input.title?.trim() || !input.body?.trim()) throw AppError.badRequest('Title and body required');
  if (input.companyId) await ensureCompanyInTenant(tenantId, input.companyId);
  const inserted = await db
    .insert(portalQuestionTemplates)
    .values({
      tenantId,
      companyId: input.companyId ?? null,
      title: input.title.trim(),
      body: input.body.trim(),
      variablesJsonb: input.variables ?? [],
      createdBy: bookkeeperUserId,
    })
    .returning({ id: portalQuestionTemplates.id });
  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed');
  return { id: row.id };
}

export async function updateTemplate(
  tenantId: string,
  templateId: string,
  bookkeeperUserId: string,
  input: Partial<TemplateInput>,
): Promise<void> {
  const before = await db.query.portalQuestionTemplates.findFirst({
    where: and(eq(portalQuestionTemplates.tenantId, tenantId), eq(portalQuestionTemplates.id, templateId)),
  });
  if (!before) throw AppError.notFound('Template not found');
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.title !== undefined) patch['title'] = input.title.trim();
  if (input.body !== undefined) patch['body'] = input.body.trim();
  if (input.variables !== undefined) patch['variablesJsonb'] = input.variables;
  if (input.companyId !== undefined) {
    if (input.companyId) await ensureCompanyInTenant(tenantId, input.companyId);
    patch['companyId'] = input.companyId;
  }
  await db.update(portalQuestionTemplates).set(patch).where(eq(portalQuestionTemplates.id, templateId));
  await auditLog(tenantId, 'update', 'portal_question_template', templateId, before, patch, bookkeeperUserId);
}

export async function deleteTemplate(
  tenantId: string,
  templateId: string,
  bookkeeperUserId: string,
): Promise<void> {
  const before = await db.query.portalQuestionTemplates.findFirst({
    where: and(eq(portalQuestionTemplates.tenantId, tenantId), eq(portalQuestionTemplates.id, templateId)),
  });
  if (!before) throw AppError.notFound('Template not found');
  await db.delete(portalQuestionTemplates).where(eq(portalQuestionTemplates.id, templateId));
  await auditLog(tenantId, 'delete', 'portal_question_template', templateId, before, null, bookkeeperUserId);
}

// 11.2 variable substitution. Variables not present in `vars` are
// left as literal `{name}` so the bookkeeper notices and edits.
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{(\w+)\}/g, (m, key: string) => {
    const v = vars[key];
    return v === undefined ? m : String(v);
  });
}

// ── Recurring schedules (11.4) ───────────────────────────────────

export interface RecurringInput {
  companyId: string;
  templateBody: string;
  cadence: 'monthly' | 'quarterly' | 'custom';
  dayOfPeriod: number;
  startDate: string;
}

function nextFireFor(cadence: 'monthly' | 'quarterly' | 'custom', dayOfPeriod: number, after: Date): string {
  const d = new Date(after);
  d.setUTCHours(0, 0, 0, 0);
  if (cadence === 'monthly') {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, dayOfPeriod));
    return next.toISOString().slice(0, 10);
  }
  if (cadence === 'quarterly') {
    const month = d.getUTCMonth();
    const nextQuarterMonth = Math.floor(month / 3) * 3 + 3; // 0,3,6,9 → 3,6,9,12
    const next = new Date(Date.UTC(d.getUTCFullYear(), nextQuarterMonth, dayOfPeriod));
    return next.toISOString().slice(0, 10);
  }
  // 'custom' — caller manages nextFire externally; default to +30 days.
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 30));
  return next.toISOString().slice(0, 10);
}

export async function createRecurring(
  tenantId: string,
  input: RecurringInput,
): Promise<{ id: string }> {
  await ensureCompanyInTenant(tenantId, input.companyId);
  const inserted = await db
    .insert(portalRecurringQuestionSchedules)
    .values({
      tenantId,
      companyId: input.companyId,
      templateBody: input.templateBody.trim(),
      cadence: input.cadence,
      dayOfPeriod: String(input.dayOfPeriod),
      nextFire: input.startDate,
      active: true,
    })
    .returning({ id: portalRecurringQuestionSchedules.id });
  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed');
  return { id: row.id };
}

export async function listRecurring(tenantId: string) {
  return db
    .select()
    .from(portalRecurringQuestionSchedules)
    .where(eq(portalRecurringQuestionSchedules.tenantId, tenantId))
    .orderBy(portalRecurringQuestionSchedules.nextFire);
}

export async function pauseRecurring(tenantId: string, id: string, active: boolean) {
  await db
    .update(portalRecurringQuestionSchedules)
    .set({ active })
    .where(
      and(
        eq(portalRecurringQuestionSchedules.tenantId, tenantId),
        eq(portalRecurringQuestionSchedules.id, id),
      ),
    );
}

// Scheduler tick — call on a 1h cadence from the worker. Fires every
// active recurring schedule whose nextFire <= today, advances nextFire,
// and creates a portal_questions row tied to the system user (no
// human createdBy).
export async function tickRecurring(): Promise<{ fired: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const due = await db
    .select()
    .from(portalRecurringQuestionSchedules)
    .where(
      and(
        eq(portalRecurringQuestionSchedules.active, true),
        lte(portalRecurringQuestionSchedules.nextFire, today),
      ),
    );

  let fired = 0;
  for (const sched of due) {
    await db.transaction(async (tx) => {
      await tx.insert(portalQuestions).values({
        tenantId: sched.tenantId,
        companyId: sched.companyId,
        transactionId: null,
        assignedContactId: null,
        body: sched.templateBody,
        status: 'open',
        createdBy: sched.tenantId, // system marker — no real user
        currentClosePeriod: currentClosePeriod(),
      });
      const next = nextFireFor(
        sched.cadence as 'monthly' | 'quarterly' | 'custom',
        Number(sched.dayOfPeriod),
        new Date(`${sched.nextFire}T00:00:00Z`),
      );
      await tx
        .update(portalRecurringQuestionSchedules)
        .set({ nextFire: next, updatedAt: new Date() })
        .where(eq(portalRecurringQuestionSchedules.id, sched.id));
    });
    fired++;
  }
  return { fired };
}

// 12.2 — append a portal-question response to a transaction's memo.
// Format follows the build-plan convention: `//<existing>// [response]`.
// Returns the updated memo.
export async function appendResponseToMemo(
  tenantId: string,
  bookkeeperUserId: string,
  args: { questionId: string; messageId: string },
): Promise<{ memo: string }> {
  const q = await db.query.portalQuestions.findFirst({
    where: and(
      eq(portalQuestions.tenantId, tenantId),
      eq(portalQuestions.id, args.questionId),
    ),
  });
  if (!q) throw AppError.notFound('Question not found');
  if (!q.transactionId) throw AppError.badRequest('Question is not attached to a transaction');

  const m = await db.query.portalQuestionMessages.findFirst({
    where: and(
      eq(portalQuestionMessages.id, args.messageId),
      eq(portalQuestionMessages.questionId, args.questionId),
    ),
  });
  if (!m) throw AppError.notFound('Message not found');

  const txn = await db.query.transactions.findFirst({
    where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, q.transactionId)),
  });
  if (!txn) throw AppError.notFound('Transaction not found');

  const prior = txn.memo ?? '';
  const next = prior
    ? `${prior}\n//Comment// ${m.body.trim()}`
    : `//Comment// ${m.body.trim()}`;

  await db
    .update(transactions)
    .set({ memo: next })
    .where(eq(transactions.id, q.transactionId));

  await auditLog(
    tenantId,
    'update',
    'transaction',
    q.transactionId,
    { memo: prior },
    { memo: next, fromQuestionId: q.id, fromMessageId: m.id },
    bookkeeperUserId,
  );
  return { memo: next };
}

// Cross-tenant variant — the scheduler tick runs this so orphans
// across every tenant are picked up without us iterating tenants in
// the worker. Returns the total count cleaned.
export async function resolveOrphansAllTenants(): Promise<number> {
  const orphaned = await db
    .select({ id: portalQuestions.id })
    .from(portalQuestions)
    .leftJoin(transactions, eq(portalQuestions.transactionId, transactions.id))
    .where(
      and(
        sql`${portalQuestions.status} != 'resolved'`,
        sql`${portalQuestions.transactionId} IS NOT NULL`,
        sql`${transactions.id} IS NULL`,
      ),
    );
  if (orphaned.length === 0) return 0;
  await db
    .update(portalQuestions)
    .set({ status: 'resolved', resolvedAt: new Date() })
    .where(inArray(portalQuestions.id, orphaned.map((o) => o.id)));
  return orphaned.length;
}

// 10.8 — auto-resolve when the underlying transaction is gone.
// Called from the existing transaction void/delete path; can also
// run on demand as a periodic cleaner.
export async function resolveOrphans(tenantId: string): Promise<number> {
  const orphaned = await db
    .select({ id: portalQuestions.id, transactionId: portalQuestions.transactionId })
    .from(portalQuestions)
    .leftJoin(transactions, eq(portalQuestions.transactionId, transactions.id))
    .where(
      and(
        eq(portalQuestions.tenantId, tenantId),
        sql`${portalQuestions.status} != 'resolved'`,
        sql`${portalQuestions.transactionId} IS NOT NULL`,
        sql`${transactions.id} IS NULL`,
      ),
    );

  if (orphaned.length === 0) return 0;
  await db
    .update(portalQuestions)
    .set({ status: 'resolved', resolvedAt: new Date() })
    .where(inArray(portalQuestions.id, orphaned.map((o) => o.id)));

  return orphaned.length;
}
