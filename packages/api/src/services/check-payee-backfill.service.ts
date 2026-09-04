// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// STATEMENT_CHECK_PAYEE_V2 — backfill payees onto EXISTING posted check
// transactions that have a check number but no payee/contact (Plaid checks,
// pre-V2 statement imports). Two authoritative sources, matched by check
// number and confirmed by amount within a cent:
//   1. bank_statement_lines.payee   — payees read off statement check images
//   2. payroll_check_register_rows  — the payroll check register (payee_name
//                                     is NOT NULL there by schema)
// Optionally re-scans already-uploaded statement PDFs through the V2
// check-crop pass to harvest payees that pre-V2 parses never read.

import crypto from 'crypto';
import { sql, eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bankFeedItems, contacts } from '../db/schema/index.js';
import { log } from '../utils/logger.js';
import { auditLog } from '../middleware/audit.js';
import { matchByName } from './ai-name-match.js';

export interface BackfillReport {
  scannedTransactions: number;
  payeesApplied: number;
  contactsLinked: number;
  /**
   * Rows whose memo was still the bank's generic descriptor ("CHECK 3607",
   * "Unknown") and has been replaced with the payee. Only untouched memos are
   * rewritten — see the guard on the UPDATE below.
   */
  memosFilled: number;
  fromStatementLines: number;
  fromPayrollRegister: number;
  rescan?: { statementsScanned: number; checksRead: number; payeesApplied: number };
}

interface TargetTxn {
  id: string;
  check_number: number;
  total: string | null;
  contact_id: string | null;
}

const centsOf = (v: string | number | null | undefined): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : null;
};

/**
 * Posted MONEY-OUT check transactions with a number but no payee identity.
 * A check image is a check WE wrote (money out), so only money-out types
 * are valid targets — never a deposit that happens to carry a check number
 * (e.g. an "NSF REF #1042" reversal), which would otherwise be stamped with
 * the original check's payee.
 */
async function findTargets(tenantId: string, companyId?: string | null): Promise<TargetTxn[]> {
  const res = await db.execute(sql`
    SELECT id, check_number, total, contact_id
    FROM transactions
    WHERE tenant_id = ${tenantId}
      AND (${companyId ?? null}::uuid IS NULL OR company_id = ${companyId ?? null}::uuid OR company_id IS NULL)
      AND check_number IS NOT NULL
      AND txn_type IN ('check', 'expense', 'bill_payment')
      AND (payee_name_on_check IS NULL OR payee_name_on_check = '')
      AND contact_id IS NULL
      AND voided_at IS NULL
    ORDER BY check_number
  `);
  return res.rows as unknown as TargetTxn[];
}

/**
 * Put the check payee into the MEMO of already-stamped transactions.
 *
 * payee_name_on_check is metadata almost nothing displays. The memo is what
 * the register, every report and the Uncategorized screen actually read, and a
 * bank-feed posting carries the bank's own descriptor there — "CHECK 3607",
 * "Unknown" — which tells a bookkeeper nothing. This covers both the rows this
 * backfill just stamped and the ones that were posted with a payee already on
 * them (the feed fill ran before approve).
 *
 * Only a memo nobody has touched is rewritten: blank, the literal "unknown",
 * or still character-for-character the source feed item's description. A memo
 * a person typed is left exactly as it is. Voided rows are skipped.
 */
async function fillCheckMemosFromPayee(tenantId: string, companyId?: string | null): Promise<number> {
  const res = await db.execute(sql`
    UPDATE transactions t
    SET memo = CASE
          WHEN t.check_number IS NOT NULL
          THEN 'Check ' || t.check_number || ' - ' || t.payee_name_on_check
          ELSE t.payee_name_on_check
        END
    WHERE t.tenant_id = ${tenantId}
      AND (${companyId ?? null}::uuid IS NULL OR t.company_id = ${companyId ?? null}::uuid OR t.company_id IS NULL)
      AND COALESCE(btrim(t.payee_name_on_check), '') <> ''
      AND t.txn_type IN ('check', 'expense', 'bill_payment')
      AND t.voided_at IS NULL
      AND (
        COALESCE(btrim(t.memo), '') = ''
        OR lower(btrim(t.memo)) = 'unknown'
        -- A memo that is only the word "check", with or without the number
        -- ("Check", "CHECK 3607", "Check #1234"), is the bank's descriptor
        -- carried through, not something a person wrote. Replacing it with
        -- "Check 3607 - Acme Supply Co" strictly adds information.
        OR btrim(t.memo) ~* '^check[[:space:]]*#?[[:space:]]*[0-9]*$'
        OR EXISTS (
          SELECT 1 FROM bank_feed_items b
          WHERE b.tenant_id = t.tenant_id
            AND b.matched_transaction_id = t.id
            AND b.description = t.memo
        )
      )
  `);
  return (res as { rowCount?: number | null }).rowCount ?? 0;
}

