// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { eq, and, sql, lte, gte, between, count, or, ne, type SQL } from 'drizzle-orm';
// Report arithmetic runs at 60 significant digits (ReportDecimal): a
// cash-basis allocation carries many places, and the default 20 digits
// would round a sum of them (U-14).
import { ReportDecimal as Decimal } from './report-exact.js';
import {
  type PLSectionLabels,
  type BSSectionLabels,
  type CFSectionLabels,
  isDebitNormal as isDebitNormalShared,
  COST_TYPES,
  formatDetailTypeLabel,
  type AccountType,
  type ReconProof,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { transactions, journalLines, accounts, contacts } from '../db/schema/index.js';
import {
  getPLLabels,
  getBSLabels,
  getCFLabels,
  getReportFooter,
} from './tenant-report-settings.service.js';
import { loadGapDismissals, missingMonthsBetween } from './bank-statements.service.js';
import { buildReconciliationProof, type ReconciliationProofOptions } from './reconciliation-proof.service.js';
import { getCustomDetailTypeRanks, orderDetailTypeGroups } from './detail-types.service.js';
import { getLeadsheetMap, groupByLeadsheet } from './report-leadsheets.js';
import {
  applyAccountTree, dec, dsum, exactStr, legacyNum, type AccountTreeNode, type MoneyIn,
} from './report-exact.js';
import {
  ACCRUAL_COLS, CASH_COLS, lensIsEmpty, lensSql, loadGroupTags, type LineLens,
} from './report-lens.js';

// Money parsers. Reports expose `number` to the UI, but every SUM /
// DIFFERENCE runs through Decimal so aggregating hundreds of rows
// doesn't drift a P&L total or balance-sheet line by a few cents.
// Treat these helpers like `parseFloat` with exact arithmetic.
function num(x: string | number | null | undefined): number {
  return Number(new Decimal(x || 0).toFixed(4));
}
function sub(a: string | number | null | undefined, b: string | number | null | undefined): number {
  return Number(new Decimal(a || 0).minus(b || 0).toFixed(4));
}

type Basis = 'accrual' | 'cash';

// ADR 0XX §5.5 — multi-select tag filter. A report `tagId` is a comma-
// separated list of tag UUIDs (a single id is a list of one); tagIn()
// renders the parenthesized value list for `tag_id IN (...)` clauses.
// Callers guard on truthiness before building the clause, and the route
// layer (readTagFilter) has already dropped malformed entries, so the
// list is never empty here.
export function tagIn(tagId: string) {
  const ids = tagId.split(',').map((s) => s.trim()).filter(Boolean);
  return sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
}

// Report-title basis suffix — QBO-style "Accrual Basis" / "Cash Basis" so an
// exported statement states the basis it was run on (shown in the export
// header + filename). Appended to the P&L / Balance Sheet report titles.
export function basisTitleSuffix(basis: string): string {
  return ` - ${basis === 'cash' ? 'Cash Basis' : 'Accrual Basis'}`;
}

interface DateRange { startDate?: string; endDate?: string }

/**
 * Adjusting-entry lens (U-60, je-adjusting-v1): 'include' (default) keeps
 * every entry, 'exclude' leaves out transactions with is_adjusting (manual
 * adjusting journal entries and the TB module's AJEs), 'only' keeps just
 * them. Honored by the Profit and Loss, Balance Sheet (including its
 * retained-earnings and net-income rows), Trial Balance, General Ledger,
 * Transaction List and Journal Entry Report, on both bases, and by
 * GET /transactions.
 */
export type AdjustingFilter = 'include' | 'exclude' | 'only';

/**
 * SQL conjunct for the adjusting lens over a transactions column.
 * `column` is a code-controlled constant ('is_adjusting', 't.is_adjusting',
 * 'pay.is_adjusting'), never user input.
 */
export function adjustingCond(adjusting: AdjustingFilter | null | undefined, column: string) {
  if (adjusting === 'exclude') return sql`${sql.raw(column)} = false`;
  if (adjusting === 'only') return sql`${sql.raw(column)} = true`;
  return sql`TRUE`;
}

// Helper: get posted txn filter
function postedFilter(tenantId: string) {
  return sql`jl.tenant_id = ${tenantId} AND jl.transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted')`;
}

function dateFilter(startDate?: string, endDate?: string) {
  const parts = [];
  if (startDate) parts.push(sql`t.txn_date >= ${startDate}`);
  if (endDate) parts.push(sql`t.txn_date <= ${endDate}`);
  return parts.length > 0 ? sql.join(parts, sql` AND `) : sql`TRUE`;
}

function companyFilter(companyId: string | null, alias: string = 't') {
  if (!companyId) return sql`TRUE`;
  if (alias === 'jl') return sql`jl.company_id = ${companyId}`;
  return sql`t.company_id = ${companyId}`;
}

// Exported so report-comparison can build fiscal-aware year columns
// from the same source of truth.
export async function getFiscalYearStart(tenantId: string, companyId: string | null): Promise<number> {
  if (companyId) {
    const row = await db.execute(sql`SELECT fiscal_year_start_month FROM companies WHERE id = ${companyId}`);
    return (row.rows as any[])[0]?.fiscal_year_start_month ?? 1;
  }
  const row = await db.execute(sql`SELECT fiscal_year_start_month FROM companies WHERE tenant_id = ${tenantId} ORDER BY created_at LIMIT 1`);
  return (row.rows as any[])[0]?.fiscal_year_start_month ?? 1;
}

// ─── CASH-BASIS ENGINE ───────────────────────────────────────────
//
// True cash basis via a VIRTUAL LEDGER (QBO-style payment allocation).
// The old implementation filtered to "transactions that touched cash"
// and aggregated those transactions' own P&L legs — so invoice revenue
// collected through a separate payment (Dr cash / Cr AR, no revenue
// leg) never appeared, paid bills left AP with an abnormal balance on
// the cash BS, and the cash BS could unbalance.
//
// The virtual ledger rewrites the posted journal per these rules; every
// group below is internally balanced, so any report built from it
// balances by construction:
//
//   1. AR/AP DOCUMENTS (invoice, bill, credit_memo, vendor_credit,
//      bad_debt_recovery) are excluded entirely — accrual-only constructs.
//   2. All other transactions pass through as-is (cash sales, direct
//      expenses, card charges, transfers, deposits, JEs …), EXCEPT that
//      a payment's AR leg (customer_payment) / AP leg (bill_payment) is
//      reduced to its UNAPPLIED remainder. The applied portion is
//      replaced by rule 3.
//      Pure cash for receipts (U-152, Q-SPF1, cash-basis-spf-v1): money
//      received and not applied to an invoice is income in the system
//      account "Unapplied receipts" until it is applied — a payment's
//      unapplied remainder, a payment-sourced refund or a bounce of it,
//      and every Customer Deposits line of a payment, bounce or refund
//      (held deposits, draws, deposit refunds). Only the account changes,
//      so each group still balances; a credit applied later (rule 2b)
//      takes it back out of Unapplied receipts on its apply date. Journal
//      entries on A/R keep A/R (P28 residue warning).
//      Write-offs never show on cash (Q-SPF3): a payment's write-off line
//      is reduced by the write-off it settled (less the SSUTA bad-debt
//      tax, which sits on Sales Tax Payable instead), its STP line by that
//      bad-debt tax, and a bounce's matching credits likewise.
//   3. For each payment APPLICATION (payment → document, amount), the
//      paid document's non-AR/AP lines are emitted at the PAYMENT's
//      date, scaled by amount / document total. A $1,000 invoice
//      (Cr revenue 900 / Cr tax 100) paid $500 in December recognizes
//      Cr revenue 450 + Cr tax 50 in December. The amount is the cash
//      plus the early-payment discount (c + D), never the write-off
//      (Q-SPF3); the A/R reduction of rule 2 uses c + D + W. The costing
//      walk's derived lines (COGS and inventory relief, Q-PR4a) scale by
//      the settled amount c + D + W instead.
//   3c/3d. Inventory on settlement (Q-PR4a, amends Q-SPF5): a credit memo
//      applied to an invoice recognises the invoice's and the memo's
//      derived lines on the application date, scaled by the applied
//      amount; a $0 invoice or credit memo recognises them in full at its
//      own date. So COGS and the stock relieved follow every settlement
//      (cash, write-off, applied credit, $0) in proportion.
//
// AR applications come from payment_applications plus the legacy
// single-invoice link (transactions.applied_to_invoice_id, used by
// invoice.recordPayment and Stripe). AP applications come from
// bill_payment_applications: the cash plus the early-payment discount
// per bill (Q-SPF7), so A/P clears and the expense nets to the cash paid
// once the discount income line passes through — vendor-credit-settled
// portions are correctly never recognized (no cash moved). A vendor refund of
// a vendor credit (a deposit's A/P line linked to the credit, U-54) is cash
// back for those expenses: rule 3b (AP) books the credit's lines at the
// refund date and drops the A/P line, as rule 3b (AR) does for credit memos.

// The costing walk's derived line roles (inventory-costing.service.ts
// DERIVED_LINE_ROLES): COGS and the stock it takes off, recognised on cash
// basis as the invoice or credit memo is settled by any means (Q-PR4a).
const CASH_DERIVED_ROLES = sql.raw(`'cogs', 'inventory_relief', 'cost_correction', 'cost_residual'`);

/**
 * The live A/R settlements of posted invoices (U-132 to U-134, U-152), one
 * row per settlement: `amount` settles A/R (c + D + W), `cash_amount` is
 * what cash basis recognises (c + D), `write_off` / `write_off_account_id`
 * the write-off part. Effective date: `COALESCE(rec_date, payment date)`.
 * Shared by the cash virtual ledger and the cash sales tax report so the
 * GL and the report move on the same dates (Q-P23y).
 */
export function arAppsCte(tenantId: string) {
  return sql`
    ar_apps AS (
      -- U-132: rows an unapply or edit set aside (voided_at) are out; a
      -- void payment's rows drop out with it (pay.status). A row a bounce
      -- reversed stays on its payment and is mirrored as a negative row on
      -- the returned_payment, so revenue reverses at the bounce date and
      -- closed periods don't move.
      -- U-133 / U-134: a row settles cash + discount + write-off. A credit
      -- applied later (applied_date) is recognised on that date, stamped on
      -- the payment it was applied inside (else its own payment), and
      -- moves A/R by a virtual line of its own (rule 2b) instead of
      -- reducing its payment's A/R leg.
      -- U-146 B2: every branch keeps only rows of a posted invoice, as
      -- rule 3 and the open items do: an invoice voided after its payment
      -- bounced must not clear the payment's or the bounce's A/R leg.
      SELECT pa.payment_id, pa.invoice_id,
        (pa.amount + pa.discount_amount + pa.write_off_amount)::numeric AS amount,
        (pa.amount + pa.discount_amount)::numeric AS cash_amount,
        pa.write_off_amount::numeric AS write_off, pa.write_off_account_id,
        NULL::date AS rec_date, 'own' AS kind, pa.id AS app_id, pa.created_at AS app_created
      FROM payment_applications pa
      WHERE pa.tenant_id = ${tenantId} AND pa.voided_at IS NULL AND pa.applied_date IS NULL
        AND NOT EXISTS (SELECT 1 FROM transactions cm WHERE cm.id = pa.payment_id AND cm.tenant_id = pa.tenant_id AND cm.txn_type = 'credit_memo')
        AND EXISTS (SELECT 1 FROM transactions iv WHERE iv.id = pa.invoice_id AND iv.tenant_id = pa.tenant_id AND iv.status = 'posted')
      UNION ALL
      SELECT COALESCE(pa.applied_in_txn_id, pa.payment_id), pa.invoice_id, pa.amount::numeric, pa.amount::numeric,
        0::numeric, NULL::uuid, pa.applied_date, 'credit', pa.id, pa.created_at
      FROM payment_applications pa
      WHERE pa.tenant_id = ${tenantId} AND pa.voided_at IS NULL AND pa.applied_date IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM transactions cm WHERE cm.id = pa.payment_id AND cm.tenant_id = pa.tenant_id AND cm.txn_type = 'credit_memo')
        AND EXISTS (SELECT 1 FROM transactions iv WHERE iv.id = pa.invoice_id AND iv.tenant_id = pa.tenant_id AND iv.status = 'posted')
      UNION ALL
      SELECT pa.reversed_by_txn_id, pa.invoice_id,
        -(pa.amount + pa.discount_amount + pa.write_off_amount)::numeric,
        -(pa.amount + pa.discount_amount)::numeric,
        -pa.write_off_amount::numeric, pa.write_off_account_id, NULL::date, 'mirror', pa.id,
        COALESCE((SELECT rp.created_at FROM transactions rp WHERE rp.id = pa.reversed_by_txn_id), pa.created_at)
      FROM payment_applications pa
      WHERE pa.tenant_id = ${tenantId} AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM transactions cm WHERE cm.id = pa.payment_id AND cm.tenant_id = pa.tenant_id AND cm.txn_type = 'credit_memo')
        AND EXISTS (SELECT 1 FROM transactions iv WHERE iv.id = pa.invoice_id AND iv.tenant_id = pa.tenant_id AND iv.status = 'posted')
      UNION ALL
      SELECT tp.id, tp.applied_to_invoice_id, tp.total::numeric, tp.total::numeric, 0::numeric, NULL::uuid,
        NULL::date, 'own', tp.id, tp.created_at
      FROM transactions tp
      WHERE tp.tenant_id = ${tenantId} AND tp.txn_type = 'customer_payment'
        AND tp.applied_to_invoice_id IS NOT NULL AND tp.total IS NOT NULL
        AND EXISTS (SELECT 1 FROM transactions iv WHERE iv.id = tp.applied_to_invoice_id AND iv.tenant_id = tp.tenant_id AND iv.status = 'posted')
        AND NOT EXISTS (
          SELECT 1 FROM payment_applications pa2
          WHERE pa2.tenant_id = ${tenantId} AND pa2.payment_id = tp.id
        )
    )`;
}

/**
 * U-209 (ClientLedger P28 QA-6): a document's lines pro-rated over one
 * settlement, to the cent. `src` yields one row per (settlement, document
 * line) with the virtual-line columns plus:
 *   alloc_key   one settlement of one document (the footing group, with grp)
 *   grp         true for the costing walk's derived lines, which scale by
 *               their own factor and net to zero on their own
 *   is_tax      a Sales Tax Payable line (never takes the rounding plug)
 *   net         the line's debit - credit; side_debit: which column it uses
 *   p_k, p_prev the document's running settled amount through this
 *               settlement and before it (all live settlements, report
 *               filters aside, so a period and the year agree)
 *   doc_total   the document total the lines are scaled against
 *   src_line_id the document line (ordering only)
 *
 * Each line gets round(net * p_k / T, 2) - round(net * p_prev / T, 2), the
 * rule the cash sales tax report uses (Q-P23e), so a fully settled document
 * gives every line back exactly. The cents the lines of one settlement then
 * miss against round(N * p_k / T, 2) - round(N * p_prev / T, 2) (N the
 * group's net: the settled amount itself when the lines net to the total)
 * go to the group's largest non-tax line. Over all settlements those plugs
 * sum to zero, so the plug line also comes back exactly.
 */
/**
 * U-209 (ClientLedger P28 QA-4): the number a report row shows for its
 * transaction: a check's check number (checks, and bill payments or
 * expenses paid by check, keep it in check_number), else the document
 * number. Same precedence as the Check Register and Deposit Detail.
 */
export function docNumberSql(alias: string) {
  return sql.raw(`COALESCE(${alias}.check_number::text, ${alias}.txn_number)`);
}

function centAllocated(src: SQL) {
  return sql`
    SELECT a.account_id, a.tag_id, a.transaction_id, a.txn_date, a.txn_type, a.txn_number, a.memo,
      a.txn_contact_id, a.line_contact_id, a.description, a.item_id, a.line_order,
      CASE WHEN a.side_debit THEN a.amt ELSE 0::numeric END AS debit,
      CASE WHEN a.side_debit THEN 0::numeric ELSE -a.amt END AS credit,
      NULL::uuid AS line_id
    FROM (
      SELECT s.*, s.x + CASE WHEN s.plug_rank = 1 THEN s.target - SUM(s.x) OVER (PARTITION BY s.alloc_key, s.grp) ELSE 0::numeric END AS amt
      FROM (
        SELECT s0.*,
          round(s0.net * s0.p_k / s0.doc_total, 2) - round(s0.net * s0.p_prev / s0.doc_total, 2) AS x,
          -- Whole cents when the document and its settlements are; an
          -- amount stored with sub-cent places keeps them (the journal's 4)
          -- on the plug line, so the virtual transaction still balances.
          round(SUM(s0.net) OVER g * s0.p_k / s0.doc_total, s0.sc) - round(SUM(s0.net) OVER g * s0.p_prev / s0.doc_total, s0.sc) AS target,
          row_number() OVER (PARTITION BY s0.alloc_key, s0.grp
            ORDER BY s0.is_tax, abs(s0.net) DESC, s0.line_order, s0.src_line_id) AS plug_rank
        FROM (
          SELECT s1.*,
            CASE WHEN SUM(s1.net) OVER (PARTITION BY s1.alloc_key, s1.grp) % 0.01 = 0 AND s1.p_k % 0.01 = 0
                   AND s1.p_prev % 0.01 = 0 AND s1.doc_total % 0.01 = 0 THEN 2 ELSE 4 END AS sc
          FROM (${src}) s1
        ) s0
        WINDOW g AS (PARTITION BY s0.alloc_key, s0.grp)
      ) s
    ) a`;
}

// Exported for the TB module's five-column workpaper engine
// (services/tb/balance-engine.service.ts), which must compute cash-basis
// columns on the SAME virtual ledger as every other report (D12) —
// re-implementing these rules there would guarantee drift.
export function cashBasisLinesWith(
  tenantId: string,
  startDate: string | null,
  endDate: string,
  companyId: string | null,
  // U-60: the adjusting lens, applied to the transaction a virtual line is
  // recognized on (a payment is never an adjusting entry).
  adjusting: AdjustingFilter | null = null,
) {
  const dateCondT = startDate
    ? sql`t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}`
    : sql`t.txn_date <= ${endDate}`;
  const dateCondPay = startDate
    ? sql`pay.txn_date >= ${startDate} AND pay.txn_date <= ${endDate}`
    : sql`pay.txn_date <= ${endDate}`;
  // U-133: a credit applied after its payment is recognised on the day it was applied.
  const dateCondApp = startDate
    ? sql`COALESCE(app.rec_date, pay.txn_date) >= ${startDate} AND COALESCE(app.rec_date, pay.txn_date) <= ${endDate}`
    : sql`COALESCE(app.rec_date, pay.txn_date) <= ${endDate}`;
  const companyT = companyId ? sql`t.company_id = ${companyId}` : sql`TRUE`;
  const companyPay = companyId ? sql`pay.company_id = ${companyId}` : sql`TRUE`;

  return sql`
    cb_ur AS (
      -- U-152: the Unapplied receipts account (one per tenant, like every
      -- system role). NULL (a tenant 0253 could not reach) keeps the old
      -- A/R and Customer Deposits lines.
      SELECT (SELECT a.id FROM accounts a WHERE a.tenant_id = ${tenantId} AND a.system_tag = 'unapplied_receipts'
              ORDER BY a.created_at, a.id LIMIT 1) AS id
    ),
    ${arAppsCte(tenantId)},
    cb_wo AS (
      -- Q-SPF3: the write-off each payment (or the bounce mirroring it)
      -- settled, per write-off account.
      SELECT payment_id AS txn_id, write_off_account_id AS account_id, SUM(ABS(write_off)) AS amount
      FROM ar_apps WHERE kind IN ('own', 'mirror') AND write_off <> 0 AND write_off_account_id IS NOT NULL
      GROUP BY payment_id, write_off_account_id
    ),
    cb_bd AS (
      -- U-153 (SSUTA): the bad-debt tax a payment (or its bounce) moved to
      -- Sales Tax Payable instead of the write-off account.
      SELECT transaction_id AS txn_id, ABS(SUM(tax)) AS tax
      FROM transaction_tax_lines WHERE tenant_id = ${tenantId} AND kind = 'bad_debt'
      GROUP BY transaction_id
    ),
    -- U-209: running settled amounts per document, over every live
    -- settlement (report date, company and adjusting filters aside), for
    -- the cent allocation (centAllocated). Orders match the cash sales tax
    -- report's, so Sales Tax Payable here ties to it.
    cb_ar_run AS (
      SELECT app.*,
        SUM(app.cash_amount) OVER w AS cash_k, SUM(app.cash_amount) OVER w - app.cash_amount AS cash_prev,
        SUM(app.amount) OVER w AS set_k, SUM(app.amount) OVER w - app.amount AS set_prev
      FROM ar_apps app
      JOIN transactions pay ON pay.id = app.payment_id AND pay.tenant_id = ${tenantId} AND pay.status = 'posted'
      WHERE COALESCE(app.rec_date, pay.txn_date) <= ${endDate}
      WINDOW w AS (PARTITION BY app.invoice_id ORDER BY COALESCE(app.rec_date, pay.txn_date), app.app_created, app.kind, app.app_id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ),
    cb_mr_run AS (
      SELECT pay.id AS refund_id,
        SUM(pay.total::numeric) OVER w AS p_k, SUM(pay.total::numeric) OVER w - pay.total::numeric AS p_prev
      FROM transactions pay
      JOIN transactions m ON m.id = pay.source_payment_id AND m.tenant_id = pay.tenant_id AND m.txn_type = 'credit_memo' AND m.status = 'posted'
      WHERE pay.tenant_id = ${tenantId} AND pay.txn_type = 'customer_refund' AND pay.status = 'posted'
        AND pay.basis <> 'accrual' AND pay.txn_date <= ${endDate}
      WINDOW w AS (PARTITION BY pay.source_payment_id ORDER BY pay.txn_date, pay.created_at, pay.id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ),
    cb_vr_run AS (
      SELECT rl.id AS refund_line_id,
        SUM(rl.credit::numeric - rl.debit::numeric) OVER w AS p_k,
        SUM(rl.credit::numeric - rl.debit::numeric) OVER w - (rl.credit::numeric - rl.debit::numeric) AS p_prev
      FROM journal_lines rl
      JOIN accounts ra ON ra.id = rl.account_id AND ra.tenant_id = ${tenantId} AND ra.detail_type = 'accounts_payable'
      JOIN transactions dep ON dep.id = rl.transaction_id AND dep.tenant_id = ${tenantId} AND dep.status = 'posted'
        AND dep.basis <> 'accrual' AND dep.txn_date <= ${endDate}
      JOIN transactions vc ON vc.id = rl.source_transaction_id AND vc.tenant_id = ${tenantId}
        AND vc.txn_type = 'vendor_credit' AND vc.status = 'posted'
      WHERE rl.tenant_id = ${tenantId} AND rl.is_void_reversal = false
      WINDOW w AS (PARTITION BY rl.source_transaction_id ORDER BY dep.txn_date, dep.created_at, rl.id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ),
    cb_cm_run AS (
      SELECT pa.id AS pa_id,
        SUM(pa.amount::numeric) OVER wi AS inv_k, SUM(pa.amount::numeric) OVER wi - pa.amount::numeric AS inv_prev,
        SUM(pa.amount::numeric) OVER wm AS cm_k, SUM(pa.amount::numeric) OVER wm - pa.amount::numeric AS cm_prev
      FROM payment_applications pa
      JOIN transactions cm ON cm.id = pa.payment_id AND cm.tenant_id = ${tenantId}
        AND cm.txn_type = 'credit_memo' AND cm.status = 'posted' AND cm.basis <> 'accrual'
      JOIN transactions inv ON inv.id = pa.invoice_id AND inv.tenant_id = ${tenantId} AND inv.status = 'posted'
      WHERE pa.tenant_id = ${tenantId} AND pa.voided_at IS NULL
        AND COALESCE(pa.applied_date, cm.txn_date) <= ${endDate}
      WINDOW wi AS (PARTITION BY pa.invoice_id ORDER BY COALESCE(pa.applied_date, cm.txn_date), pa.created_at, pa.id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
             wm AS (PARTITION BY pa.payment_id ORDER BY COALESCE(pa.applied_date, cm.txn_date), pa.created_at, pa.id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ),
    cb_ap_run AS (
      SELECT app.id AS app_id,
        SUM(app.amount::numeric + app.discount_amount::numeric) OVER w AS p_k,
        SUM(app.amount::numeric + app.discount_amount::numeric) OVER w - (app.amount::numeric + app.discount_amount::numeric) AS p_prev
      FROM bill_payment_applications app
      JOIN transactions pay ON pay.id = app.payment_id AND pay.tenant_id = ${tenantId} AND pay.status = 'posted'
      WHERE app.tenant_id = ${tenantId} AND pay.txn_date <= ${endDate}
      WINDOW w AS (PARTITION BY app.bill_id ORDER BY pay.txn_date, app.created_at, app.id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ),
    cb_r2 AS (
      SELECT jl.account_id, a.detail_type, a.system_tag, jl.tag_id,
        t.id AS transaction_id, t.txn_date, t.txn_type, ${docNumberSql('t')} AS txn_number, t.memo,
        t.contact_id AS txn_contact_id, jl.contact_id AS line_contact_id,
        jl.description, jl.item_id, jl.line_order,
        jl.debit::numeric AS debit, jl.credit::numeric AS credit, jl.id AS line_id,
        cmr.id AS refund_memo_id, vcr.id AS refund_credit_id, arp.applied AS ar_applied, bp.applied AS ap_applied,
        -- Q-SPF3: how much of this (payment or bounce) line is write-off
        -- (or its bad-debt tax) and leaves the cash ledger.
        CASE WHEN t.txn_type NOT IN ('customer_payment', 'returned_payment') THEN 0::numeric
             WHEN wo.account_id IS NOT NULL THEN GREATEST(wo.amount - COALESCE(bd.tax, 0), 0)
             WHEN a.system_tag = 'sales_tax_payable' THEN COALESCE(bd.tax, 0)
             ELSE 0::numeric END AS reduce_by,
        -- What earlier lines of the same transaction and account already
        -- gave up (the discount and write-off may share an account).
        COALESCE(SUM(CASE WHEN t.txn_type = 'returned_payment' THEN jl.credit ELSE jl.debit END::numeric)
          OVER (PARTITION BY t.id, jl.account_id ORDER BY jl.line_order, jl.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before_amount
      FROM transactions t
      JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.tenant_id = ${tenantId}
        AND jl.is_void_reversal = false
      JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${tenantId}
      LEFT JOIN (
        SELECT payment_id, SUM(amount) AS applied FROM ar_apps WHERE kind <> 'credit' GROUP BY payment_id
      ) arp ON arp.payment_id = t.id
      LEFT JOIN (
        -- Q-SPF7: a bill payment clears A/P by its cash plus its discount.
        SELECT payment_id, SUM(amount::numeric + discount_amount::numeric) AS applied
        FROM bill_payment_applications WHERE tenant_id = ${tenantId} GROUP BY payment_id
      ) bp ON bp.payment_id = t.id
      LEFT JOIN transactions cmr ON cmr.id = t.source_payment_id AND cmr.tenant_id = ${tenantId}
        AND cmr.txn_type = 'credit_memo' AND t.txn_type = 'customer_refund'
      -- Rule 3b (AP, U-152): an A/P line refunding a vendor credit (U-54).
      LEFT JOIN transactions vcr ON vcr.id = jl.source_transaction_id AND vcr.tenant_id = ${tenantId}
        AND vcr.txn_type = 'vendor_credit' AND a.detail_type = 'accounts_payable'
      LEFT JOIN cb_wo wo ON wo.txn_id = t.id AND wo.account_id = jl.account_id
      LEFT JOIN cb_bd bd ON bd.txn_id = t.id
      WHERE t.tenant_id = ${tenantId} AND t.status = 'posted'
        AND t.basis <> 'accrual'  -- basis: exclude accrual-only entries from cash-basis reports
        AND ${dateCondT} AND ${companyT} AND ${adjustingCond(adjusting, 't.is_adjusting')}
        AND t.txn_type NOT IN ('invoice', 'bill', 'credit_memo', 'vendor_credit', 'bad_debt_recovery')
    ),
    cb_lines AS MATERIALIZED (
      -- U-155: MATERIALIZED, so the virtual ledger is built once per query.
      -- Inlined, a nested-loop consumer (accounts LEFT JOIN cb_lines) re-ran
      -- every branch below once per account.
      -- Rule 2: pass-through, with payment AR/AP legs reduced to the
      -- unapplied remainder (on Unapplied receipts, U-152) and write-offs
      -- taken out (Q-SPF3).
      SELECT
        CASE WHEN ur.id IS NOT NULL AND (
               (r.system_tag = 'customer_deposits' AND r.txn_type IN ('customer_payment', 'returned_payment', 'customer_refund'))
               OR (r.detail_type = 'accounts_receivable' AND r.txn_type IN ('customer_payment', 'returned_payment'))
               OR (r.detail_type = 'accounts_receivable' AND r.txn_type = 'customer_refund' AND r.refund_memo_id IS NULL))
             THEN ur.id ELSE r.account_id END AS account_id,
        r.tag_id, r.transaction_id, r.txn_date, r.txn_type, r.txn_number, r.memo,
        r.txn_contact_id, r.line_contact_id, r.description, r.item_id, r.line_order,
        CASE WHEN r.refund_credit_id IS NOT NULL THEN 0::numeric
             WHEN r.txn_type = 'bill_payment' AND r.detail_type = 'accounts_payable'
             THEN GREATEST(r.debit - COALESCE(r.ap_applied, 0), 0)
             -- A bounce's A/R debit less what it took back (its mirror rows are negative).
             WHEN r.txn_type = 'returned_payment' AND r.detail_type = 'accounts_receivable'
             THEN GREATEST(r.debit + COALESCE(r.ar_applied, 0), 0)
             -- U-137 rule 3b: a refund of a credit memo's credit drops its A/R
             -- leg; rule 3b below books the memo's lines instead.
             WHEN r.txn_type = 'customer_refund' AND r.detail_type = 'accounts_receivable' AND r.refund_memo_id IS NOT NULL
             THEN 0::numeric
             WHEN r.txn_type = 'customer_payment'
             THEN r.debit - LEAST(r.debit, GREATEST(r.reduce_by - r.before_amount, 0))
             ELSE r.debit END AS debit,
        CASE WHEN r.refund_credit_id IS NOT NULL THEN 0::numeric
             WHEN r.txn_type = 'customer_payment' AND r.detail_type = 'accounts_receivable'
             THEN GREATEST(r.credit - COALESCE(r.ar_applied, 0), 0)
             WHEN r.txn_type = 'returned_payment'
             THEN r.credit - LEAST(r.credit, GREATEST(r.reduce_by - r.before_amount, 0))
             ELSE r.credit END AS credit,
        -- U-202: the journal line a pass-through line is (NULL on the scaled
        -- and virtual lines below), for the cleared lens and drill ids.
        r.line_id
      FROM cb_r2 r CROSS JOIN cb_ur ur

      UNION ALL

      -- Rule 3b (AR, U-137): a refund of a credit memo's credit is cash going
      -- out for those returns: the memo's non-A/R lines (income, sales tax)
      -- at the refund's date, scaled by refund / memo total. Credit memo
      -- applications are not cash and are left out of ar_apps (as vendor
      -- credits are on the AP side).
      ${centAllocated(sql`
      SELECT ml.account_id, ml.tag_id,
        pay.id AS transaction_id, pay.txn_date, pay.txn_type, ${docNumberSql('pay')} AS txn_number, pay.memo,
        pay.contact_id AS txn_contact_id, ml.contact_id AS line_contact_id,
        ml.description, ml.item_id, ml.line_order,
        ml.id AS src_line_id, 'mr:' || pay.id::text AS alloc_key,
        COALESCE(ml.line_role IN (${CASH_DERIVED_ROLES}), false) AS grp,
        COALESCE(ma.system_tag = 'sales_tax_payable', false) AS is_tax,
        ml.debit::numeric - ml.credit::numeric AS net, ml.debit::numeric >= ml.credit::numeric AS side_debit,
        run.p_k, run.p_prev, m.total::numeric AS doc_total
      FROM transactions pay
      JOIN cb_mr_run run ON run.refund_id = pay.id
      JOIN transactions m ON m.id = pay.source_payment_id AND m.tenant_id = ${tenantId}
        AND m.txn_type = 'credit_memo' AND m.status = 'posted' AND NULLIF(m.total::numeric, 0) IS NOT NULL
      JOIN journal_lines ml ON ml.transaction_id = m.id AND ml.tenant_id = ${tenantId}
        AND ml.is_void_reversal = false
      JOIN accounts ma ON ma.id = ml.account_id AND ma.tenant_id = ${tenantId}
      WHERE pay.tenant_id = ${tenantId} AND pay.txn_type = 'customer_refund' AND pay.status = 'posted'
        AND pay.basis <> 'accrual'
        AND ${dateCondPay} AND ${companyPay} AND ${adjustingCond(adjusting, 'pay.is_adjusting')}
        AND ma.detail_type IS DISTINCT FROM 'accounts_receivable'`)}

      UNION ALL

      -- Rule 3b (AP, U-152, Q-SPF7): a vendor refund of a vendor credit (a
      -- deposit line on A/P linked to the credit) is cash coming back for
      -- those expenses: the credit's non-A/P lines at the refund's date,
      -- scaled by the refunded amount / credit total; its A/P line is dropped
      -- in rule 2, so A/P carries no residue.
      ${centAllocated(sql`
      SELECT vl.account_id, vl.tag_id,
        dep.id AS transaction_id, dep.txn_date, dep.txn_type, ${docNumberSql('dep')} AS txn_number, dep.memo,
        dep.contact_id AS txn_contact_id, vl.contact_id AS line_contact_id, vl.description, vl.item_id, vl.line_order,
        vl.id AS src_line_id, 'vr:' || rl.id::text AS alloc_key,
        COALESCE(vl.line_role IN (${CASH_DERIVED_ROLES}), false) AS grp,
        COALESCE(va.system_tag = 'sales_tax_payable', false) AS is_tax,
        vl.debit::numeric - vl.credit::numeric AS net, vl.debit::numeric >= vl.credit::numeric AS side_debit,
        run.p_k, run.p_prev, vc.total::numeric AS doc_total
      FROM journal_lines rl
      JOIN cb_vr_run run ON run.refund_line_id = rl.id
      JOIN accounts ra ON ra.id = rl.account_id AND ra.tenant_id = ${tenantId} AND ra.detail_type = 'accounts_payable'
      JOIN transactions dep ON dep.id = rl.transaction_id AND dep.tenant_id = ${tenantId} AND dep.status = 'posted'
        AND dep.basis <> 'accrual' AND dep.txn_date >= ${startDate ?? '0001-01-01'} AND dep.txn_date <= ${endDate}
        AND ${companyId ? sql`dep.company_id = ${companyId}` : sql`TRUE`} AND ${adjustingCond(adjusting, 'dep.is_adjusting')}
      JOIN transactions vc ON vc.id = rl.source_transaction_id AND vc.tenant_id = ${tenantId}
        AND vc.txn_type = 'vendor_credit' AND vc.status = 'posted' AND NULLIF(vc.total::numeric, 0) IS NOT NULL
      JOIN journal_lines vl ON vl.transaction_id = vc.id AND vl.tenant_id = ${tenantId} AND vl.is_void_reversal = false
      JOIN accounts va ON va.id = vl.account_id AND va.tenant_id = ${tenantId}
      WHERE rl.tenant_id = ${tenantId} AND rl.is_void_reversal = false
        AND va.detail_type IS DISTINCT FROM 'accounts_payable'`)}

      UNION ALL

      -- Rule 2b (AR, U-133, U-152): a credit applied later takes its amount
      -- out of Unapplied receipts (A/R before U-152) on the day it is applied.
      SELECT COALESCE(ur.id, ara.id), NULL::uuid,
        pay.id, app.rec_date, pay.txn_type, ${docNumberSql('pay')} AS txn_number, pay.memo,
        pay.contact_id, pay.contact_id,
        NULL::text, NULL::uuid, 0,
        app.amount, 0::numeric, NULL::uuid
      FROM ar_apps app
      JOIN transactions pay ON pay.id = app.payment_id AND pay.tenant_id = ${tenantId}
        AND pay.status = 'posted' AND ${dateCondApp} AND ${companyPay} AND ${adjustingCond(adjusting, 'pay.is_adjusting')}
      JOIN LATERAL (
        SELECT a2.id FROM accounts a2 WHERE a2.tenant_id = ${tenantId} AND a2.system_tag = 'accounts_receivable' LIMIT 1
      ) ara ON TRUE
      CROSS JOIN cb_ur ur
      WHERE app.kind = 'credit'

      UNION ALL

      -- Rule 3 (AR): scaled invoice distributions at the payment date (a
      -- credit applied later: at its date), by cash + discount (Q-SPF3).
      -- Inventory (Q-PR4a, PR-4 S3): the derived costing lines (COGS and
      -- the stock they take off) follow the settled amount, cash + discount
      -- + write-off, so goods already gone never stay on the cash balance
      -- sheet. Each derived pair balances on its own.
      ${centAllocated(sql`
      SELECT il.account_id, il.tag_id,
        pay.id AS transaction_id, COALESCE(app.rec_date, pay.txn_date) AS txn_date, pay.txn_type, ${docNumberSql('pay')} AS txn_number, pay.memo,
        pay.contact_id AS txn_contact_id, il.contact_id AS line_contact_id,
        il.description, il.item_id, il.line_order,
        il.id AS src_line_id, app.kind || ':' || app.app_id::text AS alloc_key,
        COALESCE(il.line_role IN (${CASH_DERIVED_ROLES}), false) AS grp,
        COALESCE(ia.system_tag = 'sales_tax_payable', false) AS is_tax,
        il.debit::numeric - il.credit::numeric AS net, il.debit::numeric >= il.credit::numeric AS side_debit,
        CASE WHEN il.line_role IN (${CASH_DERIVED_ROLES}) THEN app.set_k ELSE app.cash_k END AS p_k,
        CASE WHEN il.line_role IN (${CASH_DERIVED_ROLES}) THEN app.set_prev ELSE app.cash_prev END AS p_prev,
        inv.total::numeric AS doc_total
      FROM cb_ar_run app
      JOIN transactions pay ON pay.id = app.payment_id AND pay.tenant_id = ${tenantId}
        AND pay.status = 'posted' AND ${dateCondApp} AND ${companyPay} AND ${adjustingCond(adjusting, 'pay.is_adjusting')}
      JOIN transactions inv ON inv.id = app.invoice_id AND inv.tenant_id = ${tenantId}
        AND inv.status = 'posted' AND NULLIF(inv.total::numeric, 0) IS NOT NULL
      JOIN journal_lines il ON il.transaction_id = inv.id AND il.tenant_id = ${tenantId}
        AND il.is_void_reversal = false
      JOIN accounts ia ON ia.id = il.account_id AND ia.tenant_id = ${tenantId}
      WHERE ia.detail_type IS DISTINCT FROM 'accounts_receivable'`)}

      UNION ALL

      -- Rule 3c (inventory on settlement, Q-PR4a, PR-4 S3): a credit memo
      -- applied to an invoice settles both. On the application's date (the
      -- memo's date when applied at save) the invoice's derived costing lines
      -- scaled by applied / invoice total, and the memo's (the returned
      -- units back in stock) scaled by applied / memo total. Income and tax
      -- of either document stay off cash (no cash moved).
      ${centAllocated(sql`
      SELECT dl.account_id, dl.tag_id,
        cm.id AS transaction_id, COALESCE(pa.applied_date, cm.txn_date) AS txn_date, cm.txn_type, ${docNumberSql('cm')} AS txn_number, cm.memo,
        cm.contact_id AS txn_contact_id, dl.contact_id AS line_contact_id,
        dl.description, dl.item_id, dl.line_order,
        dl.id AS src_line_id, 'cm:' || pa.id::text || ':' || doc.id::text AS alloc_key,
        true AS grp, false AS is_tax,
        dl.debit::numeric - dl.credit::numeric AS net, dl.debit::numeric >= dl.credit::numeric AS side_debit,
        CASE WHEN doc.id = inv.id THEN run.inv_k ELSE run.cm_k END AS p_k,
        CASE WHEN doc.id = inv.id THEN run.inv_prev ELSE run.cm_prev END AS p_prev,
        doc.total::numeric AS doc_total
      FROM payment_applications pa
      JOIN cb_cm_run run ON run.pa_id = pa.id
      JOIN transactions cm ON cm.id = pa.payment_id AND cm.tenant_id = ${tenantId}
        AND cm.txn_type = 'credit_memo' AND cm.status = 'posted' AND cm.basis <> 'accrual'
        AND ${companyId ? sql`cm.company_id = ${companyId}` : sql`TRUE`} AND ${adjustingCond(adjusting, 'cm.is_adjusting')}
      JOIN transactions inv ON inv.id = pa.invoice_id AND inv.tenant_id = ${tenantId} AND inv.status = 'posted'
      JOIN transactions doc ON doc.tenant_id = ${tenantId} AND doc.id IN (inv.id, cm.id) AND NULLIF(doc.total::numeric, 0) IS NOT NULL
      JOIN journal_lines dl ON dl.transaction_id = doc.id AND dl.tenant_id = ${tenantId}
        AND dl.is_void_reversal = false AND dl.line_role IN (${CASH_DERIVED_ROLES})
      WHERE pa.tenant_id = ${tenantId} AND pa.voided_at IS NULL
        AND COALESCE(pa.applied_date, cm.txn_date) >= ${startDate ?? '0001-01-01'} AND COALESCE(pa.applied_date, cm.txn_date) <= ${endDate}`)}

      UNION ALL

      -- Rule 3d (Q-PR4a): a $0 invoice or credit memo is settled when it is
      -- posted: its derived costing lines in full at its own date.
      SELECT zl.account_id, zl.tag_id,
        t.id AS transaction_id, t.txn_date, t.txn_type, ${docNumberSql('t')} AS txn_number, t.memo,
        t.contact_id AS txn_contact_id, zl.contact_id AS line_contact_id,
        zl.description, zl.item_id, zl.line_order,
        zl.debit::numeric AS debit, zl.credit::numeric AS credit, zl.id AS line_id
      FROM transactions t
      JOIN journal_lines zl ON zl.transaction_id = t.id AND zl.tenant_id = ${tenantId}
        AND zl.is_void_reversal = false AND zl.line_role IN (${CASH_DERIVED_ROLES})
      WHERE t.tenant_id = ${tenantId} AND t.status = 'posted' AND t.basis <> 'accrual'
        AND t.txn_type IN ('invoice', 'credit_memo') AND COALESCE(t.total::numeric, 0) = 0
        AND ${dateCondT} AND ${companyT} AND ${adjustingCond(adjusting, 't.is_adjusting')}

      UNION ALL

      -- Rule 3 (AP): scaled bill distributions at the payment date, by cash
      -- plus the early-payment discount (Q-SPF7).
      ${centAllocated(sql`
      SELECT bl.account_id, bl.tag_id,
        pay.id AS transaction_id, pay.txn_date, pay.txn_type, ${docNumberSql('pay')} AS txn_number, pay.memo,
        pay.contact_id AS txn_contact_id, bl.contact_id AS line_contact_id,
        bl.description, bl.item_id, bl.line_order,
        bl.id AS src_line_id, 'bp:' || app.id::text AS alloc_key,
        COALESCE(bl.line_role IN (${CASH_DERIVED_ROLES}), false) AS grp,
        COALESCE(ba.system_tag = 'sales_tax_payable', false) AS is_tax,
        bl.debit::numeric - bl.credit::numeric AS net, bl.debit::numeric >= bl.credit::numeric AS side_debit,
        run.p_k, run.p_prev, bill.total::numeric AS doc_total
      FROM bill_payment_applications app
      JOIN cb_ap_run run ON run.app_id = app.id
      JOIN transactions pay ON pay.id = app.payment_id AND pay.tenant_id = ${tenantId}
        AND pay.status = 'posted' AND ${dateCondPay} AND ${companyPay} AND ${adjustingCond(adjusting, 'pay.is_adjusting')}
      JOIN transactions bill ON bill.id = app.bill_id AND bill.tenant_id = ${tenantId}
        AND bill.status = 'posted' AND NULLIF(bill.total::numeric, 0) IS NOT NULL
      JOIN journal_lines bl ON bl.transaction_id = bill.id AND bl.tenant_id = ${tenantId}
        AND bl.is_void_reversal = false
      JOIN accounts ba ON ba.id = bl.account_id AND ba.tenant_id = ${tenantId}
      WHERE app.tenant_id = ${tenantId}
        AND ba.detail_type IS DISTINCT FROM 'accounts_payable'`)}
    )`;
}

/**
 * Run a query built on `cashBasisLinesWith` (U-155). The virtual ledger
 * joins the tenant's transactions, lines and applications several times.
 * Without fresh statistics (a new company, or right after an import or a
 * restore, before autoanalyze runs) the planner estimates one row per
 * table and nests loops whose inner sides re-read every line of the tenant:
 * a few hundred transactions took minutes. Hash joins are linear whatever
 * the estimates, so nested loops are switched off for this one query
 * (set_config(..., true) is SET LOCAL: this transaction only). Results are
 * identical; only the plan changes.
 *
 * JIT is switched off with it: the few nested loops that stay (the CROSS
 * JOINs on cb_ur) carry the planner's disable cost, which lifts the plan
 * cost far above jit_above_cost, and on a server built with LLVM every
 * cash report then paid seconds of JIT compilation. Tenant-scoped reads of
 * payment_applications use idx_pa_tenant (migration 0257) instead of the
 * nested loop through idx_pa_invoice.
 */
export async function executeCashBasis(query: SQL) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('enable_nestloop', 'off', true), set_config('jit', 'off', true)`);
    return tx.execute(query);
  });
}

// Exact reports: the tenant's accounts with their parents, for the
// account tree on P&L / Balance Sheet / Trial Balance rows.
export async function loadAccountTree(tenantId: string): Promise<Map<string, AccountTreeNode>> {
  const res = await db.execute(sql`
    SELECT id, parent_id, name, account_number, account_type FROM accounts WHERE tenant_id = ${tenantId}
  `);
  const map = new Map<string, AccountTreeNode>();
  for (const r of res.rows as Array<Record<string, unknown>>) {
    map.set(String(r['id']), {
      id: String(r['id']),
      parentId: (r['parent_id'] as string | null) ?? null,
      name: String(r['name'] ?? ''),
      accountNumber: (r['account_number'] as string | null) ?? null,
      accountType: String(r['account_type'] ?? ''),
    });
  }
  return map;
}

// ─── FINANCIAL STATEMENTS ────────────────────────────────────────

export interface PLEntry {
  accountId: string;
  name: string;
  accountNumber: string | null;
  amount: number;
  // Present only when built with { exactAmounts: true }: the unrounded
  // numeric (decimal string) behind `amount` — for callers that must never
  // round-trip money through a JS number (Tax Estimator, R1 F15).
  amountExact?: string;
  // Present only when the report was built with groupBy: 'detail_type'.
  // Additive so the default response shape is unchanged for existing
  // consumers (PDF, comparative, portal blocks, MCP).
  detailType?: string | null;
  // Exact reports (accountTree): the account tree within the section.
  parentAccountId?: string | null;
  depth?: number;
  rollupExact?: string;
}

// One group per distinct detail type within a report section, produced
// when the caller asks for groupBy: 'detail_type'. `label` is the
// humanized detail type ('accounts_receivable' → 'Accounts Receivable');
// a null detail type groups under 'Other'.
export interface DetailTypeGroup<T> {
  detailType: string | null;
  // Set only on leadsheet groups (group_by=leadsheet); null for the
  // 'Not on a leadsheet' group.
  leadsheetCode?: string | null;
  label: string;
  entries: T[];
  subtotal: number;
  // Exact reports: the Decimal subtotal as a decimal string.
  subtotalExact?: string;
}

export type ReportGroupBy = 'detail_type' | 'leadsheet';

// Builds one section's groups for the active grouping mode. Detail type:
// humanized detail types in the tenant's presentation order. Leadsheet:
// the TB module's leadsheets in their sort order, unassigned accounts
// trailing (see report-leadsheets.ts).
type SectionGrouper = <T extends { accountId?: string | null; detailType?: string | null }>(
  entries: T[],
  amountOf: (e: T) => MoneyIn,
  accountType: AccountType,
) => Array<DetailTypeGroup<T>>;

export async function makeSectionGrouper(
  tenantId: string,
  companyId: string | null,
  groupBy: ReportGroupBy,
  // Exact reports: groups also carry subtotalExact.
  exact = false,
): Promise<SectionGrouper> {
  if (groupBy === 'leadsheet') {
    const map = await getLeadsheetMap(tenantId, companyId);
    return (entries, amountOf) => groupByLeadsheet(entries, map, (members, label, code) => {
      const d = dsum(members.map(amountOf));
      return {
        detailType: null,
        leadsheetCode: code,
        label,
        entries: members,
        subtotal: legacyNum(d),
        ...(exact ? { subtotalExact: exactStr(d) } : {}),
      };
    });
  }
  const ranks = await getCustomDetailTypeRanks(tenantId);
  return (entries, amountOf, accountType) => orderDetailTypeGroups(groupByDetailType(entries, amountOf, exact), ranks, accountType);
}

// Group a section's entries by their detailType, preserving the
// account-number ordering of the underlying entries (groups appear in
// order of first occurrence; a trailing null-detail group labels as
// 'Other'). Subtotals accumulate through Decimal like every other
// report aggregate.
function groupByDetailType<T extends { detailType?: string | null }>(
  entries: T[],
  amountOf: (e: T) => MoneyIn,
  exact = false,
): Array<DetailTypeGroup<T>> {
  const groups = new Map<string, DetailTypeGroup<T> & { subtotalDec: InstanceType<typeof Decimal> }>();
  for (const entry of entries) {
    const dt = entry.detailType ?? null;
    const key = dt ?? '__other__';
    let group = groups.get(key);
    if (!group) {
      group = {
        detailType: dt,
        label: formatDetailTypeLabel(dt),
        entries: [],
        subtotal: 0,
        subtotalDec: new Decimal(0),
      };
      groups.set(key, group);
    }
    group.entries.push(entry);
    group.subtotalDec = group.subtotalDec.plus(dec(amountOf(entry)));
  }
  return Array.from(groups.values()).map(({ subtotalDec, ...g }) => ({
    ...g,
    subtotal: legacyNum(subtotalDec),
    ...(exact ? { subtotalExact: exactStr(subtotalDec) } : {}),
  }));
}

export interface PLResult {
  title: string;
  startDate: string;
  endDate: string;
  basis: Basis;
  labels: PLSectionLabels;
  footer: string;
  revenue: PLEntry[];
  totalRevenue: number;
  cogs: PLEntry[];
  totalCogs: number;
  expenses: PLEntry[];
  totalExpenses: number;
  otherRevenue: PLEntry[];
  totalOtherRevenue: number;
  otherExpenses: PLEntry[];
  totalOtherExpenses: number;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number;
  // Present only when built with { exactAmounts: true } (U-14).
  totalRevenueExact?: string;
  totalCogsExact?: string;
  totalExpensesExact?: string;
  totalOtherRevenueExact?: string;
  totalOtherExpensesExact?: string;
  grossProfitExact?: string | null;
  operatingIncomeExact?: string | null;
  netIncomeExact?: string;
  // Additive fields — present only when built with groupBy: 'detail_type'.
  groupBy?: ReportGroupBy;
  groups?: {
    revenue: Array<DetailTypeGroup<PLEntry>>;
    cogs: Array<DetailTypeGroup<PLEntry>>;
    expenses: Array<DetailTypeGroup<PLEntry>>;
    otherRevenue: Array<DetailTypeGroup<PLEntry>>;
    otherExpenses: Array<DetailTypeGroup<PLEntry>>;
  };
}

export async function buildProfitAndLoss(
  tenantId: string,
  startDate: string,
  endDate: string,
  basis: Basis = 'accrual',
  companyId: string | null = null,
  // ADR 0XX §5.1 — line-level report: when tagId is provided, aggregate
  // only those journal_lines carrying that tag. Transactions appear only
  // to the extent their matching lines total nonzero.
  tagId: string | null = null,
  // Optional grouping mode (?group_by=detail_type). Adds detailType to
  // each entry plus per-section `groups` — additive only; the default
  // (ungrouped) response shape is untouched.
  groupBy: ReportGroupBy | null = null,
  // Additive: exactAmounts adds PLEntry.amountExact (decimal string);
  // adjusting is the U-60 lens (default include).
  // accountTree (exact reports): parentAccountId, depth and rollupExact on
  // account rows, with zero ancestors added so the tree is complete.
  plOpts: { exactAmounts?: boolean; accountTree?: boolean; adjusting?: AdjustingFilter | null } = {},
): Promise<PLResult> {
  const adjusting = plOpts.adjusting ?? null;
  // Cash basis: revenue recognized when cash is received, expenses when
  // cash is paid — implemented by the virtual cash-basis ledger (see
  // cashBasisLinesWith above), which allocates payment applications
  // across the paid document's distribution lines at the payment date.
  // Accrual: every posted txn in range, straight from journal_lines.
  const companyCond = companyId ? sql`company_id = ${companyId}` : sql`TRUE`;

  // Line-level tag filter (ADR 0XX §5.1): when present, restrict the
  // aggregated lines to those tagged with the given tag_id. Virtual
  // cash-basis lines inherit the source line's tag, so the same clause
  // applies to both bases.
  const tagJoinClause = tagId ? sql` AND jl.tag_id IN ${tagIn(tagId)}` : sql``;
  const grouped = groupBy !== null;

  const rows = basis === 'cash'
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, startDate, endDate, companyId, adjusting)}
        SELECT a.id, a.account_number, a.name, a.account_type, a.detail_type,
          COALESCE(SUM(jl.debit), 0) as total_debit,
          COALESCE(SUM(jl.credit), 0) as total_credit
        FROM accounts a
        LEFT JOIN cb_lines jl ON jl.account_id = a.id${tagJoinClause}
        WHERE a.tenant_id = ${tenantId}
          AND a.account_type IN ('revenue', 'cogs', 'expense', 'other_revenue', 'other_expense')
        GROUP BY a.id, a.account_number, a.name, a.account_type, a.detail_type
        ORDER BY a.account_number, a.name
      `)
    : await db.execute(sql`
        SELECT a.id, a.account_number, a.name, a.account_type, a.detail_type,
          COALESCE(SUM(jl.debit), 0) as total_debit,
          COALESCE(SUM(jl.credit), 0) as total_credit
        FROM accounts a
        LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
          AND jl.transaction_id IN (
            SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted'
            AND basis <> 'cash'  -- basis: exclude cash-only entries from accrual reports
            AND txn_date >= ${startDate} AND txn_date <= ${endDate}
            AND ${companyCond} AND ${adjustingCond(adjusting, 'is_adjusting')}
          )${tagJoinClause}
        WHERE a.tenant_id = ${tenantId}
          AND a.account_type IN ('revenue', 'cogs', 'expense', 'other_revenue', 'other_expense')
        GROUP BY a.id ORDER BY a.account_number, a.name
      `);

  const revenue: PLEntry[] = [];
  const cogs: PLEntry[] = [];
  const expenses: PLEntry[] = [];
  const otherRevenue: PLEntry[] = [];
  const otherExpenses: PLEntry[] = [];
  // Section totals accumulate in Decimal from the unrounded SQL sums
  // (U-14); the legacy number totals are derived from them.
  let revD = new Decimal(0);
  let cogsD = new Decimal(0);
  let expD = new Decimal(0);
  let otherRevD = new Decimal(0);
  let otherExpD = new Decimal(0);

  for (const row of rows.rows as any[]) {
    // SIGNED, normal-balance convention: income accounts report
    // credit − debit; cost accounts report debit − credit. An account
    // running an ABNORMAL balance (refund-heavy revenue account, an
    // expense account with net rebates) comes out negative and correctly
    // REDUCES its section. The previous per-account Math.abs() flipped
    // such balances positive, inflating net income — and since the BS/TB
    // retained-earnings rows are derived from this net income, the error
    // propagated into equity and broke A = L + E.
    const isIncome = row.account_type === 'revenue' || row.account_type === 'other_revenue';
    const exact = isIncome
      ? new Decimal(row.total_credit || 0).minus(row.total_debit || 0)
      : new Decimal(row.total_debit || 0).minus(row.total_credit || 0);
    const amount = legacyNum(exact);
    // Legacy responses keep the old rule (a row that rounds to 0 at 4
    // places is left out); exact responses drop only a true zero.
    if (exact.isZero() || (!plOpts.exactAmounts && amount === 0)) continue;
    const entry: PLEntry = {
      accountId: row.id,
      name: row.name,
      accountNumber: row.account_number,
      amount,
      ...(plOpts.exactAmounts ? { amountExact: exactStr(exact) } : {}),
      ...(grouped ? { detailType: (row.detail_type as string | null) ?? null } : {}),
    };
    switch (row.account_type) {
      case 'revenue': revenue.push(entry); revD = revD.plus(exact); break;
      case 'cogs': cogs.push(entry); cogsD = cogsD.plus(exact); break;
      case 'expense': expenses.push(entry); expD = expD.plus(exact); break;
      case 'other_revenue': otherRevenue.push(entry); otherRevD = otherRevD.plus(exact); break;
      case 'other_expense': otherExpenses.push(entry); otherExpD = otherExpD.plus(exact); break;
    }
  }

  const hasCogs = cogs.length > 0;
  const hasOther = otherRevenue.length > 0 || otherExpenses.length > 0;
  const grossD = hasCogs ? revD.minus(cogsD) : null;
  const opD = hasCogs || hasOther ? (grossD ?? revD).minus(expD) : null;
  const netD = revD.plus(otherRevD).minus(cogsD).minus(expD).minus(otherExpD);
  const totalRevenue = legacyNum(revD);
  const totalCogs = legacyNum(cogsD);
  const totalExpenses = legacyNum(expD);
  const totalOtherRevenue = legacyNum(otherRevD);
  const totalOtherExpenses = legacyNum(otherExpD);
  const grossProfit = grossD ? legacyNum(grossD) : null;
  const operatingIncome = opD ? legacyNum(opD) : null;
  const netIncome = legacyNum(netD);

  // Exact report (?exact=1): section totals as decimal strings and the
  // account tree on every section.
  const exactTotals = plOpts.exactAmounts
    ? {
        totalRevenueExact: exactStr(revD),
        totalCogsExact: exactStr(cogsD),
        totalExpensesExact: exactStr(expD),
        totalOtherRevenueExact: exactStr(otherRevD),
        totalOtherExpensesExact: exactStr(otherExpD),
        grossProfitExact: grossD ? exactStr(grossD) : null,
        operatingIncomeExact: opD ? exactStr(opD) : null,
        netIncomeExact: exactStr(netD),
      }
    : {};
  let sections = { revenue, cogs, expenses, otherRevenue, otherExpenses };
  if (plOpts.accountTree) {
    const tree = await loadAccountTree(tenantId);
    const t = (list: PLEntry[]) => applyAccountTree(list, tree, (e) => dec(e.amountExact ?? e.amount), (n) => ({
      accountId: n.id, name: n.name, accountNumber: n.accountNumber, amount: 0,
      ...(plOpts.exactAmounts ? { amountExact: exactStr(0) } : {}),
      ...(grouped ? { detailType: null } : {}),
    }));
    sections = {
      revenue: t(revenue), cogs: t(cogs), expenses: t(expenses),
      otherRevenue: t(otherRevenue), otherExpenses: t(otherExpenses),
    };
  }

  const [labels, footer] = await Promise.all([
    getPLLabels(tenantId),
    getReportFooter(tenantId),
  ]);

  return {
    title: 'Profit and Loss' + basisTitleSuffix(basis),
    startDate, endDate, basis,
    labels,
    footer,
    revenue: sections.revenue, totalRevenue,
    cogs: sections.cogs, totalCogs,
    expenses: sections.expenses, totalExpenses,
    otherRevenue: sections.otherRevenue, totalOtherRevenue,
    otherExpenses: sections.otherExpenses, totalOtherExpenses,
    grossProfit,
    operatingIncome,
    netIncome,
    ...exactTotals,
    ...(grouped
      ? await (async () => {
          // Detail types: stock groups keep first-occurrence order,
          // custom groups follow by tenant sort_order, null-detail
          // ('Other') trails. Leadsheets: TB sort order, unassigned last.
          const group = await makeSectionGrouper(tenantId, companyId, groupBy!, !!plOpts.exactAmounts);
          const amt = (e: PLEntry) => e.amountExact ?? e.amount;
          return {
            groupBy: groupBy!,
            groups: {
              revenue: group(revenue, amt, 'revenue'),
              cogs: group(cogs, amt, 'cogs'),
              expenses: group(expenses, amt, 'expense'),
              otherRevenue: group(otherRevenue, amt, 'other_revenue'),
              otherExpenses: group(otherExpenses, amt, 'other_expense'),
            },
          };
        })()
      : {}),
  };
}

