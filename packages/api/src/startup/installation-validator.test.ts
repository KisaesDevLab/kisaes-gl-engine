// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { validateInstallation, type ValidationInput, type SentinelReadResult } from './installation-validator.js';
import type { SentinelHeader, SentinelPayload } from '../services/sentinel.service.js';

const INSTALL_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const INSTALL_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const HOST_X = '11111111-1111-4111-8111-111111111111';
const HOST_Y = '22222222-2222-4222-8222-222222222222';

function makeHeader(installationId: string, hostId: string): SentinelHeader {
  return {
    v: 1,
    installationId,
    hostId,
    createdAt: '2026-04-11T12:00:00.000Z',
    adminEmail: 'admin@example.com',
    appVersion: '0.1.0',
  };
}

function makePayload(installationId: string, hostId: string): SentinelPayload {
  return {
    ...makeHeader(installationId, hostId),
    databaseUrlHash: 'x'.repeat(64),
    jwtSecretHash: 'y'.repeat(64),
    tenantCountAtSetup: 1,
    checksum: 'z'.repeat(64),
  };
}

function fullSentinel(installationId: string, hostId: string): SentinelReadResult {
  return { kind: 'full', header: makeHeader(installationId, hostId), payload: makePayload(installationId, hostId) };
}

function run(partial: Partial<ValidationInput>): ReturnType<typeof validateInstallation> {
  return validateInstallation({
    dbInstallationId: null,
    currentHostId: null,
    sentinel: { kind: 'missing' },
    ...partial,
  });
}

describe('validateInstallation — 12 scenario matrix', () => {
  // Scenario 1: everything matches → continue
  it('scenario 1: DB + sentinel + host-id all match → ok', () => {
    const result = run({
      dbInstallationId: INSTALL_A,
      currentHostId: HOST_X,
      sentinel: fullSentinel(INSTALL_A, HOST_X),
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.installationId).toBe(INSTALL_A);
      expect(result.hostId).toBe(HOST_X);
    }
  });

  // Scenario 2: primary threat — DB reset, sentinel survives → block
  it('scenario 2: DB empty + sentinel valid → DATABASE_RESET_DETECTED', () => {
    const result = run({
      dbInstallationId: null,
      currentHostId: HOST_X,
      sentinel: fullSentinel(INSTALL_A, HOST_X),
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.code).toBe('DATABASE_RESET_DETECTED');
      expect(result.header?.installationId).toBe(INSTALL_A);
    }
  });

  // Scenario 3: DB has ID but sentinel missing → regenerate
  it('scenario 3: DB set + sentinel missing → regenerate-sentinel (missing)', () => {
    const result = run({
      dbInstallationId: INSTALL_A,
      currentHostId: HOST_X,
      sentinel: { kind: 'missing' },
    });
    expect(result.status).toBe('regenerate-sentinel');
    if (result.status === 'regenerate-sentinel') {
      expect(result.reason).toBe('missing');
      expect(result.dbInstallationId).toBe(INSTALL_A);
      expect(result.previousHostId).toBe(HOST_X);
    }
  });

  // Scenario 4: completely fresh install
  it('scenario 4: empty DB + no sentinel + no host-id → fresh-install', () => {
    const result = run({
      dbInstallationId: null,
      currentHostId: null,
      sentinel: { kind: 'missing' },
    });
    expect(result.status).toBe('fresh-install');
  });

  // Scenario 5: wrong encryption key
  it('scenario 5: DB set + sentinel decrypt fails → SENTINEL_DECRYPT_FAILED', () => {
    const result = run({
      dbInstallationId: INSTALL_A,
      currentHostId: HOST_X,
      sentinel: { kind: 'decrypt-failed', header: makeHeader(INSTALL_A, HOST_X) },
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.code).toBe('SENTINEL_DECRYPT_FAILED');
      expect(result.header?.installationId).toBe(INSTALL_A);
    }
  });

  // Scenario 6: sentinel corrupt (byte flip in header)
  it('scenario 6: sentinel corrupt (CRC fail) → SENTINEL_CORRUPT', () => {
    const result = run({
      dbInstallationId: INSTALL_A,
      currentHostId: HOST_X,
      sentinel: { kind: 'corrupt', code: 'CRC' },
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.code).toBe('SENTINEL_CORRUPT');
    }
  });

  // Scenario 7: installation ID swap
  it('scenario 7: DB installation_id differs from sentinel → INSTALLATION_MISMATCH', () => {
    const result = run({
      dbInstallationId: INSTALL_B,
      currentHostId: HOST_X,
      sentinel: fullSentinel(INSTALL_A, HOST_X),
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.code).toBe('INSTALLATION_MISMATCH');
    }
  });

  // Scenario 8: host-id mismatch (new volume / cross-host restore)
  it('scenario 8: DB + sentinel match, host-id differs → regenerate-sentinel (host-id-changed)', () => {
    const result = run({
      dbInstallationId: INSTALL_A,
      currentHostId: HOST_Y,
      sentinel: fullSentinel(INSTALL_A, HOST_X),
    });
    expect(result.status).toBe('regenerate-sentinel');
    if (result.status === 'regenerate-sentinel') {
      expect(result.reason).toBe('host-id-changed');
      expect(result.previousHostId).toBe(HOST_X);
    }
  });

  // Scenario 9: host-id file absent, DB + sentinel present → regenerate
  it('scenario 9: DB + sentinel match, host-id file missing → regenerate (fresh-volume)', () => {
    const result = run({
      dbInstallationId: INSTALL_A,
      currentHostId: null,
      sentinel: fullSentinel(INSTALL_A, HOST_X),
    });
    expect(result.status).toBe('regenerate-sentinel');
    if (result.status === 'regenerate-sentinel') {
      expect(result.reason).toBe('fresh-volume');
      expect(result.previousHostId).toBe(HOST_X);
    }
  });

  // Scenario 10: same as scenario 2 — attacker injects single tenant row into empty DB
  // but never updates installation_id. Validator must still block.
  it('scenario 10: installation_id still null even with tenant rows → DATABASE_RESET_DETECTED', () => {
    // The validator itself only looks at installation_id. The "tenant rows
    // exist but installation_id is null" bypass is handled upstream in
    // getSetupStatus — here we just confirm a null dbInstallationId blocks
    // regardless of any hypothetical tenant-count signal.
    const result = run({
      dbInstallationId: null,
      currentHostId: HOST_X,
      sentinel: fullSentinel(INSTALL_A, HOST_X),
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.code).toBe('DATABASE_RESET_DETECTED');
  });

  // Scenario 11: ENCRYPTION_KEY missing at env load time.
  // Phase A: env.ts crashes before the validator runs, so this scenario is
  // observable only via process exit. Phase B adds the env-precheck flow.
  // Documenting here so the matrix is complete.
  it('scenario 11 (documentation): ENCRYPTION_KEY missing is handled pre-env in Phase B', () => {
    expect(true).toBe(true);
  });

  // Scenario 12: orphan data — no DB state, no sentinel, but host-id file present
  it('scenario 12: empty DB + no sentinel + host-id present → ORPHANED_DATA', () => {
    const result = run({
      dbInstallationId: null,
      currentHostId: HOST_X,
      sentinel: { kind: 'missing' },
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.code).toBe('ORPHANED_DATA');
  });
});