/** check# → payee candidates from both sources, amounts in abs cents.
 * Company-scoped when a companyId is given: check numbers restart around
 * ~1001 in every account, so company A's register must never stamp
 * payees onto company B's checks inside the same tenant. */
async function loadPayeeSources(tenantId: string, companyId?: string | null): Promise<Map<number, Array<{ payee: string; cents: number | null; source: 'statement' | 'payroll' }>>> {
  const out = new Map<number, Array<{ payee: string; cents: number | null; source: 'statement' | 'payroll' }>>();
  const add = (num: number, payee: string, cents: number | null, source: 'statement' | 'payroll') => {
    if (!Number.isFinite(num) || num <= 0 || !payee.trim()) return;
    (out.get(num) ?? out.set(num, []).get(num)!).push({ payee: payee.trim(), cents, source });
  };

  const stmt = await db.execute(sql`
    SELECT l.check_number, l.payee, l.amount
    FROM bank_statement_lines l
    JOIN bank_statements st ON st.id = l.statement_id
    WHERE l.tenant_id = ${tenantId}
      AND (${companyId ?? null}::uuid IS NULL OR st.company_id = ${companyId ?? null}::uuid OR st.company_id IS NULL)
      AND l.payee IS NOT NULL AND l.payee <> '' AND l.check_number IS NOT NULL
  `);
  for (const r of stmt.rows as Array<{ check_number: string; payee: string; amount: string }>) {
    add(Number(r.check_number), r.payee, centsOf(r.amount), 'statement');
  }

  const payroll = await db.execute(sql`
    SELECT r.check_number, r.payee_name, r.amount
    FROM payroll_check_register_rows r
    JOIN payroll_import_sessions s ON s.id = r.session_id
    WHERE s.tenant_id = ${tenantId}
      AND (${companyId ?? null}::uuid IS NULL OR s.company_id = ${companyId ?? null}::uuid OR s.company_id IS NULL)
      AND r.check_number IS NOT NULL
  `);
  for (const r of payroll.rows as Array<{ check_number: string; payee_name: string; amount: string }>) {
    add(Number(r.check_number), r.payee_name, centsOf(r.amount), 'payroll');
  }
  return out;
}

/**
 * Apply payees to targets. Amount confirmation: when both sides carry an
 * amount they must agree within a cent; a source without an amount only
 * applies when it is the SOLE candidate payee for that check number.
 */