export async function buildBalanceSheet(
  tenantId: string,
  asOfDate: string,
  basis: Basis = 'accrual',
  companyId: string | null = null,
  // ADR 0XX §5.1 — line-level tag filter. Applied to the activity join
  // so only journal lines carrying the tag contribute to balances. The
  // retained-earnings injection further down uses the same filter by
  // passing tagId to buildProfitAndLoss.
  tagId: string | null = null,
  // Optional grouping mode (?group_by=detail_type) — additive fields
  // only; see buildProfitAndLoss.
  groupBy: ReportGroupBy | null = null,
  // U-60 adjusting lens; also applied to the retained-earnings and
  // current-year net-income rows.
  // exactAmounts / accountTree: exact report fields (U-14), as on the P&L.
  // fiscalYearStart (U-213, report-fixes-v2): the start of the fiscal year
  // containing asOfDate, where income splits into prior years and the current
  // year (a retail 52-53 week year starts on its own day); default: the 1st
  // of the company's fiscal start month.
  bsOpts: { adjusting?: AdjustingFilter | null; exactAmounts?: boolean; accountTree?: boolean; fiscalYearStart?: string | null } = {},
) {
  const adjusting = bsOpts.adjusting ?? null;
  const tagClause = tagId ? sql` AND jl.tag_id IN ${tagIn(tagId)}` : sql``;
  const grouped = groupBy !== null;
  // Cash basis balance sheet: built from the virtual cash-basis ledger
  // (cashBasisLinesWith). AR/AP documents drop out entirely, payment
  // AR/AP legs are replaced by scaled document distributions, so:
  //   - AR/AP show zero except unapplied payment remainders (customer
  //     pre-payments), which is the honest cash-basis picture;
  //   - every virtual group is balanced, so A = L + E holds by
  //     construction (the old txn-set filter could unbalance the sheet
  //     because it kept the payment's AR leg but not the invoice).
  const companyCond = companyId ? sql`company_id = ${companyId}` : sql`TRUE`;

  const rows = basis === 'cash'
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, null, asOfDate, companyId, adjusting)}
        SELECT a.id, a.account_number, a.name, a.account_type, a.detail_type, a.system_tag,
          COALESCE(SUM(jl.debit), 0) as total_debit,
          COALESCE(SUM(jl.credit), 0) as total_credit
        FROM accounts a
        LEFT JOIN cb_lines jl ON jl.account_id = a.id${tagClause}
        WHERE a.tenant_id = ${tenantId} AND a.account_type IN ('asset', 'liability', 'equity')
        GROUP BY a.id, a.account_number, a.name, a.account_type, a.detail_type, a.system_tag
        ORDER BY a.account_number, a.name
      `)
    : await db.execute(sql`
        SELECT a.id, a.account_number, a.name, a.account_type, a.detail_type, a.system_tag,
          COALESCE(SUM(jl.debit), 0) as total_debit,
          COALESCE(SUM(jl.credit), 0) as total_credit
        FROM accounts a
        LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
          AND jl.transaction_id IN (
            SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted'
            AND basis <> 'cash'  -- basis: exclude cash-only entries from accrual reports
            AND txn_date <= ${asOfDate}
            AND ${companyCond} AND ${adjustingCond(adjusting, 'is_adjusting')}
          )${tagClause}
        WHERE a.tenant_id = ${tenantId} AND a.account_type IN ('asset', 'liability', 'equity')
        GROUP BY a.id ORDER BY a.account_number, a.name
      `);

  type BSEntry = {
    accountId: string | null; name: string; accountNumber: string | null; balance: number; detailType?: string | null;
    // Exact reports only (U-14).
    balanceExact?: string;
    // Exact reports only (U-213, report-fixes-v2): a computed row no ledger
    // line holds (no drill), and the Retained Earnings account when the
    // prior years' income is folded into it (its ledger lines hold only
    // priorYearsIncomeExact less than the balance).
    calculated?: true;
    includesPriorYearsIncome?: true;
    priorYearsIncomeExact?: string;
  };
  const exactMode = !!bsOpts.exactAmounts;
  // Balances accumulate in Decimal from the unrounded SQL sums (U-14); the
  // number fields are derived from them. balD keeps each entry's Decimal.
  const balD = new Map<BSEntry, InstanceType<typeof Decimal>>();
  const setBal = (e: BSEntry, d: InstanceType<typeof Decimal>) => {
    balD.set(e, d);
    e.balance = legacyNum(d);
    if (exactMode) e.balanceExact = exactStr(d);
  };
  const assets: BSEntry[] = [];
  const liabilities: BSEntry[] = [];
  const equity: BSEntry[] = [];
  // The computed rows (Retained Earnings (Prior Years), Net Income
  // (Current Year)) have no account/detail type; in grouped mode they
  // render under a dedicated 'Equity (Calculated)' group.
  const calculatedEquity: BSEntry[] = [];
  // The designated system Retained Earnings account (systemTag), captured so
  // the prior-years retained earnings folds into its single line below.
  let reEntry: BSEntry | null = null;
  let assetsD = new Decimal(0), liabD = new Decimal(0), equityD = new Decimal(0);

  for (const row of rows.rows as any[]) {
    // NOTE: the Retained Earnings system account is intentionally
    // INCLUDED here at its posted balance. The dynamic rows below add
    // income that hasn't been closed into it; if an operator posts a
    // textbook closing entry (Dr income / Cr Retained Earnings), the
    // income side nets out of the P&L-derived rows and the posted RE
    // balance carries it instead — the identity holds either way.
    // (Previously this row was skipped entirely, so any posting to RE
    // silently vanished from the BS while its counter-leg remained.)
    const rawD = new Decimal(row.total_debit || 0).minus(row.total_credit || 0);
    const isRetainedEarnings = row.system_tag === 'retained_earnings' && row.account_type === 'equity';
    // Keep the designated RE account even at a $0 posted balance so the
    // prior-years retained earnings can fold into its line below. Legacy
    // responses also drop a balance that rounds to 0 at 4 places.
    if ((rawD.isZero() || (!exactMode && legacyNum(rawD) === 0)) && !isRetainedEarnings) continue;
    const detail = grouped ? { detailType: (row.detail_type as string | null) ?? null } : {};
    if (row.account_type === 'asset') {
      const entry: BSEntry = { accountId: row.id, name: row.name, accountNumber: row.account_number, balance: 0, ...detail };
      setBal(entry, rawD);
      assets.push(entry);
      assetsD = assetsD.plus(rawD);
    } else {
      // SIGNED accumulation in natural (credit-positive) convention:
      // a normal liability/equity balance is positive; a contra balance
      // (overpaid credit card, Owner Withdraw draws) is negative and
      // correctly REDUCES the section. The previous Math.abs() added
      // contra balances as positives, unbalancing the sheet by twice
      // the contra amount. Customer Deposits (a liability) therefore
      // reads credit-positive here.
      const balance = rawD.negated();
      const entry: BSEntry = { accountId: row.id, name: row.name, accountNumber: row.account_number, balance: 0, ...detail };
      setBal(entry, balance);
      if (row.account_type === 'liability') { liabilities.push(entry); liabD = liabD.plus(balance); }
      else { equity.push(entry); equityD = equityD.plus(balance); if (isRetainedEarnings) reEntry = entry; }
    }
  }

  // Automatic year-end closing: split into Retained Earnings (prior years) + Current Year Net Income
  const fyStartMonth = await getFiscalYearStart(tenantId, companyId);

  // Compute current fiscal year start date. UTC getters so the
  // boundary is stable regardless of the container's local TZ — the
  // asOfDate string is a calendar day ('YYYY-MM-DD') that Postgres
  // stores TZ-naive, and we want the boundary computed against that
  // same calendar day.
  const asOf = new Date(asOfDate + 'T00:00:00Z');
  let currentFYStartYear = asOf.getUTCFullYear();
  if (asOf.getUTCMonth() + 1 < fyStartMonth) currentFYStartYear--;
  const currentFYStart = bsOpts.fiscalYearStart || `${currentFYStartYear}-${String(fyStartMonth).padStart(2, '0')}-01`;

  // Retained Earnings = net income for all completed fiscal years (before
  // current FY start). The P&L hands back its Decimal net income
  // (netIncomeExact) so the equity rows never round-trip through a float.
  const retainedPL = await buildProfitAndLoss(tenantId, '1900-01-01', (() => {
    const d = new Date(currentFYStart + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0]!;
  })(), basis, companyId, tagId, null, { adjusting, exactAmounts: true });
  const retainedD = dec(retainedPL.netIncomeExact);
  // Prior-years retained earnings. When a system Retained Earnings account is
  // designated (systemTag='retained_earnings'), FOLD the accumulated prior-year
  // net income into that account's line — one "Retained Earnings" line = posted
  // balance + prior-year net income (QBO-style). Otherwise keep the separate
  // calculated "Retained Earnings (Prior Years)" row so the sheet still balances.
  if (reEntry) {
    if (!retainedD.isZero()) {
      setBal(reEntry, balD.get(reEntry)!.plus(retainedD));
      equityD = equityD.plus(retainedD);
      if (exactMode) {
        reEntry.includesPriorYearsIncome = true;
        reEntry.priorYearsIncomeExact = exactStr(retainedD);
      }
    }
    // A fully-zero RE line (no posted balance and no prior income) is noise —
    // drop it, matching the $0 skip applied to every other account.
    if (balD.get(reEntry)!.isZero()) {
      const i = equity.indexOf(reEntry);
      if (i >= 0) equity.splice(i, 1);
    }
  } else if (!retainedD.isZero()) {
    const row: BSEntry = { accountId: null, name: 'Retained Earnings (Prior Years)', accountNumber: null, balance: 0, ...(exactMode ? { calculated: true as const } : {}) };
    setBal(row, retainedD);
    equity.push(row);
    calculatedEquity.push(row);
    equityD = equityD.plus(retainedD);
  }

  // Current year net income
  const currentPL = await buildProfitAndLoss(tenantId, currentFYStart, asOfDate, basis, companyId, tagId, null, { adjusting, exactAmounts: true });
  const currentD = dec(currentPL.netIncomeExact);
  if (!currentD.isZero()) {
    const row: BSEntry = { accountId: null, name: 'Net Income (Current Year)', accountNumber: null, balance: 0, ...(exactMode ? { calculated: true as const } : {}) };
    setBal(row, currentD);
    equity.push(row);
    calculatedEquity.push(row);
    equityD = equityD.plus(currentD);
  }
  const totalAssets = legacyNum(assetsD);
  const totalLiabilities = legacyNum(liabD);
  const totalEquity = legacyNum(equityD);
  const bsAmt = (e: BSEntry): MoneyIn => balD.get(e) ?? e.balance;
  let sections = { assets, liabilities, equity };
  if (bsOpts.accountTree) {
    const tree = await loadAccountTree(tenantId);
    const t = (list: BSEntry[]) => applyAccountTree(list, tree, (e) => dec(bsAmt(e)), (n) => {
      const z: BSEntry = { accountId: n.id, name: n.name, accountNumber: n.accountNumber, balance: 0, ...(grouped ? { detailType: null } : {}) };
      setBal(z, new Decimal(0));
      return z;
    });
    sections = { assets: t(assets), liabilities: t(liabilities), equity: t(equity) };
  }

  const [labels, footer] = await Promise.all([
    getBSLabels(tenantId),
    getReportFooter(tenantId),
  ]);

  return {
    title: 'Balance Sheet' + basisTitleSuffix(basis), asOfDate, basis,
    labels,
    footer,
    assets: sections.assets, totalAssets,
    liabilities: sections.liabilities, totalLiabilities,
    equity: sections.equity, totalEquity,
    totalLiabilitiesAndEquity: legacyNum(liabD.plus(equityD)),
    ...(exactMode
      ? {
          totalAssetsExact: exactStr(assetsD),
          totalLiabilitiesExact: exactStr(liabD),
          totalEquityExact: exactStr(equityD),
          totalLiabilitiesAndEquityExact: exactStr(liabD.plus(equityD)),
          // U-213 (report-fixes-v2): the year split used, and the part of
          // total equity no ledger line holds (prior years' and current-year
          // income); the equity total drills to its accounts' lines only
          // when this is zero.
          fiscalYearStart: currentFYStart,
          calculatedEquityExact: exactStr(retainedD.plus(currentD)),
        }
      : {}),
    ...(grouped
      ? await (async () => {
          // Same custom detail-type presentation ordering as the P&L —
          // stock first-occurrence, custom by sort_order, null trailing
          // (which keeps 'Equity (Calculated)' last).
          const group = await makeSectionGrouper(tenantId, companyId, groupBy!, exactMode);
          const calcD = dsum(calculatedEquity.map(bsAmt));
          return {
            groupBy: groupBy!,
            groups: {
              assets: group(assets, bsAmt, 'asset'),
              liabilities: group(liabilities, bsAmt, 'liability'),
              equity: [
                // Real equity accounts group by detail type / leadsheet…
                ...group(equity.filter((e) => e.accountId !== null), bsAmt, 'equity'),
                // …the computed rows land in a dedicated trailing group.
                ...(calculatedEquity.length > 0
                  ? [{
                      detailType: null,
                      label: 'Equity (Calculated)',
                      entries: calculatedEquity,
                      subtotal: legacyNum(calcD),
                      ...(exactMode ? { subtotalExact: exactStr(calcD) } : {}),
                    }]
                  : []),
              ],
            },
          };
        })()
      : {}),
  };
}

export async function buildCashFlowStatement(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  // ADR 0XX §5.1 — line-level tag filter flows into the P&L that
  // drives the cash-flow calc.
  tagId: string | null = null,
) {
  // DIRECT METHOD from actual cash movements. The previous version was
  // a stub (operating = accrual net income, investing/financing = 0,
  // netChange = net income) whose "net change in cash" matched real
  // cash movement only for a business with no AR/AP/loans/draws.
  //
  // Here: net change = SUM(debit − credit) over the period's journal
  // lines on CASH accounts (checking/savings/cash/petty cash/
  // undeposited funds) — exact by construction. Each cash-moving
  // transaction is classified by its counter-legs:
  //   any fixed-asset leg                  → investing
  //   any equity or long-term-debt leg     → financing
  //   everything else (P&L, AR/AP, taxes)  → operating
  // Transfers between two cash accounts net to zero and drop out.
  const companyCond = companyId ? sql`t.company_id = ${companyId}` : sql`TRUE`;
  const tagExistsClause = tagId
    ? sql` AND EXISTS (SELECT 1 FROM journal_lines jlt WHERE jlt.transaction_id = t.id AND jlt.tenant_id = ${tenantId} AND jlt.tag_id IN ${tagIn(tagId)})`
    : sql``;
  // Both detail-type vocabularies ('bank' from the default COA / QBD import,
  // 'checking'/'savings' from the QBO-style import) — a tenant whose bank
  // accounts are all 'bank' otherwise has NO cash accounts here and the
  // whole statement reads $0.00.
  const cashDetailList = sql.join(CASH_ACCOUNT_DETAIL_TYPES.map((d) => sql`${d}`), sql`, `);

  const rows = await db.execute(sql`
    WITH cash_accounts AS (
      SELECT id FROM accounts
      WHERE tenant_id = ${tenantId} AND account_type = 'asset'
        AND detail_type IN (${cashDetailList})
    ),
    txn_cash AS (
      SELECT t.id, SUM(jl.debit - jl.credit) AS cash_delta
      FROM transactions t
      JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.tenant_id = ${tenantId}
      WHERE t.tenant_id = ${tenantId} AND t.status = 'posted'
        AND t.basis <> 'cash'  -- basis: keep the direct-method cash flow consistent with the accrual P&L it reconciles to
        AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
        AND ${companyCond}
        AND jl.account_id IN (SELECT id FROM cash_accounts)
        ${tagExistsClause}
      GROUP BY t.id
      HAVING SUM(jl.debit - jl.credit) <> 0
    )
    SELECT tc.id, tc.cash_delta,
      BOOL_OR(a.detail_type = 'fixed_asset') AS touches_investing,
      BOOL_OR(a.account_type = 'equity' OR a.detail_type IN ('long_term_liability', 'line_of_credit')) AS touches_financing
    FROM txn_cash tc
    JOIN journal_lines jl ON jl.transaction_id = tc.id AND jl.tenant_id = ${tenantId}
      AND jl.account_id NOT IN (SELECT id FROM cash_accounts)
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${tenantId}
    GROUP BY tc.id, tc.cash_delta
  `);

  let operating = new Decimal(0);
  let investing = new Decimal(0);
  let financing = new Decimal(0);
  for (const r of rows.rows as Array<{ cash_delta: string | null; touches_investing: boolean; touches_financing: boolean }>) {
    const delta = new Decimal(r.cash_delta || 0);
    if (r.touches_investing) investing = investing.plus(delta);
    else if (r.touches_financing) financing = financing.plus(delta);
    else operating = operating.plus(delta);
  }

  const pl = await buildProfitAndLoss(tenantId, startDate, endDate, 'accrual', companyId, tagId);
  const [labels, footer] = await Promise.all([
    getCFLabels(tenantId),
    getReportFooter(tenantId),
  ]);
  return {
    title: 'Cash Flow Statement', startDate, endDate,
    labels,
    footer,
    // Kept for context alongside the cash sections.
    netIncome: pl.netIncome,
    operatingActivities: Number(operating.toFixed(4)),
    investingActivities: Number(investing.toFixed(4)),
    financingActivities: Number(financing.toFixed(4)),
    netChange: Number(operating.plus(investing).plus(financing).toFixed(4)),
  };
}

// ─── RECEIVABLES ─────────────────────────────────────────────────

/**
 * A/R aging summary (U-142, U-121 A/R half; ar-aging-exact-v1). Built on
 * arOpenItemsAsOf, so it is exact as of any date (later payments don't
 * count), includes open credits (unapplied payments, credit memos) and A/R
 * lines without a client (a "(no client)" row), and its total equals the
 * A/R account balance as of the date (Q-P22o).
 *
 * The response stays compatible: buckets, total and details[] (id,
 * txn_number, txn_date, due_date, total, amount_paid, balance_due,
 * contact_id, customer_name, balance, daysOverdue, bucket) keep their
 * names and number types, derived from the exact values. Added string
 * fields: bucketsExact, totalExact, customers[{contactId, name, buckets,
 * total}], details[].openExact, details[].kind. Tag filter: header-level
 * inclusion test on each item's transaction (ADR §5.2).
 */
export async function buildARAgingSummary(
  tenantId: string,
  asOfDate: string,
  companyId: string | null = null,
  tagId: string | null = null,
) {
  const { arOpenItemsAsOf, ageOpenItems } = await import('./ar-open-items.js');
  const items = await arOpenItemsAsOf(db, {
    tenantId, companyId, asOf: asOfDate,
    tagIds: tagId ? tagId.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  });
  const aging = ageOpenItems(items, asOfDate);

  const contactIds = [...new Set(items.map((i) => i.contactId).filter((x): x is string => x !== null))];
  const names = new Map<string, string>();
  const docs = new Map<string, Record<string, unknown>>();
  if (contactIds.length > 0) {
    const res = await db.execute(sql`
      SELECT id, display_name FROM contacts WHERE tenant_id = ${tenantId}
        AND id IN (${sql.join(contactIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `);
    for (const r of res.rows as Array<{ id: string; display_name: string }>) names.set(r.id, r.display_name);
  }
  const txnIds = items.map((i) => i.txnId);
  if (txnIds.length > 0) {
    const res = await db.execute(sql`
      SELECT id, total, amount_paid, balance_due FROM transactions WHERE tenant_id = ${tenantId}
        AND id IN (${sql.join(txnIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `);
    for (const r of res.rows as Array<Record<string, unknown>>) docs.set(String(r['id']), r);
  }

  const legacyBucket: Record<string, string> = {
    current: 'current', days1to30: '1-30', days31to60: '31-60', days61to90: '61-90', over90: '90+',
  };
  const details = aging.items.map((it) => {
    const doc = docs.get(it.txnId) ?? {};
    return {
      id: it.txnId,
      txn_number: it.number,
      txn_type: it.txnType,
      txn_date: it.date,
      due_date: it.dueDate,
      total: doc['total'] ?? null,
      amount_paid: doc['amount_paid'] ?? null,
      balance_due: doc['balance_due'] ?? null,
      contact_id: it.contactId,
      customer_name: it.contactId ? (names.get(it.contactId) ?? null) : '(no client)',
      balance: Number(it.open),
      daysOverdue: it.days,
      bucket: legacyBucket[it.bucket]!,
      openExact: it.openExact,
      kind: it.kind,
    };
  });

  const perContact = new Map<string | null, typeof aging.items>();
  for (const it of aging.items) perContact.set(it.contactId, [...(perContact.get(it.contactId) ?? []), it]);
  const customers = [...perContact.entries()].map(([contactId, rows]) => {
    const a = ageOpenItems(rows, asOfDate);
    return {
      contactId,
      name: contactId ? (names.get(contactId) ?? '') : '(no client)',
      buckets: a.buckets,
      total: a.total,
    };
  }).sort((x, y) => (x.contactId === null ? 1 : y.contactId === null ? -1 : x.name.localeCompare(y.name)));

  const n = (s: string) => Number(s);
  return {
    title: 'AR Aging Summary', asOfDate,
    buckets: {
      current: n(aging.buckets.current), days1to30: n(aging.buckets.days1to30), days31to60: n(aging.buckets.days31to60),
      days61to90: n(aging.buckets.days61to90), over90: n(aging.buckets.over90),
    },
    total: n(aging.total),
    details,
    bucketsExact: aging.buckets,
    totalExact: aging.totalExact,
    difference: aging.difference,
    customers,
  };
}

export async function buildARAgingDetail(
  tenantId: string,
  asOfDate: string,
  companyId: string | null = null,
  tagId: string | null = null,
) {
  return buildARAgingSummary(tenantId, asOfDate, companyId, tagId);
}

export async function buildCustomerBalanceSummary(
  tenantId: string,
  companyId: string | null = null,
  tagId: string | null = null,
) {
  // Header-level tag filter: only count invoices that touch a tagged line.
  const txnTagFilter = tagId
    ? sql` AND EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.transaction_id = t.id AND jl.tenant_id = ${tenantId} AND jl.tag_id IN ${tagIn(tagId)})`
    : sql``;
  const rows = await db.execute(sql`
    SELECT c.id, c.display_name,
      COALESCE(SUM(CASE WHEN t.txn_type = 'invoice' AND t.status = 'posted' THEN CAST(t.balance_due AS DECIMAL) ELSE 0 END), 0) as balance
    FROM contacts c
    LEFT JOIN transactions t ON t.contact_id = c.id AND t.tenant_id = ${tenantId}
      AND ${companyFilter(companyId)}${txnTagFilter}
    WHERE c.tenant_id = ${tenantId} AND c.contact_type IN ('customer', 'both') AND c.is_active = true
    GROUP BY c.id ORDER BY c.display_name
  `);

  return {
    title: 'Customer Balance Summary',
    data: (rows.rows as any[]).filter(r => num(r.balance) !== 0),
  };
}

export async function buildCustomerBalanceDetail(
  tenantId: string,
  companyId: string | null = null,
  tagId: string | null = null,
) {
  return buildCustomerBalanceSummary(tenantId, companyId, tagId);
}

export async function buildInvoiceList(
  tenantId: string,
  filters?: { startDate?: string; endDate?: string; status?: string; tagId?: string },
  companyId: string | null = null,
) {
  const conditions = [sql`t.tenant_id = ${tenantId}`, sql`t.txn_type = 'invoice'`, companyFilter(companyId)];
  if (filters?.startDate) conditions.push(sql`t.txn_date >= ${filters.startDate}`);
  if (filters?.endDate) conditions.push(sql`t.txn_date <= ${filters.endDate}`);
  if (filters?.status) conditions.push(sql`t.invoice_status = ${filters.status}`);
  if (filters?.tagId) {
    conditions.push(sql`EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.transaction_id = t.id AND jl.tenant_id = ${tenantId} AND jl.tag_id IN ${tagIn(filters.tagId)})`);
  }

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_number, t.txn_date, t.due_date, t.total, t.amount_paid, t.balance_due,
      t.invoice_status, t.status, c.display_name as customer_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.txn_date DESC
  `);

  return { title: 'Invoice List', data: rows.rows };
}

// ─── EXPENSES ────────────────────────────────────────────────────

// Per-account row nested under a vendor in the detail view.
export interface ExpenseVendorAccountRow {
  accountId: string;
  accountNumber: string | null;
  name: string;
  total: number;
  // Exact reports (U-14): the same total as a decimal string.
  totalExact?: string;
}

// A vendor with the accounts it was paid to and the vendor total.
export interface ExpenseVendorGroup {
  contactId: string | null;
  vendorName: string;
  accounts: ExpenseVendorAccountRow[];
  total: number;
  totalExact?: string;
}

export async function buildExpenseByVendor(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  tagId: string | null = null,
  // detail=true additionally returns per-vendor `groups`, each listing the
  // expense accounts the vendor was paid to + a vendor total. Both the flat
  // `data` summary and the `groups` net debit − credit per (vendor, account)
  // so wash/clearing accounts don't double-count (see the summary query).
  detail = false,
  basis: Basis = 'accrual',
  // exactAmounts (U-14): totalExact on detail groups and their accounts.
  evOpts: { exactAmounts?: boolean } = {},
) {
  const tagClause = tagId ? sql`AND jl.tag_id IN ${tagIn(tagId)}` : sql``;
  const cbTag = tagId ? sql`AND cb.tag_id IN ${tagIn(tagId)}` : sql``;
  // Cash basis groups by the PAYMENT's contact (cb.txn_contact_id); the
  // check-image payee fallback is accrual-only.
  const rows = basis === 'cash'
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, startDate, endDate, companyId)}
        SELECT c.id as contact_id,
          COALESCE(c.display_name, 'Uncategorized') as vendor_name,
          SUM(cb.debit) - SUM(cb.credit) as total
        FROM cb_lines cb
        JOIN accounts a ON a.id = cb.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
        LEFT JOIN contacts c ON c.id = cb.txn_contact_id AND c.tenant_id = ${tenantId}
        WHERE a.tenant_id = ${tenantId} ${cbTag}
        GROUP BY c.id, c.display_name
        HAVING ROUND(SUM(cb.debit) - SUM(cb.credit), 2) <> 0
        ORDER BY total DESC
      `)
    : await db.execute(sql`
    SELECT c.id as contact_id,
      -- STATEMENT_CHECK_PAYEE_V1 — fall back to the payee read off the check
      -- image when no contact matched, so checks roll up under the real payee
      -- instead of "Uncategorized". Label/grouping only.
      COALESCE(c.display_name, t.payee_name_on_check, 'Uncategorized') as vendor_name,
      -- Net debit − credit (matches the P&L). Summing gross debits alone
      -- double-counts wash/clearing accounts (e.g. Payroll Clearing), whose
      -- debits are offset by reclass credits — the credits must subtract.
      SUM(jl.debit) - SUM(jl.credit) as total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.basis <> 'cash'  -- basis: exclude cash-only entries from accrual reports
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND ${companyFilter(companyId)}
      ${tagClause}
    GROUP BY COALESCE(c.id::text, t.payee_name_on_check), c.id, c.display_name, t.payee_name_on_check
    HAVING ROUND(SUM(jl.debit) - SUM(jl.credit), 2) <> 0
    ORDER BY total DESC
  `);

  const summary = { title: 'Expenses by Vendor', startDate, endDate, data: rows.rows };
  if (!detail) return summary;

  // Detail — one row per (vendor, account). Vendors ordered by their total
  // (matches the summary); accounts within a vendor by descending total.
  const detailRows = basis === 'cash'
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, startDate, endDate, companyId)}
        SELECT
          COALESCE(c.id::text, 'uncategorized') AS vendor_key,
          c.id AS contact_id,
          COALESCE(c.display_name, 'Uncategorized') AS vendor_name,
          a.id AS account_id, a.account_number, a.name AS account_name,
          SUM(cb.debit) - SUM(cb.credit) AS total
        FROM cb_lines cb
        JOIN accounts a ON a.id = cb.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
        LEFT JOIN contacts c ON c.id = cb.txn_contact_id AND c.tenant_id = ${tenantId}
        WHERE a.tenant_id = ${tenantId} ${cbTag}
        GROUP BY vendor_key, c.id, vendor_name, a.id, a.account_number, a.name
        HAVING ROUND(SUM(cb.debit) - SUM(cb.credit), 2) <> 0
      `)
    : await db.execute(sql`
    SELECT
      COALESCE(c.id::text, t.payee_name_on_check) AS vendor_key,
      c.id AS contact_id,
      COALESCE(c.display_name, t.payee_name_on_check, 'Uncategorized') AS vendor_name,
      a.id AS account_id, a.account_number, a.name AS account_name,
      SUM(jl.debit) - SUM(jl.credit) AS total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.basis <> 'cash'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND ${companyFilter(companyId)}
      ${tagClause}
    GROUP BY vendor_key, c.id, vendor_name, a.id, a.account_number, a.name
    HAVING ROUND(SUM(jl.debit) - SUM(jl.credit), 2) <> 0
  `);

  type VRow = {
    vendor_key: string | null; contact_id: string | null; vendor_name: string;
    account_id: string; account_number: string | null; account_name: string; total: string;
  };
  const byVendor = new Map<string, ExpenseVendorGroup>();
  for (const r of detailRows.rows as unknown as VRow[]) {
    const key = r.vendor_key ?? r.vendor_name;
    let g = byVendor.get(key);
    if (!g) {
      g = { contactId: r.contact_id, vendorName: r.vendor_name, accounts: [], total: 0, totalExact: exactStr(0) };
      byVendor.set(key, g);
    }
    const totalD = dec(r.total);
    g.accounts.push({
      accountId: r.account_id, accountNumber: r.account_number, name: r.account_name, total: legacyNum(totalD),
      totalExact: exactStr(totalD),
    });
    g.totalExact = exactStr(dec(g.totalExact).plus(totalD));
    g.total = legacyNum(g.totalExact);
  }
  const byTotal = (a: { totalExact?: string }, b: { totalExact?: string }) => dec(b.totalExact).comparedTo(dec(a.totalExact));
  const strip = <T extends { totalExact?: string }>(x: T): T => {
    if (evOpts.exactAmounts) return x;
    const { totalExact: _drop, ...rest } = x;
    return rest as T;
  };
  const groups = [...byVendor.values()]
    .map((g) => ({ ...g, accounts: g.accounts.sort(byTotal).map(strip) }))
    .sort(byTotal)
    .map(strip);

  return { ...summary, groups };
}

