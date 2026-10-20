// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-13 through the services: in desktop mode SMTP settings writes refuse a
// password (company and system), `passwordConfigured` reflects the session
// store, and the SMTP test uses the session password (never the body's).
// nodemailer is mocked; the shared test database is used for the company.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({ created: [] as Array<Record<string, unknown>> }));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (opts: Record<string, unknown>) => {
      mocks.created.push(opts);
      return { options: opts, verify: async () => true, sendMail: async () => ({ messageId: 'm' }) };
    },
  },
}));

import { db } from '../db/index.js';
import { tenants, companies, systemSettings } from '../db/schema/index.js';
import { loadDesktopProfile, _resetDesktopProfileForTests } from '../desktop/profile.js';
import * as secrets from '../desktop/session-secrets.js';
import * as companyService from './company.service.js';
import * as adminService from './admin.service.js';
import { testSmtpConnection } from './setup.service.js';

const SLUG = 'smtp-desktop-test';
let tenantId = '';
let companyId = '';

function desktop(): void {
  loadDesktopProfile({ CL_MODE: 'desktop', CL_TOKEN: 'smtp_' + 's'.repeat(44), CL_BIND: '127.0.0.1:0', CL_DATA_DIR: path.join(os.tmpdir(), 'cl-smtp-test'), CL_OFFLINE: 'off' });
}

async function cleanup(): Promise<void> {
  const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, SLUG));
  for (const t of rows) await db.delete(companies).where(eq(companies.tenantId, t.id));
  await db.delete(tenants).where(eq(tenants.slug, SLUG));
}

beforeAll(async () => {
  await cleanup();
  const [t] = await db.insert(tenants).values({ name: 'SMTP Desktop', slug: SLUG }).returning();
  tenantId = t!.id;
  const company = await companyService.createCompanyForTenant(tenantId, 'Mail Co');
  companyId = company!.id;
});

afterAll(async () => { await cleanup(); });
beforeEach(() => { mocks.created.length = 0; secrets.clearAllSessionSecrets(); });
afterEach(() => { secrets.clearAllSessionSecrets(); _resetDesktopProfileForTests(); });

const SETTINGS = { smtpHost: '10.0.0.25', smtpPort: 587, smtpUser: 'owner', smtpFrom: 'owner@example.test', smtpFromName: 'Owner' };

describe('company SMTP settings in desktop mode', () => {
  it('refuses to store or clear a password; the other fields save', async () => {
    desktop();
    for (const smtpPass of ['hunter2hunter2', null]) {
      await expect(companyService.updateSmtpSettings(tenantId, companyId, { ...SETTINGS, smtpPass }))
        .rejects.toMatchObject({ statusCode: 400, code: 'DESKTOP_KEYS_NOT_STORED' });
    }
    const [row] = await db.select({ host: companies.smtpHost, pass: companies.smtpPass }).from(companies).where(eq(companies.id, companyId));
    expect(row).toEqual({ host: null, pass: null });

    await companyService.updateSmtpSettings(tenantId, companyId, { ...SETTINGS, smtpPass: '' });
    const saved = await companyService.getSmtpSettings(tenantId, companyId);
    expect(saved).toMatchObject({ smtpHost: '10.0.0.25', smtpUser: 'owner', smtpPass: '', passwordConfigured: false, configured: true });
    secrets.setSmtpPassword('hunter2hunter2');
    expect((await companyService.getSmtpSettings(tenantId, companyId)).passwordConfigured).toBe(true);
    const [after] = await db.select({ pass: companies.smtpPass }).from(companies).where(eq(companies.id, companyId));
    expect(after!.pass).toBeNull();
  });

  it('server mode still stores the password', async () => {
    await companyService.updateSmtpSettings(tenantId, companyId, { ...SETTINGS, smtpPass: 'server-stored' });
    const [row] = await db.select({ pass: companies.smtpPass }).from(companies).where(eq(companies.id, companyId));
    expect(row!.pass).toBe('server-stored');
    expect((await companyService.getSmtpSettings(tenantId, companyId)).passwordConfigured).toBe(true);
    await companyService.updateSmtpSettings(tenantId, companyId, { ...SETTINGS, smtpPass: null });
  });
});

describe('system SMTP settings in desktop mode', () => {
  it('refuses a password before writing anything', async () => {
    desktop();
    const before = await db.select().from(systemSettings).where(eq(systemSettings.key, 'smtp_host'));
    await expect(adminService.saveSmtpSettings({ ...SETTINGS, smtpHost: 'smtp.system.test', smtpPass: 'hunter2hunter2' }))
      .rejects.toMatchObject({ code: 'DESKTOP_KEYS_NOT_STORED' });
    const after = await db.select().from(systemSettings).where(eq(systemSettings.key, 'smtp_host'));
    expect(after).toEqual(before);
    expect((await adminService.getGlobalSettings()).smtpPasswordConfigured).toBe(false);
    secrets.setSmtpPassword('hunter2hunter2');
    expect((await adminService.getGlobalSettings()).smtpPasswordConfigured).toBe(true);
  });
});

describe('SMTP test in desktop mode', () => {
  it('uses the session password, never the body password', async () => {
    desktop();
    await expect(testSmtpConnection({ host: '10.0.0.25', port: 587, username: 'owner', password: 'body-pw', from: 'o@example.test' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'SMTP_NOT_CONFIGURED' });
    expect(mocks.created).toHaveLength(0);

    secrets.setSmtpPassword('hunter2hunter2');
    await secrets.allowSmtpEgress({ host: '10.0.0.25', port: 587, security: 'tls' });
    const r = await testSmtpConnection({ host: '10.0.0.25', port: 587, username: 'owner', password: 'body-pw', from: 'o@example.test' });
    expect(r).toEqual({ success: true });
    expect(mocks.created[0]).toMatchObject({ secure: true, requireTLS: false, auth: { user: 'owner', pass: 'hunter2hunter2' } });
    expect(JSON.stringify(mocks.created)).not.toContain('body-pw');
  });

  it('a server without a login needs no session password', async () => {
    desktop();
    const r = await testSmtpConnection({ host: '10.0.0.25', port: 25, from: 'o@example.test' });
    expect(r).toEqual({ success: true });
    expect(mocks.created[0]!['auth']).toBeUndefined();
  });
});
