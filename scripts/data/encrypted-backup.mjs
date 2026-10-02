// IMPORTANT: This script provides AES-256-GCM encryption for the GitHub
// encrypted-backup toolchain ONLY. It MUST NOT be used by the R2 automatic
// backup pipeline. Per AGENTS.md, R2 backups must remain plaintext JSON.
// The passphrase is sourced from GITHUB_BACKUP_ENCRYPTION_KEY (preferred) or
// BACKUP_ENCRYPTION_KEY (legacy), never from any R2_* environment variable.
import { createCipheriv, createDecipheriv, createHash, scryptSync, randomBytes } from 'node:crypto';

const ENCRYPTED_BACKUP_VERSION = 1;
const ENCRYPTED_BACKUP_MAGIC = 'blog-navigation-encrypted-backup';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const CURRENT_KEY_DERIVATION = 'scrypt';
const SUPPORTED_KEY_DERIVATIONS = ['sha256', 'scrypt'];
const LEGACY_KEY_DERIVATION_SALT = 'blog-navigation-backup-v1';
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function parseEncryptedBackupPayload(encryptedPayload) {
  if (
    !encryptedPayload ||
    encryptedPayload.version !== ENCRYPTED_BACKUP_VERSION ||
    encryptedPayload.algorithm !== ENCRYPTION_ALGORITHM ||
    !SUPPORTED_KEY_DERIVATIONS.includes(encryptedPayload.keyDerivation) ||
    typeof encryptedPayload.iv !== 'string' ||
    typeof encryptedPayload.authTag !== 'string' ||
    typeof encryptedPayload.ciphertext !== 'string' ||
    (encryptedPayload.magic !== undefined && encryptedPayload.magic !== ENCRYPTED_BACKUP_MAGIC) ||
    (encryptedPayload.salt !== undefined && typeof encryptedPayload.salt !== 'string')
  ) {
    return null;
  }

  return encryptedPayload;
}

function deriveKey(secret, method = CURRENT_KEY_DERIVATION, salt = Buffer.from(LEGACY_KEY_DERIVATION_SALT, 'utf8')) {
  if (method === 'scrypt') {
    return scryptSync(secret, salt, KEY_LENGTH);
  }

  return createHash('sha256').update(secret, 'utf8').digest();
}

export function getBackupEncryptionSecret() {
  return process.env.GITHUB_BACKUP_ENCRYPTION_KEY || process.env.BACKUP_ENCRYPTION_KEY || '';
}

export function createEncryptedBackupPayload(backupPayload, secret) {
  if (!secret) {
    throw new Error('GITHUB_BACKUP_ENCRYPTION_KEY or BACKUP_ENCRYPTION_KEY is required.');
  }

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, deriveKey(secret, CURRENT_KEY_DERIVATION, salt), iv);
  const plaintext = Buffer.from(JSON.stringify(backupPayload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    magic: ENCRYPTED_BACKUP_MAGIC,
    version: ENCRYPTED_BACKUP_VERSION,
    algorithm: ENCRYPTION_ALGORITHM,
    keyDerivation: CURRENT_KEY_DERIVATION,
    encryptedAt: new Date().toISOString(),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

export function decryptBackupPayload(encryptedPayload, secret) {
  if (!secret) {
    throw new Error('GITHUB_BACKUP_ENCRYPTION_KEY or BACKUP_ENCRYPTION_KEY is required.');
  }

  if (!parseEncryptedBackupPayload(encryptedPayload)) {
    throw new Error('Encrypted backup payload is invalid.');
  }

  const salt = encryptedPayload.salt
    ? Buffer.from(encryptedPayload.salt, 'base64')
    : Buffer.from(LEGACY_KEY_DERIVATION_SALT, 'utf8');
  const decipher = createDecipheriv(
    ENCRYPTION_ALGORITHM,
    deriveKey(secret, encryptedPayload.keyDerivation, salt),
    Buffer.from(encryptedPayload.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(encryptedPayload.authTag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPayload.ciphertext, 'base64')),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8'));
}

export function isEncryptedBackupPayload(value) {
  return Boolean(parseEncryptedBackupPayload(value));
}