// Line shape for the detail (GL-style) mode of Expenses by Category.
export interface ExpenseCategoryDetailLine {
  lineId: string;
  transactionId: string;
  date: string;
  txnType: string;
  txnNumber: string | null;
  contactName: string | null;
  memo: string;
  debit: number;
  credit: number;
  // Present only with opts.exactAmounts: unrounded decimal strings of debit /
  // credit and the running balance.
  debitExact?: string;
  creditExact?: string;
  balanceExact?: string;
  // Running period total for the account (starts at 0, accumulates
  // debit − credit through Decimal like the General Ledger).
  balance: number;
}

export interface ExpenseCategoryGroup {
  accountId: string;
  accountNumber: string | null;
  name: string;
  accountType: string;
  lines: ExpenseCategoryDetailLine[];
  totalDebits: number;
  totalCredits: number;
  // Net: totalDebits − totalCredits (expense refunds reduce the group).
  subtotal: number;
  // Carry-forward (balance-sheet detail reports only): the account's natural
  // balance from all activity before the period start, and beginning + the
  // period net. Undefined for P&L-style reports that reset each period.
  beginningBalance?: number;
  endingBalance?: number;
  // Exact reports (U-14).
  totalDebitsExact?: string;
  totalCreditsExact?: string;
  subtotalExact?: string;
  beginningBalanceExact?: string;
  endingBalanceExact?: string;
}

