// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from '../db/index.js';
import { tenants, users, companies, sessions, accounts, auditLog, systemSettings } from '../db/schema/index.js';
import {
  captureFingerprint,
  readFingerprint,
  updateFingerprint,
  verifyFingerprint,
  fingerprintExists,
  getFingerprintPath,
} from './db-fingerprint.service.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';
import { eq } from 'drizzle-orm';

let tmpDir: string;

async function cleanDb() {
  await db.delete(auditLog);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
  await db.delete(systemSettings).where(eq(systemSettings.key, SystemSettingsKeys.INSTALLATION_ID));
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fingerprint-test-'));
  process.env['DATA_DIR'] = tmpDir;
  await cleanDb();
});

afterEach(async () => {
  delete process.env['DATA_DIR'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await cleanDb();
});

describe('db-fingerprint.service', () => {
  describe('captureFingerprint', () => {
    it('returns zero counts on an empty database', async () => {
      const fp = await captureFingerprint();
      expect(fp.version).toBe(1);
      expect(fp.tenantCount).toBe(0);
      expect(fp.userCount).toBe(0);
      expect(fp.transactionCount).toBe(0);
      expect(fp.installationId).toBeNull();
      expect(fp.lastTransactionId).toBeNull();
    });

    it('counts actual tenants and users after seeding', async () => {
      const [tenant] = await db
        .insert(tenants)
        .values({ name: 'FP Tenant', slug: 'fp-tenant-' + Date.now() })
        .returning();
      await db.insert(users).values({
        tenantId: tenant!.id,
        email: `fp-user-${Date.now()}@example.com`,
        passwordHash: 'x',
        displayName: 'FP',
      });

      const fp = await captureFingerprint();
      expect(fp.tenantCount).toBeGreaterThanOrEqual(1);
      expect(fp.userCount).toBeGreaterThanOrEqual(1);
    });

    it('picks up installation_id from system_settings', async () => {
      await db
        .insert(systemSettings)
        .values({ key: SystemSettingsKeys.INSTALLATION_ID, value: 'abcd-efgh' });
      const fp = await captureFingerprint();
      expect(fp.installationId).toBe('abcd-efgh');
    });
  });

  describe('updateFingerprint + readFingerprint', () => {
    it('writes the file atomically and round-trips', async () => {
      await updateFingerprint();
      expect(fingerprintExists()).toBe(true);

      const stored = readFingerprint();
      expect(stored).not.toBeNull();
      expect(stored!.version).toBe(1);
      expect(stored!.tenantCount).toBe(0);
    });

    it('readFingerprint returns null when the file is absent', () => {
      expect(readFingerprint()).toBeNull();
    });

    it('readFingerprint returns null on malformed JSON', () => {
      fs.writeFileSync(getFingerprintPath(), '{not json');
      expect(readFingerprint()).toBeNull();
    });

    it('readFingerprint returns null on unsupported version', () => {
      fs.writeFileSync(getFingerprintPath(), JSON.stringify({ version: 999 }));
      expect(readFingerprint()).toBeNull();
    });

    it('leaves no .tmp file after updateFingerprint', async () => {
      await updateFingerprint();
      expect(fs.existsSync(getFingerprintPath() + '.tmp')).toBe(false);
    });
  });

  describe('verifyFingerprint', () => {
    it('returns null when no fingerprint has been written yet', async () => {
      expect(await verifyFingerprint()).toBeNull();
    });

    it('returns null when the stored and live states agree', async () => {
      await updateFingerprint();
      expect(await verifyFingerprint()).toBeNull();
    });

    it('flags a transaction count collapse', async () => {
      // Write a fingerprint that claims many transactions exist.
      const bogus = {
        version: 1 as const,
        updatedAt: new Date().toISOString(),
        installationId: null,
        tenantCount: 0,
        userCount: 0,
        transactionCount: 12_345,
        lastTransactionId: null,
      };
      fs.writeFileSync(getFingerprintPath(), JSON.stringify(bogus));
      const verdict = await verifyFingerprint();
      expect(verdict).toMatch(/transaction count dropped/);
    });

    it('flags a tenant count collapse', async () => {
      const bogus = {
        version: 1 as const,
        updatedAt: new Date().toISOString(),
        installationId: null,
        tenantCount: 7,
        userCount: 0,
        transactionCount: 0,
        lastTransactionId: null,
      };
      fs.writeFileSync(getFingerprintPath(), JSON.stringify(bogus));
      const verdict = await verifyFingerprint();
      expect(verdict).toMatch(/tenant count dropped/);
    });

    it('flags an installation_id change', async () => {
      await db
        .insert(systemSettings)
        .values({ key: SystemSettingsKeys.INSTALLATION_ID, value: 'current-id' });
      const bogus = {
        version: 1 as const,
        updatedAt: new Date().toISOString(),
        installationId: 'old-id',
        tenantCount: 0,
        userCount: 0,
        transactionCount: 0,
        lastTransactionId: null,
      };
      fs.writeFileSync(getFingerprintPath(), JSON.stringify(bogus));
      const verdict = await verifyFingerprint();
      expect(verdict).toMatch(/installation_id changed/);
    });
  });
});