export async function backfillCheckPayees(
  tenantId: string,
  opts: { rescan?: boolean; companyId?: string | null } = {},
  userId?: string,
): Promise<BackfillReport> {
  const targets = await findTargets(tenantId, opts.companyId);
  const sources = await loadPayeeSources(tenantId, opts.companyId);
  const tenantContacts = await db.query.contacts.findMany({
    where: eq(contacts.tenantId, tenantId),
    columns: { id: true, displayName: true },
  });
  const report: BackfillReport = {
    scannedTransactions: targets.length,
    payeesApplied: 0,
    contactsLinked: 0,
    memosFilled: 0,
    fromStatementLines: 0,
    fromPayrollRegister: 0,
  };

  for (const txn of targets) {
    const candidates = sources.get(Number(txn.check_number)) ?? [];
    if (candidates.length === 0) continue;
    const txnCents = centsOf(txn.total);

    let chosen: { payee: string; source: 'statement' | 'payroll' } | null = null;
    const amountConfirmed = candidates.filter(
      (c) => c.cents != null && txnCents != null && Math.abs(c.cents - txnCents) <= 1,
    );
    if (amountConfirmed.length > 0) {
      chosen = amountConfirmed[0]!;
    } else {
      // Sole-payee fallback ONLY when no source actively contradicts:
      // a candidate whose readable amount disagrees with the txn is a
      // different check that happens to share the number — applying its
      // payee anyway is a wrong-payee write, not a weak match.
      const contradicted = candidates.some(
        (c) => c.cents != null && txnCents != null && Math.abs(c.cents - txnCents) > 1,
      );
      const distinctPayees = new Set(candidates.map((c) => c.payee.toLowerCase()));
      if (!contradicted && distinctPayees.size === 1) chosen = candidates[0]!;
    }
    if (!chosen) continue;

    // Contact link only on a unique name match — never guess.
    const contact = matchByName(tenantContacts, (c) => c.displayName, chosen.payee);
    const contactId: string | null = contact?.id ?? null;

await db.execute(sql`
      UPDATE transactions
      SET payee_name_on_check = ${chosen.payee},
          contact_id = COALESCE(contact_id, ${contactId})
      WHERE id = ${txn.id} AND tenant_id = ${tenantId}
    `);
    report.payeesApplied += 1;
    if (contactId) report.contactsLinked += 1;
    if (chosen.source === 'statement') report.fromStatementLines += 1;
    else report.fromPayrollRegister += 1;
  }

  report.memosFilled = await fillCheckMemosFromPayee(tenantId, opts.companyId);

  if (opts.rescan) {
    report.rescan = await rescanStatements(tenantId, opts.companyId);
    if (report.rescan.payeesApplied > 0) {
      // New statement-line payees may unlock more targets — one more pass.
      const second = await backfillCheckPayees(tenantId, { companyId: opts.companyId }, userId);
      report.payeesApplied += second.payeesApplied;
      report.contactsLinked += second.contactsLinked;
      report.memosFilled += second.memosFilled;
      report.fromStatementLines += second.fromStatementLines;
      report.fromPayrollRegister += second.fromPayrollRegister;
    }
  }

  // entity_id is a uuid column — mint a run id so each backfill is traceable.
  await auditLog(tenantId, 'update', 'check_payee_backfill', crypto.randomUUID(), null, { ...report }, userId);
  return report;
}

const RESCAN_STATEMENT_CAP = 25;

/**
 * Re-run the V2 check-crop pass over already-uploaded statement PDFs and
 * write newly-read payees onto their bank_statement_lines (matched by check
 * number; amount confirmed within a cent when the crop read one).
 */
async function rescanStatements(tenantId: string, companyId?: string | null): Promise<NonNullable<BackfillReport['rescan']>> {
  const { extractCheckCandidateImages, readChecksFromCandidates } = await import('./extraction/check-crop.service.js');
  const aiConfigService = await import('./ai-config.service.js');
  const { env } = await import('../config/env.js');
  const { getProviderForTenant } = await import('./storage/storage-provider.factory.js');
  const { checkTenantTaskConsent } = await import('./ai-consent.service.js');

  const result = { statementsScanned: 0, checksRead: 0, payeesApplied: 0 };

  const rawConfig = await aiConfigService.getRawConfig();
  const config = await aiConfigService.getConfig();
  // Same gates the normal statement-parse path gets via createJob: AI
  // master switch + per-company statement_parsing consent. Without
  // these, a company that explicitly disabled AI statement parsing
  // could still have its stored PDFs pushed through the OCR models by
  // anyone clicking "Backfill" with rescan on.
  if (!config.isEnabled) return result;
  const glm = await aiConfigService.resolveGlmOcrConfig();
  const ocrProvider = config.ocrProvider || config.categorizationProvider;

  // Statements that still have payee-less check lines and a stored file.
  const stmts = await db.execute(sql`
    SELECT DISTINCT s.id, s.company_id, a.storage_key, a.file_path
    FROM bank_statements s
    JOIN attachments a ON a.id = s.attachment_id
    JOIN bank_statement_lines l ON l.statement_id = s.id
    WHERE s.tenant_id = ${tenantId}
      AND (${companyId ?? null}::uuid IS NULL OR s.company_id = ${companyId ?? null}::uuid OR s.company_id IS NULL)
      AND l.check_number IS NOT NULL AND (l.payee IS NULL OR l.payee = '')
    LIMIT ${RESCAN_STATEMENT_CAP}
  `);

  const consentByCompany = new Map<string, boolean>();
  const companyConsent = async (cid: string | null): Promise<boolean> => {
    const key = cid ?? '__tenant__';
    if (!consentByCompany.has(key)) {
      const check = await checkTenantTaskConsent(tenantId, 'statement_parsing', cid);
      consentByCompany.set(key, check.allowed);
    }
    return consentByCompany.get(key)!;
  };

  for (const s of stmts.rows as Array<{ id: string; company_id: string | null; storage_key: string | null; file_path: string | null }>) {
    if (!(await companyConsent(s.company_id))) continue;
    let pdf: Buffer | null = null;
    try {
      const provider = await getProviderForTenant(tenantId);
      if (s.storage_key) pdf = await provider.download(s.storage_key);
      else if (s.file_path) {
        const fs = await import('fs');
        if (fs.existsSync(s.file_path)) pdf = fs.readFileSync(s.file_path);
      }
    } catch (err) {
      log.warn({ component: 'check-backfill', event: 'statement_fetch_failed', statementId: s.id, message: err instanceof Error ? err.message : String(err) });
    }
    if (!pdf) continue;

    result.statementsScanned += 1;
    const candidates = await extractCheckCandidateImages(pdf);
    if (candidates.length === 0) continue;
    const reads = await readChecksFromCandidates(candidates, {
      glm: glm.enabled
        ? { baseUrl: glm.baseUrl, model: glm.model, timeoutMs: glm.timeoutMs, concurrency: glm.concurrency, apiKey: glm.apiKey }
        : null,
      vision: ocrProvider
        ? { rawConfig, ocrProvider, primaryModel: config.ocrModel || env.OCR_VISION_MODEL, task: 'ocr_statement_checks' }
        : null,
    });
    result.checksRead += reads.length;

    for (const read of reads) {
      const upd = await db.execute(sql`
        UPDATE bank_statement_lines
        SET payee = ${read.payee}
        WHERE tenant_id = ${tenantId} AND statement_id = ${s.id}
          AND check_number = ${read.checkNumber}
          AND (payee IS NULL OR payee = '')
          -- Debit lines only: statement amounts are credit-positive /
          -- debit-negative, so a check (money out) is the negative side.
          -- Never stamp a check payee onto a same-number deposit line.
          AND amount < 0
          AND (${read.amount ?? null}::numeric IS NULL OR abs(abs(amount) - abs(${read.amount ?? null}::numeric)) <= 0.01)
      `);
      result.payeesApplied += (upd as { rowCount?: number | null }).rowCount ?? 0;
    }
  }
  return result;
}

