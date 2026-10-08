// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Standalone check-register payroll import (import_mode 'check_register').
// A check register (e.g. Payroll Relief's Checks.csv) is one row per
// check/EFT with only the amount paid — no gross/net split — so each row
// posts as a check (an expense paid by check/ACH): DR the offset account (a clearing account, or the
// liability/expense the file names), CR the bank account. Both sides come
// either from the file's own account-number columns or from one account
// chosen for the whole import.

import { eq, and } from 'drizzle-orm';
import type {
  PayrollCheckAccountCode,
  PayrollCheckRegisterSummary,
  PostCheckRegisterInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { payrollImportSessions, payrollCheckRegisterRows, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import * as importService from './payroll-import.service.js';
import { getChecks, parseAndStoreChecks } from './payroll-modeb.service.js';
import { stampPayrollHeaderTags } from './payroll-je.service.js';
import { assertTagsInTenant } from './tags.service.js';

type AccountRef = { id: string; name: string; accountNumber: string | null; isActive: boolean | null };

async function loadAccounts(tenantId: string): Promise<AccountRef[]> {
  return db.select({
    id: accounts.id,
    name: accounts.name,
    accountNumber: accounts.accountNumber,
    isActive: accounts.isActive,
  }).from(accounts).where(eq(accounts.tenantId, tenantId));
}

/** Account-number → account, active accounts only. */
function indexByNumber(accts: AccountRef[]): Map<string, AccountRef> {
  const map = new Map<string, AccountRef>();
  for (const a of accts) {
    if (a.accountNumber && a.isActive !== false) map.set(a.accountNumber.trim(), a);
  }
  return map;
}

function summarizeCodes(
  codes: Array<string | null | undefined>,
  byNumber: Map<string, AccountRef>,
): PayrollCheckAccountCode[] {
  const counts = new Map<string, number>();
  for (const c of codes) {
    const code = (c ?? '').trim();
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, checkCount]) => {
      const acct = code ? byNumber.get(code) : undefined;
      return { code, accountId: acct?.id ?? null, accountName: acct?.name ?? null, checkCount };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Store the uploaded checks file's rows and remember how many $0 (voided)
 *  rows were dropped, for the review screen. */
export async function storeCheckRegisterFile(tenantId: string, sessionId: string, buffer: Buffer, filename: string) {
  const session = await importService.getSession(tenantId, sessionId);
  const { stored, skippedZero } = await parseAndStoreChecks(tenantId, sessionId, buffer, filename);
  await db.update(payrollImportSessions)
    .set({
      status: 'validated',
      metadata: { ...((session.metadata as Record<string, unknown>) ?? {}), skippedZeroChecks: skippedZero },
      updatedAt: new Date(),
    })
    .where(and(eq(payrollImportSessions.tenantId, tenantId), eq(payrollImportSessions.id, sessionId)));
  return { stored, skippedZero };
}

export async function getCheckRegister(tenantId: string, sessionId: string): Promise<PayrollCheckRegisterSummary> {
  const session = await importService.getSession(tenantId, sessionId);
  if (session.importMode !== 'check_register') throw AppError.badRequest('This import is not a check register');
  const checks = await getChecks(tenantId, sessionId);
  const byNumber = indexByNumber(await loadAccounts(tenantId));
  return {
    checks,
    cashCodes: summarizeCodes(checks.map(c => c.cashAccountCode), byNumber),
    offsetCodes: summarizeCodes(checks.map(c => c.offsetAccountCode), byNumber),
    skippedZeroCount: Number((session.metadata as Record<string, unknown> | null)?.['skippedZeroChecks'] ?? 0),
  };
}

export async function postCheckRegister(
  tenantId: string,
  sessionId: string,
  input: PostCheckRegisterInput,
  userId: string,
  companyId?: string,
) {
  const session = await importService.getSession(tenantId, sessionId);
  if (session.importMode !== 'check_register') throw AppError.badRequest('This import is not a check register');
  if (session.status === 'posted') throw AppError.badRequest('Session already posted');
  await importService.checkDuplicateFileHash(tenantId, session);

  const accts = await loadAccounts(tenantId);
  const byId = new Map(accts.map(a => [a.id, a]));
  const byNumber = indexByNumber(accts);
  for (const id of [input.cashAccountId, input.offsetAccountId]) {
    if (id && !byId.has(id)) throw AppError.notFound('Account not found');
  }
  const tagId = input.tagId ?? null;
  if (tagId) await assertTagsInTenant(tenantId, [tagId]);

  const checks = (await db.select().from(payrollCheckRegisterRows)
    .where(eq(payrollCheckRegisterRows.sessionId, sessionId))
    .orderBy(payrollCheckRegisterRows.rowNumber))
    .filter(c => !c.posted);
  if (checks.length === 0) throw AppError.badRequest('There are no checks to post in this file');

  // Resolve both sides of every check up front so a single unknown account
  // number refuses the whole import instead of posting half of it.
  const missing = new Set<string>();
  const resolve = (source: 'file' | 'account', chosenId: string | undefined, code: string | null, side: string) => {
    if (source === 'account') return chosenId!;
    const acct = code ? byNumber.get(code.trim()) : undefined;
    if (!acct) missing.add(code ? `${side} account ${code}` : `a check with no ${side} account`);
    return acct?.id ?? '';
  };
  const plan = checks.map(c => ({
    check: c,
    cashAccountId: resolve(input.cashSource, input.cashAccountId, c.cashAccountCode, 'cash'),
    offsetAccountId: resolve(input.offsetSource, input.offsetAccountId, c.offsetAccountCode, 'offset'),
  }));
  if (missing.size > 0) {
    throw AppError.badRequest(
      `No active account in the chart of accounts for: ${[...missing].join(', ')}. ` +
      'Add the account, or choose one account for that side instead of using the file.',
    );
  }
  if (plan.some(p => p.cashAccountId === p.offsetAccountId)) {
    throw AppError.badRequest('A check cannot post to the same account it is paid from');
  }

  const postedIds: string[] = [];
  await db.transaction(async (tx) => {
    for (const { check, cashAccountId, offsetAccountId } of plan) {
      const amount = Number(check.amount);
      const abs = Math.abs(amount).toFixed(2);
      // A negative row is a returned/voided payment: money back into the bank.
      const outflow = amount > 0;
      const txn = await ledger.postTransaction(tenantId, {
        // A written check is an expense paid by check (what Write Check
        // posts); there is no separate 'check' transaction type.
        txnType: outflow ? 'expense' : 'journal_entry',
        total: outflow ? abs : undefined,
        paymentMethod: outflow ? (/^\d+$/.test(check.checkNumber ?? '') ? 'check' : 'ach') : undefined,
        txnDate: check.checkDate,
        memo: `Payroll: ${check.payeeName}${check.memo ? ` — ${check.memo}` : ''}`,
        referenceNumber: check.checkNumber || undefined,
        source: 'payroll_import',
        sourceId: sessionId,
        lines: [
          {
            accountId: offsetAccountId,
            debit: outflow ? abs : '0',
            credit: outflow ? '0' : abs,
            description: check.payeeName,
            tagId,
          },
          {
            accountId: cashAccountId,
            debit: outflow ? '0' : abs,
            credit: outflow ? abs : '0',
            description: check.payeeName,
            tagId,
          },
        ],
      }, userId, companyId, tx);

      await tx.update(payrollCheckRegisterRows)
        .set({ posted: true, transactionId: txn.id })
        .where(eq(payrollCheckRegisterRows.id, check.id));
      postedIds.push(txn.id);
    }
  });

  for (const id of postedIds) {
    await stampPayrollHeaderTags(tenantId, companyId, id, [tagId]);
  }

  await db.update(payrollImportSessions)
    .set({ status: 'posted', jeCount: postedIds.length, updatedAt: new Date() })
    .where(and(eq(payrollImportSessions.tenantId, tenantId), eq(payrollImportSessions.id, sessionId)));

  await auditLog(tenantId, 'create', 'payroll_check_post', sessionId, null, {
    mode: 'check_register',
    posted: postedIds.length,
    cashSource: input.cashSource,
    offsetSource: input.offsetSource,
    cashAccountId: input.cashAccountId ?? null,
    offsetAccountId: input.offsetAccountId ?? null,
    tagId,
  }, userId);

  return { posted: postedIds.length, transactionIds: postedIds };
}
