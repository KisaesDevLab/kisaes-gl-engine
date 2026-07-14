// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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
import { eq, inArray, like } from 'drizzle-orm';

let tmpDir: string;

// Scoped cleanup — unscoped deletes nuke concurrently-running suites'
// data and die on their FKs. This file has no persistent tenant fixture:
// tests create tenants ad hoc with the 'fp-tenant-' slug prefix, so
// cleanup keys off that prefix. (NB: the fingerprint counts themselves
// are DB-global, so the zero-count assertions still assume no other
// suite's rows exist while this file runs.)
const fpTenantIds = () => db.select({ id: tenants.id }).from(tenants).where(like(tenants.slug, 'fp-tenant-%'));

async function cleanDb() {
  await db.delete(auditLog).where(inArray(auditLog.tenantId, fpTenantIds()));
  await db.delete(accounts).where(inArray(accounts.tenantId, fpTenantIds()));
  await db.delete(companies).where(inArray(companies.tenantId, fpTenantIds()));
  // sessions has no tenant_id — scope through the fp tenants' users.
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(inArray(users.tenantId, fpTenantIds()))),
  );
  await db.delete(users).where(inArray(users.tenantId, fpTenantIds()));
  await db.delete(tenants).where(like(tenants.slug, 'fp-tenant-%'));
  // system_settings is a global table (no tenant column); this delete is
  // already scoped to the single key these tests own.
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
    it('captures a well-formed fingerprint (counts are DB-global, so only bounds are deterministic under parallel suites)', async () => {
      const fp = await captureFingerprint();
      expect(fp.version).toBe(1);
      expect(fp.tenantCount).toBeGreaterThanOrEqual(0);
      expect(fp.userCount).toBeGreaterThanOrEqual(0);
      expect(fp.transactionCount).toBeGreaterThanOrEqual(0);
      // This suite owns the INSTALLATION_ID key (cleanup removes it and
      // no other suite writes it), so null IS deterministic.
      expect(fp.installationId).toBeNull();
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
      expect(typeof stored!.tenantCount).toBe('number');
      expect(stored!.tenantCount).toBeGreaterThanOrEqual(0);
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

    it('returns null when live counts are at or above the stored ones', async () => {
      // A stored all-zeros fingerprint can never look like a collapse
      // (live counts are ≥ 0), which makes this deterministic even
      // while other suites add/remove their own tenants concurrently.
      // (`updateFingerprint(); verifyFingerprint()` back to back is NOT
      // deterministic here — a parallel suite's cleanup can drop the
      // global tenant count between the two calls.)
      const zeros = {
        version: 1 as const,
        updatedAt: new Date().toISOString(),
        installationId: null,
        tenantCount: 0,
        userCount: 0,
        transactionCount: 0,
        lastTransactionId: null,
      };
      fs.writeFileSync(getFingerprintPath(), JSON.stringify(zeros));
      expect(await verifyFingerprint()).toBeNull();
    });

    // The collapse checks fire only when the LIVE count is exactly 0 —
    // a DB-global condition tests can't pin while other suites run in
    // parallel, so these pass a zeroed live snapshot via the service's
    // test seam.
    const zeroLive = {
      version: 1 as const,
      updatedAt: new Date().toISOString(),
      installationId: null,
      tenantCount: 0,
      userCount: 0,
      transactionCount: 0,
      lastTransactionId: null,
    };

    it('flags a transaction count collapse', async () => {
      const bogus = { ...zeroLive, transactionCount: 12_345 };
      fs.writeFileSync(getFingerprintPath(), JSON.stringify(bogus));
      const verdict = await verifyFingerprint(zeroLive);
      expect(verdict).toMatch(/transaction count dropped/);
    });

    it('flags a tenant count collapse', async () => {
      const bogus = { ...zeroLive, tenantCount: 7 };
      fs.writeFileSync(getFingerprintPath(), JSON.stringify(bogus));
      const verdict = await verifyFingerprint(zeroLive);
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