export async function buildExpenseByCategory(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  tagId: string | null = null,
  // Optional multi-account filter. Ids are "validated" by the
  // account-type-filtered join itself: a foreign-tenant or non-expense
  // id simply matches nothing. Empty/undefined = no filter. Applies to
  // BOTH summary and detail modes.
  accountIds: string[] | null = null,
  // detail=true additionally returns GL-style per-account transaction
  // `groups` + `grandTotal`. The summary `data` array nets debit − credit
  // per account (like the P&L) so wash/clearing accounts don't inflate the
  // totals; api-v2 / MCP callers read the same netted `data`.
  detail = false,
  basis: Basis = 'accrual',
  // exactAmounts (U-14): *Exact strings in detail mode.
  ebcOpts: { exactAmounts?: boolean } = {},
) {
  const tagClause = tagId ? sql`AND jl.tag_id IN ${tagIn(tagId)}` : sql``;
  const hasIdFilter = !!accountIds && accountIds.length > 0;
  // colRef is a code-controlled constant ('a.id' / 'id'), never user
  // input; the ids themselves are bound parameters.
  const idFilter = (colRef: string) =>
    hasIdFilter
      ? sql`AND ${sql.raw(colRef)} IN (${sql.join(accountIds!.map((id) => sql`${id}`), sql`, `)})`
      : sql``;
  // Cash-basis filters over the virtual ledger (cb_lines).
  const cbTag = tagId ? sql`AND cb.tag_id IN ${tagIn(tagId)}` : sql``;
  const cbId = hasIdFilter
    ? sql`AND cb.account_id IN (${sql.join(accountIds!.map((id) => sql`${id}`), sql`, `)})`
    : sql``;

  const rows = basis === 'cash'
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, startDate, endDate, companyId)}
        SELECT a.id as account_id, a.name as category, a.account_number, a.account_type,
          SUM(cb.debit) - SUM(cb.credit) as total
        FROM cb_lines cb
        JOIN accounts a ON a.id = cb.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
        WHERE a.tenant_id = ${tenantId} ${cbTag} ${cbId}
        GROUP BY a.id
        HAVING ROUND(SUM(cb.debit) - SUM(cb.credit), 2) <> 0
        ORDER BY total DESC
      `)
    : await db.execute(sql`
    SELECT a.id as account_id, a.name as category, a.account_number, a.account_type,
      SUM(jl.debit) - SUM(jl.credit) as total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.basis <> 'cash'  -- basis: exclude cash-only entries from accrual reports
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND ${companyFilter(companyId)}
      ${tagClause}
      ${idFilter('a.id')}
    GROUP BY a.id
    HAVING ROUND(SUM(jl.debit) - SUM(jl.credit), 2) <> 0
    ORDER BY total DESC
  `);

  const summary = { title: 'Expenses by Category', startDate, endDate, data: rows.rows };
  if (!detail) return summary;

  // ─── Detail mode — GL-style per-account sections ────────────────
  // Accounts first (tenant + expense-type scoped) so an explicitly
  // selected account with zero period activity still gets an empty
  // section — a user filtering to 3 accounts should see all 3.
  const acctResult = await db.execute(sql`
    SELECT id, account_number, name, account_type
    FROM accounts
    WHERE tenant_id = ${tenantId}
      AND account_type IN ('cogs', 'expense', 'other_expense')
      ${idFilter('id')}
    ORDER BY
      CASE account_type WHEN 'cogs' THEN 1 WHEN 'expense' THEN 2 ELSE 3 END,
      account_number NULLS LAST,
      name
  `);

  // ONE query for every account's lines (mirrors buildGeneralLedger's
  // period-activity query restricted to expense-type accounts). Unlike
  // the summary, credits are included so refunds show and the subtotal
  // nets them out.
  const linesResult = basis === 'cash'
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, startDate, endDate, companyId)}
        SELECT
          (row_number() OVER (ORDER BY cb.account_id, cb.txn_date, cb.line_order))::text AS line_id,
          cb.account_id, cb.debit, cb.credit,
          cb.description AS line_description,
          cb.transaction_id, cb.txn_date, cb.txn_type, cb.txn_number,
          cb.memo AS txn_memo,
          c.display_name AS contact_name
        FROM cb_lines cb
        JOIN accounts a ON a.id = cb.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
        LEFT JOIN contacts c ON c.id = cb.txn_contact_id AND c.tenant_id = ${tenantId}
        WHERE a.tenant_id = ${tenantId} AND (cb.debit <> 0 OR cb.credit <> 0) ${cbTag} ${cbId}
        ORDER BY cb.account_id, cb.txn_date, cb.line_order
      `)
    : await db.execute(sql`
    SELECT
      jl.id AS line_id,
      jl.account_id,
      jl.debit,
      jl.credit,
      jl.description AS line_description,
      t.id AS transaction_id,
      t.txn_date,
      t.txn_type,
      ${docNumberSql('t')} AS txn_number,
      t.memo AS txn_memo,
      -- STATEMENT_CHECK_PAYEE_V1 — show the check-image payee when no
      -- contact is linked (same as the General Ledger).
      COALESCE(c.display_name, t.payee_name_on_check) AS contact_name
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.basis <> 'cash'  -- basis: exclude cash-only entries from accrual reports
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND ${companyFilter(companyId)}
      ${tagClause}
      ${idFilter('a.id')}
    ORDER BY jl.account_id, t.txn_date, t.created_at, jl.line_order
  `);

  type DetailAcctRow = { id: string; account_number: string | null; name: string; account_type: string };
  type DetailLineRow = {
    line_id: string;
    account_id: string;
    debit: string;
    credit: string;
    line_description: string | null;
    transaction_id: string;
    txn_date: string;
    txn_type: string;
    txn_number: string | null;
    txn_memo: string | null;
    contact_name: string | null;
  };

  const linesByAccount = new Map<string, DetailLineRow[]>();
  for (const line of linesResult.rows as unknown as DetailLineRow[]) {
    const arr = linesByAccount.get(line.account_id) || [];
    arr.push(line);
    linesByAccount.set(line.account_id, arr);
  }

  const built = buildDetailGroups(
    acctResult.rows as unknown as DetailAcctRow[], linesByAccount,
    { creditNormal: false, carryForward: false, hasIdFilter, exact: !!ebcOpts.exactAmounts, beginByAccount: new Map(), dropZeroSubtotal: true },
  );
  return { ...summary, groups: built.groups, grandTotal: built.grandTotal, ...(built.grandTotalExact !== undefined ? { grandTotalExact: built.grandTotalExact } : {}) };
}

