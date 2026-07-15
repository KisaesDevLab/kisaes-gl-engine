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
import { sql, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contacts } from '../db/schema/index.js';
import { log } from '../utils/logger.js';
import { auditLog } from '../middleware/audit.js';
import { matchByName } from './ai-name-match.js';

export interface BackfillReport {
  scannedTransactions: number;
  payeesApplied: number;
  contactsLinked: number;
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
async function findTargets(tenantId: string): Promise<TargetTxn[]> {
  const res = await db.execute(sql`
    SELECT id, check_number, total, contact_id
    FROM transactions
    WHERE tenant_id = ${tenantId}
      AND check_number IS NOT NULL
      AND txn_type IN ('check', 'expense', 'bill_payment')
      AND (payee_name_on_check IS NULL OR payee_name_on_check = '')
      AND contact_id IS NULL
      AND voided_at IS NULL
    ORDER BY check_number
  `);
  return res.rows as unknown as TargetTxn[];
}

/** check# → payee candidates from both sources, amounts in abs cents. */
async function loadPayeeSources(tenantId: string): Promise<Map<number, Array<{ payee: string; cents: number | null; source: 'statement' | 'payroll' }>>> {
  const out = new Map<number, Array<{ payee: string; cents: number | null; source: 'statement' | 'payroll' }>>();
  const add = (num: number, payee: string, cents: number | null, source: 'statement' | 'payroll') => {
    if (!Number.isFinite(num) || num <= 0 || !payee.trim()) return;
    (out.get(num) ?? out.set(num, []).get(num)!).push({ payee: payee.trim(), cents, source });
  };

  const stmt = await db.execute(sql`
    SELECT check_number, payee, amount
    FROM bank_statement_lines
    WHERE tenant_id = ${tenantId} AND payee IS NOT NULL AND payee <> '' AND check_number IS NOT NULL
  `);
  for (const r of stmt.rows as Array<{ check_number: string; payee: string; amount: string }>) {
    add(Number(r.check_number), r.payee, centsOf(r.amount), 'statement');
  }

  const payroll = await db.execute(sql`
    SELECT r.check_number, r.payee_name, r.amount
    FROM payroll_check_register_rows r
    JOIN payroll_import_sessions s ON s.id = r.session_id
    WHERE s.tenant_id = ${tenantId} AND r.check_number IS NOT NULL
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
  opts: { rescan?: boolean } = {},
  userId?: string,
): Promise<BackfillReport> {
  const targets = await findTargets(tenantId);
  const sources = await loadPayeeSources(tenantId);
  const tenantContacts = await db.query.contacts.findMany({
    where: eq(contacts.tenantId, tenantId),
    columns: { id: true, displayName: true },
  });
  const report: BackfillReport = {
    scannedTransactions: targets.length,
    payeesApplied: 0,
    contactsLinked: 0,
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
      const distinctPayees = new Set(candidates.map((c) => c.payee.toLowerCase()));
      if (distinctPayees.size === 1) chosen = candidates[0]!;
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

  if (opts.rescan) {
    report.rescan = await rescanStatements(tenantId);
    if (report.rescan.payeesApplied > 0) {
      // New statement-line payees may unlock more targets — one more pass.
      const second = await backfillCheckPayees(tenantId, {}, undefined);
      report.payeesApplied += second.payeesApplied;
      report.contactsLinked += second.contactsLinked;
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
async function rescanStatements(tenantId: string): Promise<NonNullable<BackfillReport['rescan']>> {
  const { extractCheckCandidateImages, readChecksFromCandidates } = await import('./extraction/check-crop.service.js');
  const aiConfigService = await import('./ai-config.service.js');
  const { env } = await import('../config/env.js');
  const { getProviderForTenant } = await import('./storage/storage-provider.factory.js');

  const result = { statementsScanned: 0, checksRead: 0, payeesApplied: 0 };

  // Statements that still have payee-less check lines and a stored file.
  const stmts = await db.execute(sql`
    SELECT DISTINCT s.id, a.storage_key, a.file_path
    FROM bank_statements s
    JOIN attachments a ON a.id = s.attachment_id
    JOIN bank_statement_lines l ON l.statement_id = s.id
    WHERE s.tenant_id = ${tenantId}
      AND l.check_number IS NOT NULL AND (l.payee IS NULL OR l.payee = '')
    LIMIT ${RESCAN_STATEMENT_CAP}
  `);

  const rawConfig = await aiConfigService.getRawConfig();
  const config = await aiConfigService.getConfig();
  const glm = await aiConfigService.resolveGlmOcrConfig();
  const ocrProvider = config.ocrProvider || config.categorizationProvider;

  for (const s of stmts.rows as Array<{ id: string; storage_key: string | null; file_path: string | null }>) {
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
