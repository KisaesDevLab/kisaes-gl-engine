import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const keyHex = process.env['PLAID_ENCRYPTION_KEY'];
  if (!keyHex || keyHex.length < 32) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'PLAID_ENCRYPTION_KEY must be set in production (minimum 32 chars or 64 hex chars). ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    // Fallback to a derived key from JWT_SECRET for development/test only
    const secret = process.env['JWT_SECRET'] || 'dev-fallback-key';
    return crypto.createHash('sha256').update(secret).digest();
  }
  // If hex-encoded (64 chars = 32 bytes)
  if (keyHex.length === 64 && /^[0-9a-f]+$/i.test(keyHex)) {
    return Buffer.from(keyHex, 'hex');
  }
  // Otherwise hash whatever was provided
  return crypto.createHash('sha256').update(keyHex).digest();
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (all base64)
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted data format');

  const iv = Buffer.from(parts[0]!, 'base64');
  const tag = Buffer.from(parts[1]!, 'base64');
  const encrypted = Buffer.from(parts[2]!, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}
