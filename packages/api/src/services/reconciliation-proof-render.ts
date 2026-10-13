// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// PDF (HTML) and CSV renderings of the professional bank reconciliation
// (ReconProof). One renderer for the Reconciliation Detail / Summary report
// exports and the Report Pack's Bank Reconciliations pages, so they cannot
// drift apart. The section line order comes from the shared layout helpers
// (reconSummaryLines & co.) that the web screens render too.

import {
  formatIsoUS,
  reconBookProofLines,
  reconClearedRollLines,
  reconDiscrepancyComponentLines,
  reconDiscrepancyReasonLabel,
  reconMoney,
  reconSubsequentLines,
  reconSummaryLines,
  type ReconProof,
  type ReconSchedule,
  type ReconStatementLine,
} from '@kis-books/shared';
import { escapeHtml } from './report-export.service.js';

export interface ProofClearedLine {
  txnDate: string;
  txnType: string;
  txnNumber: string | null;
  description: string | null;
  payment: number | null;
  deposit: number | null;
}

export interface ProofRenderOptions {
  /** 'detail' prints every schedule item and the cleared list; 'summary' prints schedule counts/totals and the oldest items. */
  mode: 'detail' | 'summary';
  cleared?: ProofClearedLine[];
  clearedTotals?: { payments: number; deposits: number };
  /** Items per schedule in summary mode. */
  topItems?: number;
  /** Extra paragraph under the sign-off (e.g. the pack's statement-file status). */
  statementFileNote?: string;
}

export const PROOF_CSS = `<style>
  .rp h2{font-size:13px;margin:18px 0 6px 0;padding-bottom:3px;border-bottom:1px solid #d1d5db}
  .rp h3{font-size:12px;margin:12px 0 4px 0}
  .rp table.stmt{width:100%;max-width:640px;border-collapse:collapse;margin:0 0 6px 0}
  .rp table.stmt td{border:none;padding:3px 8px;font-size:11px}
  .rp table.stmt td.ind{padding-left:26px}
  .rp table.stmt tr.subtotal td{border-top:1px solid #111;font-weight:600}
  .rp table.stmt tr.result td{border-top:1px solid #111;border-bottom:3px double #111;font-weight:700}
  .rp .ok{color:#15803d;font-weight:600}
  .rp .bad{color:#b91c1c;font-weight:600}
  .rp .muted{color:#6b7280;font-size:10px}
  .rp .flag{color:#b45309;font-weight:600}
  .rp .flag-sd{color:#b91c1c;font-weight:600}
  .rp ul.expl{margin:4px 0 8px 18px;padding:0;font-size:11px}
  .rp .sign{display:grid;grid-template-columns:1fr 1fr;gap:18px 32px;margin-top:10px;font-size:11px}
  .rp .sign .ln{border-bottom:1px solid #111;min-height:16px;padding:0 2px}
  .rp .sign .cap{color:#6b7280;font-size:10px}
  .rp .avoid{page-break-inside:avoid}
</style>`;

function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  return reconMoney(v);
}

function stmtTable(lines: ReconStatementLine[]): string {
  return `<table class="stmt">${lines.map((l) => {
    const cls = l.kind === 'subtotal' ? ' class="subtotal"' : l.kind === 'result' ? ' class="result"' : '';
    const ind = l.kind === 'line' && /^(Add|Less)/.test(l.label) ? ' class="ind"' : '';
    return `<tr${cls}><td${ind}>${escapeHtml(l.label)}</td><td class="amount">${money(l.amount)}</td></tr>`;
  }).join('')}</table>`;
}

function flagHtml(flag: string | null, label: string | null): string {
  if (!flag || !label) return '';
  return `<span class="${flag === 'stale_dated' ? 'flag-sd' : 'flag'}">${escapeHtml(label)}</span>`;
}

