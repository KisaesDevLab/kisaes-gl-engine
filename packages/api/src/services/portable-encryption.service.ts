import crypto from 'crypto';

// File format magic bytes to distinguish encryption methods
const PASSPHRASE_MAGIC = Buffer.from('VMBP', 'ascii'); // Vibe MyBooks Passphrase

/**
 * Format versions — the iteration count used by PBKDF2 is tied to the
 * version byte so we can bump it without breaking existing files.
 *
 *   v1 → 100,000 iterations (legacy; original release)
 *   v2 → 600,000 iterations (OWASP 2023 recommendation for PBKDF2-SHA512)
 *
 * Writes always use the latest version. Reads dispatch on the version
 * byte so existing backups and .env.recovery files from v1 continue to
 * decrypt with the original parameters. F19.
 */
const FORMAT_VERSION_V1 = 1;
const FORMAT_VERSION_V2 = 2;
const FORMAT_VERSION_LATEST = FORMAT_VERSION_V2;

const PBKDF2_ITERATIONS_BY_VERSION: Record<number, number> = {
  [FORMAT_VERSION_V1]: 100_000,
  [FORMAT_VERSION_V2]: 600_000,
};

const KEY_LENGTH = 32; // 256 bits
const SALT_LENGTH = 32;
const IV_LENGTH = 12; // AES-GCM standard
const AUTH_TAG_LENGTH = 16;

// Header layout:
// [4 bytes magic][1 byte version][32 bytes salt][12 bytes IV][16 bytes authTag][...encrypted data]
const HEADER_SIZE = PASSPHRASE_MAGIC.length + 1 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;

export type PassphraseStrength = 'weak' | 'fair' | 'strong' | 'very_strong';

/**
 * Derive an AES-256 key from a passphrase using PBKDF2. The iteration count
 * is selected by format version so existing v1 files can still be decrypted
 * after the v2 bump.
 */
function deriveKey(passphrase: string, salt: Buffer, version: number): Buffer {
  const iterations = PBKDF2_ITERATIONS_BY_VERSION[version];
  if (!iterations) {
    throw new Error(`Unsupported encryption format version: ${version}`);
  }
  return crypto.pbkdf2Sync(passphrase, salt, iterations, KEY_LENGTH, 'sha512');
}

/**
 * Encrypt data with a user-provided passphrase using PBKDF2 + AES-256-GCM.
 *
 * The output is a self-contained buffer:
 *   [VMBP magic][version][salt][IV][authTag][encrypted data]
 *
 * The passphrase is never stored anywhere.
 */
export function encryptWithPassphrase(data: Buffer, passphrase: string): Buffer {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(passphrase, salt, FORMAT_VERSION_LATEST);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: magic + version + salt + iv + authTag + ciphertext
  const header = Buffer.alloc(PASSPHRASE_MAGIC.length + 1);
  PASSPHRASE_MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION_LATEST, PASSPHRASE_MAGIC.length);

  return Buffer.concat([header, salt, iv, authTag, encrypted]);
}

/**
 * Decrypt a passphrase-encrypted buffer.
 *
 * Throws a clear error if the passphrase is wrong (auth tag verification fails)
 * or if the file is corrupted/tampered with.
 */
export function decryptWithPassphrase(fileBuffer: Buffer, passphrase: string): Buffer {
  if (fileBuffer.length < HEADER_SIZE) {
    throw new Error('File is too small to be a valid encrypted backup');
  }

  const magic = fileBuffer.subarray(0, PASSPHRASE_MAGIC.length);
  if (!magic.equals(PASSPHRASE_MAGIC)) {
    throw new Error('Not a passphrase-encrypted file (invalid magic bytes)');
  }

  const version = fileBuffer.readUInt8(PASSPHRASE_MAGIC.length);
  if (!PBKDF2_ITERATIONS_BY_VERSION[version]) {
    throw new Error(`Unsupported encryption format version: ${version}`);
  }

  let offset = PASSPHRASE_MAGIC.length + 1;
  const salt = fileBuffer.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = fileBuffer.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = fileBuffer.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const encrypted = fileBuffer.subarray(offset);

  const key = deriveKey(passphrase, salt, version);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error('Incorrect passphrase or corrupted file');
  }
}

