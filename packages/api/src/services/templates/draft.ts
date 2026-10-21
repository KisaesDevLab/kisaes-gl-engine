// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Template drafts (U-62, templates-v1): parsing, validation, storage rows
 * and totals.
 *
 * A draft is the create body of its kind's endpoint minus the date and
 * numbers. Validation runs the kind's own pure builder (the one the live
 * create uses) on a placeholder date, so a template can never hold what its
 * create endpoint would refuse; the database-backed scope checks run in the
 * write transaction (assertDraftRefsInScope). Amounts are exact decimal
 * strings throughout (exactAmount / Decimal); nothing here converts money
 * to a float.
 */

import { and, eq, inArray } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import {
  TEMPLATE_DRAFT_SCHEMAS,
  type TemplateDraft, type TemplateDraftKind,
  type CheckTemplateDraft, type ExpenseTemplateDraft, type DepositTemplateDraft,
  type TransferTemplateDraft, type JournalEntryTemplateDraft, type DailySalesTemplateDraft,
} from '@kis-books/shared';
import type { DbOrTx, Tx } from '../../db/index.js';
import {
  accounts, contacts, tags, dailySalesTemplates, dailySalesTemplateLines,
  templateTransactions, templateTransactionLines,
} from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { exactAmount } from '../../utils/money.js';
import { buildCheckLines } from '../check.service.js';
import { buildExpensePayload } from '../expense.service.js';
import { planDeposit, validateCashBackAccount } from '../deposit.service.js';
import { assertBillableLinesHaveContact, assertContactsInScope } from '../line-contacts.service.js';
import { computeEntry } from '../daily-sales.service.js';
import { DESKTOP_CAPABILITIES } from '../../desktop/capabilities.js';

const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;

/** Date the pure builders run on; a template has no date of its own. */
const PLACEHOLDER_DATE = '2000-01-01';

/** Keys of the create bodies a template can't hold (400 TEMPLATE_FIELD_NOT_ALLOWED). */
export const TEMPLATE_NOT_ALLOWED: Record<TemplateDraftKind, readonly string[]> = {
  check: ['checkNumber', 'txnDate', 'draftAttachmentId', 'printedCheckChange'],
  expense: ['txnNumber', 'txnDate', 'draftAttachmentId'],
  deposit: ['txnDate', 'draftAttachmentId'],
  transfer: ['txnDate', 'draftAttachmentId'],
  journal_entry: ['txnNumber', 'reverseOn', 'txnDate', 'draftAttachmentId'],
  daily_sales: ['businessDate'],
};

function notAllowed(field: string): AppError {
  return new AppError(400, `A template can't hold ${field}.`, 'TEMPLATE_FIELD_NOT_ALLOWED', { field });
}

export function depositGroupingRefused(): AppError {
  return new AppError(400,
    'A deposit template can’t include payments waiting to be deposited (deposit grouping). Use plain lines.',
    'TEMPLATE_DEPOSIT_GROUPING');
}

