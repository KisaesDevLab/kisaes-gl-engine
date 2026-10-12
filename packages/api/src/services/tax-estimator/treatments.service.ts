// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Estimator tax-treatment map (MODULE.md D3): the per-account treatments TB
// lacks (tax_est_account_treatments) and per-transaction non-recurring flags
// (tax_est_transaction_flags). Character is NEVER stored here — it comes from
// TB account_tax_assignments.
//
// Every function runs the D1 scope guard first, and every query is pinned to
// that single verified tenant (+ company). Writes are audited against the
// books tenant with entityType 'tax_est_treatment', tagged with the acting
// firm (R1 F16). Suggestions are returned, never applied.
//
// Validation (R1 F1, F9, F10): each treatment applies only to its account
// types (TREATMENT_ACCOUNT_TYPES → 422 TE_TREATMENT_ACCOUNT_TYPE) and entity
// types (guaranteed_payment = partnership only → 422
// TE_TREATMENT_NOT_FOR_ENTITY); a guaranteed payment and an S corp owner item
// need a person target (422 TE_PERSON_REQUIRED).

import { and, count, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type {
  AccountTreatment, AccountTreatmentDto, AccountTreatmentInput, EntityTaxType, PagedList, PutTransactionFlagsInput,
  TaxCodeRef, TransactionFlagDto, TreatmentSuggestion,
} from '@kis-books/shared';
import { TREATMENT_ACCOUNT_TYPES, TREATMENT_ENTITY_TYPES, allowsPersonTarget, personRequiredFor } from '@kis-books/shared';
import { db } from '../../db/index.js';
import {
  accounts, taxEstAccountTreatments, taxEstPersons, taxEstTaxpayers, taxEstTransactionFlags, transactions,
} from '../../db/schema/index.js';
import { auditLog } from '../../middleware/audit.js';
import { AppError } from '../../utils/errors.js';
import type { FirmScope } from './firm-scope.service.js';
import { assertEntityInScope, resolveForCompany } from './entity-type.service.js';
import { listAssignments } from '../tb/balance-engine.service.js';
import { impliedTreatmentForCode } from './pl-provider.service.js';

const AUDIT_ENTITY = 'tax_est_treatment';

/** Audit row tagged with the acting firm, like the taxpayer audits (R1 F16). */
function tagFirm(scope: FirmScope, v: unknown | null): unknown | null {
  return v ? { ...(v as object), firmId: scope.firmId } : null;
}

export interface ListOptions { limit: number; offset: number }

/** Accounts usable by a company: its own plus tenant-level (company_id NULL) accounts. */
function companyAccountCond(tenantId: string, companyId: string) {
  return and(eq(accounts.tenantId, tenantId), or(eq(accounts.companyId, companyId), isNull(accounts.companyId)));
}

export async function listTreatments(
  scope: FirmScope, tenantId: string, companyId: string, opts: ListOptions,
): Promise<PagedList<AccountTreatmentDto>> {
  await assertEntityInScope(scope, tenantId, companyId);
  const where = and(eq(taxEstAccountTreatments.tenantId, tenantId), eq(taxEstAccountTreatments.companyId, companyId));
  const [totalRow] = await db.select({ n: count() }).from(taxEstAccountTreatments).where(where);
  const rows = await db.select({
    t: taxEstAccountTreatments,
    accountNumber: accounts.accountNumber,
    accountName: accounts.name,
    accountType: accounts.accountType,
  }).from(taxEstAccountTreatments)
    .innerJoin(accounts, and(eq(accounts.id, taxEstAccountTreatments.accountId), eq(accounts.tenantId, tenantId)))
    .where(where)
    .orderBy(accounts.accountNumber, accounts.name)
    .limit(opts.limit)
    .offset(opts.offset);
  return {
    items: rows.map((r) => ({
      id: r.t.id,
      accountId: r.t.accountId,
      accountNumber: r.accountNumber,
      accountName: r.accountName,
      accountType: r.accountType,
      treatment: (r.t.treatment as AccountTreatment | null) ?? null,
      pct: r.t.pct,
      paymentTaxpayerId: r.t.paymentTaxpayerId,
      paymentPersonId: r.t.paymentPersonId,
      paymentJurisdiction: r.t.paymentJurisdiction,
      nonRecurring: r.t.nonRecurring,
      updatedAt: r.t.updatedAt.toISOString(),
    })),
    total: Number(totalRow?.n ?? 0),
    limit: opts.limit,
    offset: opts.offset,
  };
}

async function validatePaymentTargets(scope: FirmScope, inputs: AccountTreatmentInput[]): Promise<void> {
  const taxpayerIds = [...new Set(inputs.map((i) => i.paymentTaxpayerId).filter((x): x is string => !!x))];
  const personIds = [...new Set(inputs.map((i) => i.paymentPersonId).filter((x): x is string => !!x))];
  if (taxpayerIds.length > 0) {
    // Taxpayers are firm-scoped (D1): only the caller's firm's taxpayers may receive payments.
    const found = await db.select({ id: taxEstTaxpayers.id }).from(taxEstTaxpayers)
      .where(and(inArray(taxEstTaxpayers.id, taxpayerIds), eq(taxEstTaxpayers.firmId, scope.firmId)));
    if (found.length !== taxpayerIds.length) throw new AppError(404, 'Taxpayer not found', 'TE_TAXPAYER_NOT_FOUND');
  }
  if (personIds.length > 0) {
    const found = await db.select({ id: taxEstPersons.id, taxpayerId: taxEstPersons.taxpayerId })
      .from(taxEstPersons)
      .innerJoin(taxEstTaxpayers, eq(taxEstTaxpayers.id, taxEstPersons.taxpayerId))
      .where(and(inArray(taxEstPersons.id, personIds), eq(taxEstTaxpayers.firmId, scope.firmId)));
    const byId = new Map(found.map((p) => [p.id, p.taxpayerId]));
    for (const i of inputs) {
      if (!i.paymentPersonId) continue;
      const tp = byId.get(i.paymentPersonId);
      if (!tp) throw new AppError(404, 'Person not found', 'TE_PERSON_NOT_FOUND');
      if (i.paymentTaxpayerId && tp !== i.paymentTaxpayerId) {
        throw AppError.badRequest('The person does not belong to the payment taxpayer', 'TE_PERSON_TAXPAYER_MISMATCH');
      }
    }
  }
}

/** Account-type, entity-type and person-target rules (R1 F1, F9, F10). Exported for tests. */
export function validateTreatmentRules(
  inputs: AccountTreatmentInput[], accountTypes: Map<string, string>, entityType: EntityTaxType | null,
): void {
  for (const i of inputs) {
    const t = i.treatment;
    if (!t) continue;
    const accountType = accountTypes.get(i.accountId) ?? '';
    const allowedTypes = TREATMENT_ACCOUNT_TYPES[t];
    if (allowedTypes && !allowedTypes.includes(accountType)) {
      throw AppError.unprocessableEntity(
        `The ${t} treatment does not apply to a ${accountType} account (allowed: ${allowedTypes.join(', ')})`,
        'TE_TREATMENT_ACCOUNT_TYPE', { accountId: i.accountId, treatment: t, accountType },
      );
    }
    const allowedEntities = TREATMENT_ENTITY_TYPES[t];
    if (allowedEntities && (!entityType || !allowedEntities.includes(entityType))) {
      throw AppError.unprocessableEntity(
        `The ${t} treatment applies to ${allowedEntities.join(' / ')} entities only (this entity: ${entityType ?? 'not set'})`,
        'TE_TREATMENT_NOT_FOR_ENTITY', { accountId: i.accountId, treatment: t, entityType },
      );
    }
    if (personRequiredFor(t, entityType) && !i.paymentPersonId) {
      throw AppError.unprocessableEntity(
        t === 'guaranteed_payment'
          ? 'A guaranteed payment needs the partner it is paid to'
          : 'An S corp owner treatment needs the officer (person) it belongs to',
        'TE_PERSON_REQUIRED', { accountId: i.accountId, treatment: t },
      );
    }
  }
}

export async function putTreatments(
  scope: FirmScope, tenantId: string, companyId: string, inputs: AccountTreatmentInput[], userId?: string,
): Promise<PagedList<AccountTreatmentDto>> {
  const company = await assertEntityInScope(scope, tenantId, companyId);
  const accountIds = [...new Set(inputs.map((i) => i.accountId))];
  if (accountIds.length !== inputs.length) throw AppError.badRequest('Each account may appear once', 'TE_DUPLICATE_ACCOUNT');
  const found = await db.select({ id: accounts.id, accountType: accounts.accountType }).from(accounts)
    .where(and(companyAccountCond(tenantId, companyId), inArray(accounts.id, accountIds)));
  if (found.length !== accountIds.length) throw new AppError(404, 'Account not found', 'TE_ACCOUNT_NOT_FOUND');
  validateTreatmentRules(inputs, new Map(found.map((a) => [a.id, a.accountType])), (await resolveForCompany(company)).entityType);
  await validatePaymentTargets(scope, inputs);

  await db.transaction(async (tx) => {
    for (const input of inputs) {
      const [before] = await tx.select().from(taxEstAccountTreatments)
        .where(and(
          eq(taxEstAccountTreatments.tenantId, tenantId),
          eq(taxEstAccountTreatments.companyId, companyId),
          eq(taxEstAccountTreatments.accountId, input.accountId),
        ))
        .for('update')
        .limit(1);
      if (input.treatment === null && !input.nonRecurring) {
        if (before) {
          await tx.delete(taxEstAccountTreatments)
            .where(and(eq(taxEstAccountTreatments.tenantId, tenantId), eq(taxEstAccountTreatments.id, before.id)));
          await auditLog(tenantId, 'delete', AUDIT_ENTITY, before.id, tagFirm(scope, before), null, userId, tx);
        }
        continue;
      }
      const isPayment = input.treatment === 'estimated_tax_payment';
      const hasPerson = allowsPersonTarget(input.treatment);
      const values = {
        treatment: input.treatment,
        pct: input.treatment === 'nondeductible_pct' ? input.pct ?? null : null,
        paymentTaxpayerId: hasPerson ? input.paymentTaxpayerId ?? null : null,
        paymentPersonId: hasPerson ? input.paymentPersonId ?? null : null,
        paymentJurisdiction: isPayment ? input.paymentJurisdiction ?? null : null,
        nonRecurring: input.nonRecurring,
        updatedBy: userId ?? null,
        updatedAt: new Date(),
      };
      const [after] = before
        ? await tx.update(taxEstAccountTreatments).set(values)
          .where(and(eq(taxEstAccountTreatments.tenantId, tenantId), eq(taxEstAccountTreatments.id, before.id)))
          .returning()
        : await tx.insert(taxEstAccountTreatments)
          .values({ tenantId, companyId, accountId: input.accountId, ...values })
          .returning();
      await auditLog(tenantId, before ? 'update' : 'create', AUDIT_ENTITY, after!.id, tagFirm(scope, before ?? null), tagFirm(scope, after), userId, tx);
    }
  });
  return listTreatments(scope, tenantId, companyId, { limit: 500, offset: 0 });
}

export async function listTransactionFlags(
  scope: FirmScope, tenantId: string, companyId: string, opts: ListOptions,
): Promise<PagedList<TransactionFlagDto>> {
  await assertEntityInScope(scope, tenantId, companyId);
  const where = and(
    eq(taxEstTransactionFlags.tenantId, tenantId),
    eq(transactions.tenantId, tenantId),
    eq(transactions.companyId, companyId),
  );
  const [totalRow] = await db.select({ n: count() }).from(taxEstTransactionFlags)
    .innerJoin(transactions, eq(transactions.id, taxEstTransactionFlags.transactionId))
    .where(where);
  const rows = await db.select({
    f: taxEstTransactionFlags,
    txnDate: transactions.txnDate,
    txnType: transactions.txnType,
    txnNumber: transactions.txnNumber,
  }).from(taxEstTransactionFlags)
    .innerJoin(transactions, eq(transactions.id, taxEstTransactionFlags.transactionId))
    .where(where)
    .orderBy(transactions.txnDate)
    .limit(opts.limit)
    .offset(opts.offset);
  return {
    items: rows.map((r) => ({
      transactionId: r.f.transactionId,
      nonRecurring: r.f.nonRecurring,
      txnDate: r.txnDate,
      txnType: r.txnType,
      txnNumber: r.txnNumber,
      updatedAt: r.f.updatedAt.toISOString(),
    })),
    total: Number(totalRow?.n ?? 0),
    limit: opts.limit,
    offset: opts.offset,
  };
}

export async function putTransactionFlags(
  scope: FirmScope, tenantId: string, companyId: string, input: PutTransactionFlagsInput, userId?: string,
): Promise<PagedList<TransactionFlagDto>> {
  await assertEntityInScope(scope, tenantId, companyId);
  const ids = [...new Set(input.flags.map((f) => f.transactionId))];
  if (ids.length !== input.flags.length) throw AppError.badRequest('Each transaction may appear once', 'TE_DUPLICATE_TRANSACTION');
  const found = await db.select({ id: transactions.id }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.companyId, companyId), inArray(transactions.id, ids)));
  if (found.length !== ids.length) throw new AppError(404, 'Transaction not found', 'TE_TRANSACTION_NOT_FOUND');

  await db.transaction(async (tx) => {
    for (const f of input.flags) {
      const [before] = await tx.select().from(taxEstTransactionFlags)
        .where(and(eq(taxEstTransactionFlags.tenantId, tenantId), eq(taxEstTransactionFlags.transactionId, f.transactionId)))
        .for('update')
        .limit(1);
      if (!f.nonRecurring) {
        if (before) {
          await tx.delete(taxEstTransactionFlags)
            .where(and(eq(taxEstTransactionFlags.tenantId, tenantId), eq(taxEstTransactionFlags.id, before.id)));
          await auditLog(tenantId, 'delete', AUDIT_ENTITY, before.id, tagFirm(scope, { ...before, kind: 'transaction_flag' }), null, userId, tx);
        }
        continue;
      }
      if (before) continue; // already flagged — idempotent
      const [after] = await tx.insert(taxEstTransactionFlags)
        .values({ tenantId, transactionId: f.transactionId, nonRecurring: true, updatedBy: userId ?? null })
        .returning();
      await auditLog(tenantId, 'create', AUDIT_ENTITY, after!.id, null, tagFirm(scope, { ...after, kind: 'transaction_flag' }), userId, tx);
    }
  });
  return listTransactionFlags(scope, tenantId, companyId, { limit: 500, offset: 0 });
}

