// IMPORTANT: This module provides AES-256-GCM encryption for the GitHub
// encrypted-backup toolchain ONLY (scripts/data/encrypted-backup.mjs and
// restore-encrypted-backup.mjs). It MUST NOT be used by the R2 automatic
// backup pipeline. Per AGENTS.md, R2 backups must remain plaintext JSON so
// they can be JSON.parse'd directly for inspection, migration, and restore.
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
    scryptSync,
} from 'node:crypto';

const ENCRYPTED_BACKUP_MAGIC = 'blog-navigation-encrypted-backup';
const ENCRYPTED_BACKUP_VERSION = 1;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const CURRENT_KEY_DERIVATION = 'scrypt';
const LEGACY_SCRYPT_SALT = 'blog-navigation-backup-v1';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

type SupportedKeyDerivation = 'sha256' | 'scrypt';

export interface EncryptedBackupPayload {
    magic: typeof ENCRYPTED_BACKUP_MAGIC;
    version: typeof ENCRYPTED_BACKUP_VERSION;
    algorithm: typeof ENCRYPTION_ALGORITHM;
    keyDerivation: SupportedKeyDerivation;
    encryptedAt: string;
    salt: string;
    iv: string;
    authTag: string;
    ciphertext: string;
}

interface LegacyEncryptedBackupPayload {
    version: typeof ENCRYPTED_BACKUP_VERSION;
    algorithm: typeof ENCRYPTION_ALGORITHM;
    keyDerivation: SupportedKeyDerivation;
    iv: string;
    authTag: string;
    ciphertext: string;
    salt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deriveKey(passphrase: string, method: SupportedKeyDerivation, salt: Buffer): Buffer {
    if (method === 'scrypt') {
        return scryptSync(passphrase, salt, KEY_LENGTH);
    }

    return createHash('sha256').update(passphrase, 'utf8').digest();
}

function parseSupportedKeyDerivation(value: unknown): SupportedKeyDerivation | null {
    return value === 'scrypt' || value === 'sha256' ? value : null;
}

function parseEncryptedBackupPayload(value: unknown): LegacyEncryptedBackupPayload | null {
    if (!isRecord(value)) {
        return null;
    }

    const keyDerivation = parseSupportedKeyDerivation(value.keyDerivation);

    if (
        value.version !== ENCRYPTED_BACKUP_VERSION ||
        value.algorithm !== ENCRYPTION_ALGORITHM ||
        !keyDerivation ||
        typeof value.iv !== 'string' ||
        typeof value.authTag !== 'string' ||
        typeof value.ciphertext !== 'string' ||
        (value.salt !== undefined && typeof value.salt !== 'string')
    ) {
        return null;
    }

    if (value.magic !== undefined && value.magic !== ENCRYPTED_BACKUP_MAGIC) {
        return null;
    }

    return {
        version: ENCRYPTED_BACKUP_VERSION,
        algorithm: ENCRYPTION_ALGORITHM,
        keyDerivation,
        iv: value.iv,
        authTag: value.authTag,
        ciphertext: value.ciphertext,
        salt: value.salt,
    };
}

export function isEncryptedBackupPayload(value: unknown): value is EncryptedBackupPayload {
    return Boolean(parseEncryptedBackupPayload(value));
}

export function encryptBackupPayload(payload: unknown, passphrase: string): EncryptedBackupPayload {
    const trimmedPassphrase = passphrase.trim();

    if (!trimmedPassphrase) {
        throw new Error('Encrypted backup passphrase is required.');
    }

    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(
        ENCRYPTION_ALGORITHM,
        deriveKey(trimmedPassphrase, CURRENT_KEY_DERIVATION, salt),
        iv
    );
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
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

export function decryptBackupPayload(value: unknown, passphrase: string): unknown {
    const trimmedPassphrase = passphrase.trim();

    if (!trimmedPassphrase) {
        throw new Error('Encrypted backup passphrase is required.');
    }

    const encrypted = parseEncryptedBackupPayload(value);

    if (!encrypted) {
        throw new Error('Encrypted backup payload is invalid.');
    }

    const salt = encrypted.salt
        ? Buffer.from(encrypted.salt, 'base64')
        : Buffer.from(LEGACY_SCRYPT_SALT, 'utf8');
    const decipher = createDecipheriv(
        ENCRYPTION_ALGORITHM,
        deriveKey(trimmedPassphrase, encrypted.keyDerivation, salt),
        Buffer.from(encrypted.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
        decipher.final(),
    ]);

    return JSON.parse(decrypted.toString('utf8')) as unknown;
}
