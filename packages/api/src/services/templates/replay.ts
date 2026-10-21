// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Posting a template draft on a date (U-62 "Enter", U-63 run-due). The
 * draft goes to its kind's own create service on the caller's transaction
 * (outerTx), so a replayed posting is exactly what a live create of the
 * same draft on the same date posts: same builders, same scope checks, the
 * same closing-date rule, check numbers allocated on the transaction.
 * Expense header tags (E3: the expense create body has none) are added on
 * the same transaction.
 */

import { and, eq } from 'drizzle-orm';
import type { TemplateDraft, CreateJournalEntryInput } from '@kis-books/shared';
import type { Tx } from '../../db/index.js';
import { transactionTags } from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import * as checkService from '../check.service.js';
import * as expenseService from '../expense.service.js';
import * as depositService from '../deposit.service.js';
import * as transferService from '../transfer.service.js';
import * as journalEntryService from '../journal-entry.service.js';
import { checkInput, depositInput, expenseInput, journalEntryInput, transferInput } from './draft.js';

export interface Replayed {
  id: string;
  txnType: string;
}

export function autoUnsupported(): AppError {
  return new AppError(400,
    'Daily sales amounts differ every day, so a daily-sales template can only remind you; open it in the form instead.',
    'TEMPLATE_AUTO_UNSUPPORTED');
}

export async function replayDraft(
  tx: Tx, tenantId: string, companyId: string | null, userId: string | undefined, td: TemplateDraft, date: string,
): Promise<Replayed> {
  const company = companyId ?? undefined;
  switch (td.kind) {
    case 'check': {
      const t = await checkService.createCheck(tenantId, checkInput(td.draft, date), userId, company, tx);
      return { id: t.id, txnType: t.txnType };
    }
    case 'expense': {
      const t = await expenseService.createExpense(tenantId, expenseInput(td.draft, date), userId, company, tx);
      for (const tagId of [...new Set(td.draft.tagIds)]) {
        await tx.insert(transactionTags).values({ transactionId: t.id, tagId, tenantId, companyId }).onConflictDoNothing();
      }
      return { id: t.id, txnType: t.txnType };
    }
    case 'deposit': {
      const r = await depositService.createDepositWithWarnings(tenantId, depositInput(td.draft, date), userId, company, tx);
      return { id: r.transaction.id, txnType: r.transaction.txnType };
    }
    case 'transfer': {
      const t = await transferService.createTransfer(tenantId, transferInput(td.draft, date), userId, company, tx);
      return { id: t.id, txnType: t.txnType };
    }
    case 'journal_entry': {
      const input = journalEntryInput(td.draft, date) as CreateJournalEntryInput;
      const t = await journalEntryService.createJournalEntry(tenantId, input, userId, company, tx);
      return { id: t.id, txnType: t.txnType };
    }
    case 'daily_sales':
      throw autoUnsupported();
  }
}

/** The transaction's header tags (for the equivalence tests). */
export async function headerTagIds(tx: Tx, tenantId: string, txnId: string): Promise<string[]> {
  const rows = await tx.select({ tagId: transactionTags.tagId }).from(transactionTags)
    .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, txnId)));
  return [...new Set(rows.map((r) => r.tagId))].sort();
}
