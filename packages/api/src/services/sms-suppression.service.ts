// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { portalContacts, reminderSuppressions } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';

// DOC_REQUEST_SMS_V1 — STOP-keyword handling for inbound SMS. TCPA
// non-negotiable: a contact who replies STOP must not receive any
// further SMS from any reminder schedule, ever. Reply START removes
// the suppression.
//
// Lookup is by phone number → portal_contacts.phone. We normalize the
// inbound phone by stripping non-digits + leading-1 (NANP) so a
// contact stored as +13125551234 matches an inbound 3125551234.

const STOP_KEYWORDS = ['STOP', 'UNSUBSCRIBE', 'END', 'QUIT', 'CANCEL', 'OPTOUT'];
const START_KEYWORDS = ['START', 'UNSTOP', 'YES'];

export type InboundClassification = 'stop' | 'start' | 'none';

export function classifyInboundBody(body: string): InboundClassification {
  const trimmed = body.trim().toUpperCase();
  if (STOP_KEYWORDS.includes(trimmed)) return 'stop';
  if (START_KEYWORDS.includes(trimmed)) return 'start';
  return 'none';
}

// Normalize a phone number for matching against portal_contacts.phone.
// Strategy: keep only digits, drop a leading "1" if the result is 11
// digits (NANP). Imperfect for international numbers but the worst
// case is a STOP that doesn't take effect — operators see it in the
// audit log and apply manual suppression.
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

interface ContactMatch {
  contactId: string;
  tenantId: string;
}

async function findContactByPhone(rawPhone: string): Promise<ContactMatch | null> {
  const normalized = normalizePhone(rawPhone);
  if (!normalized) return null;

  // Find any portal_contacts whose phone normalizes to the same
  // digit string. We scan rather than index because the stored
  // format is heterogeneous; the table size is modest.
  const candidates = await db
    .select({ id: portalContacts.id, tenantId: portalContacts.tenantId, phone: portalContacts.phone })
    .from(portalContacts);
  for (const c of candidates) {
    if (!c.phone) continue;
    if (normalizePhone(c.phone) === normalized) {
      return { contactId: c.id, tenantId: c.tenantId };
    }
  }
  return null;
}

export async function applyStopKeyword(rawPhone: string): Promise<{ matched: boolean; contactId?: string }> {
  const match = await findContactByPhone(rawPhone);
  if (!match) return { matched: false };

  // Insert an SMS-channel suppression unless one already exists.
  const existing = await db
    .select({ id: reminderSuppressions.id })
    .from(reminderSuppressions)
    .where(
      and(
        eq(reminderSuppressions.contactId, match.contactId),
        or(eq(reminderSuppressions.channel, 'sms'), isNull(reminderSuppressions.channel)),
      ),
    )
    .limit(1);
  if (existing.length === 0) {
    await db.insert(reminderSuppressions).values({
      contactId: match.contactId,
      reason: 'STOP_KEYWORD',
      channel: 'sms',
    });
    await auditLog(
      match.tenantId,
      'create',
      'reminder_suppression',
      match.contactId,
      null,
      { reason: 'STOP_KEYWORD', channel: 'sms', source: 'inbound_sms' },
    );
  }
  return { matched: true, contactId: match.contactId };
}

export async function applyStartKeyword(rawPhone: string): Promise<{ matched: boolean; contactId?: string; removed: number }> {
  const match = await findContactByPhone(rawPhone);
  if (!match) return { matched: false, removed: 0 };

  const res = await db
    .delete(reminderSuppressions)
    .where(
      and(
        eq(reminderSuppressions.contactId, match.contactId),
        or(eq(reminderSuppressions.channel, 'sms'), isNull(reminderSuppressions.channel)),
        eq(reminderSuppressions.reason, 'STOP_KEYWORD'),
      ),
    );
  const removed = (res as { rowCount?: number }).rowCount ?? 0;
  if (removed > 0) {
    await auditLog(
      match.tenantId,
      'delete',
      'reminder_suppression',
      match.contactId,
      { removed, reason: 'STOP_KEYWORD' },
      null,
    );
  }
  return { matched: true, contactId: match.contactId, removed };
}