function scheduleTable(s: ReconSchedule, mode: 'detail' | 'summary', top: number): string {
  if (s.count === 0) return '<p class="muted">None.</p>';
  const items = mode === 'detail' ? s.items : s.items.slice(0, top);
  const more = mode === 'summary' && s.items.length > items.length
    ? `<tr><td colspan="6" class="muted">… ${s.items.length - items.length} more (oldest shown) — see the Reconciliation Detail report.</td></tr>` : '';
  return `<table>
    <thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Payee / Description</th><th class="amount">Age (days)</th><th class="amount">Amount</th></tr></thead>
    <tbody>${items.map((i) => `<tr>
      <td>${escapeHtml(formatIsoUS(i.txnDate))}</td>
      <td>${escapeHtml(i.txnType.replace(/_/g, ' '))}</td>
      <td>${escapeHtml(i.number ?? '')}</td>
      <td>${escapeHtml([i.payee, i.description].filter(Boolean).join(' — '))}${i.flagLabel ? `<br>${flagHtml(i.flag, i.flagLabel)}` : ''}</td>
      <td class="amount">${i.ageDays}</td>
      <td class="amount">${money(i.amount)}</td>
    </tr>`).join('')}${more}
    <tr class="total-row"><td colspan="5">Total ${escapeHtml(s.label.toLowerCase())} (${s.count})</td><td class="amount">${money(s.total)}</td></tr>
    </tbody></table>`;
}

function clearedTable(rows: ProofClearedLine[], totals: { payments: number; deposits: number }): string {
  if (rows.length === 0) return '<p class="muted">None.</p>';
  return `<table>
    <thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Description</th><th class="amount">Payment</th><th class="amount">Deposit</th></tr></thead>
    <tbody>${rows.map((l) => `<tr>
      <td>${escapeHtml(formatIsoUS(l.txnDate))}</td>
      <td>${escapeHtml(l.txnType.replace(/_/g, ' '))}</td>
      <td>${escapeHtml(l.txnNumber ?? '')}</td>
      <td>${escapeHtml(l.description ?? '')}</td>
      <td class="amount">${l.payment ? money(l.payment) : ''}</td>
      <td class="amount">${l.deposit ? money(l.deposit) : ''}</td>
    </tr>`).join('')}
    <tr class="total-row"><td colspan="4">Total cleared</td><td class="amount">${money(totals.payments)}</td><td class="amount">${money(totals.deposits)}</td></tr>
    </tbody></table>`;
}