/**
 * Detect whether a file buffer uses passphrase encryption (new format)
 * or server-key encryption (old format).
 */
export function detectEncryptionMethod(fileBuffer: Buffer): 'passphrase' | 'server_key' {
  if (fileBuffer.length >= PASSPHRASE_MAGIC.length) {
    const magic = fileBuffer.subarray(0, PASSPHRASE_MAGIC.length);
    if (magic.equals(PASSPHRASE_MAGIC)) {
      return 'passphrase';
    }
  }
  return 'server_key';
}

/**
 * Decrypt using the old server-key method (AES-256-GCM with SHA-256 hashed key).
 * For backward compatibility with existing .kbk backups.
 *
 * Old format: [16 bytes IV][16 bytes authTag][encrypted data]
 */
export function decryptWithServerKey(fileBuffer: Buffer, serverKey: string): Buffer {
  if (fileBuffer.length < 32) {
    throw new Error('File is too small to be a valid server-key encrypted backup');
  }

  const iv = fileBuffer.subarray(0, 16);
  const authTag = fileBuffer.subarray(16, 32);
  const encrypted = fileBuffer.subarray(32);
  const keyHash = crypto.createHash('sha256').update(serverKey).digest();

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyHash, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error('Invalid encryption key or corrupted file');
  }
}

/**
 * Smart decrypt: auto-detect encryption method and decrypt accordingly.
 *
 * - If passphrase-encrypted: requires `passphrase` parameter.
 * - If server-key encrypted: uses `BACKUP_ENCRYPTION_KEY` from env (backward compat).
 */
export function smartDecrypt(
  fileBuffer: Buffer,
  passphrase?: string,
): { data: Buffer; method: 'passphrase' | 'server_key' } {
  const method = detectEncryptionMethod(fileBuffer);

  if (method === 'passphrase') {
    if (!passphrase) {
      throw new Error('This backup is passphrase-encrypted. Please provide the passphrase.');
    }
    return { data: decryptWithPassphrase(fileBuffer, passphrase), method };
  }

  // Server-key encrypted (old format)
  const serverKey = process.env['BACKUP_ENCRYPTION_KEY'];
  if (!serverKey) {
    throw new Error(
      'This backup uses the old server-key encryption format. ' +
      'BACKUP_ENCRYPTION_KEY must be configured in .env to decrypt it.',
    );
  }
  return { data: decryptWithServerKey(fileBuffer, serverKey), method };
}

/**
 * Validate passphrase strength.
 *
 * - Minimum 12 characters required.
 * - Strength based on length + character class diversity.
 */
export function validatePassphraseStrength(passphrase: string): {
  valid: boolean;
  strength: PassphraseStrength;
  message: string;
} {
  if (passphrase.length < 12) {
    return {
      valid: false,
      strength: 'weak',
      message: 'Passphrase must be at least 12 characters',
    };
  }

  let score = 0;

  // Length scoring
  if (passphrase.length >= 12) score += 1;
  if (passphrase.length >= 16) score += 1;
  if (passphrase.length >= 24) score += 1;
  if (passphrase.length >= 32) score += 1;

  // Character class diversity
  if (/[a-z]/.test(passphrase)) score += 1;
  if (/[A-Z]/.test(passphrase)) score += 1;
  if (/[0-9]/.test(passphrase)) score += 1;
  if (/[^a-zA-Z0-9]/.test(passphrase)) score += 1;

  let strength: PassphraseStrength;
  if (score <= 3) {
    strength = 'fair';
  } else if (score <= 5) {
    strength = 'strong';
  } else {
    strength = 'very_strong';
  }

  return {
    valid: true,
    strength,
    message: strength === 'fair'
      ? 'Consider adding more character types or length'
      : strength === 'strong'
        ? 'Good passphrase'
        : 'Excellent passphrase',
  };
}

/**
 * Generate a SHA-256 checksum for data integrity verification.
 */
export function generateChecksum(data: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
}

/**
 * Verify a SHA-256 checksum.
 */
export function verifyChecksum(data: Buffer, checksum: string): boolean {
  const expected = generateChecksum(data);
  return expected === checksum;
}