// ── Bank-feed variant (STATEMENT_CHECK_PAYEE_FEED) ───────────────
//
// backfillCheckPayees above repairs POSTED transactions. This one repairs
// the step before that: check rows sitting UNPOSTED in the bank feed with no
// payee, which is where they land when the feed item arrived (from Plaid, or
// an earlier import) before the statement that names the payee was parsed.
//
// The existing `applyCheckImagePayees` in bank-feed.service already does this
// correlation, but only at statement-import time and only over the rows that
// same import just created — a feed item that was already sitting there is
// never revisited. Everything here is the same matching rule (check number,
// confirmed by amount within a cent, debit side only) sourced from the stored
// bank_statement_lines instead of a live parse result.

export interface FeedPayeeBackfillMatch {
  feedItemId: string;
  checkNumber: number;
  amount: string;
  payee: string;
  /** Existing contact matched by name, or a vendor we would create. */
  contactAction: 'linked' | 'created' | 'none';
  suggestedAccountId: string | null;
  suggestedAccountName: string | null;
}

export interface FeedPayeeBackfillReport {
  dryRun: boolean;
  scannedItems: number;
  matched: number;
  payeesApplied: number;
  contactsLinked: number;
  contactsCreated: number;
  categoriesSuggested: number;
  /** Matched a payee but history gave no unambiguous account — needs a human. */
  needsCategory: number;
  matches: FeedPayeeBackfillMatch[];
}

interface FeedTarget {
  id: string;
  check_number: number;
  amount: string;
  company_id: string | null;
  payee_name_on_check: string | null;
  suggested_contact_id: string | null;
}

/**
 * Unposted check rows the feed can still improve. Two shapes:
 *
 *  1. No payee at all — fill it from the statement lines.
 *  2. A payee, but no vendor link — the payee text is already right, the row
 *     just isn't connected to a contact. This is the state the AI step used
 *     to leave rows in (it nulled the check-image contact), and it is also
 *     what happens when contact creation was declined or failed. Without
 *     this case the button skips exactly the rows a user is looking at when
 *     they say "I have the payee but it isn't matching a name".
 *
 * Money-out only (`amount > 0` is an outflow on bank_feed_items): a check is
 * something we wrote, so a deposit that happens to quote a check number in
 * its description must never inherit that check's payee. Same guard
 * applyCheckImagePayees uses.
 *
 * Company scoping accepts NULL company_id rows because Plaid-sourced feed
 * items carry no company — excluding them would skip exactly the rows this
 * is meant to repair.
 */
