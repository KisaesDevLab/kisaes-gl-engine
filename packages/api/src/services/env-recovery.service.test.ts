import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeRecoveryFile,
  readRecoveryFile,
  recoveryFileExists,
  deleteRecoveryFile,
  getRecoveryFilePath,
} from './env-recovery.service.js';
import { generateRecoveryKey } from './recovery-key.service.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-recovery-test-'));
  process.env['DATA_DIR'] = tmpDir;
});

afterEach(() => {
  delete process.env['DATA_DIR'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SAMPLE_VALUES = {
  encryptionKey: '0123456789abcdef'.repeat(4),
  jwtSecret: 'test-jwt-secret-at-least-thirty-two-characters',
  databaseUrl: 'postgresql://kisbooks:kisbooks@db:5432/kisbooks',
};

describe('env-recovery.service', () => {
  it('round-trips: writeRecoveryFile → readRecoveryFile returns the same values', () => {
    const key = generateRecoveryKey();
    writeRecoveryFile(key, SAMPLE_VALUES, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');

    expect(recoveryFileExists()).toBe(true);
    const decrypted = readRecoveryFile(key);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.encryptionKey).toBe(SAMPLE_VALUES.encryptionKey);
    expect(decrypted!.jwtSecret).toBe(SAMPLE_VALUES.jwtSecret);
    expect(decrypted!.databaseUrl).toBe(SAMPLE_VALUES.databaseUrl);
    expect(decrypted!.installationId).toBe('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    expect(decrypted!.version).toBe(1);
  });

  it('returns null when the file does not exist', () => {
    expect(readRecoveryFile(generateRecoveryKey())).toBeNull();
  });

  it('rejects a wrong recovery key with a decryption error', () => {
    const keyA = generateRecoveryKey();
    const keyB = generateRecoveryKey();
    writeRecoveryFile(keyA, SAMPLE_VALUES, null);
    expect(() => readRecoveryFile(keyB)).toThrow(/decrypt/);
  });

  it('rejects a malformed recovery key with a parse error', () => {
    writeRecoveryFile(generateRecoveryKey(), SAMPLE_VALUES, null);
    expect(() => readRecoveryFile('not-a-real-key')).toThrow();
  });

  it('overwrites an existing recovery file', () => {
    const key = generateRecoveryKey();
    writeRecoveryFile(key, SAMPLE_VALUES, null);
    const modified = { ...SAMPLE_VALUES, databaseUrl: 'postgresql://other:other@db:5432/other' };
    writeRecoveryFile(key, modified, null);

    const decrypted = readRecoveryFile(key);
    expect(decrypted!.databaseUrl).toBe('postgresql://other:other@db:5432/other');
  });

  it('deleteRecoveryFile removes the file', () => {
    writeRecoveryFile(generateRecoveryKey(), SAMPLE_VALUES, null);
    expect(recoveryFileExists()).toBe(true);
    deleteRecoveryFile();
    expect(recoveryFileExists()).toBe(false);
  });

  it('leaves no .tmp file after a successful write', () => {
    writeRecoveryFile(generateRecoveryKey(), SAMPLE_VALUES, null);
    expect(fs.existsSync(getRecoveryFilePath() + '.tmp')).toBe(false);
  });

  it('stores only the three fields we commit to recovering', () => {
    const key = generateRecoveryKey();
    writeRecoveryFile(key, SAMPLE_VALUES, 'inst-id');
    const contents = readRecoveryFile(key);
    expect(Object.keys(contents!).sort()).toEqual(
      ['createdAt', 'databaseUrl', 'encryptionKey', 'installationId', 'jwtSecret', 'version'].sort(),
    );
  });
});