// ── Suggestions (never auto-applied) ───────────────────────────────

const PL_COST_TYPES = new Set(['expense', 'other_expense', 'cogs']);
const MEALS_PCT = '50';

interface SuggestRule {
  treatment: AccountTreatment;
  test: (name: string, accountType: string) => boolean;
  pct?: string;
  jurisdiction?: (name: string) => string | null;
  reason: (accountType: string) => string;
}

// Order matters: the first matching rule wins for an account.
const SUGGEST_RULES: SuggestRule[] = [
  {
    treatment: 'estimated_tax_payment',
    test: (n, t) => ['equity', 'expense', 'other_expense', 'liability', 'asset'].includes(t)
      && /(estimated\s+(income\s+)?tax|est\.?\s+tax|1040-?es|quarterly\s+tax|\birs\b|federal\s+income\s+tax\s+pay)/.test(n),
    jurisdiction: (n) => (/\birs\b|federal|1040-?es/.test(n) ? 'federal' : null),
    reason: (t) => `Name refers to estimated / IRS tax payments (${t} account); amounts go to the payment ledger, not entity profit.`,
  },
  {
    treatment: 'owner_sehi',
    test: (n, t) => PL_COST_TYPES.has(t) && /(health|medical|dental)/.test(n)
      && /(owner|officer|shareholder|partner|member|self[-\s]?employed)/.test(n),
    reason: (t) => `Name refers to owner/officer health insurance (${t} account); routed to the owner as self-employed health insurance.`,
  },
  {
    treatment: 'nondeductible_pct',
    test: (n, t) => PL_COST_TYPES.has(t) && /\bmeals?\b|entertain/.test(n),
    pct: MEALS_PCT,
    reason: (t) => `Name refers to meals (${t} account); business meals are generally 50% deductible.`,
  },
  {
    treatment: 'w2_wages',
    test: (n, t) => PL_COST_TYPES.has(t)
      && /(wage|salar|officer'?s?\s+comp|compensation\s+of\s+officers|payroll)/.test(n)
      && !/(tax|fica|futa|suta|fee|service|processing|benefit|clearing|liabilit|payable|contractor)/.test(n),
    reason: (t) => `Name refers to wages / salaries / officer compensation (${t} account); the year's total feeds the QBI W-2 wage limit.`,
  },
];

export function suggestTreatmentFor(name: string, accountType: string): Omit<TreatmentSuggestion, 'accountId' | 'accountNumber' | 'accountName' | 'accountType'> | null {
  const n = name.toLowerCase();
  for (const rule of SUGGEST_RULES) {
    if (!rule.test(n, accountType)) continue;
    return {
      treatment: rule.treatment,
      pct: rule.pct ?? null,
      paymentJurisdiction: rule.jurisdiction ? rule.jurisdiction(n) : null,
      reason: rule.reason(accountType),
      basis: 'name',
    };
  }
  return null;
}

/**
 * Suggestion from the account's TB tax code (R1 F1, F3): 1065 guaranteed-
 * payment codes → guaranteed_payment (partnership only; the partner must
 * still be picked); 1040 Sch 1 L17 SEHI codes → owner_sehi (the provider
 * already honours the code — the suggestion lets the CPA confirm it).
 * Exported for tests.
 */
export function suggestFromCode(
  code: TaxCodeRef | null, accountType: string, entityType: EntityTaxType | null,
): Omit<TreatmentSuggestion, 'accountId' | 'accountNumber' | 'accountName' | 'accountType'> | null {
  const implied = impliedTreatmentForCode(code);
  if (!implied || !code) return null;
  if (!(TREATMENT_ACCOUNT_TYPES[implied] ?? []).includes(accountType)) return null;
  if (implied === 'guaranteed_payment' && entityType !== 'partnership') return null;
  return {
    treatment: implied,
    pct: null,
    paymentJurisdiction: null,
    reason: implied === 'guaranteed_payment'
      ? `TB code ${code.code}${code.description ? ` (${code.description})` : ''} is a guaranteed payment; pick the partner it is paid to so it reaches that partner's income.`
      : `TB code ${code.code}${code.description ? ` (${code.description})` : ''} is owner self-employed health insurance; already routed to the owner from the TB code.`,
    basis: 'tb_code',
  };
}

export async function suggestTreatments(scope: FirmScope, tenantId: string, companyId: string): Promise<TreatmentSuggestion[]> {
  const company = await assertEntityInScope(scope, tenantId, companyId);
  const resolved = await resolveForCompany(company);
  const [accts, existing, assignments] = await Promise.all([
    db.select({
      id: accounts.id, accountNumber: accounts.accountNumber, name: accounts.name, accountType: accounts.accountType,
    }).from(accounts)
      .where(and(companyAccountCond(tenantId, companyId), sql`COALESCE(${accounts.isActive}, true)`))
      .orderBy(accounts.accountNumber, accounts.name),
    db.select({ accountId: taxEstAccountTreatments.accountId, treatment: taxEstAccountTreatments.treatment })
      .from(taxEstAccountTreatments)
      .where(and(eq(taxEstAccountTreatments.tenantId, tenantId), eq(taxEstAccountTreatments.companyId, companyId))),
    listAssignments(tenantId, companyId),
  ]);
  // Seed code per account (account-level row first), by code identity.
  const codeByAccount = new Map<string, TaxCodeRef>();
  for (const a of [...assignments].sort((x, y) => (x.activityUnitId === null ? -1 : 0) - (y.activityUnitId === null ? -1 : 0))) {
    if (codeByAccount.has(a.accountId) || !a.seedCode || !a.seedActivityType) continue;
    codeByAccount.set(a.accountId, {
      returnForm: resolved.tbReturnForm ?? '', activityType: a.seedActivityType, code: a.seedCode, description: '', source: 'seed',
    });
  }
  const treated = new Set(existing.filter((e) => e.treatment !== null).map((e) => e.accountId));
  const out: TreatmentSuggestion[] = [];
  for (const a of accts) {
    if (treated.has(a.id)) continue;
    const s = suggestFromCode(codeByAccount.get(a.id) ?? null, a.accountType, resolved.entityType)
      ?? suggestTreatmentFor(a.name, a.accountType);
    if (!s) continue;
    out.push({ accountId: a.id, accountNumber: a.accountNumber, accountName: a.name, accountType: a.accountType, ...s });
  }
  return out;
}
