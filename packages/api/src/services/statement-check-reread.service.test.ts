// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// STATEMENT_CHECK_PAYEE_REREAD — guards on the per-statement check-image
// re-read. The vision call itself isn't exercised here (it needs the OCR
// engine); these pin the tenant scoping and the refusal paths, which are what
// must never regress.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { rereadCheckImages } from './ai-statement-parser.service.js';

const tenantId = crypto.randomUUID();
const otherTenantId = crypto.randomUUID();
const attachmentId = crypto.randomUUID();
const jobComplete = crypto.randomUUID();
const jobProcessing = crypto.randomUUID();
const jobNoFile = crypto.randomUUID();

beforeAll(async () => {
  await db.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Reread A', ${'reread-a-' + tenantId.slice(0, 8)})`);
  await db.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${otherTenantId}, 'Reread B', ${'reread-b-' + otherTenantId.slice(0, 8)})`);
  await db.execute(sql`
    INSERT INTO attachments (id, tenant_id, file_name, file_path, storage_key, mime_type, attachable_type, attachable_id)
    VALUES (${attachmentId}, ${tenantId}, 'stmt.pdf', '/nonexistent/stmt.pdf', ${tenantId || ''} || '/attachments/stmt.pdf',
            'application/pdf', 'bank_statement', ${attachmentId})
  `);
  const mkJob = async (id: string, status: string, inputId: string | null) => {
    await db.execute(sql`
      INSERT INTO ai_jobs (id, tenant_id, job_type, status, input_id, output_data)
      VALUES (${id}, ${tenantId}, 'ocr_statement', ${status}, ${inputId}::uuid,
              ${JSON.stringify({ transactions: [], checks: [], qualityWarnings: [] })}::jsonb)
    `);
  };
  await mkJob(jobComplete, 'complete', attachmentId);
  await mkJob(jobProcessing, 'processing', attachmentId);
  await mkJob(jobNoFile, 'complete', null);
});

afterAll(async () => {
  for (const t of [tenantId, otherTenantId]) {
    await db.execute(sql`DELETE FROM ai_jobs WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM attachments WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM tenants WHERE id = ${t}`);
  }
});

describe('rereadCheckImages guards', () => {
  it('404s for a job in another tenant', async () => {
    // The job id is real; only the tenant differs. A statement PDF must never
    // be readable across firms.
    await expect(rereadCheckImages(otherTenantId, jobComplete)).rejects.toThrow(/not found/i);
  });

  it('404s for an unknown job id', async () => {
    await expect(rereadCheckImages(tenantId, crypto.randomUUID())).rejects.toThrow(/not found/i);
  });

  it('refuses while the statement is still processing', async () => {
    await expect(rereadCheckImages(tenantId, jobProcessing)).rejects.toThrow(/still processing/i);
  });

  it('refuses when the original file is gone', async () => {
    await expect(rereadCheckImages(tenantId, jobNoFile)).rejects.toThrow(/no longer available/i);
  });

  it('does NOT refuse an already-imported statement (unlike reprocess)', async () => {
    // Re-reading creates nothing, so it stays available after a statement has
    // been saved — that is the whole point versus /reprocess. It should fail
    // on something later (fetching the missing file), never on importedAt.
    await db.execute(sql`UPDATE ai_jobs SET imported_at = now() WHERE id = ${jobComplete}`);
    await expect(rereadCheckImages(tenantId, jobComplete)).rejects.not.toThrow(/already been imported/i);
    await db.execute(sql`UPDATE ai_jobs SET imported_at = NULL WHERE id = ${jobComplete}`);
  });
});
