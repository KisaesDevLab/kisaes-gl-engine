// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureHostId, readHostId, getHostIdPath } from './host-id.service.js';

/**
 * Cross-host restore detection (Phase C / F8) relies on comparing the
 * `installation_files.hostId` inside a backup archive against the current
 * /data/.host-id. These tests simulate the different scenarios the
 * restore flow in setup.routes.ts has to branch on.
 */

let volumeA: string;
let volumeB: string;

function useVolume(dir: string): void {
  process.env['DATA_DIR'] = dir;
}

function simulateRestoreDetection(backupHostId: string | null, currentHostId: string | null): boolean {
  // Mirror of the logic inside setup.routes.ts /restore/execute. Change
  // this test if the condition in the real route changes.
  return backupHostId !== null && currentHostId !== null && backupHostId === currentHostId;
}

beforeEach(() => {
  volumeA = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-host-a-'));
  volumeB = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-host-b-'));
});

afterEach(() => {
  delete process.env['DATA_DIR'];
  fs.rmSync(volumeA, { recursive: true, force: true });
  fs.rmSync(volumeB, { recursive: true, force: true });
});

describe('cross-host restore detection', () => {
  it('same-host: restoring onto the same volume where host-id matches → isSameHost', () => {
    useVolume(volumeA);
    const original = ensureHostId();
    // Operator runs /restore/execute against the same volume — backup's
    // embedded hostId matches the current volume's.
    expect(simulateRestoreDetection(original, readHostId())).toBe(true);
  });

  it('new-host: backup from volume A restored onto volume B → NOT same host', () => {
    useVolume(volumeA);
    const backupHostId = ensureHostId();
    useVolume(volumeB);
    const currentHostId = ensureHostId();
    expect(backupHostId).not.toBe(currentHostId);
    expect(simulateRestoreDetection(backupHostId, currentHostId)).toBe(false);
  });

  it('legacy: backup lacks hostId field → NOT same host', () => {
    useVolume(volumeA);
    ensureHostId();
    expect(simulateRestoreDetection(null, readHostId())).toBe(false);
  });

  it('pre-boot: host-id file not yet created on current volume → NOT same host', () => {
    useVolume(volumeA);
    const backupHostId = 'some-uuid-from-backup';
    // readHostId() returns null if the file does not exist
    expect(readHostId()).toBeNull();
    expect(simulateRestoreDetection(backupHostId, readHostId())).toBe(false);
  });

  it('host-id persists: switching volumes and back produces the original id', () => {
    useVolume(volumeA);
    const originalA = ensureHostId();
    useVolume(volumeB);
    const originalB = ensureHostId();
    useVolume(volumeA);
    expect(ensureHostId()).toBe(originalA);
    expect(originalA).not.toBe(originalB);
  });

  it('host-id file is written under the expected path', () => {
    useVolume(volumeA);
    ensureHostId();
    expect(getHostIdPath()).toBe(path.join(volumeA, '.host-id'));
    expect(fs.existsSync(getHostIdPath())).toBe(true);
  });
});
