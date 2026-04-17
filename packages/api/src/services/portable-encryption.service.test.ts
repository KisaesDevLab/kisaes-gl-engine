// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  encryptWithPassphrase,
  decryptWithPassphrase,
  detectEncryptionMethod,
  decryptWithServerKey,
  smartDecrypt,
  validatePassphraseStrength,
  generateChecksum,
  verifyChecksum,
} from './portable-encryption.service.js';

describe('Portable Encryption Service', () => {
  const testPassphrase = 'my-secure-backup-2026';
  const testData = Buffer.from('{"metadata":{"version":"1.0"},"data":"hello world"}');

  describe('encryptWithPassphrase / decryptWithPassphrase', () => {
    it('should encrypt and decrypt round-trip with correct passphrase', () => {
      const encrypted = encryptWithPassphrase(testData, testPassphrase);
      const decrypted = decryptWithPassphrase(encrypted, testPassphrase);
      expect(decrypted.toString()).toBe(testData.toString());
    });

    it('should produce different ciphertext each time (random salt + IV)', () => {
      const encrypted1 = encryptWithPassphrase(testData, testPassphrase);
      const encrypted2 = encryptWithPassphrase(testData, testPassphrase);
      expect(encrypted1.equals(encrypted2)).toBe(false);
    });

    it('should fail with wrong passphrase', () => {
      const encrypted = encryptWithPassphrase(testData, testPassphrase);
      expect(() => decryptWithPassphrase(encrypted, 'wrong-passphrase-here'))
        .toThrow('Incorrect passphrase or corrupted file');
    });

    it('should detect tampered data via auth tag verification', () => {
      const encrypted = encryptWithPassphrase(testData, testPassphrase);
      // Tamper with the encrypted data (flip a byte near the end)
      const tampered = Buffer.from(encrypted);
      const idx = tampered.length - 5;
      tampered.writeUInt8(tampered.readUInt8(idx) ^ 0xff, idx);
      expect(() => decryptWithPassphrase(tampered, testPassphrase))
        .toThrow('Incorrect passphrase or corrupted file');
    });

    it('should reject too-small buffers', () => {
      const tooSmall = Buffer.alloc(10);
      expect(() => decryptWithPassphrase(tooSmall, testPassphrase))
        .toThrow('too small');
    });

    it('should reject buffers without correct magic bytes', () => {
      const wrongMagic = Buffer.alloc(100);
      wrongMagic.write('XXXX', 0, 'ascii');
      expect(() => decryptWithPassphrase(wrongMagic, testPassphrase))
        .toThrow('invalid magic bytes');
    });

    it('should still decrypt legacy v1 files (100k iterations)', () => {
      // Phase C F19: the default format version was bumped from v1 (100k
      // PBKDF2 iterations) to v2 (600k). Existing backups and .env.recovery
      // files on upgraded installs are v1 and must keep decrypting.
      //
      // Build a v1 file by hand: same layout as the service produces, but
      // with FORMAT_VERSION=1 and the matching 100k iteration count.
      const passphrase = 'legacy-v1-passphrase';
      const plaintext = Buffer.from('legacy v1 payload');
      const salt = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const legacyKey = crypto.pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha512');
      const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();

      const header = Buffer.alloc(5);
      header.write('VMBP', 0, 'ascii');
      header.writeUInt8(1, 4); // v1
      const legacyFile = Buffer.concat([header, salt, iv, authTag, ciphertext]);

      const decrypted = decryptWithPassphrase(legacyFile, passphrase);
      expect(decrypted.toString()).toBe('legacy v1 payload');
    });

    it('should write v2 files by default after the F19 bump', () => {
      const encrypted = encryptWithPassphrase(testData, testPassphrase);
      // 5th byte (index 4) is the version byte
      expect(encrypted.readUInt8(4)).toBe(2);
    });

    it('should reject an unknown format version', () => {
      // Header layout is 4 magic + 1 version + 32 salt + 12 IV + 16 tag = 65
      // bytes. Add a few ciphertext bytes so the buffer clears the HEADER_SIZE
      // gate inside decryptWithPassphrase.
      const bogus = Buffer.alloc(4 + 1 + 32 + 12 + 16 + 16);
      bogus.write('VMBP', 0, 'ascii');
      bogus.writeUInt8(99, 4);
      expect(() => decryptWithPassphrase(bogus, testPassphrase)).toThrow(/format version/);
    });
  });

  describe('detectEncryptionMethod', () => {
    it('should detect passphrase-encrypted files', () => {
      const encrypted = encryptWithPassphrase(testData, testPassphrase);
      expect(detectEncryptionMethod(encrypted)).toBe('passphrase');
    });

    it('should detect server-key encrypted files (old format)', () => {
      // Old format: [16 bytes IV][16 bytes authTag][encrypted data]
      const iv = crypto.randomBytes(16);
      const key = crypto.createHash('sha256').update('server-key').digest();
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(testData), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const oldFormat = Buffer.concat([iv, authTag, encrypted]);

      expect(detectEncryptionMethod(oldFormat)).toBe('server_key');
    });
  });

  describe('decryptWithServerKey (backward compat)', () => {
    it('should decrypt old format with correct server key', () => {
      const serverKey = 'my-old-server-encryption-key';
      const iv = crypto.randomBytes(16);
      const keyHash = crypto.createHash('sha256').update(serverKey).digest();
      const cipher = crypto.createCipheriv('aes-256-gcm', keyHash, iv);
      const encrypted = Buffer.concat([cipher.update(testData), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const oldFormat = Buffer.concat([iv, authTag, encrypted]);

      const decrypted = decryptWithServerKey(oldFormat, serverKey);
      expect(decrypted.toString()).toBe(testData.toString());
    });

    it('should fail with wrong server key', () => {
      const serverKey = 'correct-key';
      const iv = crypto.randomBytes(16);
      const keyHash = crypto.createHash('sha256').update(serverKey).digest();
      const cipher = crypto.createCipheriv('aes-256-gcm', keyHash, iv);
      const encrypted = Buffer.concat([cipher.update(testData), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const oldFormat = Buffer.concat([iv, authTag, encrypted]);

      expect(() => decryptWithServerKey(oldFormat, 'wrong-key'))
        .toThrow('Invalid encryption key or corrupted file');
    });
  });

  describe('smartDecrypt', () => {
    it('should auto-detect and decrypt passphrase format', () => {
      const encrypted = encryptWithPassphrase(testData, testPassphrase);
      const result = smartDecrypt(encrypted, testPassphrase);
      expect(result.method).toBe('passphrase');
      expect(result.data.toString()).toBe(testData.toString());
    });

    it('should require passphrase for passphrase-encrypted files', () => {
      const encrypted = encryptWithPassphrase(testData, testPassphrase);
      expect(() => smartDecrypt(encrypted))
        .toThrow('passphrase-encrypted');
    });
  });

  describe('validatePassphraseStrength', () => {
    it('should reject passphrases shorter than 12 characters', () => {
      const result = validatePassphraseStrength('short');
      expect(result.valid).toBe(false);
      expect(result.strength).toBe('weak');
    });

    it('should accept 12-character passphrases', () => {
      const result = validatePassphraseStrength('exactly12cha');
      expect(result.valid).toBe(true);
    });

    it('should rate mixed-case with numbers as strong', () => {
      const result = validatePassphraseStrength('MyPassphrase123');
      expect(result.valid).toBe(true);
      expect(['strong', 'very_strong']).toContain(result.strength);
    });

    it('should rate long diverse passphrases as very strong', () => {
      const result = validatePassphraseStrength('My-Super-Secure-Passphrase-2026!');
      expect(result.valid).toBe(true);
      expect(result.strength).toBe('very_strong');
    });

    it('should rate lowercase-only 12-char passphrase as fair', () => {
      const result = validatePassphraseStrength('mysimplepassphrase');
      expect(result.valid).toBe(true);
      expect(result.strength).toBe('fair');
    });
  });

  describe('checksum', () => {
    it('should generate and verify checksums', () => {
      const checksum = generateChecksum(testData);
      expect(checksum.startsWith('sha256:')).toBe(true);
      expect(verifyChecksum(testData, checksum)).toBe(true);
    });

    it('should reject incorrect checksums', () => {
      const checksum = generateChecksum(testData);
      const differentData = Buffer.from('different data');
      expect(verifyChecksum(differentData, checksum)).toBe(false);
    });
  });
});