// Shared GL-style section builder for Expenses by Category and the
// "<Group> by Account" reports. Every amount is a Decimal of the
// unrounded SQL value (U-14); the legacy numbers come from the same
// Decimals and exact reports add *Exact strings on lines, groups and the
// grand total.
function buildDetailGroups(
  accts: Array<{ id: string; account_number: string | null; name: string; account_type: string }>,
  linesByAccount: Map<string, Array<{
    line_id: string; debit: string; credit: string; line_description: string | null; transaction_id: string;
    txn_date: string; txn_type: string; txn_number: string | null; txn_memo: string | null; contact_name: string | null;
  }>>,
  o: {
    creditNormal: boolean; carryForward: boolean; hasIdFilter: boolean; exact: boolean;
    beginByAccount: Map<string, InstanceType<typeof Decimal>>;
    // Expenses by Category drops a section that nets to zero (wash /
    // clearing accounts) unless it was explicitly selected.
    dropZeroSubtotal: boolean;
  },
): { groups: ExpenseCategoryGroup[]; grandTotal: number; grandTotalExact?: string } {
  let grandD = new Decimal(0);
  const groups: ExpenseCategoryGroup[] = [];
  for (const acct of accts) {
    const periodLines = linesByAccount.get(acct.id) || [];
    const beginD = o.beginByAccount.get(acct.id) ?? new Decimal(0);
    // Skip only accounts with no period activity AND (for carry-forward) no
    // opening balance — unless the account was explicitly selected.
    if (periodLines.length === 0 && !o.hasIdFilter && (!o.carryForward || beginD.abs().lt('0.005'))) continue;

    let running = o.carryForward ? beginD : new Decimal(0);
    let debitsD = new Decimal(0);
    let creditsD = new Decimal(0);
    const reportLines: ExpenseCategoryDetailLine[] = periodLines.map((line) => {
      const debitD = dec(line.debit);
      const creditD = dec(line.credit);
      // Credit-normal groups read positive when credits exceed debits.
      running = o.creditNormal ? running.plus(creditD).minus(debitD) : running.plus(debitD).minus(creditD);
      debitsD = debitsD.plus(debitD);
      creditsD = creditsD.plus(creditD);
      return {
        lineId: line.line_id,
        transactionId: line.transaction_id,
        date: line.txn_date,
        txnType: line.txn_type,
        txnNumber: line.txn_number,
        contactName: line.contact_name,
        // Prefer the per-line description, fall back to the txn memo.
        memo: line.line_description || line.txn_memo || '',
        debit: legacyNum(debitD),
        credit: legacyNum(creditD),
        ...(o.exact
          ? { debitExact: exactStr(debitD), creditExact: exactStr(creditD), balanceExact: exactStr(running) }
          : {}),
        balance: legacyNum(running),
      };
    });

    const subD = o.creditNormal ? creditsD.minus(debitsD) : debitsD.minus(creditsD);
    // A wash/clearing account (equal debits and credits, e.g. Payroll
    // Clearing) nets to zero — drop its section unless the user explicitly
    // filtered to it, so it doesn't read as a phantom expense line.
    if (o.dropZeroSubtotal && legacyNum(subD) === 0 && !o.hasIdFilter) continue;
    const endD = beginD.plus(subD);
    // Grand total ties to the Balance Sheet (sum of ending balances) for
    // carry-forward reports; P&L-style reports total the period net.
    grandD = grandD.plus(o.carryForward ? endD : subD);
    groups.push({
      accountId: acct.id,
      accountNumber: acct.account_number,
      name: acct.name,
      accountType: acct.account_type,
      lines: reportLines,
      totalDebits: legacyNum(debitsD),
      totalCredits: legacyNum(creditsD),
      subtotal: legacyNum(subD),
      ...(o.carryForward ? { beginningBalance: legacyNum(beginD), endingBalance: legacyNum(endD) } : {}),
      ...(o.exact
        ? {
            totalDebitsExact: exactStr(debitsD),
            totalCreditsExact: exactStr(creditsD),
            subtotalExact: exactStr(subD),
            ...(o.carryForward ? { beginningBalanceExact: exactStr(beginD), endingBalanceExact: exactStr(endD) } : {}),
          }
        : {}),
    });
  }
  return { groups, grandTotal: legacyNum(grandD), ...(o.exact ? { grandTotalExact: exactStr(grandD) } : {}) };
}

// ─── Generic "<Group> by Account" detail report ──────────────────
// Same shape and GL-style detail as Expenses by Category, but for any
// account-type group (Revenues, Assets, Liabilities, Equity). `normalSide`
// controls the summary total column and the sign of the running balance /
// subtotal: debit-normal groups (assets) accumulate debit − credit;
// credit-normal groups (revenue, liabilities, equity) accumulate
// credit − debit so their natural balance reads positive.
export interface AccountDetailReportOpts {
  title: string;
  accountTypes: string[];
  normalSide: 'debit' | 'credit';
  companyId?: string | null;
  tagId?: string | null;
  accountIds?: string[] | null;
  detail?: boolean;
  // Balance-sheet groups (asset/liability/equity) carry a beginning balance
  // forward from all prior activity so the running balance and per-account
  // ending balance tie to the Balance Sheet. P&L groups leave this off — they
  // reset to 0 each period.
  carryForward?: boolean;
  // Cash basis sources from the virtual cash-basis ledger (recognition at
  // payment dates); accrual (default) reads the posted journal.
  basis?: Basis;
  // Additive: detail lines also carry debitExact / creditExact (decimal strings).
  exactAmounts?: boolean;
}

export async function buildAccountDetailReport(
  tenantId: string,
  startDate: string,
  endDate: string,
  opts: AccountDetailReportOpts,
) {
  const { title, accountTypes, normalSide } = opts;
  const companyId = opts.companyId ?? null;
  const tagId = opts.tagId ?? null;
  const accountIds = opts.accountIds ?? null;
  const detail = opts.detail ?? false;
  const carryForward = opts.carryForward ?? false;

  const creditNormal = normalSide === 'credit';
  const tagClause = tagId ? sql`AND jl.tag_id IN ${tagIn(tagId)}` : sql``;
  const hasIdFilter = !!accountIds && accountIds.length > 0;
  const idFilter = (colRef: string) =>
    hasIdFilter
      ? sql`AND ${sql.raw(colRef)} IN (${sql.join(accountIds!.map((id) => sql`${id}`), sql`, `)})`
      : sql``;
  // accountTypes / normalSide are code-controlled constants, never user input.
  const typeList = sql.join(accountTypes.map((t) => sql`${t}`), sql`, `);
  const sideCol = sql.raw(creditNormal ? 'jl.credit' : 'jl.debit');
  // Section order follows the given accountTypes order (e.g. revenue before
  // other_revenue), falling back after any unlisted type.
  const typeOrderCase = sql.join(accountTypes.map((t, i) => sql`WHEN ${t} THEN ${i}`), sql` `);

  // Cash-basis variants: source from the virtual cash-basis ledger (cb_lines),
  // which already scopes the date range + company. Same tag / account filters.
  const basis = opts.basis ?? 'accrual';
  const cbSideCol = sql.raw(creditNormal ? 'cb.credit' : 'cb.debit');
  const cbTag = tagId ? sql`AND cb.tag_id IN ${tagIn(tagId)}` : sql``;
  const cbId = hasIdFilter
    ? sql`AND cb.account_id IN (${sql.join(accountIds!.map((id) => sql`${id}`), sql`, `)})`
    : sql``;

  const rows = basis === 'cash'
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, startDate, endDate, companyId)}
        SELECT a.id as account_id, a.name as category, a.account_number, a.account_type,
          SUM(${cbSideCol}) as total
        FROM cb_lines cb
        JOIN accounts a ON a.id = cb.account_id AND a.account_type IN (${typeList})
        WHERE a.tenant_id = ${tenantId} AND ${cbSideCol} > 0 ${cbTag} ${cbId}
        GROUP BY a.id ORDER BY total DESC
      `)
    : await db.execute(sql`
    SELECT a.id as account_id, a.name as category, a.account_number, a.account_type,
      SUM(${sideCol}) as total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN (${typeList})
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.basis <> 'cash'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND ${sideCol} > 0
      AND ${companyFilter(companyId)}
      ${tagClause}
      ${idFilter('a.id')}
    GROUP BY a.id ORDER BY total DESC
  `);

  const summary = { title, startDate, endDate, data: rows.rows };
  if (!detail) return summary;

  const acctResult = await db.execute(sql`
    SELECT id, account_number, name, account_type
    FROM accounts
    WHERE tenant_id = ${tenantId}
      AND account_type IN (${typeList})
      ${idFilter('id')}
    ORDER BY
      CASE account_type ${typeOrderCase} ELSE 99 END,
      account_number NULLS LAST,
      name
  `);

  const linesResult = basis === 'cash'
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, startDate, endDate, companyId)}
        SELECT
          (row_number() OVER (ORDER BY cb.account_id, cb.txn_date, cb.line_order))::text AS line_id,
          cb.account_id, cb.debit, cb.credit,
          cb.description AS line_description,
          cb.transaction_id, cb.txn_date, cb.txn_type, cb.txn_number,
          cb.memo AS txn_memo,
          c.display_name AS contact_name
        FROM cb_lines cb
        JOIN accounts a ON a.id = cb.account_id AND a.account_type IN (${typeList})
        LEFT JOIN contacts c ON c.id = cb.txn_contact_id AND c.tenant_id = ${tenantId}
        WHERE a.tenant_id = ${tenantId} AND (cb.debit <> 0 OR cb.credit <> 0) ${cbTag} ${cbId}
        ORDER BY cb.account_id, cb.txn_date, cb.line_order
      `)
    : await db.execute(sql`
    SELECT
      jl.id AS line_id,
      jl.account_id,
      jl.debit,
      jl.credit,
      jl.description AS line_description,
      t.id AS transaction_id,
      t.txn_date,
      t.txn_type,
      ${docNumberSql('t')} AS txn_number,
      t.memo AS txn_memo,
      COALESCE(c.display_name, t.payee_name_on_check) AS contact_name
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN (${typeList})
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.basis <> 'cash'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND ${companyFilter(companyId)}
      ${tagClause}
      ${idFilter('a.id')}
    ORDER BY jl.account_id, t.txn_date, t.created_at, jl.line_order
  `);

  type DetailAcctRow = { id: string; account_number: string | null; name: string; account_type: string };
  type DetailLineRow = {
    line_id: string; account_id: string; debit: string; credit: string;
    line_description: string | null; transaction_id: string; txn_date: string;
    txn_type: string; txn_number: string | null; txn_memo: string | null; contact_name: string | null;
  };

  const linesByAccount = new Map<string, DetailLineRow[]>();
  for (const line of linesResult.rows as unknown as DetailLineRow[]) {
    const arr = linesByAccount.get(line.account_id) || [];
    arr.push(line);
    linesByAccount.set(line.account_id, arr);
  }

  // Carry-forward opening balance per account: the natural balance of all
  // posted (accrual) activity BEFORE the period start. Same scoping as the
  // period query so filters stay consistent.
  const beginByAccount = new Map<string, InstanceType<typeof Decimal>>();
  if (carryForward) {
    // Day before the period start — the cash-basis ledger's date window is
    // inclusive, so this gives all recognition strictly before the period.
    const dayBefore = new Date(new Date(startDate + 'T00:00:00Z').getTime() - 86400000).toISOString().split('T')[0]!;
    const beginRows = basis === 'cash'
      ? await executeCashBasis(sql`
          WITH ${cashBasisLinesWith(tenantId, null, dayBefore, companyId)}
          SELECT cb.account_id,
            COALESCE(SUM(cb.debit), 0) AS begin_debit,
            COALESCE(SUM(cb.credit), 0) AS begin_credit
          FROM cb_lines cb
          JOIN accounts a ON a.id = cb.account_id AND a.account_type IN (${typeList})
          WHERE a.tenant_id = ${tenantId} ${cbTag} ${cbId}
          GROUP BY cb.account_id
        `)
      : await db.execute(sql`
      SELECT jl.account_id,
        COALESCE(SUM(jl.debit), 0) AS begin_debit,
        COALESCE(SUM(jl.credit), 0) AS begin_credit
      FROM journal_lines jl
      JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
      JOIN accounts a ON a.id = jl.account_id AND a.account_type IN (${typeList})
      WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
        AND t.basis <> 'cash'
        AND t.txn_date < ${startDate}
        AND ${companyFilter(companyId)}
        ${tagClause}
        ${idFilter('a.id')}
      GROUP BY jl.account_id
    `);
    for (const r of beginRows.rows as unknown as { account_id: string; begin_debit: string; begin_credit: string }[]) {
      const bal = creditNormal ? dec(r.begin_credit).minus(dec(r.begin_debit)) : dec(r.begin_debit).minus(dec(r.begin_credit));
      beginByAccount.set(r.account_id, bal);
    }
  }

  const built = buildDetailGroups(
    acctResult.rows as unknown as DetailAcctRow[], linesByAccount,
    { creditNormal, carryForward, hasIdFilter, exact: !!opts.exactAmounts, beginByAccount, dropZeroSubtotal: false },
  );
  return { ...summary, groups: built.groups, grandTotal: built.grandTotal, ...(built.grandTotalExact !== undefined ? { grandTotalExact: built.grandTotalExact } : {}) };
}

// ─── SALES ────────────────────────────────────────────────────────

// Sales by Customer — aggregates revenue (credits to revenue-type
// accounts) grouped by the transaction's contact. Scoped to posted
// sales transactions in the given date range. Line-level tag filter:
// when tagId is supplied we narrow the aggregation to lines that
// carry the tag (project-accounting semantic, same as P&L and
// Expenses by Vendor).
export async function buildSalesByCustomer(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  tagId: string | null = null,
  basis: Basis = 'accrual',
  // U-202 (E11): the U-60 adjusting lens (default include).
  adjusting: AdjustingFilter | null = null,
) {
  const tagClause = tagId ? sql`AND jl.tag_id IN ${tagIn(tagId)}` : sql``;
  const cbTag = tagId ? sql`AND cb.tag_id IN ${tagIn(tagId)}` : sql``;
  // Cash basis recognizes revenue when the customer pays (cb_lines Rule 3 for
  // invoices at payment; cash sales pass through) grouped by the payment's
  // contact. Accrual counts sale-document revenue by the document's contact.
  const rows = basis === 'cash'
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, startDate, endDate, companyId, adjusting)}
        SELECT c.id as contact_id, COALESCE(c.display_name, 'Uncategorized') as customer_name,
          SUM(CASE WHEN cb.txn_type = 'customer_refund' THEN cb.credit - cb.debit ELSE cb.credit END) as total
        FROM cb_lines cb
        JOIN accounts a ON a.id = cb.account_id AND a.account_type IN ('revenue', 'other_revenue')
        LEFT JOIN contacts c ON c.id = cb.txn_contact_id AND c.tenant_id = ${tenantId}
        WHERE a.tenant_id = ${tenantId} AND (cb.credit > 0 OR cb.txn_type IN ('returned_payment', 'customer_refund')) ${cbTag}
          -- U-146 S4: a bounce counts only its rule-3 mirror rows (credit <= 0); its own
          -- credit to a discount or write-off account is not a sale (the payment's own
          -- discount debit was never counted).
          AND NOT (cb.txn_type = 'returned_payment' AND cb.credit > 0)
          -- U-152: money not yet applied to an invoice (Unapplied receipts) is not a sale.
          AND a.system_tag IS DISTINCT FROM 'unapplied_receipts'
          -- Sale documents + the payments their revenue re-emits at
          -- (cb_lines rule 3 stamps the PAYMENT's txn_type). Without this,
          -- cash-basis "Sales" would count revenue credits from deposits and
          -- journal entries — semantically broader than the accrual report.
          -- A refund of a credit memo re-emits the memo's income debits at the
          -- refund date (cb_lines rule 3b): returns, counted negative.
          AND cb.txn_type IN ('invoice', 'cash_sale', 'credit_memo', 'customer_payment', 'returned_payment', 'customer_refund')
        GROUP BY c.id, c.display_name ORDER BY total DESC
      `)
    : await db.execute(sql`
    SELECT c.id as contact_id, COALESCE(c.display_name, 'Uncategorized') as customer_name,
      SUM(CASE WHEN t.txn_type = 'credit_memo' THEN jl.credit - jl.debit ELSE jl.credit END) as total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('revenue', 'other_revenue')
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      -- Credit memos debit income (returns): counted negative, net of any
      -- negative memo line.
      AND (jl.credit > 0 OR t.txn_type = 'credit_memo')
      AND t.txn_type IN ('invoice', 'cash_sale', 'credit_memo')
      AND ${companyFilter(companyId)}
      AND ${adjustingCond(adjusting, 't.is_adjusting')}
      ${tagClause}
    GROUP BY c.id, c.display_name ORDER BY total DESC
  `);

  return { title: 'Sales by Customer', startDate, endDate, data: rows.rows };
}

// Sales by Item — aggregates revenue (credits to revenue-type
// accounts) grouped by `journal_lines.item_id`. Lines without an item
// (e.g. ad-hoc revenue entries) collapse into a single
// "Uncategorized" bucket so totals stay conserved against Sales by
// Customer / P&L. Same tag semantic as Sales by Customer.
export async function buildSalesByItem(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  tagId: string | null = null,
  basis: Basis = 'accrual',
  // U-202 (E11): the U-60 adjusting lens (default include).
  adjusting: AdjustingFilter | null = null,
) {
  const tagClause = tagId ? sql`AND jl.tag_id IN ${tagIn(tagId)}` : sql``;
  const cbTag = tagId ? sql`AND cb.tag_id IN ${tagIn(tagId)}` : sql``;
  const rows = basis === 'cash'
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, startDate, endDate, companyId, adjusting)}
        SELECT
          cb.item_id,
          COALESCE(i.name, 'Uncategorized') as item_name,
          '' as item_sku, -- items has no sku column; kept for the response shape
          SUM(CASE WHEN cb.txn_type = 'customer_refund' THEN cb.credit - cb.debit ELSE cb.credit END) as total,
          COUNT(DISTINCT cb.transaction_id)::int as txn_count
        FROM cb_lines cb
        JOIN accounts a ON a.id = cb.account_id AND a.account_type IN ('revenue', 'other_revenue')
        LEFT JOIN items i ON i.id = cb.item_id AND i.tenant_id = ${tenantId}
        WHERE a.tenant_id = ${tenantId} AND (cb.credit > 0 OR cb.txn_type IN ('returned_payment', 'customer_refund')) ${cbTag}
          -- U-146 S4: a bounce counts only its rule-3 mirror rows (credit <= 0); its own
          -- credit to a discount or write-off account is not a sale (the payment's own
          -- discount debit was never counted).
          AND NOT (cb.txn_type = 'returned_payment' AND cb.credit > 0)
          -- U-152: money not yet applied to an invoice (Unapplied receipts) is not a sale.
          AND a.system_tag IS DISTINCT FROM 'unapplied_receipts'
          -- Same sale-document restriction as Sales by Customer (see note there).
          -- A refund of a credit memo re-emits the memo's income debits at the
          -- refund date (cb_lines rule 3b): returns, counted negative.
          AND cb.txn_type IN ('invoice', 'cash_sale', 'credit_memo', 'customer_payment', 'returned_payment', 'customer_refund')
        GROUP BY cb.item_id, i.name
        ORDER BY total DESC
      `)
    : await db.execute(sql`
    SELECT
      jl.item_id,
      COALESCE(i.name, 'Uncategorized') as item_name,
      '' as item_sku, -- items has no sku column; kept for the response shape
      SUM(CASE WHEN t.txn_type = 'credit_memo' THEN jl.credit - jl.debit ELSE jl.credit END) as total,
      COUNT(DISTINCT jl.transaction_id)::int as txn_count
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('revenue', 'other_revenue')
    LEFT JOIN items i ON i.id = jl.item_id AND i.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      -- Credit memos debit income (returns): counted negative, net of any
      -- negative memo line.
      AND (jl.credit > 0 OR t.txn_type = 'credit_memo')
      AND t.txn_type IN ('invoice', 'cash_sale', 'credit_memo')
      AND ${companyFilter(companyId)}
      AND ${adjustingCond(adjusting, 't.is_adjusting')}
      ${tagClause}
    GROUP BY jl.item_id, i.name
    ORDER BY total DESC
  `);

  return { title: 'Sales by Item', startDate, endDate, data: rows.rows };
}