/** Body HTML (Sections A–E) for one reconciliation. Includes its own CSS. */
export function renderProofHtml(p: ReconProof, opts: ProofRenderOptions): string {
  const D = formatIsoUS(p.statementDate);
  const top = opts.topItems ?? 5;
  const s = p.summary;
  const parts: string[] = [PROOF_CSS, '<div class="rp">'];

  parts.push(`<p class="muted">Account: ${escapeHtml(p.accountNumber ? `${p.accountNumber} ${p.accountName}` : p.accountName)} · Statement date ${escapeHtml(D)} · Status: ${escapeHtml(p.status === 'complete' ? 'Completed' : 'In progress')}${p.orientation === 'liability' ? ' · Credit card / liability: balances shown as amounts owed' : ''}</p>`);

  // Section A
  parts.push('<div class="avoid"><h2>Reconciliation summary — statement to books</h2>');
  parts.push(stmtTable(reconSummaryLines(p)));
  parts.push(s.reconciledToBooks
    ? '<p class="ok">Reconciled to books — the adjusted statement balance equals the adjusted book balance.</p>'
    : `<p class="bad">Not reconciled to books — unreconciled difference ${escapeHtml(money(s.unreconciledDifference))}.</p>${s.explanations.length ? `<ul class="expl">${s.explanations.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}`);
  if (!s.unrecorded && s.unrecordedNote) parts.push(`<p class="muted">Unrecorded bank items: ${escapeHtml(s.unrecordedNote)}</p>`);
  parts.push('</div>');

  // Cleared roll
  parts.push('<div class="avoid"><h2>Cleared activity</h2>');
  parts.push(stmtTable(reconClearedRollLines(p)));
  parts.push('</div>');

  // Section B
  const fc = p.flagCounts;
  parts.push('<h2>Supporting schedules</h2>');
  if (fc.stale + fc.staleDated + fc.investigate > 0) {
    parts.push(`<p class="flag">Aged items: ${[
      fc.staleDated ? `${fc.staleDated} stale-dated (over 180 days)` : '',
      fc.stale ? `${fc.stale} stale (over 90 days)` : '',
      fc.investigate ? `${fc.investigate} to investigate` : '',
    ].filter(Boolean).join(' · ')}</p>`);
  }
  parts.push(`<h3>${escapeHtml(p.schedules.increases.label)} (${p.schedules.increases.count})</h3>`);
  parts.push(scheduleTable(p.schedules.increases, opts.mode, top));
  parts.push(`<h3>${escapeHtml(p.schedules.decreases.label)} (${p.schedules.decreases.count})</h3>`);
  parts.push(scheduleTable(p.schedules.decreases, opts.mode, top));
  if (s.unrecorded && p.schedules.unrecorded.length > 0) {
    parts.push(`<h3>${escapeHtml(p.labels.unrecorded)} (${p.schedules.unrecorded.length})</h3>`);
    parts.push(`<table><thead><tr><th>Date</th><th>Check #</th><th>Statement description</th><th class="amount">Amount</th></tr></thead><tbody>${
      p.schedules.unrecorded.map((u) => `<tr><td>${escapeHtml(formatIsoUS(u.lineDate))}</td><td>${escapeHtml(u.checkNumber ?? '')}</td><td>${escapeHtml(u.description ?? '')}</td><td class="amount">${money(u.amount)}</td></tr>`).join('')
    }<tr class="total-row"><td colspan="3">Total</td><td class="amount">${money(s.unrecorded.total)}</td></tr></tbody></table>`);
  }

  if (opts.mode === 'detail' && opts.cleared) {
    parts.push(`<h3>Cleared transactions (${opts.cleared.length})</h3>`);
    parts.push(clearedTable(opts.cleared, opts.clearedTotals ?? { payments: 0, deposits: 0 }));
  }

  // Section C
  parts.push('<div class="avoid"><h2>Subsequent activity — register balance</h2>');
  parts.push(stmtTable(reconSubsequentLines(p)));
  parts.push('</div>');

  // Section D
  const b = p.bookProof;
  parts.push('<div class="avoid"><h2>Book-side proof — reconciliation discrepancies</h2>');
  parts.push(stmtTable(reconBookProofLines(p)));
  parts.push(b.ties
    ? '<p class="ok">The books tie to the reconciled and outstanding items — no discrepancies.</p>'
    : `<p class="bad">Discrepancy of ${escapeHtml(money(b.discrepancy))} between the books and the reconciled activity.</p>`);
  parts.push('</div>');
  if (!b.ties) {
    const comps = reconDiscrepancyComponentLines(p);
    if (comps.length) parts.push(stmtTable(comps));
    if (b.explanations.length) parts.push(`<ul class="expl">${b.explanations.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`);
    if (b.priorChanges.length) {
      parts.push(`<h3>Changes since prior reconciliations</h3><table><thead><tr><th>Reconciliation</th><th class="amount">Cleared at completion</th><th class="amount">Cleared now</th><th class="amount">Change</th></tr></thead><tbody>${
        b.priorChanges.map((c) => `<tr><td>${escapeHtml(formatIsoUS(c.statementDate))}</td><td class="amount">${money(c.clearedAtCompletion)}</td><td class="amount">${money(c.clearedNow)}</td><td class="amount">${money(c.change)}</td></tr>`).join('')
      }</tbody></table>`);
    }
  }
  if (b.items.length) {
    parts.push(`<h3>Reconciled items changed since they were reconciled (${b.items.length})</h3><table><thead><tr><th>Reconciled</th><th>Date</th><th>Type</th><th>Number</th><th>Description</th><th>What changed</th><th class="amount">Current amount</th></tr></thead><tbody>${
      b.items.map((i) => `<tr>
        <td>${escapeHtml(i.thisReconciliation ? 'This reconciliation' : formatIsoUS(i.reconciliationDate))}</td>
        <td>${escapeHtml(i.txnDate ? formatIsoUS(i.txnDate) : '')}</td>
        <td>${escapeHtml((i.txnType ?? '').replace(/_/g, ' '))}</td>
        <td>${escapeHtml(i.number ?? '')}</td>
        <td>${escapeHtml(i.description ?? '')}</td>
        <td>${escapeHtml(i.reasons.map(reconDiscrepancyReasonLabel).join('; '))}${i.editedAt ? ` (${escapeHtml(formatIsoUS(i.editedAt))})` : ''}</td>
        <td class="amount">${i.currentAmount === null ? '—' : money(i.currentAmount)}</td>
      </tr>`).join('')
    }</tbody></table>`);
  }

  // Section E
  const so = p.signOff;
  parts.push('<div class="avoid"><h2>Sign-off</h2><div class="sign">');
  parts.push(`<div><div class="ln">${escapeHtml(so.preparedBy ?? '')}</div><div class="cap">Prepared by</div></div>`);
  parts.push(`<div><div class="ln">${escapeHtml(so.preparedAt ? formatIsoUS(so.preparedAt) : '')}</div><div class="cap">Date</div></div>`);
  parts.push(`<div><div class="ln">${escapeHtml(so.reviewedBy ?? '')}</div><div class="cap">Reviewed by</div></div>`);
  parts.push(`<div><div class="ln">${escapeHtml(so.reviewedAt ? formatIsoUS(so.reviewedAt) : '')}</div><div class="cap">Date</div></div>`);
  parts.push('</div>');
  const stmtRef = so.statementPeriod
    ? `Bank statement: ${so.statementPeriod}${so.statementFileName ? ` — ${so.statementFileName}` : ' — no file attached'}`
    : 'Bank statement: none linked to this reconciliation.';
  parts.push(`<p class="muted">${escapeHtml(stmtRef)}</p>`);
  if (opts.statementFileNote) parts.push(`<p class="muted">${opts.statementFileNote}</p>`);
  parts.push('</div></div>');
  return parts.join('\n');
}

// ─── CSV ──────────────────────────────────────────────────────────

export const PROOF_CSV_COLUMNS = [
  { key: 'line', label: 'Line' },
  { key: 'date', label: 'Date' },
  { key: 'type', label: 'Type' },
  { key: 'number', label: 'Number' },
  { key: 'description', label: 'Payee / Description' },
  { key: 'age', label: 'Age (days)' },
  { key: 'flag', label: 'Flag' },
  { key: 'amount', label: 'Amount', align: 'right' as const },
  { key: 'payment', label: 'Payment', align: 'right' as const },
  { key: 'deposit', label: 'Deposit', align: 'right' as const },
];

type CsvRow = Record<string, unknown>;

function stmtRows(lines: ReconStatementLine[]): CsvRow[] {
  return lines.map((l) => ({ line: l.label, amount: l.amount, ...(l.kind !== 'line' ? { _total: true } : {}) }));
}

function scheduleRows(s: ReconSchedule, mode: 'detail' | 'summary', top: number): CsvRow[] {
  const items = mode === 'detail' ? s.items : s.items.slice(0, top);
  return [
    ...items.map((i) => ({
      date: i.txnDate, type: i.txnType, number: i.number ?? '',
      description: [i.payee, i.description].filter(Boolean).join(' — '),
      age: String(i.ageDays), flag: i.flagLabel ?? '', amount: i.amount,
    })),
    { line: `Total ${s.label.toLowerCase()} (${s.count})`, amount: s.total, _total: true },
  ];
}

/** CSV rows for one reconciliation (the same sections, top to bottom). */
export function proofCsvRows(p: ReconProof, opts: ProofRenderOptions): CsvRow[] {
  const top = opts.topItems ?? 5;
  const label = p.accountNumber ? `${p.accountNumber} ${p.accountName}` : p.accountName;
  const rows: CsvRow[] = [];
  rows.push({ line: `--- ${label} — reconciliation as of ${p.statementDate} (${p.status === 'complete' ? 'completed' : 'in progress'}) ---` });
  rows.push({ line: '--- Reconciliation summary: statement to books ---' });
  rows.push(...stmtRows(reconSummaryLines(p)));
  rows.push({ line: p.summary.reconciledToBooks ? 'Reconciled to books' : `NOT reconciled to books: ${p.summary.explanations.join(' ')}` });
  rows.push({ line: '--- Cleared activity ---' });
  rows.push(...stmtRows(reconClearedRollLines(p)));
  rows.push({ line: `--- ${p.schedules.increases.label} (${p.schedules.increases.count}) ---` });
  rows.push(...scheduleRows(p.schedules.increases, opts.mode, top));
  rows.push({ line: `--- ${p.schedules.decreases.label} (${p.schedules.decreases.count}) ---` });
  rows.push(...scheduleRows(p.schedules.decreases, opts.mode, top));
  if (p.summary.unrecorded && p.schedules.unrecorded.length > 0) {
    rows.push({ line: `--- ${p.labels.unrecorded} (${p.schedules.unrecorded.length}) ---` });
    for (const u of p.schedules.unrecorded) {
      rows.push({ date: u.lineDate, number: u.checkNumber ?? '', description: u.description ?? '', amount: u.amount });
    }
  }
  if (opts.mode === 'detail' && opts.cleared) {
    rows.push({ line: `--- Cleared Transactions (${opts.cleared.length}) ---` });
    for (const l of opts.cleared) {
      rows.push({ date: l.txnDate, type: l.txnType, number: l.txnNumber ?? '', description: l.description ?? '', payment: l.payment, deposit: l.deposit });
    }
    rows.push({ line: 'Total Cleared', payment: opts.clearedTotals?.payments ?? 0, deposit: opts.clearedTotals?.deposits ?? 0, _total: true });
  }
  rows.push({ line: '--- Subsequent activity: register balance ---' });
  rows.push(...stmtRows(reconSubsequentLines(p)));
  rows.push({ line: '--- Book-side proof: reconciliation discrepancies ---' });
  rows.push(...stmtRows(reconBookProofLines(p)));
  rows.push(...stmtRows(reconDiscrepancyComponentLines(p)));
  for (const e of p.bookProof.explanations) rows.push({ line: e });
  for (const i of p.bookProof.items) {
    rows.push({
      line: i.thisReconciliation ? 'Changed item (this reconciliation)' : `Changed item (reconciled ${i.reconciliationDate})`,
      date: i.txnDate ?? '', type: i.txnType ?? '', number: i.number ?? '', description: i.description ?? '',
      flag: i.reasons.map(reconDiscrepancyReasonLabel).join('; '),
      amount: i.currentAmount,
    });
  }
  rows.push({ line: '--- Sign-off ---' });
  rows.push({ line: 'Prepared by', description: p.signOff.preparedBy ?? '', date: p.signOff.preparedAt ? p.signOff.preparedAt.slice(0, 10) : '' });
  rows.push({ line: 'Reviewed by', description: p.signOff.reviewedBy ?? '', date: p.signOff.reviewedAt ? p.signOff.reviewedAt.slice(0, 10) : '' });
  rows.push({ line: 'Bank statement', description: p.signOff.statementPeriod ? `${p.signOff.statementPeriod}${p.signOff.statementFileName ? ` — ${p.signOff.statementFileName}` : ''}` : 'none linked' });
  return rows;
}