function validation(message: string): AppError {
  return AppError.badRequest(message, 'VALIDATION_ERROR');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parses and validates a draft of `kind`. Throws 400 TEMPLATE_FIELD_NOT_ALLOWED
 * (details.field), TEMPLATE_DEPOSIT_GROUPING or VALIDATION_ERROR (zod issues,
 * builder refusals). Database scope checks are separate (assertDraftRefsInScope).
 */
export function parseDraft(kind: TemplateDraftKind, raw: unknown): TemplateDraft {
  if (!isRecord(raw)) throw validation('draft must be an object');
  for (const field of TEMPLATE_NOT_ALLOWED[kind]) {
    if (field in raw) throw notAllowed(field);
  }
  if (kind === 'deposit' && Array.isArray(raw['lines'])
    && raw['lines'].some((l) => isRecord(l) && 'sourceTransactionId' in l)) {
    throw depositGroupingRefused();
  }
  if (kind === 'journal_entry' && raw['isAdjusting'] === true && !DESKTOP_CAPABILITIES.includes('je-adjusting-v1')) {
    // The adjusting flag arrives with je-adjusting-v1; until then a template can't promise it.
    throw notAllowed('isAdjusting');
  }
  if (kind === 'journal_entry' && Array.isArray(raw['lines']) && !DESKTOP_CAPABILITIES.includes('je-names-v1')
    && raw['lines'].some((l) => isRecord(l) && l['contactId'] !== undefined && l['contactId'] !== null)) {
    // Journal entry line names arrive with je-names-v1 (the create body drops them before it).
    throw notAllowed('lines.contactId');
  }
  let td: TemplateDraft;
  switch (kind) {
    case 'check': td = { kind, draft: TEMPLATE_DRAFT_SCHEMAS.check.parse(raw) }; break;
    case 'expense': td = { kind, draft: TEMPLATE_DRAFT_SCHEMAS.expense.parse(raw) }; break;
    case 'deposit': td = { kind, draft: TEMPLATE_DRAFT_SCHEMAS.deposit.parse(raw) }; break;
    case 'transfer': td = { kind, draft: TEMPLATE_DRAFT_SCHEMAS.transfer.parse(raw) }; break;
    case 'journal_entry': td = { kind, draft: TEMPLATE_DRAFT_SCHEMAS.journal_entry.parse(raw) }; break;
    case 'daily_sales': td = { kind, draft: TEMPLATE_DRAFT_SCHEMAS.daily_sales.parse(raw) }; break;
  }
  validateDraft(td);
  return td;
}

function nonZero(value: string, field: string): DecimalValue {
  const d = exactAmount(value, field);
  if (d.isZero()) {
    // Q-251: a template never holds an amount to be filled in later.
    throw validation(`${field} must not be zero`);
  }
  return d;
}

/** The kind's pure builder on a placeholder date; throws what the create would. */
export function validateDraft(td: TemplateDraft): void {
  switch (td.kind) {
    case 'check': {
      const d = td.draft;
      d.lines.forEach((l, i) => nonZero(l.amount, `lines[${i}].amount`));
      buildCheckLines({ amount: d.amount, bankAccountId: d.bankAccountId, lines: checkLines(d) });
      return;
    }
    case 'expense': {
      const d = td.draft;
      d.lines.forEach((l, i) => nonZero(l.amount, `lines[${i}].amount`));
      assertBillableLinesHaveContact(d.lines);
      const payload = buildExpensePayload(expenseInput(d, PLACEHOLDER_DATE));
      if (!new Decimal(payload.total).greaterThan(0)) throw validation('The expense total must be greater than zero');
      return;
    }
    case 'deposit': {
      const d = td.draft;
      d.lines.forEach((l, i) => nonZero(l.amount, `lines[${i}].amount`));
      planDeposit(depositInput(d, PLACEHOLDER_DATE));
      return;
    }
    case 'transfer': {
      const d = td.draft;
      const amount = exactAmount(d.amount, 'amount');
      if (!amount.greaterThan(0)) throw validation('The transfer amount must be greater than zero');
      if (d.fromAccountId === d.toAccountId) throw validation('Transfer to a different account');
      return;
    }
    case 'journal_entry': {
      let debits = new Decimal(0);
      let credits = new Decimal(0);
      td.draft.lines.forEach((l, i) => {
        const dr = exactAmount(l.debit, `lines[${i}].debit`);
        const cr = exactAmount(l.credit, `lines[${i}].credit`);
        if (dr.isNegative() || cr.isNegative()) throw validation(`lines[${i}]: debit and credit can't be negative`);
        if (dr.greaterThan(0) && cr.greaterThan(0)) throw validation(`lines[${i}]: a line is a debit or a credit, not both`);
        if (dr.isZero() && cr.isZero()) throw validation(`lines[${i}] must not be zero`);
        debits = debits.plus(dr);
        credits = credits.plus(cr);
      });
      if (!debits.equals(credits)) {
        throw validation(`The entry does not balance: debits ${debits.toFixed(4)}, credits ${credits.toFixed(4)}`);
      }
      return;
    }
    case 'daily_sales':
      td.draft.values.forEach((v, i) => nonZero(v.amount, `values[${i}].amount`));
      return;
  }
}

// ── Draft → the create services' inputs ────────────────────────────

const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

export function checkLines(d: CheckTemplateDraft) {
  return d.lines.map((l) => ({
    accountId: l.accountId,
    amount: l.amount,
    description: opt(l.description),
    tagId: l.tagId ?? null,
    contactId: l.contactId ?? null,
    isBillable: l.isBillable === true,
  }));
}

export function checkInput(d: CheckTemplateDraft, txnDate: string) {
  return {
    bankAccountId: d.bankAccountId,
    contactId: opt(d.contactId),
    payeeNameOnCheck: d.payeeNameOnCheck,
    payeeAddress: opt(d.payeeAddress),
    printedMemo: opt(d.printedMemo),
    memo: opt(d.memo),
    amount: d.amount,
    printLater: d.printLater,
    tagIds: d.tagIds,
    lines: checkLines(d),
    txnDate,
  };
}

export function expenseInput(d: ExpenseTemplateDraft, txnDate: string) {
  return {
    txnDate,
    payFromAccountId: d.payFromAccountId,
    contactId: opt(d.contactId),
    memo: opt(d.memo),
    lines: d.lines.map((l) => ({
      expenseAccountId: l.expenseAccountId,
      amount: l.amount,
      description: opt(l.description),
      tagId: l.tagId ?? null,
      contactId: l.contactId ?? null,
      isBillable: l.isBillable === true,
    })),
  };
}

export function depositInput(d: DepositTemplateDraft, txnDate: string) {
  return {
    txnDate,
    depositToAccountId: d.depositToAccountId,
    memo: opt(d.memo),
    strictAmounts: true,
    lines: d.lines.map((l) => ({
      accountId: l.accountId,
      amount: l.amount,
      description: opt(l.description),
      tagId: l.tagId ?? null,
      contactId: l.contactId ?? null,
    })),
    cashBack: d.cashBack ? { accountId: d.cashBack.accountId, amount: d.cashBack.amount, memo: opt(d.cashBack.memo) } : null,
  };
}

export function transferInput(d: TransferTemplateDraft, txnDate: string) {
  return { txnDate, fromAccountId: d.fromAccountId, toAccountId: d.toAccountId, amount: d.amount, memo: opt(d.memo) };
}

export function journalEntryInput(d: JournalEntryTemplateDraft, txnDate: string) {
  return {
    txnDate,
    memo: opt(d.memo),
    basis: d.basis,
    ...(d.isAdjusting !== undefined ? { isAdjusting: d.isAdjusting } : {}),
    lines: d.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      description: opt(l.description),
      tagId: l.tagId ?? null,
      contactId: l.contactId ?? null,
      isTaxable: false,
      taxRate: '0',
      taxAmount: '0',
    })),
  };
}

