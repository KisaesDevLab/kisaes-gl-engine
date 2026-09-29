// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The transaction page's Activity card: one timeline, oldest first, stitched
// from everything that records what happened to a transaction —
//   - audit_log rows for the transaction (created / edited / voided)
//   - the bank-feed item it was posted from (imported, the suggestion and
//     where it came from, assign / exclude audit rows)
//   - Close Review review marks (audit rows, plus the item's
//     close_reviewed_at for marks that predate per-item logging)
//   - attachments (audit rows, plus attachment rows with no audit, e.g.
//     portal uploads)
//   - Close Review findings on the transaction and their status changes
//   - client portal questions about it
//   - the transaction's own printed / sent / viewed / paid timestamps
// Read-only; nothing here writes.

import { sql } from 'drizzle-orm';
import type { TransactionActivityEvent, TransactionActivityKind } from '@kis-books/shared';
import { db } from '../db/index.js';
import { AppError } from '../utils/errors.js';

type Row = Record<string, unknown>;

// audit_log.before_data / after_data are jsonb, but the helper writes
// JSON.stringify(...) into them, so most rows hold a JSON *string* that
// itself encodes the object. Accept either.
export function decodeAudit(v: unknown): Record<string, unknown> | null {
  let x = v;
  if (typeof x === 'string') {
    try { x = JSON.parse(x); } catch { return null; }
  }
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

const iso = (v: unknown): string => new Date(v as string).toISOString();
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function money(v: unknown): string | null {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return null;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const SOURCE_LABELS: Record<string, string> = {
  bank_feed: 'Posted from the bank feed',
  statement_line: 'Posted from a bank statement',
  quickbooks_online_import: 'Imported from QuickBooks Online',
  quickbooks_desktop_import: 'Imported from QuickBooks Desktop',
  accounting_power_import: 'Imported from Accounting Power',
  generic_import: 'Imported from a file',
  payroll_import: 'Imported from payroll',
  trial_balance_import: 'Imported from a trial balance',
};

const MATCH_TYPE_LABELS: Record<string, string> = {
  rule: 'a bank rule',
  ai: 'AI',
  history: "the payee's history",
  check_image: 'the check image',
};

const FINDING_STATUS_LABELS: Record<string, string> = {
  open: 'Reopened',
  assigned: 'Assigned',
  in_review: 'In review',
  resolved: 'Accepted',
  ignored: 'Dismissed',
};

export async function getTransactionActivity(
  tenantId: string,
  transactionId: string,
  companyId?: string | null,
): Promise<TransactionActivityEvent[]> {
  const txnRes = await db.execute(sql`
    SELECT id, txn_type, source, status, created_at, voided_at, void_reason,
           printed_at, sent_at, viewed_at, paid_at, total
    FROM transactions
    WHERE tenant_id = ${tenantId} AND id = ${transactionId}
      ${companyId ? sql`AND (company_id = ${companyId} OR company_id IS NULL)` : sql``}
  `);
  const txn = txnRes.rows[0] as Row | undefined;
  if (!txn) throw AppError.notFound('Transaction not found');

  const feedRes = await db.execute(sql`
    SELECT f.id, f.created_at, f.feed_date, f.original_description, f.description, f.amount,
           f.match_type, f.suggested_account_id, f.statement_id, f.status,
           f.close_reviewed_at, f.close_reviewed_by,
           bc.institution_name, bc.mask, bc.provider,
           sa.name AS suggested_account_name,
           tcs.created_at AS classified_at
    FROM bank_feed_items f
    JOIN bank_connections bc ON bc.id = f.bank_connection_id
    LEFT JOIN accounts sa ON sa.id = f.suggested_account_id
    LEFT JOIN transaction_classification_state tcs ON tcs.bank_feed_item_id = f.id
    WHERE f.tenant_id = ${tenantId} AND f.matched_transaction_id = ${transactionId}
  `);
  const feeds = feedRes.rows as Row[];
  const feedIds = feeds.map((f) => f['id'] as string);
  const feedIdList = feedIds.length > 0 ? sql.join(feedIds.map((id) => sql`${id}::uuid`), sql`, `) : null;

  // Audit rows: the transaction itself, its feed items, and attachments.
  // Legacy Close Review marks were one row per batch with the ids inside.
  const auditRes = await db.execute(sql`
    SELECT id, action, entity_type, entity_id, user_id, before_data, after_data, created_at
    FROM audit_log
    WHERE tenant_id = ${tenantId} AND (
      (entity_type = 'transaction' AND entity_id = ${transactionId})
      ${feedIdList ? sql`
        OR (entity_type IN ('bank_feed', 'close_feed_review') AND entity_id IN (${feedIdList}))
        OR (entity_type = 'close_feed_review' AND entity_id IS NULL AND EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(
                (CASE WHEN jsonb_typeof(after_data) = 'string' THEN (after_data #>> '{}')::jsonb ELSE after_data END) -> 'feedItemIds'
              ) e WHERE e IN (${sql.join(feedIds.map((id) => sql`${id}`), sql`, `)})))` : sql``}
      OR (entity_type = 'attachment' AND action IN ('create', 'delete') AND (
            (CASE WHEN jsonb_typeof(after_data) = 'string' THEN (after_data #>> '{}')::jsonb ELSE after_data END) ->> 'attachableId' = ${transactionId}
         OR (CASE WHEN jsonb_typeof(before_data) = 'string' THEN (before_data #>> '{}')::jsonb ELSE before_data END) ->> 'attachableId' = ${transactionId}))
    )
    ORDER BY created_at
  `);
  const audits = auditRes.rows as Row[];

  const attRes = await db.execute(sql`
    SELECT a.id, a.file_name, a.created_at, a.uploaded_by_contact_id,
           NULLIF(TRIM(CONCAT(pc.first_name, ' ', pc.last_name)), '') AS contact_name, pc.email AS contact_email
    FROM attachments a
    LEFT JOIN portal_contacts pc ON pc.id = a.uploaded_by_contact_id
    WHERE a.tenant_id = ${tenantId} AND a.attachable_id = ${transactionId}
  `);
  const atts = attRes.rows as Row[];

  const findRes = await db.execute(sql`
    SELECT f.id, f.check_key, f.created_at, f.severity, cr.name AS check_name
    FROM findings f
    LEFT JOIN check_registry cr ON cr.check_key = f.check_key
    WHERE f.tenant_id = ${tenantId} AND f.transaction_id = ${transactionId}
  `);
  const finds = findRes.rows as Row[];
  const findIds = finds.map((f) => f['id'] as string);
  const findEvents = findIds.length > 0
    ? ((await db.execute(sql`
        SELECT finding_id, from_status, to_status, user_id, note, created_at
        FROM finding_events
        WHERE finding_id IN (${sql.join(findIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `)).rows as Row[])
    : [];

  const qRes = await db.execute(sql`
    SELECT id, body, created_by, created_at, viewed_at, responded_at, resolved_at
    FROM portal_questions
    WHERE tenant_id = ${tenantId} AND transaction_id = ${transactionId}
  `);
  const questions = qRes.rows as Row[];

  // ── Name lookups (users, contacts, accounts) in one pass each ──────
  const userIds = new Set<string>();
  const contactIds = new Set<string>();
  const accountIds = new Set<string>();
  for (const a of audits) {
    if (a['user_id']) userIds.add(a['user_id'] as string);
    const after = decodeAudit(a['after_data']);
    for (const k of ['contactId']) if (str(after?.[k])) contactIds.add(after![k] as string);
    for (const k of ['categoryAccountId', 'moveFromAccountId', 'moveToAccountId', 'assignedAccountId']) {
      if (str(after?.[k])) accountIds.add(after![k] as string);
    }
    const before = decodeAudit(a['before_data']);
    if (str(before?.['contactId'])) contactIds.add(before!['contactId'] as string);
    if (Array.isArray(after?.['lines'])) {
      for (const l of after!['lines'] as Array<Record<string, unknown>>) if (str(l?.['accountId'])) accountIds.add(l['accountId'] as string);
    }
  }
  for (const f of feeds) if (f['close_reviewed_by']) userIds.add(f['close_reviewed_by'] as string);
  for (const e of findEvents) if (e['user_id']) userIds.add(e['user_id'] as string);
  for (const q of questions) if (q['created_by']) userIds.add(q['created_by'] as string);

  const names = async (table: 'users' | 'contacts' | 'accounts', ids: Set<string>): Promise<Map<string, string>> => {
    if (ids.size === 0) return new Map();
    const list = sql.join([...ids].map((id) => sql`${id}::uuid`), sql`, `);
    const q = table === 'users'
      // Firm staff live in another tenant, so users are looked up by id
      // alone — the ids come from this tenant's own records.
      ? sql`SELECT id, COALESCE(NULLIF(display_name, ''), email) AS name FROM users WHERE id IN (${list})`
      : table === 'contacts'
        ? sql`SELECT id, display_name AS name FROM contacts WHERE tenant_id = ${tenantId} AND id IN (${list})`
        : sql`SELECT id, CASE WHEN account_number IS NOT NULL AND account_number <> '' THEN account_number || ' · ' || name ELSE name END AS name
              FROM accounts WHERE tenant_id = ${tenantId} AND id IN (${list})`;
    const r = await db.execute(q);
    return new Map((r.rows as Array<{ id: string; name: string }>).map((x) => [x.id, x.name]));
  };
  const [userNames, contactNames, accountNames] = await Promise.all([
    names('users', userIds), names('contacts', contactIds), names('accounts', accountIds),
  ]);
  const who = (id: unknown): string | null => (typeof id === 'string' ? userNames.get(id) ?? 'A former user' : null);

  const events: TransactionActivityEvent[] = [];
  const push = (at: unknown, kind: TransactionActivityKind, title: string, detail: string | null, actor: string | null) => {
    if (!at) return;
    events.push({ at: iso(at), kind, title, detail, actor });
  };

  // ── Bank feed origin ────────────────────────────────────────────────
  for (const f of feeds) {
    const bank = [str(f['institution_name']), str(f['mask']) ? `••${f['mask']}` : null].filter(Boolean).join(' ');
    const how = f['statement_id']
      ? 'Imported from a bank statement'
      : f['provider'] === 'plaid' ? 'Downloaded from the bank' : 'Imported from a bank file';
    const desc = str(f['original_description']) ?? str(f['description']);
    push(f['created_at'], 'imported', how,
      [bank || null, desc ? `“${desc}”` : null, money(f['amount'] === null ? null : Math.abs(Number(f['amount'])))].filter(Boolean).join(' · ') || null,
      null);
    if (f['suggested_account_id']) {
      const src = MATCH_TYPE_LABELS[f['match_type'] as string] ?? 'the categorizer';
      push(f['classified_at'] ?? f['created_at'], 'suggested', `Category suggested by ${src}`,
        str(f['suggested_account_name']), null);
    }
  }

  // ── Audit rows ──────────────────────────────────────────────────────
  const reviewAuditFeeds = new Set<string>();
  const auditedAttachments = new Set<string>();
  for (const a of audits) {
    const type = a['entity_type'] as string;
    const action = a['action'] as string;
    const after = decodeAudit(a['after_data']);
    const before = decodeAudit(a['before_data']);
    const actor = who(a['user_id']);

    if (type === 'transaction') {
      if (action === 'create') {
        const label = SOURCE_LABELS[txn['source'] as string] ?? 'Created';
        push(a['created_at'], 'created', label, money(after?.['total'] ?? txn['total']), actor);
      } else if (action === 'void') {
        push(a['created_at'], 'voided', 'Voided', str(after?.['reason']) ?? str(txn['void_reason']), actor);
      } else if (action === 'update') {
        push(a['created_at'], 'edited', after?.['bulk'] ? 'Edited (bulk change)' : 'Edited', describeEdit(before, after, contactNames, accountNames), actor);
      }
      continue;
    }

    if (type === 'bank_feed') {
      const to = str(after?.['status']);
      const from = str(before?.['status']);
      if (to === 'excluded') push(a['created_at'], 'excluded', 'Excluded in the bank feed', null, actor);
      else if (to === 'assigned' && from !== 'assigned') {
        const acct = str(after?.['assignedAccountId']);
        push(a['created_at'], 'staged', 'Category chosen, waiting for approval', acct ? accountNames.get(acct) ?? null : null, actor);
      }
      continue;
    }

    if (type === 'close_feed_review') {
      for (const id of feedIds) reviewAuditFeeds.add(id);
      const reviewed = after?.['reviewed'] !== false;
      const via = str(after?.['via']);
      push(a['created_at'], reviewed ? 'reviewed' : 'unreviewed',
        reviewed ? 'Marked reviewed in Close Review' : 'Review mark removed in Close Review',
        via === 'recategorize' ? 'Recategorized from Close Review' : via === 'approve' ? 'Approved from Close Review' : null,
        actor);
      continue;
    }

    if (type === 'attachment') {
      if (a['entity_id']) auditedAttachments.add(a['entity_id'] as string);
      const file = str(after?.['fileName']) ?? str(before?.['fileName']);
      push(a['created_at'], action === 'create' ? 'attachment_added' : 'attachment_removed',
        action === 'create' ? 'Attachment added' : 'Attachment removed', file, actor);
    }
  }

  // Review marks written before per-item audit rows existed.
  for (const f of feeds) {
    if (f['close_reviewed_at'] && !reviewAuditFeeds.has(f['id'] as string)) {
      push(f['close_reviewed_at'], 'reviewed', 'Marked reviewed in Close Review', null, who(f['close_reviewed_by']));
    }
  }

  // Attachments with no audit row (portal uploads, imports).
  for (const at of atts) {
    if (auditedAttachments.has(at['id'] as string)) continue;
    const client = at['uploaded_by_contact_id']
      ? `Client (${str(at['contact_name']) ?? str(at['contact_email']) ?? 'portal'})`
      : null;
    push(at['created_at'], 'attachment_added', 'Attachment added', str(at['file_name']), client);
  }

  // ── Transaction's own timestamps ────────────────────────────────────
  if (!audits.some((a) => a['entity_type'] === 'transaction' && a['action'] === 'create')) {
    push(txn['created_at'], 'created', SOURCE_LABELS[txn['source'] as string] ?? 'Created', money(txn['total']), null);
  }
  if (txn['voided_at'] && !audits.some((a) => a['entity_type'] === 'transaction' && a['action'] === 'void')) {
    push(txn['voided_at'], 'voided', 'Voided', str(txn['void_reason']), null);
  }
  push(txn['printed_at'], 'printed', 'Check printed', null, null);
  push(txn['sent_at'], 'sent', 'Sent to the customer', null, null);
  push(txn['viewed_at'], 'viewed', 'Viewed by the customer', null, null);
  push(txn['paid_at'], 'paid', 'Paid in full', null, null);

  // ── Close Review findings ───────────────────────────────────────────
  const checkName = new Map(finds.map((f) => [f['id'] as string, str(f['check_name']) ?? (f['check_key'] as string)]));
  for (const f of finds) {
    push(f['created_at'], 'finding', 'Flagged by a review check', checkName.get(f['id'] as string) ?? null, null);
  }
  for (const e of findEvents) {
    const to = e['to_status'] as string;
    const label = FINDING_STATUS_LABELS[to] ?? `Finding ${to}`;
    const detail = [checkName.get(e['finding_id'] as string), str(e['note'])].filter(Boolean).join(' — ') || null;
    push(e['created_at'], 'finding_update', `Review finding: ${label}`, detail, who(e['user_id']));
  }

  // ── Client questions ────────────────────────────────────────────────
  for (const q of questions) {
    const body = str(q['body']);
    const short = body && body.length > 140 ? `${body.slice(0, 137)}…` : body;
    push(q['created_at'], 'question', 'Question sent to the client', short, who(q['created_by']));
    push(q['viewed_at'], 'question_update', 'Client viewed the question', null, 'Client');
    push(q['responded_at'], 'question_update', 'Client answered the question', null, 'Client');
    push(q['resolved_at'], 'question_update', 'Question resolved', null, null);
  }

  // Oldest first; ties keep a natural order (import → suggest → post).
  const ORDER: TransactionActivityKind[] = ['imported', 'suggested', 'staged', 'created'];
  const rank = (k: TransactionActivityKind) => { const i = ORDER.indexOf(k); return i === -1 ? ORDER.length : i; };
  events.sort((a, b) => (a.at === b.at ? rank(a.kind) - rank(b.kind) : a.at < b.at ? -1 : 1));
  return events;
}

// A readable one-liner for an edit. Bulk edits record exactly what they set;
// a full edit records the header before and the submitted input after.
function describeEdit(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  contacts: Map<string, string>,
  accounts: Map<string, string>,
): string | null {
  if (!after) return null;
  const parts: string[] = [];
  const contactName = (id: unknown) => (typeof id === 'string' ? contacts.get(id) ?? 'another payee' : 'no payee');
  const accountName = (id: unknown) => (typeof id === 'string' ? accounts.get(id) ?? 'another account' : '—');

  if (after['bulk']) {
    if ('contactId' in after) parts.push(`payee → ${contactName(after['contactId'])}`);
    if ('categoryAccountId' in after) parts.push(`category → ${accountName(after['categoryAccountId'])}`);
    if ('moveToAccountId' in after) parts.push(`moved ${accountName(after['moveFromAccountId'])} → ${accountName(after['moveToAccountId'])}`);
    if ('tagId' in after) parts.push(after['tagId'] ? 'tag changed' : 'tag removed');
    return parts.join('; ') || null;
  }
  if (after['reconciledPartialEdit']) return 'Category or tag changed (reconciled transaction)';

  const changed = (k: string) => before !== null && k in after && String(before[k] ?? '') !== String(after[k] ?? '');
  if (before === null) {
    const keys = ['txnDate', 'contactId', 'memo', 'total', 'lines'].filter((k) => k in after);
    return keys.length > 0 ? `Changed: ${keys.map(fieldLabel).join(', ')}` : null;
  }
  if (changed('txnDate')) parts.push(`date ${String(before['txnDate'])} → ${String(after['txnDate'])}`);
  if (changed('contactId')) parts.push(`payee ${contactName(before['contactId'])} → ${contactName(after['contactId'])}`);
  if (changed('total')) parts.push(`amount ${money(before['total']) ?? '—'} → ${money(after['total']) ?? '—'}`);
  if (changed('memo')) parts.push('memo changed');
  if (Array.isArray(after['lines'])) {
    const accts = [...new Set((after['lines'] as Array<Record<string, unknown>>)
      .map((l) => (typeof l?.['accountId'] === 'string' ? accounts.get(l['accountId'] as string) : undefined))
      .filter((n): n is string => !!n))];
    parts.push(accts.length > 0 ? `saved with ${accts.slice(0, 4).join(', ')}${accts.length > 4 ? ', …' : ''}` : 'lines saved');
  }
  return parts.join('; ') || null;
}

function fieldLabel(k: string): string {
  return ({ txnDate: 'date', contactId: 'payee', memo: 'memo', total: 'amount', lines: 'lines' } as Record<string, string>)[k] ?? k;
}
