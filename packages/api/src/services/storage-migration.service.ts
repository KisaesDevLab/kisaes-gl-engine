// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { storageMigrations, attachments, storageProviders } from '../db/schema/index.js';
import { getProviderForTenant, invalidateProviderCache } from './storage/storage-provider.factory.js';
import { evictForTenant } from './storage/cache.service.js';
import { AppError } from '../utils/errors.js';

export async function startMigration(tenantId: string, fromProvider: string, toProvider: string) {
  // Count files
  const countResult = await db.execute(sql`
    SELECT COUNT(*) as count FROM attachments WHERE tenant_id = ${tenantId} AND storage_provider = ${fromProvider}
  `);
  const totalFiles = parseInt((countResult.rows[0] as any)?.count || '0');

  if (totalFiles === 0) throw AppError.badRequest('No files to migrate');

  const [migration] = await db.insert(storageMigrations).values({
    tenantId,
    fromProvider,
    toProvider,
    totalFiles,
    status: 'pending',
  }).returning();

  return migration;
}

export async function processMigration(migrationId: string) {
  const migration = await db.query.storageMigrations.findFirst({ where: eq(storageMigrations.id, migrationId) });
  if (!migration || migration.status !== 'pending') return;

  await db.update(storageMigrations).set({ status: 'running', startedAt: new Date() }).where(eq(storageMigrations.id, migrationId));

  const sourceProvider = await getProviderForTenant(migration.tenantId);

  // Activate the target provider temporarily to get its instance
  const targetRecord = await db.query.storageProviders.findFirst({
    where: and(eq(storageProviders.tenantId, migration.tenantId), eq(storageProviders.provider, migration.toProvider)),
  });
  if (!targetRecord) {
    await db.update(storageMigrations).set({ status: 'failed' }).where(eq(storageMigrations.id, migrationId));
    return;
  }

  // Process files in batches
  let offset = 0;
  const batchSize = 50;
  let migrated = 0;
  let failed = 0;
  const errors: any[] = [];

  while (true) {
    const batch = await db.select().from(attachments)
      .where(and(eq(attachments.tenantId, migration.tenantId), eq(attachments.storageProvider, migration.fromProvider)))
      .limit(batchSize).offset(offset);

    if (batch.length === 0) break;

    for (const attachment of batch) {
      // Check if migration was cancelled
      const current = await db.query.storageMigrations.findFirst({ where: eq(storageMigrations.id, migrationId) });
      if (current?.status === 'cancelled') return;

      try {
        const key = attachment.storageKey || attachment.filePath;
        if (!key) { failed++; continue; }

        const downloadKey = attachment.providerFileId || key;
        const data = await sourceProvider.download(downloadKey);

        // Re-resolve target provider (in case of token refresh)
        invalidateProviderCache(migration.tenantId);
        // Temporarily switch active provider
        await db.update(storageProviders).set({ isActive: true }).where(eq(storageProviders.id, targetRecord.id));
        const targetProvider = await getProviderForTenant(migration.tenantId);

        const result = await targetProvider.upload(key, data, {
          fileName: attachment.fileName,
          mimeType: attachment.mimeType || 'application/octet-stream',
          sizeBytes: data.length,
        });

        // Update attachment
        await db.update(attachments).set({
          storageProvider: migration.toProvider,
          providerFileId: result.providerFileId || null,
          storageKey: key,
        }).where(eq(attachments.id, attachment.id));

        migrated++;
      } catch (err: any) {
        failed++;
        errors.push({ attachmentId: attachment.id, error: err.message });
      }

      // Update progress every 10 files
      if ((migrated + failed) % 10 === 0) {
        await db.update(storageMigrations).set({ migratedFiles: migrated, failedFiles: failed, errorLog: errors }).where(eq(storageMigrations.id, migrationId));
      }
    }

    offset += batchSize;
  }

  // Finalize
  const finalStatus = failed === 0 ? 'completed' : 'completed';
  await db.update(storageMigrations).set({
    status: finalStatus, migratedFiles: migrated, failedFiles: failed, errorLog: errors, completedAt: new Date(),
  }).where(eq(storageMigrations.id, migrationId));

  // If fully successful, switch active provider
  if (failed === 0) {
    await db.update(storageProviders).set({ isActive: false }).where(and(eq(storageProviders.tenantId, migration.tenantId), eq(storageProviders.provider, migration.fromProvider)));
    await db.update(storageProviders).set({ isActive: true }).where(and(eq(storageProviders.tenantId, migration.tenantId), eq(storageProviders.provider, migration.toProvider)));
    invalidateProviderCache(migration.tenantId);
  }

  // Evict cache
  await evictForTenant(migration.tenantId);
}

export async function getMigrationStatus(tenantId: string) {
  return db.query.storageMigrations.findFirst({
    where: eq(storageMigrations.tenantId, tenantId),
    orderBy: (m, { desc }) => [desc(m.createdAt)],
  });
}

export async function cancelMigration(migrationId: string) {
  await db.update(storageMigrations).set({ status: 'cancelled' }).where(eq(storageMigrations.id, migrationId));
}