// ── References ─────────────────────────────────────────────────────

export interface DraftRefs {
  accountIds: string[];
  contactIds: string[];
  tagIds: string[];
}

const uniq = (xs: Array<string | null | undefined>): string[] => [...new Set(xs.filter((x): x is string => !!x))];

/** Every account, contact and tag a draft names (daily-sales layout lines excluded). */
export function draftRefs(td: TemplateDraft): DraftRefs {
  switch (td.kind) {
    case 'check': {
      const d = td.draft;
      return {
        accountIds: uniq([d.bankAccountId, ...d.lines.map((l) => l.accountId)]),
        contactIds: uniq([d.contactId, ...d.lines.map((l) => l.contactId)]),
        tagIds: uniq([...d.tagIds, ...d.lines.map((l) => l.tagId)]),
      };
    }
    case 'expense': {
      const d = td.draft;
      return {
        accountIds: uniq([d.payFromAccountId, ...d.lines.map((l) => l.expenseAccountId)]),
        contactIds: uniq([d.contactId, ...d.lines.map((l) => l.contactId)]),
        tagIds: uniq([...d.tagIds, ...d.lines.map((l) => l.tagId)]),
      };
    }
    case 'deposit': {
      const d = td.draft;
      return {
        accountIds: uniq([d.depositToAccountId, d.cashBack?.accountId, ...d.lines.map((l) => l.accountId)]),
        contactIds: uniq(d.lines.map((l) => l.contactId)),
        tagIds: uniq(d.lines.map((l) => l.tagId)),
      };
    }
    case 'transfer':
      return { accountIds: uniq([td.draft.fromAccountId, td.draft.toAccountId]), contactIds: [], tagIds: [] };
    case 'journal_entry':
      return {
        accountIds: uniq(td.draft.lines.map((l) => l.accountId)),
        contactIds: uniq(td.draft.lines.map((l) => l.contactId)),
        tagIds: uniq(td.draft.lines.map((l) => l.tagId)),
      };
    case 'daily_sales':
      return { accountIds: [], contactIds: [], tagIds: uniq([td.draft.tagId, ...td.draft.values.map((v) => v.tagId)]) };
  }
}

