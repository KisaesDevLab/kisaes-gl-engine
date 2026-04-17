// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and } from 'drizzle-orm';
import { isDebitNormal } from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as accountsService from './accounts.service.js';
import * as contactsService from './contacts.service.js';
import * as ledger from './ledger.service.js';

export async function importOpeningBalances(tenantId: string, balances: Array<{ accountName?: string; accountNumber?: string; accountId?: string; balance: string }>, companyId?: string) {
  // Resolve account names/numbers to IDs
  const allAccounts = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId));

  const resolvedLines: Array<{ accountId: string; debit: string; credit: string; description: string }> = [];
  let totalDebits = 0;
  let totalCredits = 0;

  for (const entry of balances) {
    let account;
    if (entry.accountId) {
      account = allAccounts.find((a) => a.id === entry.accountId);
    } else if (entry.accountNumber) {
      account = allAccounts.find((a) => a.accountNumber === entry.accountNumber);
    } else if (entry.accountName) {
      account = allAccounts.find((a) => a.name.toLowerCase() === entry.accountName!.toLowerCase());
    }

    if (!account) {
      throw AppError.badRequest(`Account not found: ${entry.accountName || entry.accountNumber || entry.accountId}`);
    }

    const amount = parseFloat(entry.balance);
    if (amount === 0) continue;

    const debitNormal = isDebitNormal(account.accountType);

    if ((debitNormal && amount > 0) || (!debitNormal && amount < 0)) {
      resolvedLines.push({ accountId: account.id, debit: Math.abs(amount).toFixed(4), credit: '0', description: `Opening balance - ${account.name}` });
      totalDebits += Math.abs(amount);
    } else {
      resolvedLines.push({ accountId: account.id, debit: '0', credit: Math.abs(amount).toFixed(4), description: `Opening balance - ${account.name}` });
      totalCredits += Math.abs(amount);
    }
  }

  // Add Opening Balances equity account to balance
  const openingBalancesAccount = allAccounts.find((a) => a.systemTag === 'opening_balances');
  if (!openingBalancesAccount) throw AppError.internal('Opening Balances equity account not found');

  const difference = totalDebits - totalCredits;
  if (Math.abs(difference) > 0.01) {
    if (difference > 0) {
      resolvedLines.push({ accountId: openingBalancesAccount.id, debit: '0', credit: difference.toFixed(4), description: 'Opening balance offset' });
    } else {
      resolvedLines.push({ accountId: openingBalancesAccount.id, debit: Math.abs(difference).toFixed(4), credit: '0', description: 'Opening balance offset' });
    }
  }

  // Post as a journal entry
  const txn = await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry',
    txnDate: new Date().toISOString().split('T')[0]!,
    memo: 'Opening balances import',
    lines: resolvedLines,
  }, undefined, companyId);

  return { transactionId: txn.id, linesCreated: resolvedLines.length };
}

export async function parseOpeningBalancesCsv(csvText: string): Promise<Array<{ accountName: string; accountNumber: string; balance: string }>> {
  const lines = csvText.split('\n').filter((l) => l.trim());
  if (lines.length < 2) throw AppError.badRequest('CSV must have a header row and at least one data row');

  const results: Array<{ accountName: string; accountNumber: string; balance: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    if (cols.length < 2) continue;

    results.push({
      accountNumber: cols[0] || '',
      accountName: cols[1] || '',
      balance: (cols[2] || '0').replace(/[$,]/g, ''),
    });
  }

  return results;
}
