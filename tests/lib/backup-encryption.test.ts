import { describe, expect, it } from 'vitest';
import {
  decryptBackupPayload,
  encryptBackupPayload,
  isEncryptedBackupPayload,
} from '@/lib/backup-encryption';

describe('backup encryption', () => {
  it('encrypts and decrypts a backup payload', () => {
    const payload = {
      version: 1,
      data: {
        articles: [{ title: 'Sensitive Draft' }],
      },
    };
    const encrypted = encryptBackupPayload(payload, 'strong-backup-passphrase');

    expect(encrypted).toEqual(
      expect.objectContaining({
        magic: 'blog-navigation-encrypted-backup',
        version: 1,
        algorithm: 'aes-256-gcm',
        keyDerivation: 'scrypt',
        salt: expect.any(String),
        iv: expect.any(String),
        authTag: expect.any(String),
        ciphertext: expect.any(String),
      })
    );
    expect(JSON.stringify(encrypted)).not.toContain('Sensitive Draft');
    expect(decryptBackupPayload(encrypted, 'strong-backup-passphrase')).toEqual(payload);
  });

  it('uses fresh salt and ciphertext for each encryption', () => {
    const payload = { version: 1, value: 'same payload' };
    const first = encryptBackupPayload(payload, 'strong-backup-passphrase');
    const second = encryptBackupPayload(payload, 'strong-backup-passphrase');

    expect(first.salt).not.toBe(second.salt);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('rejects the wrong passphrase', () => {
    const encrypted = encryptBackupPayload({ value: 'secret' }, 'correct-passphrase');

    expect(() => decryptBackupPayload(encrypted, 'wrong-passphrase')).toThrow();
  });

  it('does not classify ordinary backup JSON as encrypted', () => {
    expect(isEncryptedBackupPayload({
      version: 1,
      data: {
        articles: [],
        navigation: [],
      },
    })).toBe(false);
  });

  it('decrypts legacy scrypt payloads without a stored salt', () => {
    const legacyPayload = {
      version: 1,
      algorithm: 'aes-256-gcm',
      keyDerivation: 'scrypt',
      iv: 'AQEBAQEBAQEBAQEB',
      authTag: '8MCapSwWxHVX2q00S5waTw==',
      ciphertext: 'ss1pPMHdKW/8RM31dRLb/AjXR3WSGSAfyw==',
    };

    expect(decryptBackupPayload(legacyPayload, 'legacy-passphrase')).toEqual({ value: 'legacy secret' });
  });
});