export async function buildVendorBalanceSummary(tenantId: string, companyId: string | null = null) {
  const rows = await db.execute(sql`
    SELECT c.id, c.display_name,
      COALESCE(SUM(CASE WHEN t.status = 'posted' THEN CAST(t.total AS DECIMAL) ELSE 0 END), 0) as total_spent
    FROM contacts c
    LEFT JOIN transactions t ON t.contact_id = c.id AND t.tenant_id = ${tenantId} AND t.txn_type = 'expense'
      AND ${companyFilter(companyId)}
    WHERE c.tenant_id = ${tenantId} AND c.contact_type IN ('vendor', 'both') AND c.is_active = true
    GROUP BY c.id ORDER BY c.display_name
  `);

  return { title: 'Vendor Balance Summary', data: rows.rows };
}

export async function buildTransactionListByVendor(tenantId: string, vendorId: string, dateRange?: DateRange, companyId: string | null = null) {
  const conditions = [
    sql`t.tenant_id = ${tenantId}`,
    sql`t.contact_id = ${vendorId}`,
    sql`t.status = 'posted'`,
    companyFilter(companyId),
  ];
  if (dateRange?.startDate) conditions.push(sql`t.txn_date >= ${dateRange.startDate}`);
  if (dateRange?.endDate) conditions.push(sql`t.txn_date <= ${dateRange.endDate}`);

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date, t.total, t.memo
    FROM transactions t
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.txn_date DESC
  `);

  return { title: 'Transactions by Vendor', vendorId, data: rows.rows };
}

// ─── BANKING ─────────────────────────────────────────────────────

// Bank detail-type vocabulary. The default COA template uses the
// umbrella 'bank' for checking/savings accounts; the QBO-style import
// path uses the more specific 'checking'/'savings'. Both vocabularies
// exist in production data (see BANK_DETAIL_TYPES in
// portal-report-evaluator.service.ts), so the report accepts either.
export const BANK_ACCOUNT_DETAIL_TYPES = ['bank', 'checking', 'savings'];
// Everything that IS cash for the direct-method cash-flow statement: the
// bank vocabulary above plus cash-on-hand and the undeposited-funds
// clearing account (money received, not yet at the bank — still cash).
export const CASH_ACCOUNT_DETAIL_TYPES = [...BANK_ACCOUNT_DETAIL_TYPES, 'cash', 'petty_cash', 'undeposited_funds'];
// Liability accounts that are reconciled like a bank account (credit-card and
// line-of-credit statements). Included in the Bank Reconciliation Summary so
// card reconciliations show alongside bank accounts.
export const RECONCILABLE_LIABILITY_DETAIL_TYPES = ['credit_card', 'line_of_credit'];

// Bank Account Balances — as-of balance per bank account. Same accrual
// as-of pattern as buildBalanceSheet (bank accounts are cash accounts,
// so there's no cash/accrual distinction and no `basis` param).
// Active bank accounts always appear (even at $0); inactive accounts
// appear only while they still carry a nonzero as-of balance and are
// flagged with an " (inactive)" name suffix + isInactive field.
export async function buildBankBalances(
  tenantId: string,
  asOfDate: string,
  companyId: string | null = null,
  // exactAmounts (U-14): balanceExact and totalBalanceExact.
  bbOpts: { exactAmounts?: boolean } = {},
) {
  const companyCond = companyId ? sql`company_id = ${companyId}` : sql`TRUE`;
  const detailList = sql.join(BANK_ACCOUNT_DETAIL_TYPES.map((d) => sql`${d}`), sql`, `);

  const rows = await db.execute(sql`
    SELECT a.id, a.account_number, a.name, a.is_active,
      COALESCE(SUM(jl.debit), 0) as total_debit,
      COALESCE(SUM(jl.credit), 0) as total_credit
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
      AND jl.transaction_id IN (
        SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted'
        AND basis <> 'cash'  -- basis: bank balances stay consistent with the accrual balance sheet
        AND txn_date <= ${asOfDate}
        AND ${companyCond}
      )
    WHERE a.tenant_id = ${tenantId} AND a.account_type = 'asset'
      AND a.detail_type IN (${detailList})
    GROUP BY a.id
    ORDER BY a.account_number, a.name
  `);

  type BankBalanceEntry = {
    accountId: string;
    accountNumber: string | null;
    name: string;
    balance: number;
    // Exact reports (U-14): the balance as a decimal string.
    balanceExact?: string;
    isInactive: boolean;
  };
  const entries: BankBalanceEntry[] = [];
  let total = new Decimal(0);
  for (const row of rows.rows as Array<{
    id: string;
    account_number: string | null;
    name: string;
    is_active: boolean | null;
    total_debit: string | number | null;
    total_credit: string | number | null;
  }>) {
    const balD = dec(row.total_debit).minus(dec(row.total_credit));
    const balance = legacyNum(balD);
    const isInactive = row.is_active === false;
    if (isInactive && balance === 0) continue;
    entries.push({
      accountId: row.id,
      accountNumber: row.account_number,
      name: isInactive ? `${row.name} (inactive)` : row.name,
      balance,
      ...(bbOpts.exactAmounts ? { balanceExact: exactStr(balD) } : {}),
      isInactive,
    });
    total = total.plus(balD);
  }

  const footer = await getReportFooter(tenantId);
  return {
    title: 'Bank Account Balances',
    asOfDate,
    footer,
    accounts: entries,
    totalBalance: legacyNum(total),
    ...(bbOpts.exactAmounts ? { totalBalanceExact: exactStr(total) } : {}),
  };
}

export interface ReconSummaryAccountRow {
  accountId: string;
  accountNumber: string | null;
  name: string;
  lastReconciledDate: string | null;
  lastReconciledBalance: number | null;
  latestStatementEnd: string | null;
  statementCount: number;
  statementGapCount: number;
  unclearedCount: number;
  oldestUnclearedDate: string | null;
  staleCheckCount: number;
}

export interface ReconSummaryStaleCheck {
  accountId: string;
  accountName: string;
  txnDate: string;
  checkNumber: string | null;
  payee: string | null;
  amount: number;
}

// Bank Reconciliation Summary — per bank account: last completed
// reconciliation, latest statement on file, statement coverage gaps,
// uncleared posted journal lines (count + oldest date), and a stale
// outstanding-checks sub-list (uncleared check payments older than 90
// days). Uses the same uncleared derivation as reconciliation start():
// posted lines on the account not cleared by any COMPLETED reconciliation.
export interface BankReconciliationSummaryOptions extends ReconciliationProofOptions {
  /** Summarize this one reconciliation (its account only) instead of each account's latest completed one. */
  reconciliationId?: string;
}

export async function buildBankReconciliationSummary(
  tenantId: string,
  accountId: string,
  companyId: string | null = null,
  opts: BankReconciliationSummaryOptions = {},
) {
  // One-reconciliation mode: the proof drives which account is shown.
  let focusProof: ReconProof | null = null;
  if (opts.reconciliationId) {
    focusProof = await buildReconciliationProof(tenantId, opts.reconciliationId, opts);
    accountId = focusProof.accountId;
  }
  const bankDetailList = sql.join(BANK_ACCOUNT_DETAIL_TYPES.map((d) => sql`${d}`), sql`, `);
  const creditDetailList = sql.join(RECONCILABLE_LIABILITY_DETAIL_TYPES.map((d) => sql`${d}`), sql`, `);
  const accountCond = accountId ? sql`AND a.id = ${accountId}` : sql``;

  // Reconcilable accounts: asset bank/checking/savings accounts and liability
  // credit-card / line-of-credit accounts (reconciled the same way).
  const accountRows = await db.execute(sql`
    SELECT a.id, a.account_number, a.name
    FROM accounts a
    WHERE a.tenant_id = ${tenantId} AND a.is_active = true
      AND (
        (a.account_type = 'asset' AND a.detail_type IN (${bankDetailList}))
        OR (a.account_type = 'liability' AND a.detail_type IN (${creditDetailList}))
      )
      ${accountCond}
    ORDER BY a.account_number, a.name
  `);
  const bankAccounts = accountRows.rows as Array<{ id: string; account_number: string | null; name: string }>;
  if (bankAccounts.length === 0) {
    return {
      title: 'Bank Reconciliation Summary', accounts: [] as ReconSummaryAccountRow[],
      staleChecks: [] as ReconSummaryStaleCheck[], proofs: focusProof ? [focusProof] : [] as ReconProof[],
      reconciliationId: opts.reconciliationId ?? null,
    };
  }
  const idList = sql.join(bankAccounts.map((a) => sql`${a.id}::uuid`), sql`, `);

  // Last completed reconciliation per account.
  const recRows = await db.execute(sql`
    SELECT DISTINCT ON (account_id) id, account_id, statement_date, statement_ending_balance
    FROM reconciliations
    WHERE tenant_id = ${tenantId} AND status = 'complete' AND account_id IN (${idList})
    ORDER BY account_id, statement_date DESC
  `);
  const lastRecByAccount = new Map(
    (recRows.rows as Array<{ id: string; account_id: string; statement_date: string; statement_ending_balance: string }>)
      .map((r) => [r.account_id, r]),
  );

  // Statements per account (for latest + gap computation).
  const stmtRows = await db.execute(sql`
    SELECT account_id, period_end FROM bank_statements
    WHERE tenant_id = ${tenantId} AND account_id IN (${idList})
  `);
  const stmtsByAccount = new Map<string, string[]>();
  for (const r of stmtRows.rows as Array<{ account_id: string; period_end: string }>) {
    const list = stmtsByAccount.get(r.account_id) ?? [];
    list.push(r.period_end);
    stmtsByAccount.set(r.account_id, list);
  }

  // Uncleared posted lines per account (same derivation as recon start).
  const unclearedCond = sql`
    t.status = 'posted' AND ${companyFilter(companyId)}
    AND jl.id NOT IN (
      SELECT rl.journal_line_id FROM reconciliation_lines rl
      JOIN reconciliations r ON r.id = rl.reconciliation_id
      WHERE r.tenant_id = ${tenantId} AND r.status = 'complete' AND rl.is_cleared = true
    )
  `;
  const unclearedRows = await db.execute(sql`
    SELECT jl.account_id, count(*)::int AS uncleared_count, min(t.txn_date) AS oldest_date
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id IN (${idList}) AND ${unclearedCond}
    GROUP BY jl.account_id
  `);
  const unclearedByAccount = new Map(
    (unclearedRows.rows as Array<{ account_id: string; uncleared_count: number; oldest_date: string }>)
      .map((r) => [r.account_id, r]),
  );

  // Stale outstanding checks: uncleared check payments (credit on the bank
  // account, transaction carries a check number or is a printed check)
  // older than 90 days.
  const staleRows = await db.execute(sql`
    SELECT jl.account_id, a.name AS account_name, t.txn_date, t.check_number, t.txn_number,
      COALESCE(c.display_name, t.payee_name_on_check) AS payee, jl.credit
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    JOIN accounts a ON a.id = jl.account_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id IN (${idList})
      AND jl.credit > 0 AND t.check_number IS NOT NULL
      AND t.txn_date < (CURRENT_DATE - INTERVAL '90 days')
      AND ${unclearedCond}
    ORDER BY t.txn_date ASC
  `);
  const staleChecks: ReconSummaryStaleCheck[] = (staleRows.rows as Array<{
    account_id: string; account_name: string; txn_date: string;
    check_number: number | string | null; txn_number: string | null;
    payee: string | null; credit: string;
  }>).map((r) => ({
    accountId: r.account_id,
    accountName: r.account_name,
    txnDate: r.txn_date,
    checkNumber: r.check_number != null ? String(r.check_number) : r.txn_number,
    payee: r.payee,
    amount: num(r.credit),
  }));
  const staleCountByAccount = new Map<string, number>();
  for (const s of staleChecks) {
    staleCountByAccount.set(s.accountId, (staleCountByAccount.get(s.accountId) ?? 0) + 1);
  }

  const gapDismissals = await loadGapDismissals(tenantId);
  const accountsOut: ReconSummaryAccountRow[] = bankAccounts.map((a) => {
    const rec = lastRecByAccount.get(a.id);
    const ends = stmtsByAccount.get(a.id) ?? [];
    const uncleared = unclearedByAccount.get(a.id);
    return {
      accountId: a.id,
      accountNumber: a.account_number,
      name: a.name,
      lastReconciledDate: rec?.statement_date ?? null,
      lastReconciledBalance: rec ? num(rec.statement_ending_balance) : null,
      latestStatementEnd: ends.length ? [...ends].sort().pop()! : null,
      statementCount: ends.length,
      statementGapCount: missingMonthsBetween(ends).filter((m) => !gapDismissals.get(a.id)?.has(m)).length,
      unclearedCount: uncleared?.uncleared_count ?? 0,
      oldestUnclearedDate: uncleared?.oldest_date ?? null,
      staleCheckCount: staleCountByAccount.get(a.id) ?? 0,
    };
  });

  // Bank-to-books proof per account: the focused reconciliation, or each
  // account's latest COMPLETED reconciliation.
  const proofs: ReconProof[] = [];
  if (focusProof) proofs.push(focusProof);
  else {
    for (const a of bankAccounts) {
      const r = lastRecByAccount.get(a.id);
      if (r) proofs.push(await buildReconciliationProof(tenantId, r.id, opts));
    }
  }

  const footer = await getReportFooter(tenantId);
  return {
    title: 'Bank Reconciliation Summary', footer, accounts: accountsOut, staleChecks, proofs,
    reconciliationId: opts.reconciliationId ?? null,
  };
}

// Completed-reconciliation detail: header (account, dates, balances,
// completed by, linked statement), cleared lines, uncleared-as-of-
// statement-date lines, and totals.
export async function buildReconciliationDetail(tenantId: string, reconciliationId: string, opts: ReconciliationProofOptions = {}) {
  const recRows = await db.execute(sql`
    SELECT r.*, a.name AS account_name, a.account_number, u.display_name AS completed_by_name, u.email AS completed_by_email
    FROM reconciliations r
    JOIN accounts a ON a.id = r.account_id
    LEFT JOIN users u ON u.id = r.completed_by
    WHERE r.tenant_id = ${tenantId} AND r.id = ${reconciliationId}
    LIMIT 1
  `);
  const rec = (recRows.rows as Array<Record<string, unknown>>)[0];
  if (!rec) {
    const { AppError } = await import('../utils/errors.js');
    throw AppError.notFound('Reconciliation not found');
  }

  const stmtRows = await db.execute(sql`
    SELECT bs.id, bs.period_start, bs.period_end, bs.attachment_id, att.file_name,
      bs.institution_name, bs.masked_account_number
    FROM bank_statements bs
    LEFT JOIN attachments att ON att.id = bs.attachment_id
    WHERE bs.tenant_id = ${tenantId} AND bs.reconciliation_id = ${reconciliationId}
    LIMIT 1
  `);
  const stmt = (stmtRows.rows as Array<Record<string, unknown>>)[0] ?? null;

  const lineRows = await db.execute(sql`
    SELECT rl.is_cleared, rl.cleared_at, jl.debit, jl.credit, jl.description,
      t.txn_date, t.txn_type, t.txn_number, t.check_number, t.memo
    FROM reconciliation_lines rl
    JOIN journal_lines jl ON jl.id = rl.journal_line_id
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE rl.reconciliation_id = ${reconciliationId}
    ORDER BY t.txn_date, t.created_at
  `);
  interface LineRow {
    is_cleared: boolean; cleared_at: Date | null; debit: string; credit: string;
    description: string | null; txn_date: string; txn_type: string;
    txn_number: string | null; check_number: number | null; memo: string | null;
  }
  const allLines = lineRows.rows as unknown as LineRow[];
  const mapLine = (l: LineRow) => ({
    txnDate: l.txn_date,
    txnType: l.txn_type,
    txnNumber: l.check_number != null ? String(l.check_number) : l.txn_number,
    description: l.description || l.memo || null,
    payment: num(l.credit) > 0 ? num(l.credit) : null,
    deposit: num(l.debit) > 0 ? num(l.debit) : null,
  });
  const cleared = allLines.filter((l) => l.is_cleared).map(mapLine);
  const uncleared = allLines.filter((l) => !l.is_cleared).map(mapLine);

  const sumOf = (rows: ReturnType<typeof mapLine>[], key: 'payment' | 'deposit') =>
    Number(rows.reduce((acc, r) => acc.plus(r[key] ?? 0), new Decimal(0)).toFixed(4));

  const footer = await getReportFooter(tenantId);
  return {
    title: 'Reconciliation Detail',
    footer,
    reconciliation: {
      id: String(rec['id']),
      accountId: String(rec['account_id']),
      accountName: String(rec['account_name']),
      accountNumber: (rec['account_number'] as string | null) ?? null,
      statementDate: String(rec['statement_date']),
      beginningBalance: num(rec['beginning_balance'] as string),
      statementEndingBalance: num(rec['statement_ending_balance'] as string),
      clearedBalance: rec['cleared_balance'] != null ? num(rec['cleared_balance'] as string) : null,
      difference: rec['difference'] != null ? num(rec['difference'] as string) : null,
      status: String(rec['status']),
      completedAt: (rec['completed_at'] as Date | null) ?? null,
      completedBy: (rec['completed_by_name'] as string | null) || (rec['completed_by_email'] as string | null) || null,
    },
    statement: stmt ? {
      id: String(stmt['id']),
      periodStart: (stmt['period_start'] as string | null) ?? null,
      periodEnd: String(stmt['period_end']),
      attachmentId: (stmt['attachment_id'] as string | null) ?? null,
      fileName: (stmt['file_name'] as string | null) ?? null,
      institutionName: (stmt['institution_name'] as string | null) ?? null,
      maskedAccountNumber: (stmt['masked_account_number'] as string | null) ?? null,
    } : null,
    cleared,
    uncleared,
    // Professional bank-to-books reconciliation (Sections A–E).
    proof: await buildReconciliationProof(tenantId, reconciliationId, opts),
    totals: {
      clearedPayments: sumOf(cleared, 'payment'),
      clearedDeposits: sumOf(cleared, 'deposit'),
      unclearedPayments: sumOf(uncleared, 'payment'),
      unclearedDeposits: sumOf(uncleared, 'deposit'),
    },
  };
}

export async function buildDepositDetail(tenantId: string, dateRange?: DateRange, companyId: string | null = null) {
  const conditions = [
    sql`t.tenant_id = ${tenantId}`,
    sql`t.txn_type = 'deposit'`,
    sql`t.status = 'posted'`,
    companyFilter(companyId),
  ];
  if (dateRange?.startDate) conditions.push(sql`t.txn_date >= ${dateRange.startDate}`);
  if (dateRange?.endDate) conditions.push(sql`t.txn_date <= ${dateRange.endDate}`);

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_number, t.txn_date, t.total, t.memo
    FROM transactions t
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.txn_date DESC
  `);

  return { title: 'Deposit Detail', data: rows.rows };
}

