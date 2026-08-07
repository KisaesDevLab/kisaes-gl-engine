// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Client answers can carry file attachments: stored via the tenant's
// provider, recorded in portal_question_attachments, denormalized onto
// the message's attachments_json, and downloadable through the
// question's own authorization (tenant hop — the table has no
// tenant_id of its own).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const storageUpload = vi.hoisted(() => vi.fn(async () => undefined));
const storageDownload = vi.hoisted(() => vi.fn(async () => Buffer.from('file-bytes')));
vi.mock('./storage/storage-provider.factory.js', () => ({
  getProviderForTenant: async () => ({
    name: 'local',
    upload: storageUpload,
    download: storageDownload,
    delete: vi.fn(async () => undefined),
  }),
  invalidateProviderCache: () => undefined,
}));

import { db, pool } from '../db/index.js';
import {
  companies, portalContactCompanies, portalContacts, portalQuestionAttachments,
  portalQuestionMessages, portalQuestions, tenants, users,
} from '../db/schema/index.js';
import {
  contactAnswer, getQuestionAttachmentForContact, getQuestionAttachmentForStaff,
} from './portal-question.service.js';

let tenantId: string;
let companyId: string;
let contactId: string;
let otherContactId: string;
let questionId: string;
let userId: string;

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: 'pq-attach', slug: `pq-attach-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Attach Co' }).returning();
  companyId = c!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `pq-attach-${Date.now()}@test.local`, passwordHash: 'x', displayName: 'Asker', role: 'accountant',
  }).returning();
  userId = u!.id;
  const [contact] = await db.insert(portalContacts).values({
    tenantId, email: `client-${Date.now()}@test.local`, firstName: 'Cli', lastName: 'Ent',
  }).returning();
  contactId = contact!.id;
  const [other] = await db.insert(portalContacts).values({
    tenantId, email: `other-${Date.now()}@test.local`, firstName: 'Ot', lastName: 'Her',
  }).returning();
  otherContactId = other!.id;
  await db.insert(portalContactCompanies).values({ contactId, companyId });
  const [q] = await db.insert(portalQuestions).values({
    tenantId, companyId, body: 'What is this charge?', createdBy: userId,
    assignedContactId: contactId, notifiedAt: new Date(),
  }).returning();
  questionId = q!.id;
});

afterAll(async () => {
  await db.delete(portalQuestions).where(eq(portalQuestions.tenantId, tenantId)); // cascades messages + attachments
  await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, contactId));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

describe('portal question answer attachments', () => {
  it('stores files, records rows, and denormalizes attachments_json', async () => {
    const { messageId } = await contactAnswer({
      tenantId, contactId, questionId,
      body: 'Receipts attached.',
      files: [
        { filename: 'receipt one.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1') },
        { filename: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('png-bytes') },
      ],
    });
    expect(storageUpload).toHaveBeenCalledTimes(2);

    const rows = await db.select().from(portalQuestionAttachments)
      .where(eq(portalQuestionAttachments.questionId, questionId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.messageId === messageId)).toBe(true);
    expect(rows.every((r) => r.uploadedByType === 'contact' && r.uploadedBy === contactId)).toBe(true);
    // Storage keys are UUID-prefixed with the original name sanitized.
    expect(rows.some((r) => r.storageKey.includes('receipt_one.pdf'))).toBe(true);

    const [msg] = await db.select().from(portalQuestionMessages)
      .where(eq(portalQuestionMessages.id, messageId));
    const json = msg!.attachmentsJson as Array<{ attachmentId: string; filename: string }>;
    expect(json).toHaveLength(2);
    expect(json.map((a) => a.filename).sort()).toEqual(['photo.png', 'receipt one.pdf']);
    expect(json.every((a) => rows.some((r) => r.id === a.attachmentId))).toBe(true);

    const [q] = await db.select().from(portalQuestions).where(eq(portalQuestions.id, questionId));
    expect(q!.status).toBe('responded');
  });

  it('downloads through question authorization; refuses foreign contact and tenant', async () => {
    const [att] = await db.select().from(portalQuestionAttachments)
      .where(eq(portalQuestionAttachments.questionId, questionId)).limit(1);

    const file = await getQuestionAttachmentForContact({
      tenantId, contactId, questionId, attachmentId: att!.id,
    });
    expect(file.buffer.toString()).toBe('file-bytes');
    expect(file.filename).toBe(att!.filename);

    await expect(getQuestionAttachmentForContact({
      tenantId, contactId: otherContactId, questionId, attachmentId: att!.id,
    })).rejects.toMatchObject({ statusCode: 403 });

    const staffFile = await getQuestionAttachmentForStaff(tenantId, questionId, att!.id);
    expect(staffFile.buffer.toString()).toBe('file-bytes');

    await expect(getQuestionAttachmentForStaff('00000000-0000-0000-0000-000000000001', questionId, att!.id))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('plain answers without files still work and carry empty attachments', async () => {
    const { messageId } = await contactAnswer({ tenantId, contactId, questionId, body: 'No files this time.' });
    const [msg] = await db.select().from(portalQuestionMessages)
      .where(eq(portalQuestionMessages.id, messageId));
    expect(msg!.attachmentsJson).toEqual([]);
  });
});
