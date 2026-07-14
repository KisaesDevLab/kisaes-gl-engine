// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { FindingDraft } from '@kis-books/shared';

// Params a handler receives: the resolved registry/override params
// (arbitrary keys) plus the optional close-period window the
// orchestrator injects for the current run. Period bounds are ISO
// date/timestamp strings; periodEnd is exclusive
// (first-of-next-month) per ClosePeriodSelector. Both null/absent =
// all-time. Handlers that flag transactions by txn_date bound their
// query to [periodStart, periodEnd) when present; period-agnostic
// (current-state) handlers simply ignore them.
export interface CheckParams {
  [key: string]: unknown;
  periodStart?: string | null;
  periodEnd?: string | null;
}

// All handlers share this signature per plan §D3. Pure data
// readers — no writes; the orchestrator owns the dedupe and
// persistence step.
export type CheckHandler = (
  tenantId: string,
  companyId: string | null,
  params: CheckParams,
) => Promise<FindingDraft[]>;

import { handler as parentAccountPosting } from './parent-account-posting.js';
import { handler as missingAttachmentAboveThreshold } from './missing-attachment-above-threshold.js';
import { handler as uncategorizedStale } from './uncategorized-stale.js';
import { handler as autoPostedByRuleSampling } from './auto-posted-by-rule-sampling.js';
import { handler as tagInconsistencyVsHistory } from './tag-inconsistency-vs-history.js';
import { handler as transactionAboveMateriality } from './transaction-above-materiality.js';
import { handler as duplicateCandidate } from './duplicate-candidate.js';
import { handler as roundDollarAboveThreshold } from './round-dollar-above-threshold.js';
import { handler as weekendHolidayPosting } from './weekend-holiday-posting.js';
import { handler as negativeNonLiability } from './negative-non-liability.js';
import { handler as closedPeriodPosting } from './closed-period-posting.js';
import { handler as vendor1099ThresholdNoW9 } from './vendor-1099-threshold-no-w9.js';
import { handler as missingRequiredCustomer } from './missing-required-customer.js';
import { handler as receiptAmountMismatch } from './receipt-amount-mismatch.js';
import { handler as aiPersonalExpenseReview } from './ai-personal-expense-review.js';
import { handler as plaidConnectionHealth } from './plaid-connection-health.js';
import { handler as expenseWithoutPayee } from './expense-without-payee.js';
import { handler as accountInconsistencyVsHistory } from './account-inconsistency-vs-history.js';
import { handler as journalEntryWithoutAttachment } from './journal-entry-without-attachment.js';
import { handler as newEntitiesReview } from './new-entities-review.js';
import { handler as postedIntoReconciledRange } from './posted-into-reconciled-range.js';
import { handler as fluxVariance } from './flux-variance.js';
import { handler as duplicateEntityNames } from './duplicate-entity-names.js';

// Map check_registry.handler_name → handler function. The
// orchestrator iterates registry entries and looks each up
// here. Handlers not in this map are skipped with a log warning.
export const HANDLERS: Record<string, CheckHandler> = {
  parent_account_posting: parentAccountPosting,
  missing_attachment_above_threshold: missingAttachmentAboveThreshold,
  uncategorized_stale: uncategorizedStale,
  auto_posted_by_rule_sampling: autoPostedByRuleSampling,
  tag_inconsistency_vs_history: tagInconsistencyVsHistory,
  transaction_above_materiality: transactionAboveMateriality,
  duplicate_candidate: duplicateCandidate,
  round_dollar_above_threshold: roundDollarAboveThreshold,
  weekend_holiday_posting: weekendHolidayPosting,
  negative_non_liability: negativeNonLiability,
  closed_period_posting: closedPeriodPosting,
  vendor_1099_threshold_no_w9: vendor1099ThresholdNoW9,
  missing_required_customer: missingRequiredCustomer,
  receipt_amount_mismatch: receiptAmountMismatch,
  ai_personal_expense_review: aiPersonalExpenseReview,
  plaid_connection_health: plaidConnectionHealth,
  expense_without_payee: expenseWithoutPayee,
  account_inconsistency_vs_history: accountInconsistencyVsHistory,
  journal_entry_without_attachment: journalEntryWithoutAttachment,
  new_entities_review: newEntitiesReview,
  posted_into_reconciled_range: postedIntoReconciledRange,
  flux_variance: fluxVariance,
  duplicate_entity_names: duplicateEntityNames,
};