export async function buildCheckRegister(
  tenantId: string,
  accountId: string,
  dateRange?: DateRange,
  companyId: string | null = null,
  // ADR 0XX §5.1 — line-level tag semantic: hide lines whose tag_id
  // does not match. Account-level reports are project-accounting
  // surfaces, so this matches P&L/GL behavior.
  tagId: string | null = null,
) {
  const conditions = [
    sql`jl.tenant_id = ${tenantId}`,
    sql`jl.account_id = ${accountId}`,
    sql`t.status = 'posted'`,
    companyFilter(companyId),
  ];
  if (dateRange?.startDate) conditions.push(sql`t.txn_date >= ${dateRange.startDate}`);
  if (dateRange?.endDate) conditions.push(sql`t.txn_date <= ${dateRange.endDate}`);
  if (tagId) conditions.push(sql`jl.tag_id IN ${tagIn(tagId)}`);

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date, t.memo,
      t.check_number,
      -- STATEMENT_CHECK_PAYEE_V1 — payee for the check: linked contact, else
      -- the name read off the check image.
      COALESCE(c.display_name, t.payee_name_on_check) AS payee,
      jl.debit, jl.credit
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.txn_date DESC, t.created_at DESC
  `);

  return { title: 'Check Register', accountId, data: rows.rows };
}

// ─── TAX ─────────────────────────────────────────────────────────

export async function buildSalesTaxLiability(tenantId: string, startDate: string, endDate: string, companyId: string | null = null) {
  const rows = await db.execute(sql`
    -- U-138 (S5): credit memos give tax back, so they count negated.
    SELECT COALESCE(SUM(CASE WHEN t.txn_type = 'credit_memo' THEN -CAST(t.tax_amount AS DECIMAL) ELSE CAST(t.tax_amount AS DECIMAL) END), 0) as total_tax,
      COALESCE(SUM(CASE WHEN t.txn_type = 'credit_memo' THEN -CAST(t.subtotal AS DECIMAL) ELSE CAST(t.subtotal AS DECIMAL) END), 0) as total_sales
    FROM transactions t
    WHERE t.tenant_id = ${tenantId} AND t.status = 'posted'
      AND t.txn_type IN ('invoice', 'cash_sale', 'credit_memo')
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND ${companyFilter(companyId)}
  `);

  const row = (rows.rows as any[])[0] || { total_tax: '0', total_sales: '0' };
  return {
    title: 'Sales Tax Liability', startDate, endDate,
    totalSales: num(row.total_sales),
    totalTax: num(row.total_tax),
  };
}

export async function buildTaxableSalesSummary(tenantId: string, startDate: string, endDate: string, companyId: string | null = null) {
  return buildSalesTaxLiability(tenantId, startDate, endDate, companyId);
}

export async function buildSalesTaxPayments(tenantId: string, startDate: string, endDate: string, companyId: string | null = null) {
  return { title: 'Sales Tax Payments', startDate, endDate, data: [] };
}

export async function build1099VendorSummary(tenantId: string, year: string, companyId: string | null = null) {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  // 1099 is CASH-basis: count actual disbursements (bill payments,
  // direct expenses, checks) — NOT 'bill' documents (that's accrual and
  // double-counts once the bill is paid). This matches the portal 1099
  // center's txn-type set so the two surfaces agree.
  const rows = await db.execute(sql`
    SELECT c.id, c.display_name, c.tax_id,
      COALESCE(SUM(CAST(t.total AS DECIMAL)), 0) as total_paid
    FROM contacts c
    JOIN transactions t ON t.contact_id = c.id AND t.tenant_id = ${tenantId}
      AND t.txn_type IN ('bill_payment', 'expense', 'check') AND t.status = 'posted'
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND ${companyFilter(companyId)}
    WHERE c.tenant_id = ${tenantId} AND c.is_1099_eligible = true
    GROUP BY c.id ORDER BY total_paid DESC
  `);

  return { title: '1099 Vendor Summary', year, data: rows.rows };
}

// ─── GENERAL ─────────────────────────────────────────────────────

/**
 * General Ledger report — properly grouped by account, with beginning
 * balance, line-by-line running balance, period totals, and ending
 * balance for each account. This matches the format any accountant or
 * auditor expects to see.
 *
 * Income statement accounts (revenue/expense) use a fiscal-year reset
 * for the beginning balance: their "beginning of period" balance is
 * computed from the fiscal year start, not from the beginning of time,
 * because revenue/expense accounts conceptually close to retained
 * earnings at fiscal year end. Balance sheet accounts (asset, liability,
 * equity) carry their cumulative balance forward forever.
 *
 * Running balances are shown using the natural sign convention:
 *   - debit-normal accounts (asset, expense):  balance = debits - credits
 *   - credit-normal accounts (liab, equity, revenue):  balance = credits - debits
 * so a "normal" balance is always displayed as a positive number.
 */
export async function buildGeneralLedger(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  // ADR 0XX §5.1 — line-level tag filter. When set, only journal lines
  // carrying that tag contribute to beginning balances and period
  // activity, so the ledger reads as the segment's standalone book.
  tagId: string | null = null,
  basis: Basis = 'accrual',
  // Optional account filter (?account_ids=). Removes whole account
  // SECTIONS — never individual lines — so each returned account's
  // beginning / running / ending balances are exactly what the
  // unfiltered ledger shows. Ids are validated by the tenant-scoped
  // accounts query itself: a foreign-tenant id simply matches nothing
  // (never widens, never leaks). An explicitly selected account with
  // no activity still gets an (empty) section. Null/empty = all.
  accountIds: string[] | null = null,
  // U-60 adjusting lens (beginning balances and period lines alike).
  // exactAmounts (U-14): *Exact decimal strings on lines, accounts and
  // totals. limit: return at most this many lines (report order); totals,
  // balances and rowCount still cover every line, truncated says so.
  // lens (U-202, reports-drill-v1): per-line contact / tag / amount /
  // cleared / type filters (report-lens.ts), applied to the beginning
  // balances and the period lines alike, so a drill sums to its cell.
  // tagSplitGroupId (U-201): each account gains tagSplit rows (lines without
  // a tag from the group, each group tag with activity, the account total).
  // fiscalYearStart (U-213): the start of the fiscal year containing
  // startDate; income-statement beginning balances count from it.
  glOpts: {
    adjusting?: AdjustingFilter | null; exactAmounts?: boolean; limit?: number | null;
    lens?: LineLens | null; tagSplitGroupId?: string | null; fiscalYearStart?: string | null;
  } = {},
) {
  const adjusting = glOpts.adjusting ?? null;
  const exactMode = !!glOpts.exactAmounts;
  const lens = lensIsEmpty(glOpts.lens) ? null : glOpts.lens!;
  const accrualLens = lens ? sql` AND ${lensSql(tenantId, lens, ACCRUAL_COLS)}` : sql``;
  const cashLens = lens ? sql` AND ${lensSql(tenantId, lens, CASH_COLS)}` : sql``;
  const hasIdFilter = !!accountIds && accountIds.length > 0;
  // colRef is a code-controlled constant, never user input; the ids
  // themselves are bound parameters.
  const idFilter = (colRef: string) =>
    hasIdFilter
      ? sql` AND ${sql.raw(colRef)} IN (${sql.join(accountIds!.map((id) => sql`${id}`), sql`, `)})`
      : sql``;
  // Evaluated as an inline conjunct. Empty sql`` is a no-op append.
  const tagClause = tagId ? sql` AND jl.tag_id IN ${tagIn(tagId)}` : sql``;
  const cbTag = tagId ? sql` AND cb.tag_id IN ${tagIn(tagId)}` : sql``;
  // Day before the period start for the cash-basis beginning-balance window
  // (cb_lines' date range is inclusive).
  const dayBeforeStart = new Date(new Date(startDate + 'T00:00:00Z').getTime() - 86400000).toISOString().split('T')[0]!;
  const fyStartMonth = await getFiscalYearStart(tenantId, companyId);
  // UTC getters — same pattern as buildBalanceSheet. Local getters on a
  // UTC-parsed 'YYYY-MM-DD' shift the day west of UTC, which flipped the
  // fiscal year for boundary dates (e.g. a July-1 report in TZ=UTC−5
  // computed the PREVIOUS fiscal year's start).
  const startDt = new Date(startDate + 'T00:00:00Z');
  let fyStartYear = startDt.getUTCFullYear();
  if (startDt.getUTCMonth() + 1 < fyStartMonth) fyStartYear--;
  // U-213 (report-fixes-v2): an explicit fiscal year start (a retail 52-53
  // week year) replaces the month rule for the income accounts' reset.
  const fyStart = glOpts.fiscalYearStart || `${fyStartYear}-${String(fyStartMonth).padStart(2, '0')}-01`;

  // 1. All accounts (so we can include accounts that have beginning
  //    balance only and no period activity).
  const accountsResult = await db.execute(sql`
    SELECT id, account_number, name, account_type, system_tag, is_system
    FROM accounts
    WHERE tenant_id = ${tenantId}${idFilter('id')}
    ORDER BY
      CASE account_type
        WHEN 'asset' THEN 1
        WHEN 'liability' THEN 2
        WHEN 'equity' THEN 3
        WHEN 'revenue' THEN 4
        WHEN 'cogs' THEN 5
        WHEN 'expense' THEN 6
        WHEN 'other_revenue' THEN 7
        WHEN 'other_expense' THEN 8
        ELSE 9
      END,
      account_number NULLS LAST,
      name
  `);

  // 2. Beginning balances (per account) — debit-side and credit-side sums
  //    of all activity strictly before the report startDate. For income
  //    statement accounts, only count activity from the fiscal year start.
  const beginResult = basis === 'cash'
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, null, dayBeforeStart, companyId, adjusting)}
        SELECT a.id,
          COALESCE(SUM(
            CASE WHEN a.account_type IN ('asset','liability','equity') THEN cb.debit
                 WHEN cb.txn_date >= ${fyStart} THEN cb.debit ELSE 0 END
          ), 0) AS begin_debit,
          COALESCE(SUM(
            CASE WHEN a.account_type IN ('asset','liability','equity') THEN cb.credit
                 WHEN cb.txn_date >= ${fyStart} THEN cb.credit ELSE 0 END
          ), 0) AS begin_credit
        FROM accounts a
        LEFT JOIN cb_lines cb ON cb.account_id = a.id${cbTag}${cashLens}
        WHERE a.tenant_id = ${tenantId}${idFilter('a.id')}
        GROUP BY a.id
      `)
    : lens
      // With a lens the lines join their transaction before the filter
      // (the lens reads the transaction's contact and type).
      ? await db.execute(sql`
        SELECT a.id,
          COALESCE(SUM(CASE WHEN a.account_type IN ('asset','liability','equity') THEN x.debit
                            WHEN x.txn_date >= ${fyStart} THEN x.debit ELSE 0 END), 0) AS begin_debit,
          COALESCE(SUM(CASE WHEN a.account_type IN ('asset','liability','equity') THEN x.credit
                            WHEN x.txn_date >= ${fyStart} THEN x.credit ELSE 0 END), 0) AS begin_credit
        FROM accounts a
        LEFT JOIN (
          SELECT jl.account_id, jl.debit, jl.credit, t.txn_date
          FROM journal_lines jl
          JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
          WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted' AND t.txn_date < ${startDate}
            AND t.basis <> 'cash'
            AND ${companyId ? sql`t.company_id = ${companyId}` : sql`TRUE`}
            AND ${adjustingCond(adjusting, 't.is_adjusting')}${tagClause}${accrualLens}
        ) x ON x.account_id = a.id
        WHERE a.tenant_id = ${tenantId}${idFilter('a.id')}
        GROUP BY a.id
      `)
      : await db.execute(sql`
    SELECT a.id,
      COALESCE(SUM(
        CASE
          WHEN a.account_type IN ('asset','liability','equity') THEN jl.debit
          WHEN t.txn_date >= ${fyStart} THEN jl.debit
          ELSE 0
        END
      ), 0) AS begin_debit,
      COALESCE(SUM(
        CASE
          WHEN a.account_type IN ('asset','liability','equity') THEN jl.credit
          WHEN t.txn_date >= ${fyStart} THEN jl.credit
          ELSE 0
        END
      ), 0) AS begin_credit
    FROM accounts a
    LEFT JOIN journal_lines jl
      ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
      AND jl.transaction_id IN (
        SELECT id FROM transactions
        WHERE tenant_id = ${tenantId} AND status = 'posted' AND txn_date < ${startDate}
        AND basis <> 'cash'  -- basis: exclude cash-only entries from the accrual ledger
        AND ${companyId ? sql`company_id = ${companyId}` : sql`TRUE`}
        AND ${adjustingCond(adjusting, 'is_adjusting')}
      )${tagClause}
    LEFT JOIN transactions t
      ON t.id = jl.transaction_id
    WHERE a.tenant_id = ${tenantId}${idFilter('a.id')}
    GROUP BY a.id
  `);

  // 3. Period activity (all journal lines in [startDate, endDate])
  const linesResult = basis === 'cash'
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, startDate, endDate, companyId, adjusting)}
        SELECT
          (row_number() OVER (ORDER BY cb.account_id, cb.txn_date, cb.line_order))::text AS line_id,
          cb.account_id, cb.debit, cb.credit,
          cb.description AS line_description, cb.line_order,
          cb.tag_id AS line_tag_id, tag.name AS line_tag_name,
          cb.transaction_id, cb.txn_date, cb.txn_type, cb.txn_number,
          cb.memo AS txn_memo,
          c.display_name AS contact_name,
          cb.line_id AS source_line_id,
          COALESCE(cb.line_contact_id, cb.txn_contact_id) AS line_contact_id
        FROM cb_lines cb
        LEFT JOIN contacts c ON c.id = cb.txn_contact_id AND c.tenant_id = ${tenantId}
        LEFT JOIN tags tag ON tag.id = cb.tag_id AND tag.tenant_id = ${tenantId}
        WHERE (cb.debit <> 0 OR cb.credit <> 0)${cbTag}${idFilter('cb.account_id')}${cashLens}
        ORDER BY cb.account_id, cb.txn_date, cb.line_order
      `)
    : await db.execute(sql`
    SELECT
      jl.id AS line_id,
      jl.account_id,
      jl.debit,
      jl.credit,
      jl.description AS line_description,
      jl.line_order,
      -- ADR 0XX §6.3 — per-line tag surfaced for CSV/Excel export.
      jl.tag_id AS line_tag_id,
      tag.name AS line_tag_name,
      t.id AS transaction_id,
      t.txn_date,
      t.txn_type,
      ${docNumberSql('t')} AS txn_number,
      t.memo AS txn_memo,
      -- STATEMENT_CHECK_PAYEE_V1 — show the check-image payee when no
      -- contact is linked (e.g. statement-imported checks).
      COALESCE(c.display_name, t.payee_name_on_check) AS contact_name,
      jl.id AS source_line_id,
      COALESCE(jl.contact_id, t.contact_id) AS line_contact_id
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN tags tag ON tag.id = jl.tag_id AND tag.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId}
      AND t.status = 'posted'
      AND t.basis <> 'cash'  -- basis: exclude cash-only entries from the accrual ledger
      AND t.txn_date >= ${startDate}
      AND t.txn_date <= ${endDate}
      AND ${adjustingCond(adjusting, 't.is_adjusting')}
      AND ${companyFilter(companyId)}${tagClause}${idFilter('jl.account_id')}${accrualLens}
    ORDER BY jl.account_id, t.txn_date, t.created_at, jl.line_order
  `);

  // ── Build the response ───────────────────────────────────────
  type AccountRow = {
    id: string;
    account_number: string | null;
    name: string;
    account_type: string;
    system_tag: string | null;
    is_system: boolean;
  };
  type BeginRow = { id: string; begin_debit: string; begin_credit: string };
  type LineRow = {
    line_id: string;
    account_id: string;
    debit: string;
    credit: string;
    line_description: string | null;
    line_order: number;
    line_tag_id: string | null;
    line_tag_name: string | null;
    transaction_id: string;
    txn_date: string;
    txn_type: string;
    txn_number: string | null;
    txn_memo: string | null;
    contact_name: string | null;
    source_line_id: string | null;
    line_contact_id: string | null;
  };

  const allAccounts = accountsResult.rows as unknown as AccountRow[];
  const beginRows = beginResult.rows as unknown as BeginRow[];
  const lines = linesResult.rows as unknown as LineRow[];

  // Index beginning balances and period lines by account id. Every
  // amount stays a Decimal of the unrounded SQL value (U-14); the legacy
  // number fields are derived from the same Decimals.
  type D = InstanceType<typeof Decimal>;
  const beginMap = new Map<string, { debit: D; credit: D }>();
  for (const r of beginRows) {
    beginMap.set(r.id, { debit: dec(r.begin_debit), credit: dec(r.begin_credit) });
  }
  const linesByAccount = new Map<string, LineRow[]>();
  for (const line of lines) {
    const arr = linesByAccount.get(line.account_id) || [];
    arr.push(line);
    linesByAccount.set(line.account_id, arr);
  }

  // Helper: signed balance using the account's natural sign convention.
  // asset / cogs / expense / other_expense are debit-normal; the rest
  // (liability / equity / revenue / other_revenue) are credit-normal.
  const naturalBalance = (type: string, debit: D, credit: D) =>
    isDebitNormalShared(type) ? debit.minus(credit) : credit.minus(debit);

  let totalDebitsD = new Decimal(0);
  let totalCreditsD = new Decimal(0);
  let rowCount = 0;

  // U-201 tag split: the group's tags in display order.
  const splitTags = glOpts.tagSplitGroupId ? (await loadGroupTags(tenantId, glOpts.tagSplitGroupId)) ?? [] : null;
  const glTagSplit = (accountType: string, periodLines: LineRow[]) => {
    if (!splitTags) return {};
    type Acc = { d: D; c: D };
    const zero = (): Acc => ({ d: new Decimal(0), c: new Decimal(0) });
    const byTag = new Map<string, Acc>();
    const untagged = zero();
    const total = zero();
    const inGroup = new Set(splitTags.map((t) => t.id));
    for (const l of periodLines) {
      const d = dec(l.debit); const c = dec(l.credit);
      const tgt = l.line_tag_id && inGroup.has(l.line_tag_id)
        ? (byTag.get(l.line_tag_id) ?? (byTag.set(l.line_tag_id, zero()), byTag.get(l.line_tag_id)!))
        : untagged;
      tgt.d = tgt.d.plus(d); tgt.c = tgt.c.plus(c);
      total.d = total.d.plus(d); total.c = total.c.plus(c);
    }
    const row = (a: Acc) => ({
      periodDebitsExact: exactStr(a.d), periodCreditsExact: exactStr(a.c),
      netChangeExact: exactStr(naturalBalance(accountType, a.d, a.c)),
    });
    return {
      tagSplit: [
        { rowKind: 'account' as const, tagId: null, tagNumber: null, tagName: null, ...row(untagged) },
        ...splitTags.filter((t) => byTag.has(t.id)).map((t) => ({
          rowKind: 'tag' as const, tagId: t.id, tagNumber: t.tagNumber, tagName: t.name, ...row(byTag.get(t.id)!),
        })),
        { rowKind: 'account_total' as const, tagId: null, tagNumber: null, tagName: null, ...row(total) },
      ],
    };
  };

  const accounts = allAccounts
    .map((acct) => {
      const begin = beginMap.get(acct.id) || { debit: new Decimal(0), credit: new Decimal(0) };
      const beginningD = naturalBalance(acct.account_type, begin.debit, begin.credit);
      const beginningBalance = legacyNum(beginningD);
      const periodLines = linesByAccount.get(acct.id) || [];

      // Skip accounts with no activity AND no beginning balance — they're
      // noise on the report. (This is what every commercial GL does.)
      // Explicitly selected accounts are kept: a user filtering to 3
      // accounts should see all 3.
      if (!hasIdFilter && periodLines.length === 0 && beginningD.abs().lt('0.005')) {
        return null;
      }

      let running = beginningD;
      let periodDebitsD = new Decimal(0);
      let periodCreditsD = new Decimal(0);

      const reportLines = periodLines.map((line) => {
        const debitD = dec(line.debit);
        const creditD = dec(line.credit);
        // Running balance in Decimal on every add, so the GL column stays
        // exact however many lines accumulate.
        running = running.plus(naturalBalance(acct.account_type, debitD, creditD));
        periodDebitsD = periodDebitsD.plus(debitD);
        periodCreditsD = periodCreditsD.plus(creditD);

        return {
          lineId: line.line_id,
          transactionId: line.transaction_id,
          date: line.txn_date,
          txnType: line.txn_type,
          txnNumber: line.txn_number,
          contactName: line.contact_name,
          // Prefer the per-line description, fall back to the transaction memo
          description: line.line_description || line.txn_memo || '',
          debit: legacyNum(debitD),
          credit: legacyNum(creditD),
          // ADR 0XX §6.3 — per-line tag flows to the GL response so
          // CSV/Excel exports can include a `line_tag` column.
          tagId: line.line_tag_id,
          tagName: line.line_tag_name,
          // The GL "Tag" column: the line's OWN tag only ('' when
          // untagged) — exactly what the line-level tag filter matches.
          // No transaction-level fallback (owner decision).
          tagLabel: line.line_tag_name || '',
          runningBalance: legacyNum(running),
          ...(exactMode
            ? {
                debitExact: exactStr(debitD), creditExact: exactStr(creditD), runningBalanceExact: exactStr(running),
                // U-202: the journal line (cash basis: the line passed through,
                // null for a share of a paid document) and the line's client.
                sourceLineId: line.source_line_id ?? null,
                contactId: line.line_contact_id ?? null,
                lineOrder: Number(line.line_order ?? 0),
              }
            : {}),
        };
      });

      totalDebitsD = totalDebitsD.plus(periodDebitsD);
      totalCreditsD = totalCreditsD.plus(periodCreditsD);
      rowCount += reportLines.length;

      return {
        id: acct.id,
        accountNumber: acct.account_number,
        name: acct.name,
        accountType: acct.account_type,
        normalBalance: isDebitNormalShared(acct.account_type) ? ('debit' as const) : ('credit' as const),
        beginningBalance,
        lines: reportLines,
        periodDebits: legacyNum(periodDebitsD),
        periodCredits: legacyNum(periodCreditsD),
        endingBalance: legacyNum(running),
        ...(exactMode
          ? {
              accountId: acct.id,
              beginningBalanceExact: exactStr(beginningD),
              periodDebitsExact: exactStr(periodDebitsD),
              periodCreditsExact: exactStr(periodCreditsD),
              endingBalanceExact: exactStr(running),
              // U-202: the period's activity in the account's natural sign
              // (ending - beginning); what a P&L cell drills to.
              netChangeExact: exactStr(running.minus(beginningD)),
              ...glTagSplit(acct.account_type, periodLines),
            }
          : {}),
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);

  // ?limit: keep the first `limit` lines in report order. Every account
  // keeps its section and its full balances and totals.
  const limit = glOpts.limit && glOpts.limit > 0 ? glOpts.limit : null;
  let truncated = false;
  if (limit !== null && rowCount > limit) {
    truncated = true;
    let left = limit;
    for (const a of accounts) {
      if (a.lines.length > left) a.lines = a.lines.slice(0, left);
      left -= a.lines.length;
    }
  }
  const totalDebits = legacyNum(totalDebitsD);
  const totalCredits = legacyNum(totalCreditsD);

  return {
    title: 'General Ledger',
    startDate,
    endDate,
    fiscalYearStart: fyStart,
    accounts,
    totalDebits,
    totalCredits,
    ...(exactMode ? { totalDebitsExact: exactStr(totalDebitsD), totalCreditsExact: exactStr(totalCreditsD) } : {}),
    ...(exactMode || limit !== null ? { rowCount, truncated } : {}),
    // Present only when filtered: the tenant-owned accounts the filter
    // resolved to (foreign / unknown ids already dropped), in report
    // order — drives the printed header note.
    ...(hasIdFilter
      ? { accountFilter: { accounts: allAccounts.map((a) => ({ id: a.id, accountNumber: a.account_number, name: a.name })) } }
      : {}),
  };
}

/**
 * U-213 (ClientLedger PR-6 S5, Q-SPF7, report-fixes-v2): what A/R and A/P
 * keep on the cash basis through `asOfDate` from entries other than customer
 * and vendor payments (journal entries and other entries posted straight to
 * A/R or A/P pass through the cash ledger unchanged). A/R in debit sign, A/P
 * in credit sign, whole books (company scope and adjusting lens, no tag
 * filter); accountIds and txnTypes select those lines on the cash General
 * Ledger. Null when both are zero.
 */
export async function cashBasisArApResidue(
  tenantId: string, asOfDate: string, companyId: string | null, adjusting: AdjustingFilter | null = null,
): Promise<{ accountsReceivableExact: string; accountsPayableExact: string; accountIds: string[]; txnTypes: string[] } | null> {
  const res = await executeCashBasis(sql`
    WITH ${cashBasisLinesWith(tenantId, null, asOfDate, companyId, adjusting)}
    SELECT a.id, a.detail_type, cb.txn_type, COALESCE(SUM(cb.debit - cb.credit), 0) AS net
    FROM cb_lines cb
    JOIN accounts a ON a.id = cb.account_id AND a.tenant_id = ${tenantId}
    WHERE a.detail_type IN ('accounts_receivable', 'accounts_payable')
      AND cb.txn_type NOT IN ('customer_payment', 'returned_payment', 'customer_refund', 'bill_payment')
    GROUP BY a.id, a.detail_type, cb.txn_type
  `);
  let ar = new Decimal(0);
  let ap = new Decimal(0);
  const accountIds = new Set<string>();
  const txnTypes = new Set<string>();
  for (const r of res.rows as Array<{ id: string; detail_type: string; txn_type: string; net: string }>) {
    const n = new Decimal(r.net || 0);
    if (n.isZero()) continue;
    if (r.detail_type === 'accounts_receivable') ar = ar.plus(n); else ap = ap.minus(n);
    accountIds.add(r.id);
    txnTypes.add(r.txn_type);
  }
  if (ar.isZero() && ap.isZero()) return null;
  return {
    accountsReceivableExact: exactStr(ar), accountsPayableExact: exactStr(ap),
    accountIds: [...accountIds].sort(), txnTypes: [...txnTypes].sort(),
  };
}

export async function buildTrialBalance(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  // ADR 0XX §5.1 — Trial Balance uses the **transaction-level** tag
  // semantic (include every line of any transaction that has at least
  // one line carrying the tag) rather than the line-level filter used
  // by P&L/GL. A fundamental accounting invariant of the TB is
  // debits = credits; line-level filtering breaks that invariant for
  // mixed-tag transactions (only one side of a balanced entry would
  // survive the filter). Swapping in EXISTS preserves the invariant
  // while still narrowing the report to transactions the tag actually
  // touched.
  tagId: string | null = null,
  basis: Basis = 'accrual',
  // U-60 adjusting lens; also applied to the prior-years retained-earnings row.
  // exactAmounts / accountTree: exact report fields (U-14). Exact rows add
  // accountId, total_debitExact, total_creditExact, debitExact, creditExact
  // and netExact (debit − credit; rollupExact on parent rows is the same sign).
  // fiscalYearStart (U-213, report-fixes-v2): the fiscal year start to split
  // at (a retail 52-53 week year starts on its own day); default: the 1st of
  // the company's fiscal start month on or before endDate.
  tbOpts: { adjusting?: AdjustingFilter | null; exactAmounts?: boolean; accountTree?: boolean; fiscalYearStart?: string | null } = {},
) {
  const adjusting = tbOpts.adjusting ?? null;
  let fyStart: string;
  if (tbOpts.fiscalYearStart) {
    fyStart = tbOpts.fiscalYearStart;
  } else {
    const fyStartMonth = await getFiscalYearStart(tenantId, companyId);
    // Compute current fiscal year start based on the report end date.
    // UTC getters — see the identical note in buildGeneralLedger; local
    // getters flipped the fiscal year for boundary dates west of UTC.
    const endDt = new Date(endDate + 'T00:00:00Z');
    let fyStartYear = endDt.getUTCFullYear();
    if (endDt.getUTCMonth() + 1 < fyStartMonth) fyStartYear--;
    fyStart = `${fyStartYear}-${String(fyStartMonth).padStart(2, '0')}-01`;
  }
  const tagExistsClause = tagId
    ? sql` AND EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.transaction_id = transactions.id AND jl2.tenant_id = ${tenantId} AND jl2.tag_id IN ${tagIn(tagId)})`
    : sql``;

  // For balance sheet accounts (asset, liability, equity): show cumulative balance through end date
  // For income statement accounts (revenue, expense): show balance only from fiscal year start through end date
  // This implements virtual year-end closing — revenue/expense reset at fiscal year boundaries

  // Cash basis reads the virtual cash-basis ledger (already scoped to
  // <= endDate); the fiscal-year cutoff for P&L accounts uses each line's
  // recognition date (cb.txn_date). Accrual reads the posted journal.
  // U-213 (ClientLedger PR-6 S2): the cash TB uses the same transaction-level
  // tag semantic as the accrual one — every virtual line of a transaction
  // (payment, check, …) that has a line with the tag — so a tag-filtered
  // cash TB balances too. Each virtual group is balanced and belongs to one
  // transaction, so whole transactions balance.
  const cashTagClause = tagId
    ? sql`AND EXISTS (SELECT 1 FROM cb_lines cb2 WHERE cb2.transaction_id = cb.transaction_id AND cb2.tag_id IN ${tagIn(tagId)})`
    : sql``;
  // With a tag filter, the prior-years income (retained earnings row) is
  // summed from the same transaction-level set (pre_net below); without
  // one, from the same-basis P&L as before.
  const rows = basis === 'cash'
    ? await executeCashBasis(sql`
        WITH ${cashBasisLinesWith(tenantId, null, endDate, companyId, adjusting)}
        SELECT a.id, a.account_number, a.name, a.account_type,
          COALESCE(SUM(
            CASE WHEN a.account_type NOT IN ('asset', 'liability', 'equity') AND cb.txn_date < ${fyStart}
              THEN cb.credit - cb.debit ELSE 0 END
          ), 0) as pre_net,
          COALESCE(SUM(
            CASE WHEN a.account_type IN ('asset', 'liability', 'equity')
              THEN cb.debit ELSE CASE WHEN cb.txn_date >= ${fyStart} THEN cb.debit ELSE 0 END END
          ), 0) as total_debit,
          COALESCE(SUM(
            CASE WHEN a.account_type IN ('asset', 'liability', 'equity')
              THEN cb.credit ELSE CASE WHEN cb.txn_date >= ${fyStart} THEN cb.credit ELSE 0 END END
          ), 0) as total_credit
        FROM accounts a
        LEFT JOIN cb_lines cb ON cb.account_id = a.id ${cashTagClause}
        WHERE a.tenant_id = ${tenantId}
        GROUP BY a.id
        HAVING COALESCE(SUM(cb.debit), 0) > 0 OR COALESCE(SUM(cb.credit), 0) > 0
        ORDER BY a.account_number, a.name
      `)
    : await db.execute(sql`
    SELECT a.id, a.account_number, a.name, a.account_type,
      COALESCE(SUM(
        CASE WHEN a.account_type NOT IN ('asset', 'liability', 'equity') AND t.txn_date < ${fyStart}
          THEN jl.credit - jl.debit ELSE 0 END
      ), 0) as pre_net,
      COALESCE(SUM(
        CASE WHEN a.account_type IN ('asset', 'liability', 'equity')
          THEN jl.debit ELSE
          CASE WHEN t.txn_date >= ${fyStart} THEN jl.debit ELSE 0 END
        END
      ), 0) as total_debit,
      COALESCE(SUM(
        CASE WHEN a.account_type IN ('asset', 'liability', 'equity')
          THEN jl.credit ELSE
          CASE WHEN t.txn_date >= ${fyStart} THEN jl.credit ELSE 0 END
        END
      ), 0) as total_credit
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
      AND jl.transaction_id IN (
        SELECT id FROM transactions
        WHERE tenant_id = ${tenantId} AND status = 'posted' AND txn_date <= ${endDate}
        AND basis <> 'cash'  -- basis: exclude cash-only entries from the accrual trial balance
        AND ${companyId ? sql`company_id = ${companyId}` : sql`TRUE`}
        AND ${adjustingCond(adjusting, 'is_adjusting')}
        ${tagExistsClause}
      )
    LEFT JOIN transactions t ON t.id = jl.transaction_id
    WHERE a.tenant_id = ${tenantId}
    GROUP BY a.id
    HAVING COALESCE(SUM(jl.debit), 0) > 0 OR COALESCE(SUM(jl.credit), 0) > 0
    ORDER BY a.account_number, a.name
  `);

  // Proper trial-balance presentation: each account shows its NET
  // balance in exactly ONE column — `debit` when the account nets to a
  // debit balance, `credit` (absolute value) when it nets to a credit
  // balance. The gross activity sums stay on the row as `total_debit` /
  // `total_credit` for API compatibility (api-v2 documents them in
  // swagger), but every first-party surface (screen, CSV/PDF export)
  // renders the netted columns. Accounts whose activity nets to zero
  // are omitted — a zero-balance row is noise on a trial balance.
  //
  // Totals must tie out to the penny for every user. Accumulate through
  // Decimal so "totalDebits === totalCredits" isn't off by fractional
  // cents.
  // Everything accumulates in Decimal from the unrounded SQL sums (U-14);
  // the number fields are derived from the same Decimals.
  const exactMode = !!tbOpts.exactAmounts;
  const netOf = new Map<object, InstanceType<typeof Decimal>>();
  type TBRow = {
    id: string | null; account_number: string | null; name: string; account_type: string;
    total_debit: number; total_credit: number; debit: number; credit: number;
    // Exact reports only.
    accountId?: string | null; total_debitExact?: string; total_creditExact?: string;
    debitExact?: string; creditExact?: string; netExact?: string;
  };
  type TBBase = { id: string | null; account_number: string | null; name: string; account_type: string };
  const tbRow = (base: TBBase, dD: InstanceType<typeof Decimal>, cD: InstanceType<typeof Decimal>): TBRow => {
    const net = dD.minus(cD);
    const row: TBRow = {
      ...base,
      total_debit: legacyNum(dD),
      total_credit: legacyNum(cD),
      debit: net.gt(0) ? legacyNum(net) : 0,
      credit: net.lt(0) ? legacyNum(net.abs()) : 0,
      ...(exactMode
        ? {
            accountId: base.id,
            total_debitExact: exactStr(dD),
            total_creditExact: exactStr(cD),
            debitExact: exactStr(net.gt(0) ? net : 0),
            creditExact: exactStr(net.lt(0) ? net.abs() : 0),
            netExact: exactStr(net),
          }
        : {}),
    };
    netOf.set(row, net);
    return row;
  };
  const data: TBRow[] = (rows.rows as any[]).map(({ pre_net: _preNet, ...r }) => tbRow(r, new Decimal(r.total_debit || 0), new Decimal(r.total_credit || 0)))
    // The HAVING above keeps accounts with LIFETIME activity; drop rows
    // that net to zero after the fiscal-YTD CASE and debit/credit netting
    // (fully-offset accounts, prior-fiscal-year-only income accounts).
    // Legacy responses also drop a net that rounds to 0 at 4 places.
    .filter((r) => !netOf.get(r)!.isZero() && (exactMode || r.debit !== 0 || r.credit !== 0));

  // Add Retained Earnings row for prior-year net income (virtual closing),
  // on the report's basis (U-213, ClientLedger PR-6 B1: it was always the
  // accrual P&L, so a cash TB with an invoice open at a year end did not
  // balance). With a tag filter it is the prior-years income of the same
  // transaction-level set as the rows (U-213 S2; the line-level P&L could
  // drift on mixed-tag entries).
  if (fyStart > '1900-01-02') {
    // UTC arithmetic so the day-before subtraction can't drift across a
    // month boundary in a non-UTC container.
    const priorEndDate = new Date(fyStart + 'T00:00:00Z');
    priorEndDate.setUTCDate(priorEndDate.getUTCDate() - 1);
    const priorEnd = priorEndDate.toISOString().split('T')[0]!;
    const reD = tagId
      ? dsum((rows.rows as any[]).map((r) => r.pre_net ?? 0))
      : dec((await buildProfitAndLoss(tenantId, '1900-01-01', priorEnd, basis, companyId, null, null, { adjusting, exactAmounts: true })).netIncomeExact);
    if (!reD.isZero()) {
      // Retained earnings is a credit-balance equity account. Numbered
      // 30120 to sort beside the posted Retained Earnings account (the
      // seeds use 30120; the old '3900' sorted it away from equity), and
      // labeled "(Prior Years)" so the virtual row is distinguishable
      // from the real account when closing entries have been posted.
      const reDebit = reD.lt(0) ? reD.abs() : new Decimal(0);
      const reCredit = reD.gt(0) ? reD : new Decimal(0);
      data.push(tbRow(
        { id: null, account_number: '30120', name: 'Retained Earnings (Prior Years)', account_type: 'equity' },
        reDebit, reCredit,
      ));
    }
  }
  const td = dsum(data.map((r) => { const n = netOf.get(r)!; return n.gt(0) ? n : 0; }));
  const tc = dsum(data.map((r) => { const n = netOf.get(r)!; return n.lt(0) ? n.abs() : 0; }));
  const totalDebits = legacyNum(td);
  const totalCredits = legacyNum(tc);

  // Sort by account number to maintain proper order after adding Retained Earnings
  data.sort((a: any, b: any) => {
    const numA = a.account_number || '9999';
    const numB = b.account_number || '9999';
    return numA.localeCompare(numB, undefined, { numeric: true });
  });

  if (exactMode) {
    let out: TBRow[] = data;
    if (tbOpts.accountTree) {
      const tree = await loadAccountTree(tenantId);
      out = applyAccountTree(data as Array<TBRow & { accountId: string | null }>, tree,
        (r) => netOf.get(r) ?? dec(r.netExact),
        (n) => tbRow({ id: n.id, account_number: n.accountNumber, name: n.name, account_type: n.accountType }, new Decimal(0), new Decimal(0)) as TBRow & { accountId: string | null });
    }
    return {
      title: 'Trial Balance', startDate, endDate, data: out, totalDebits, totalCredits,
      totalDebitsExact: exactStr(td), totalCreditsExact: exactStr(tc),
    };
  }
  return { title: 'Trial Balance', startDate, endDate, data, totalDebits, totalCredits };
}

// Account Activity Summary — per-account TOTAL DEBITS and TOTAL CREDITS
// for the period, plus a signed Net column (debits − credits). This
// preserves the presentation the Trial Balance had before it moved to
// proper netted single-column format.
//
// Unlike the Trial Balance, this is a plain ACTIVITY report: it sums
// journal-line debits/credits for ALL account types strictly within the
// start..end date range — no cumulative-through-end-date treatment for
// balance sheet accounts and no fiscal-YTD reset for income accounts.
// (The TB's hybrid window answers "what does each account's balance net
// to"; this report answers "how much moved through each account".)
export async function buildAccountActivitySummary(
  tenantId: string,
  startDate: string,
  endDate: string,
  companyId: string | null = null,
  // Same transaction-level EXISTS tag semantic as the Trial Balance:
  // include every line of any transaction that has at least one line
  // carrying the tag, so both sides of a tagged entry stay visible.
  tagId: string | null = null,
  // exactAmounts (U-14): *Exact strings on rows and totals.
  aaOpts: { exactAmounts?: boolean } = {},
) {
  const tagExistsClause = tagId
    ? sql` AND EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.transaction_id = transactions.id AND jl2.tenant_id = ${tenantId} AND jl2.tag_id IN ${tagIn(tagId)})`
    : sql``;

  const rows = await db.execute(sql`
    SELECT a.id, a.account_number, a.name, a.account_type,
      COALESCE(SUM(jl.debit), 0) as total_debit,
      COALESCE(SUM(jl.credit), 0) as total_credit
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = ${tenantId}
      AND jl.transaction_id IN (
        SELECT id FROM transactions
        WHERE tenant_id = ${tenantId} AND status = 'posted'
        AND basis <> 'cash'  -- basis: exclude cash-only entries from the accrual activity summary
        AND txn_date >= ${startDate} AND txn_date <= ${endDate}
        AND ${companyId ? sql`company_id = ${companyId}` : sql`TRUE`}
        ${tagExistsClause}
      )
    WHERE a.tenant_id = ${tenantId}
    GROUP BY a.id
    HAVING COALESCE(SUM(jl.debit), 0) > 0 OR COALESCE(SUM(jl.credit), 0) > 0
    ORDER BY a.account_number, a.name
  `);

  // Decimal accumulation so the TOTAL row ties to the row sums exactly.
  type ActivityRow = {
    id: string;
    account_number: string | null;
    name: string;
    account_type: string;
    total_debit: string;
    total_credit: string;
  };
  let td = new Decimal('0');
  let tc = new Decimal('0');
  const data = (rows.rows as unknown as ActivityRow[]).map((r) => {
    const d = dec(r.total_debit);
    const c = dec(r.total_credit);
    td = td.plus(d);
    tc = tc.plus(c);
    return {
      ...r, total_debit: legacyNum(d), total_credit: legacyNum(c), net: legacyNum(d.minus(c)),
      ...(aaOpts.exactAmounts
        ? { total_debitExact: exactStr(d), total_creditExact: exactStr(c), netExact: exactStr(d.minus(c)) }
        : {}),
    };
  });

  return {
    title: 'Account Activity Summary',
    startDate,
    endDate,
    data,
    totalDebits: legacyNum(td),
    totalCredits: legacyNum(tc),
    totalNet: legacyNum(td.minus(tc)),
    ...(aaOpts.exactAmounts
      ? { totalDebitsExact: exactStr(td), totalCreditsExact: exactStr(tc), totalNetExact: exactStr(td.minus(tc)) }
      : {}),
  };
}

export async function buildTransactionList(tenantId: string, filters?: {
  startDate?: string; endDate?: string; txnType?: string; accountId?: string;
  // ADR 0XX §5.2 — header-level tag filter: keep the transaction when
  // any of its journal_lines carries this tag.
  tagId?: string;
  basis?: Basis;
  /** U-60 adjusting lens (default include). */
  adjusting?: AdjustingFilter | null;
  /**
   * Exact reports (U-14): rows also carry line_id (the journal line; on cash
   * basis the line passed through, null for a share of a paid document),
   * account_id and line_contact_id (the line's client, U-202).
   */
  exactAmounts?: boolean;
  /** U-202: several accounts (line level). */
  accountIds?: string[] | null;
  /** U-202: per-line lens (report-lens.ts). */
  lens?: LineLens | null;
}, companyId: string | null = null) {
  const lineIdCol = filters?.exactAmounts
    ? sql`jl.id AS line_id, jl.account_id, COALESCE(jl.contact_id, t.contact_id) AS line_contact_id, ` : sql``;
  const cbLineIdCol = filters?.exactAmounts
    ? sql`cb.line_id AS line_id, cb.account_id, COALESCE(cb.line_contact_id, cb.txn_contact_id) AS line_contact_id, ` : sql``;
  const lens = lensIsEmpty(filters?.lens) ? null : filters!.lens!;
  const ids = filters?.accountIds && filters.accountIds.length > 0 ? filters.accountIds : null;
  const idsIn = (col: string) => sql`${sql.raw(col)} IN (${sql.join(ids!.map((id) => sql`${id}`), sql`, `)})`;
  // Cash basis: list the virtual cash-basis ledger (income/expense recognition
  // moved to payment dates), one row per cash-basis line. Accrual: the posted
  // journal (excluding cash-only entries).
  if (filters?.basis === 'cash') {
    const end = filters?.endDate || new Date().toISOString().split('T')[0]!;
    const start = filters?.startDate || null;
    const typeCond = filters?.txnType ? sql`AND cb.txn_type = ${filters.txnType}` : sql``;
    const acctCond = filters?.accountId ? sql`AND cb.account_id = ${filters.accountId}` : sql``;
    const tagCond = filters?.tagId ? sql`AND cb.tag_id IN ${tagIn(filters.tagId)}` : sql``;
    const idsCond = ids ? sql`AND ${idsIn('cb.account_id')}` : sql``;
    const lensCond = lens ? sql`AND ${lensSql(tenantId, lens, CASH_COLS)}` : sql``;
    const cashRows = await executeCashBasis(sql`
      WITH ${cashBasisLinesWith(tenantId, start, end, companyId, filters?.adjusting ?? null)}
      SELECT cb.transaction_id AS id, ${cbLineIdCol}cb.txn_type, cb.txn_number, cb.txn_date, cb.memo, 'posted' AS status,
        c.display_name AS contact_name,
        a.account_number, a.name AS account_name,
        CASE WHEN a.account_number IS NOT NULL AND a.account_number <> ''
             THEN a.account_number || ' · ' || a.name ELSE a.name END AS account,
        cb.debit, cb.credit,
        (cb.debit::numeric - cb.credit::numeric) AS amount,
        cb.description AS line_description,
        tg.name AS line_tag
      FROM cb_lines cb
      JOIN accounts a ON a.id = cb.account_id AND a.tenant_id = ${tenantId}
      LEFT JOIN contacts c ON c.id = cb.txn_contact_id AND c.tenant_id = ${tenantId}
      LEFT JOIN tags tg ON tg.id = cb.tag_id AND tg.tenant_id = ${tenantId}
      WHERE (cb.debit <> 0 OR cb.credit <> 0) ${typeCond} ${acctCond} ${tagCond} ${idsCond} ${lensCond}
      ORDER BY cb.txn_date DESC, cb.transaction_id, cb.line_order
    `);
    return { title: 'Transaction List', data: cashRows.rows };
  }

  const conditions = [sql`t.tenant_id = ${tenantId}`, sql`t.status = 'posted'`, companyFilter(companyId), sql`t.basis <> 'cash'`,
    adjustingCond(filters?.adjusting ?? null, 't.is_adjusting')];
  if (filters?.startDate) conditions.push(sql`t.txn_date >= ${filters.startDate}`);
  if (filters?.endDate) conditions.push(sql`t.txn_date <= ${filters.endDate}`);
  if (filters?.txnType) conditions.push(sql`t.txn_type = ${filters.txnType}`);
  // Line-level account filter (the cash branch honors it; accrual silently
  // ignored it, so ?account_id returned every account's lines).
  if (filters?.accountId) conditions.push(sql`jl.account_id = ${filters.accountId}`);
  if (filters?.tagId) {
    conditions.push(sql`EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.transaction_id = t.id AND jl.tenant_id = ${tenantId} AND jl.tag_id IN ${tagIn(filters.tagId)})`);
  }
  if (ids) conditions.push(idsIn('jl.account_id'));
  if (lens) conditions.push(lensSql(tenantId, lens, ACCRUAL_COLS));

  // One row per journal LINE (not per transaction), so a split shows each of
  // its lines with its account instead of a single "Split" row. `amount` is
  // signed to the accounting convention: debits positive, credits negative.
  // Void transactions are already excluded (status = 'posted' above); the
  // is_void_reversal filter drops the reversing lines the voider persisted.
  const rows = await db.execute(sql`
    SELECT t.id, ${lineIdCol}t.txn_type, ${docNumberSql('t')} AS txn_number, t.txn_date, t.memo, t.status,
      -- STATEMENT_CHECK_PAYEE_V1 — fall back to the check-image payee.
      COALESCE(c.display_name, t.payee_name_on_check) as contact_name,
      a.account_number, a.name AS account_name,
      CASE WHEN a.account_number IS NOT NULL AND a.account_number <> ''
           THEN a.account_number || ' · ' || a.name ELSE a.name END AS account,
      jl.debit, jl.credit,
      (jl.debit::numeric - jl.credit::numeric) AS amount,
      jl.description AS line_description,
      tg.name AS line_tag
    FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.tenant_id = ${tenantId} AND jl.is_void_reversal = false
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${tenantId}
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    LEFT JOIN tags tg ON tg.id = jl.tag_id AND tg.tenant_id = ${tenantId}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.txn_date DESC, t.created_at DESC, jl.line_order
  `);

  return { title: 'Transaction List', data: rows.rows };
}

export async function buildJournalEntryReport(
  tenantId: string,
  dateRange?: DateRange,
  companyId: string | null = null,
  // ADR 0XX §5.2 — Journal Entry / Transaction Detail report uses the
  // header semantic: keep the journal entry if any of its lines carry
  // the tag. Line-level fidelity is still available in the GL / Account
  // Detail views, which filter line-by-line.
  tagId: string | null = null,
  adjusting: AdjustingFilter | null = null,
  jeOpts: { exactAmounts?: boolean } = {},
) {
  return buildTransactionList(
    tenantId,
    { ...dateRange, txnType: 'journal_entry', ...(tagId ? { tagId } : {}), adjusting, exactAmounts: jeOpts.exactAmounts },
    companyId,
  );
}

export async function buildAccountReport(
  tenantId: string,
  accountId: string,
  dateRange?: DateRange,
  companyId: string | null = null,
  tagId: string | null = null,
) {
  return buildCheckRegister(tenantId, accountId, dateRange, companyId, tagId);
}