async function findFeedTargets(tenantId: string, companyId?: string | null): Promise<FeedTarget[]> {
  const res = await db.execute(sql`
    SELECT id, check_number, amount, company_id, payee_name_on_check, suggested_contact_id
    FROM bank_feed_items
    WHERE tenant_id = ${tenantId}
      AND (${companyId ?? null}::uuid IS NULL OR company_id = ${companyId ?? null}::uuid OR company_id IS NULL)
      AND check_number IS NOT NULL
      AND amount > 0
      AND status IN ('pending', 'assigned')
      AND (
        (payee_name_on_check IS NULL OR payee_name_on_check = '')
        OR suggested_contact_id IS NULL
      )
    ORDER BY check_number
  `);
  return res.rows as unknown as FeedTarget[];
}

/**
 * check# → statement payees. Separate from loadPayeeSources above because
 * bank_statement_lines.check_number is VARCHAR while bank_feed_items
 * .check_number is INTEGER, so the join needs an explicit cast — and the
 * cast has to be guarded, since the column legitimately holds values like
 * '1042A' (a bank's check-sequence marker) that would abort the query.
 */
async function loadStatementPayeesByCheckNumber(
  tenantId: string,
  companyId?: string | null,
): Promise<Map<number, Array<{ payee: string; cents: number | null }>>> {
  const out = new Map<number, Array<{ payee: string; cents: number | null }>>();
  const res = await db.execute(sql`
    SELECT l.check_number, l.payee, l.amount
    FROM bank_statement_lines l
    JOIN bank_statements st ON st.id = l.statement_id
    WHERE l.tenant_id = ${tenantId}
      AND (${companyId ?? null}::uuid IS NULL OR st.company_id = ${companyId ?? null}::uuid OR st.company_id IS NULL)
      AND l.payee IS NOT NULL AND l.payee <> ''
      AND l.check_number IS NOT NULL
      -- Debit lines only (statement amounts are credit-positive), so a
      -- same-numbered deposit line can't supply a check payee.
      AND l.amount < 0
  `);
  for (const r of res.rows as Array<{ check_number: string; payee: string; amount: string }>) {
    // '1042A' / '1042*' are variants of check 1042; parseInt buckets them
    // the same way applyCheckImagePayees does.
    const num = Number.parseInt(String(r.check_number), 10);
    if (!Number.isFinite(num) || num <= 0) continue;
    const payee = String(r.payee).trim();
    if (!payee) continue;
    const arr = out.get(num) ?? [];
    arr.push({ payee, cents: centsOf(r.amount) });
    out.set(num, arr);
  }
  return out;
}

/**
 * Fill payee (and, where history is unambiguous, the category) on unposted
 * check rows in the bank feed from statement data already on file.
 *
 * `dryRun` reports exactly what would be written without touching anything,
 * including the contacts it would create — the intended first click, because
 * the write path can auto-create vendor contacts.
 */