/** Row in scope: this tenant (by query) and the company or tenant-wide. */
const inScope = (rowCompanyId: string | null, companyId: string | null) =>
  !companyId || rowCompanyId === null || rowCompanyId === companyId;

/**
 * The draft's references belong to this tenant and company (400
 * VALIDATION_ERROR otherwise, naming nothing of another company). Runs on
 * the write transaction.
 */
export async function assertDraftRefsInScope(
  tx: Tx, tenantId: string, companyId: string | null, td: TemplateDraft,
): Promise<void> {
  const refs = draftRefs(td);
  if (refs.accountIds.length > 0) {
    const rows = await tx.select({ id: accounts.id, companyId: accounts.companyId }).from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, refs.accountIds)));
    if (rows.length !== refs.accountIds.length || rows.some((r) => !inScope(r.companyId, companyId))) {
      throw validation('One or more accounts do not belong to this company');
    }
  }
  await assertContactsInScope(tx, tenantId, companyId, refs.contactIds, 'One or more names do not belong to this company');
  if (refs.tagIds.length > 0) {
    const rows = await tx.select({ id: tags.id, companyId: tags.companyId }).from(tags)
      .where(and(eq(tags.tenantId, tenantId), inArray(tags.id, refs.tagIds)));
    if (rows.length !== refs.tagIds.length || rows.some((r) => !inScope(r.companyId, companyId))) {
      throw validation('One or more tags do not belong to this company');
    }
  }
  if (td.kind === 'deposit') {
    await validateCashBackAccount(tx, tenantId, depositInput(td.draft, PLACEHOLDER_DATE));
  }
  if (td.kind === 'daily_sales') await assertDailySalesDraft(tx, tenantId, companyId, td.draft);
}

async function assertDailySalesDraft(tx: Tx, tenantId: string, companyId: string | null, d: DailySalesTemplateDraft) {
  const [layout] = await tx.select().from(dailySalesTemplates)
    .where(and(eq(dailySalesTemplates.tenantId, tenantId), eq(dailySalesTemplates.id, d.templateId))).limit(1);
  if (!layout || !inScope(layout.companyId, companyId)) throw validation('The daily-sales layout was not found in this company');
  const lines = await tx.select().from(dailySalesTemplateLines)
    .where(and(eq(dailySalesTemplateLines.tenantId, tenantId), eq(dailySalesTemplateLines.templateId, layout.id)));
  const byId = new Set(lines.map((l) => l.id));
  const unknown = d.values.find((v) => !byId.has(v.templateLineId));
  if (unknown) throw validation('A value names a line that is not on the daily-sales layout');
  const computed = computeEntry(lines, d.values.map((v) => ({ templateLineId: v.templateLineId, amount: v.amount, tagId: v.tagId ?? null })),
    d.tagId ?? null, layout.defaultTagId ?? null);
  if (computed.unmappedLabels.length > 0) {
    throw validation(`These daily-sales lines have no account yet: ${computed.unmappedLabels.join(', ')}`);
  }
}

// ── Storage rows ───────────────────────────────────────────────────

type HeaderRow = Pick<typeof templateTransactions.$inferInsert,
  'accountId' | 'toAccountId' | 'contactId' | 'amount' | 'memo' | 'payeeNameOnCheck' | 'payeeAddress' | 'printedMemo'
  | 'printLater' | 'basis' | 'isAdjusting' | 'cashBackAccountId' | 'cashBackAmount' | 'cashBackMemo' | 'dailySalesTemplateId'>;
type LineRow = Omit<typeof templateTransactionLines.$inferInsert, 'id' | 'tenantId' | 'companyId' | 'templateId'>;

export interface DraftRows { header: HeaderRow; lines: LineRow[]; tagIds: string[] }

