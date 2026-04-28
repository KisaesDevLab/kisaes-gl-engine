// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { FindingDraft } from '@kis-books/shared';

// All handlers share this signature per plan §D3. Pure data
// readers — no writes; the orchestrator owns the dedupe and
// persistence step.
export type CheckHandler = (
  tenantId: string,
  companyId: string | null,
  params: Record<string, unknown>,
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
};