export async function backfillFeedItemCheckPayees(
  tenantId: string,
  opts: { dryRun?: boolean; createMissingContacts?: boolean; companyId?: string | null } = {},
  userId?: string,
): Promise<FeedPayeeBackfillReport> {
  const dryRun = opts.dryRun === true;
  const createMissingContacts = opts.createMissingContacts !== false;
  const companyId = opts.companyId ?? null;

  const targets = await findFeedTargets(tenantId, companyId);
  const sources = await loadStatementPayeesByCheckNumber(tenantId, companyId);
  const report: FeedPayeeBackfillReport = {
    dryRun,
    scannedItems: targets.length,
    matched: 0,
    payeesApplied: 0,
    contactsLinked: 0,
    contactsCreated: 0,
    categoriesSuggested: 0,
    needsCategory: 0,
    matches: [],
  };
  if (targets.length === 0 || sources.size === 0) return report;

  const tenantContacts = await db.query.contacts.findMany({
    where: eq(contacts.tenantId, tenantId),
    columns: { id: true, displayName: true },
  });
  const contactsService = await import('./contacts.service.js');
  const { suggestAccountFromPayeeHistory } = await import('./categorization-ai.service.js');
  const accountNameCache = new Map<string, string | null>();

  for (const item of targets) {
    const existingPayee = (item.payee_name_on_check ?? '').trim();
    let payee: string | null = existingPayee || null;

    // Only consult the statement when the row has no payee of its own. A row
    // that already carries one is here to be linked, not re-read.
    if (!payee) {
      const candidates = sources.get(Number(item.check_number)) ?? [];
      if (candidates.length === 0) continue;
      const itemCents = centsOf(item.amount);

      // Identical selection rule to the posted-transaction path: prefer an
      // amount-confirmed candidate; otherwise accept a sole payee only when no
      // candidate's readable amount actively contradicts this row.
      const amountConfirmed = candidates.filter(
        (c) => c.cents != null && itemCents != null && Math.abs(c.cents - itemCents) <= 1,
      );
      if (amountConfirmed.length > 0) {
        payee = amountConfirmed[0]!.payee;
      } else {
        const contradicted = candidates.some(
          (c) => c.cents != null && itemCents != null && Math.abs(c.cents - itemCents) > 1,
        );
        const distinct = new Set(candidates.map((c) => c.payee.toLowerCase()));
        if (!contradicted && distinct.size === 1) payee = candidates[0]!.payee;
      }
    }
    if (!payee) continue;

    report.matched += 1;

    let contact = matchByName(tenantContacts, (c) => c.displayName, payee);
    let contactAction: FeedPayeeBackfillMatch['contactAction'] = contact ? 'linked' : 'none';
    if (!contact && createMissingContacts) {
      if (dryRun) {
        contactAction = 'created';
      } else {
        try {
          const created = await contactsService.create(tenantId, {
            displayName: payee.slice(0, 255),
            contactType: 'vendor',
          });
          contact = { id: created.id, displayName: created.displayName };
          tenantContacts.push(contact);
          contactAction = 'created';
        } catch (err) {
          // Best-effort, matching applyCheckImagePayees: a creation failure
          // still leaves the payee text on the row.
          log.warn({
            component: 'feed-check-payee-backfill',
            event: 'contact_create_failed',
            payee,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Category from what this payee has always been coded to before.
    const suggestion = await suggestAccountFromPayeeHistory(tenantId, {
      contactId: contact?.id ?? null,
      payeeName: payee,
      companyId: item.company_id,
    });
    if (suggestion) {
      if (!accountNameCache.has(suggestion.accountId)) {
        const acct = await db.execute(sql`
          SELECT name FROM accounts WHERE id = ${suggestion.accountId} AND tenant_id = ${tenantId}
        `);
        accountNameCache.set(
          suggestion.accountId,
          (acct.rows[0] as { name?: string } | undefined)?.name ?? null,
        );
      }
      report.categoriesSuggested += 1;
    } else {
      report.needsCategory += 1;
    }

    report.matches.push({
      feedItemId: item.id,
      checkNumber: Number(item.check_number),
      amount: String(item.amount),
      payee,
      contactAction,
      suggestedAccountId: suggestion?.accountId ?? null,
      suggestedAccountName: suggestion ? accountNameCache.get(suggestion.accountId) ?? null : null,
    });

    if (dryRun) continue;

    const patch: Partial<typeof bankFeedItems.$inferInsert> = {
      payeeNameOnCheck: payee.slice(0, 255),
      updatedAt: new Date(),
    };
    if (contact) {
      patch.suggestedContactId = contact.id;
      patch.matchType = 'check_image';
      patch.confidenceScore = '0.95';
    }
    if (suggestion) {
      patch.suggestedAccountId = suggestion.accountId;
      // The account is the weaker of the two claims (payee is read off the
      // check, the account is inferred), so the row's confidence reflects
      // the account when we set one.
      patch.confidenceScore = suggestion.confidence.toFixed(2);
    }
    await db.update(bankFeedItems).set(patch).where(
      and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item.id)),
    );
    report.payeesApplied += 1;
    if (contactAction === 'linked') report.contactsLinked += 1;
    if (contactAction === 'created') report.contactsCreated += 1;
  }

  if (!dryRun) {
    await auditLog(
      tenantId,
      'update',
      'feed_check_payee_backfill',
      crypto.randomUUID(),
      null,
      { ...report, matches: report.matches.length },
      userId,
    );
  }
  return report;
}