const EMPTY_HEADER: HeaderRow = {
  accountId: null, toAccountId: null, contactId: null, amount: null, memo: null, payeeNameOnCheck: null,
  payeeAddress: null, printedMemo: null, printLater: null, basis: null, isAdjusting: null,
  cashBackAccountId: null, cashBackAmount: null, cashBackMemo: null, dailySalesTemplateId: null,
};

const fix4 = (v: string) => exactAmount(v, 'amount').toFixed(4);
const line0 = { debit: '0', credit: '0', isBillable: false, dailySalesLineId: null, contactId: null, tagId: null, description: null };

/** The columns a draft is stored in; every kind column is set (others NULL). */
export function draftToRows(td: TemplateDraft): DraftRows {
  switch (td.kind) {
    case 'check': {
      const d = td.draft;
      return {
        header: {
          ...EMPTY_HEADER, accountId: d.bankAccountId, contactId: d.contactId ?? null, amount: fix4(d.amount),
          memo: d.memo ?? null, payeeNameOnCheck: d.payeeNameOnCheck, payeeAddress: d.payeeAddress ?? null,
          printedMemo: d.printedMemo ?? null, printLater: d.printLater,
        },
        lines: d.lines.map((l, i) => ({
          ...line0, lineOrder: i, accountId: l.accountId, amount: fix4(l.amount), description: l.description ?? null,
          tagId: l.tagId ?? null, contactId: l.contactId ?? null, isBillable: l.isBillable === true,
        })),
        tagIds: [...new Set(d.tagIds)],
      };
    }
    case 'expense': {
      const d = td.draft;
      return {
        header: { ...EMPTY_HEADER, accountId: d.payFromAccountId, contactId: d.contactId ?? null, memo: d.memo ?? null },
        lines: d.lines.map((l, i) => ({
          ...line0, lineOrder: i, accountId: l.expenseAccountId, amount: fix4(l.amount), description: l.description ?? null,
          tagId: l.tagId ?? null, contactId: l.contactId ?? null, isBillable: l.isBillable === true,
        })),
        tagIds: [...new Set(d.tagIds)],
      };
    }
    case 'deposit': {
      const d = td.draft;
      return {
        header: {
          ...EMPTY_HEADER, accountId: d.depositToAccountId, memo: d.memo ?? null,
          cashBackAccountId: d.cashBack?.accountId ?? null,
          cashBackAmount: d.cashBack ? fix4(d.cashBack.amount) : null,
          cashBackMemo: d.cashBack?.memo ?? null,
        },
        lines: d.lines.map((l, i) => ({
          ...line0, lineOrder: i, accountId: l.accountId, amount: fix4(l.amount), description: l.description ?? null,
          tagId: l.tagId ?? null, contactId: l.contactId ?? null,
        })),
        tagIds: [],
      };
    }
    case 'transfer': {
      const d = td.draft;
      return {
        header: { ...EMPTY_HEADER, accountId: d.fromAccountId, toAccountId: d.toAccountId, amount: fix4(d.amount), memo: d.memo ?? null },
        lines: [],
        tagIds: [],
      };
    }
    case 'journal_entry': {
      const d = td.draft;
      return {
        header: { ...EMPTY_HEADER, memo: d.memo ?? null, basis: d.basis, isAdjusting: d.isAdjusting ?? null },
        lines: d.lines.map((l, i) => ({
          ...line0, lineOrder: i, accountId: l.accountId, debit: fix4(l.debit), credit: fix4(l.credit),
          description: l.description ?? null, tagId: l.tagId ?? null, contactId: l.contactId ?? null,
        })),
        tagIds: [],
      };
    }
    case 'daily_sales': {
      const d = td.draft;
      return {
        header: { ...EMPTY_HEADER, dailySalesTemplateId: d.templateId, memo: d.notes ?? null },
        lines: d.values.map((v, i) => ({
          ...line0, lineOrder: i, accountId: null, dailySalesLineId: v.templateLineId, amount: fix4(v.amount), tagId: v.tagId ?? null,
        })),
        tagIds: d.tagId ? [d.tagId] : [],
      };
    }
  }
}

type StoredHeader = typeof templateTransactions.$inferSelect;
type StoredLine = typeof templateTransactionLines.$inferSelect;

