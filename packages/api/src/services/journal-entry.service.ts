import type { CreateJournalEntryInput } from '@kis-books/shared';
import * as ledger from './ledger.service.js';

function buildJournalEntryPayload(input: CreateJournalEntryInput) {
  return {
    txnType: 'journal_entry' as const,
    txnDate: input.txnDate,
    memo: input.memo,
    lines: input.lines,
  };
}

export async function createJournalEntry(tenantId: string, input: CreateJournalEntryInput, userId?: string) {
  return ledger.postTransaction(tenantId, buildJournalEntryPayload(input), userId);
}

export async function updateJournalEntry(tenantId: string, txnId: string, input: CreateJournalEntryInput, userId?: string) {
  return ledger.updateTransaction(tenantId, txnId, buildJournalEntryPayload(input), userId);
}
