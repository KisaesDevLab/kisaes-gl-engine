// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Tenant-rooted storage layout (refactor(storage)): NEW attachment
// uploads write {tenantId}/attachments/{uuid}{ext}, while rows created
// under the legacy attachments/{tenantId}/... layout keep downloading
// via their STORED keys — zero migration.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// UPLOAD_DIR must be set before any module (config/env, LocalProvider)
// reads it. vi.hoisted runs ahead of the hoisted imports below.
const TMP_UPLOAD_DIR = vi.hoisted(() => {
  const dir = `${process.cwd()}/.tmp-storage-key-test-${process.pid}`;
  process.env['UPLOAD_DIR'] = dir;
  return dir;
});

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments } from '../db/schema/index.js';
import * as attachmentService from './attachment.service.js';
import { invalidateSystemProviderCache } from './storage/storage-provider.factory.js';

const tenantId = crypto.randomUUID();

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

beforeAll(() => {
  fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });
  // The system-default provider cache may hold a LocalProvider built for
  // a different UPLOAD_DIR from an earlier test file (singleFork pool).
  invalidateSystemProviderCache();
});

afterAll(async () => {
  await db.delete(attachments).where(eq(attachments.tenantId, tenantId));
  fs.rmSync(TMP_UPLOAD_DIR, { recursive: true, force: true });
  invalidateSystemProviderCache();
});

describe('attachment storage keys (tenant-rooted layout)', () => {
  it('new uploads use {tenantId}/attachments/{uuid}{ext} and mirror it in filePath', async () => {
    const attachment = await attachmentService.upload(
      tenantId,
      {
        originalname: 'receipt.pdf',
        buffer: Buffer.from('%PDF-1.4 test'),
        mimetype: 'application/pdf',
        size: 13,
      },
      'draft',
      crypto.randomUUID(),
    );

    expect(attachment).toBeDefined();
    expect(attachment!.storageKey).toMatch(
      new RegExp(`^${tenantId}/attachments/[0-9a-f-]{36}\\.pdf$`),
    );
    expect(attachment!.filePath).toBe(`/uploads/${attachment!.storageKey}`);

    // The file physically lives under the tenant's root folder.
    const onDisk = path.join(TMP_UPLOAD_DIR, attachment!.storageKey!);
    expect(fs.existsSync(onDisk)).toBe(true);

    // And it round-trips through the standard download path.
    const { stream } = await attachmentService.download(tenantId, attachment!.id);
    const data = await streamToBuffer(stream);
    expect(data.toString()).toBe('%PDF-1.4 test');
  });

  it('an existing attachment with a legacy old-layout key still downloads', async () => {
    // Seed a pre-refactor row: key/filePath in the OLD layout, file on
    // disk where the old layout put it. No migration ever rewrites these.
    const legacyKey = `attachments/${tenantId}/legacy-file.pdf`;
    const legacyDir = path.join(TMP_UPLOAD_DIR, 'attachments', tenantId);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'legacy-file.pdf'), 'legacy content');

    const [row] = await db
      .insert(attachments)
      .values({
        tenantId,
        fileName: 'legacy-file.pdf',
        filePath: `/uploads/${legacyKey}`,
        fileSize: 14,
        mimeType: 'application/pdf',
        attachableType: 'draft',
        attachableId: crypto.randomUUID(),
        storageKey: legacyKey,
        storageProvider: 'local',
      })
      .returning();

    const { stream, attachment } = await attachmentService.download(tenantId, row!.id);
    const data = await streamToBuffer(stream);
    expect(data.toString()).toBe('legacy content');
    expect(attachment.storageKey).toBe(legacyKey);
  });
});