const s4 = (v: string | null | undefined) => new Decimal(v ?? '0').toFixed(4);
/** Optional key: present only when stored. */
const maybe = <K extends string, V>(key: K, v: V | null | undefined): Partial<Record<K, V>> =>
  (v === null || v === undefined ? {} : ({ [key]: v } as Record<K, V>));

/** The stored rows as a draft (the create body minus date and numbers). NULL for 'legacy'. */
export function rowsToDraft(tpl: StoredHeader, lines: StoredLine[], tagIds: string[]): TemplateDraft | null {
  const ordered = [...lines].sort((a, b) => a.lineOrder - b.lineOrder);
  switch (tpl.kind) {
    case 'check':
      return {
        kind: 'check',
        draft: {
          bankAccountId: tpl.accountId!,
          ...maybe('contactId', tpl.contactId),
          payeeNameOnCheck: tpl.payeeNameOnCheck ?? '',
          ...maybe('payeeAddress', tpl.payeeAddress),
          ...maybe('printedMemo', tpl.printedMemo),
          ...maybe('memo', tpl.memo),
          amount: s4(tpl.amount),
          printLater: tpl.printLater === true,
          tagIds: [...tagIds].sort(),
          lines: ordered.map((l) => ({
            accountId: l.accountId!, amount: s4(l.amount), ...maybe('description', l.description),
            tagId: l.tagId ?? null, ...maybe('contactId', l.contactId), isBillable: l.isBillable,
          })),
        },
      };
    case 'expense':
      return {
        kind: 'expense',
        draft: {
          payFromAccountId: tpl.accountId!,
          ...maybe('contactId', tpl.contactId),
          ...maybe('memo', tpl.memo),
          tagIds: [...tagIds].sort(),
          lines: ordered.map((l) => ({
            expenseAccountId: l.accountId!, amount: s4(l.amount), ...maybe('description', l.description),
            tagId: l.tagId ?? null, ...maybe('contactId', l.contactId), isBillable: l.isBillable,
          })),
        },
      };
    case 'deposit':
      return {
        kind: 'deposit',
        draft: {
          depositToAccountId: tpl.accountId!,
          ...maybe('memo', tpl.memo),
          lines: ordered.map((l) => ({
            accountId: l.accountId!, amount: s4(l.amount), ...maybe('description', l.description),
            tagId: l.tagId ?? null, ...maybe('contactId', l.contactId),
          })),
          ...(tpl.cashBackAccountId
            ? { cashBack: { accountId: tpl.cashBackAccountId, amount: s4(tpl.cashBackAmount), ...maybe('memo', tpl.cashBackMemo) } }
            : {}),
        },
      };
    case 'transfer':
      return {
        kind: 'transfer',
        draft: { fromAccountId: tpl.accountId!, toAccountId: tpl.toAccountId!, amount: s4(tpl.amount), ...maybe('memo', tpl.memo) },
      };
    case 'journal_entry':
      return {
        kind: 'journal_entry',
        draft: {
          ...maybe('memo', tpl.memo),
          basis: (tpl.basis as 'cash' | 'accrual' | 'both' | null) ?? 'both',
          ...maybe('isAdjusting', tpl.isAdjusting),
          lines: ordered.map((l) => ({
            accountId: l.accountId!, debit: s4(l.debit), credit: s4(l.credit), ...maybe('description', l.description),
            tagId: l.tagId ?? null, ...maybe('contactId', l.contactId),
          })),
        },
      };
    case 'daily_sales':
      return {
        kind: 'daily_sales',
        draft: {
          templateId: tpl.dailySalesTemplateId!,
          ...maybe('tagId', tagIds[0]),
          ...maybe('notes', tpl.memo),
          values: ordered.map((l) => ({ templateLineId: l.dailySalesLineId!, amount: s4(l.amount), tagId: l.tagId ?? null })),
        },
      };
    default:
      return null;
  }
}

