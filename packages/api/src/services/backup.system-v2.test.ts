// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// System backup v2 completeness: the bundle must carry the tables and
// secrets whose loss defined the v1 format — Plaid credentials, SMS config,
// unstripped SMTP values, budget lines (no tenant_id), and NULL-tenant
// global rules.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { encrypt } from '../utils/encryption.js';

let tmpBackupDir: string;
let originalBackupDir: string | undefined;

const tenantId = crypto.randomUUID();
const budgetId = crypto.randomUUID();
const ruleId = crypto.randomUUID();
const accountId = crypto.randomUUID();
const PASSPHRASE = 'correct horse battery staple';

beforeAll(async () => {
  originalBackupDir = process.env['BACKUP_DIR'];
  tmpBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-v2-test-'));
  process.env['BACKUP_DIR'] = tmpBackupDir;

  await db.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'V2 Test', ${'v2-test-' + tenantId.slice(0, 8)})`);
  await db.execute(sql`
    INSERT INTO plaid_config (environment, client_id_encrypted, secret_sandbox_encrypted, webhook_url)
    VALUES ('sandbox', ${encrypt('plaid-client-id')}, ${encrypt('plaid-sandbox-secret')}, 'https://v2-test.example.com')
  `);
  await db.execute(sql`
    INSERT INTO system_settings (key, value) VALUES ('smtp_host', 'mail.example.com'), ('smtp_pass', 'hunter2')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
  await db.execute(sql`
    INSERT INTO budgets (id, tenant_id, name, fiscal_year) VALUES (${budgetId}, ${tenantId}, 'V2 Budget', 2026)
  `);
  await db.execute(sql`
    INSERT INTO budget_lines (id, budget_id, account_id, month_1)
    VALUES (${crypto.randomUUID()}, ${budgetId}, ${accountId}, 123.45)
  `);
  await db.execute(sql`
    INSERT INTO bank_rules (id, tenant_id, name, is_global, description_contains)
    VALUES (${ruleId}, NULL, 'Global v2 rule', true, 'V2TEST')
  `);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM bank_rules WHERE id = ${ruleId}`);
  await db.execute(sql`DELETE FROM budget_lines WHERE budget_id = ${budgetId}`);
  await db.execute(sql`DELETE FROM budgets WHERE id = ${budgetId}`);
  await db.execute(sql`DELETE FROM system_settings WHERE key IN ('smtp_host', 'smtp_pass')`);
  await db.execute(sql`DELETE FROM plaid_config WHERE webhook_url = 'https://v2-test.example.com'`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  if (originalBackupDir === undefined) delete process.env['BACKUP_DIR'];
  else process.env['BACKUP_DIR'] = originalBackupDir;
  fs.rmSync(tmpBackupDir, { recursive: true, force: true });
});

describe('createSystemBackup v2', () => {
  it('exports global tables verbatim — credentials included, nothing stripped', async () => {
    // Import AFTER BACKUP_DIR points at the tmp dir (module reads env at load).
    const { createSystemBackup } = await import('./backup.service.js');
    const { smartDecrypt } = await import('./portable-encryption.service.js');

    const result = await createSystemBackup(PASSPHRASE);
    const filePath = path.join(tmpBackupDir, '_system', result.fileName);
    const { data } = smartDecrypt(fs.readFileSync(filePath), PASSPHRASE);
    const content = JSON.parse(data.toString()) as {
      metadata: Record<string, unknown>;
      global_tables: Record<string, Record<string, unknown>[]>;
      tenant_data: Record<string, Record<string, Record<string, unknown>[]>>;
    };

    expect(content.metadata['format']).toBe('kis-books-system-v2');

    // Plaid credentials present and VERBATIM (decryptable with the env key).
    const plaidRow = content.global_tables['plaid_config']!.find(
      (r) => r['webhook_url'] === 'https://v2-test.example.com',
    )!;
    expect(plaidRow).toBeDefined();
    expect(plaidRow['client_id_encrypted']).toBeTruthy();
    const { decrypt } = await import('../utils/encryption.js');
    expect(decrypt(plaidRow['client_id_encrypted'] as string)).toBe('plaid-client-id');

    // SMTP settings including the password value — not stripped.
    const smtpRows = content.global_tables['system_settings']!;
    expect(smtpRows.find((r) => r['key'] === 'smtp_host')?.['value']).toBe('mail.example.com');
    expect(smtpRows.find((r) => r['key'] === 'smtp_pass')?.['value']).toBe('hunter2');

    // SMS/2FA config table is exported (row optional — table must be present).
    expect(content.global_tables).toHaveProperty('tfa_config');

    // budget_lines (no tenant_id) land in the global dump.
    const lines = content.global_tables['budget_lines']!.filter((r) => r['budget_id'] === budgetId);
    expect(lines).toHaveLength(1);
    expect(String(lines[0]!['month_1'])).toContain('123.45');
    // …while the parent budgets row rides the tenant loop.
    expect(content.tenant_data[tenantId]!['budgets']!.some((b) => b['id'] === budgetId)).toBe(true);

    // NULL-tenant global rules are captured too.
    expect(content.global_tables['bank_rules']!.some((r) => r['id'] === ruleId)).toBe(true);

    // Ephemeral token tables stay out.
    expect(content.global_tables).not.toHaveProperty('sessions');
    expect(content.global_tables).not.toHaveProperty('tfa_codes');
  });
});