/** The header amount of a draft (4 dp string); NULL for daily sales. */
export function draftTotal(td: TemplateDraft): string | null {
  const sum = (xs: string[]) => xs.reduce((s, x) => s.plus(exactAmount(x, 'amount')), new Decimal(0));
  switch (td.kind) {
    case 'check': return exactAmount(td.draft.amount, 'amount').toFixed(4);
    case 'expense': return sum(td.draft.lines.map((l) => l.amount)).toFixed(4);
    case 'deposit': {
      const lines = sum(td.draft.lines.map((l) => l.amount));
      const cb = td.draft.cashBack ? exactAmount(td.draft.cashBack.amount, 'cashBack.amount') : new Decimal(0);
      return lines.minus(cb).toFixed(4);
    }
    case 'transfer': return exactAmount(td.draft.amount, 'amount').toFixed(4);
    case 'journal_entry': return sum(td.draft.lines.map((l) => l.debit)).toFixed(4);
    case 'daily_sales': return null;
  }
}

/** Header account and contact for the list (bank / pay-from / deposit-to / transfer-from). */
export function draftHeader(td: TemplateDraft | null): { accountId: string | null; contactId: string | null } {
  if (!td) return { accountId: null, contactId: null };
  switch (td.kind) {
    case 'check': return { accountId: td.draft.bankAccountId, contactId: td.draft.contactId ?? null };
    case 'expense': return { accountId: td.draft.payFromAccountId, contactId: td.draft.contactId ?? null };
    case 'deposit': return { accountId: td.draft.depositToAccountId, contactId: null };
    case 'transfer': return { accountId: td.draft.fromAccountId, contactId: null };
    default: return { accountId: null, contactId: null };
  }
}

/** Which inactive or missing references a draft names (GET …/draft warnings). */
export async function draftWarnings(
  exec: DbOrTx, tenantId: string, companyId: string | null, td: TemplateDraft,
): Promise<Array<{ field: string; code: 'ACCOUNT_INACTIVE' | 'CONTACT_INACTIVE' | 'TAG_INACTIVE' | 'NOT_FOUND'; id: string }>> {
  const refs = draftRefs(td);
  const out: Array<{ field: string; code: 'ACCOUNT_INACTIVE' | 'CONTACT_INACTIVE' | 'TAG_INACTIVE' | 'NOT_FOUND'; id: string }> = [];
  const check = async (
    field: 'account' | 'contact' | 'tag', ids: string[],
    rows: Array<{ id: string; companyId: string | null; isActive: boolean | null }>,
    inactiveCode: 'ACCOUNT_INACTIVE' | 'CONTACT_INACTIVE' | 'TAG_INACTIVE',
  ) => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const r = byId.get(id);
      if (!r || !inScope(r.companyId, companyId)) out.push({ field, code: 'NOT_FOUND', id });
      else if (r.isActive === false) out.push({ field, code: inactiveCode, id });
    }
  };
  if (refs.accountIds.length) {
    await check('account', refs.accountIds, await exec.select({ id: accounts.id, companyId: accounts.companyId, isActive: accounts.isActive })
      .from(accounts).where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, refs.accountIds))), 'ACCOUNT_INACTIVE');
  }
  if (refs.contactIds.length) {
    await check('contact', refs.contactIds, await exec.select({ id: contacts.id, companyId: contacts.companyId, isActive: contacts.isActive })
      .from(contacts).where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, refs.contactIds))), 'CONTACT_INACTIVE');
  }
  if (refs.tagIds.length) {
    await check('tag', refs.tagIds, await exec.select({ id: tags.id, companyId: tags.companyId, isActive: tags.isActive })
      .from(tags).where(and(eq(tags.tenantId, tenantId), inArray(tags.id, refs.tagIds))), 'TAG_INACTIVE');
  }
  return out;
}

/** Drops references that are missing or out of scope from a draft (GET …/draft). */
export function withoutMissing(td: TemplateDraft, missing: Set<string>): unknown {
  const drop = (id: string | null | undefined) => (id && missing.has(id) ? null : id ?? null);
  const draft = JSON.parse(JSON.stringify(td.draft)) as Record<string, unknown>;
  const walk = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(walk).filter((x) => x !== undefined);
    if (!isRecord(o)) return o;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'tagIds' && Array.isArray(v)) out[k] = v.filter((t) => typeof t === 'string' && !missing.has(t));
      else if (/(Id)$/.test(k) && typeof v === 'string') out[k] = drop(v);
      else out[k] = walk(v);
    }
    return out;
  };
  return walk(draft);
}
