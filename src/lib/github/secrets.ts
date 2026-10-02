import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  randomBytes,
} from 'node:crypto';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';

const SECRET_FILE_NAME = 'github-app-private-key.v1.json';
const SECRET_FORMAT_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const CONFIG_NOT_READY = 'GitHub 配置未就绪：请配置 BLOG_SECRET_KEY。';

interface EncryptedPrivateKey {
  version: typeof SECRET_FORMAT_VERSION;
  algorithm: typeof ALGORITHM;
  iv: string;
  authTag: string;
  ciphertext: string;
}

function getMasterKey(): Buffer {
  const configured = process.env.BLOG_SECRET_KEY?.trim();
  if (!configured) throw new Error(CONFIG_NOT_READY);

  let key: Buffer;
  if (/^[a-f\d]{64}$/i.test(configured)) {
    key = Buffer.from(configured, 'hex');
  } else {
    key = Buffer.from(configured, 'base64');
    if (key.toString('base64').replace(/=+$/, '') !== configured.replace(/=+$/, '')) {
      throw new Error('BLOG_SECRET_KEY 格式无效。');
    }
  }
  if (key.length !== KEY_LENGTH) throw new Error('BLOG_SECRET_KEY 必须解码为 32 字节。');
  return key;
}

function getSecretFilePath(): string {
  const configuredRoot = process.env.BLOG_SECRET_ROOT?.trim();
  if (!configuredRoot) throw new Error('GitHub 配置未就绪：请配置 BLOG_SECRET_ROOT。');
  return path.join(path.resolve(configuredRoot), SECRET_FILE_NAME);
}

function isEncryptedPrivateKey(value: unknown): value is EncryptedPrivateKey {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === SECRET_FORMAT_VERSION && record.algorithm === ALGORITHM &&
    typeof record.iv === 'string' && typeof record.authTag === 'string' && typeof record.ciphertext === 'string';
}

function validateRsaPrivateKey(value: string): string {
  try {
    const key = createPrivateKey(value);
    if (key.asymmetricKeyType !== 'rsa' && key.asymmetricKeyType !== 'rsa-pss') {
      throw new Error('Unsupported asymmetric key.');
    }
    return key.export({ type: 'pkcs8', format: 'pem' }).toString();
  } catch {
    throw new Error('GitHub App 私钥 PEM/RSA 格式无效。');
  }
}

export async function hasGitHubPrivateKey(): Promise<boolean> {
  try {
    const filePath = getSecretFilePath();
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('GitHub 私钥状态不可读取。');
  }
}

export async function saveGitHubPrivateKey(privateKeyPem: string): Promise<void> {
  const key = getMasterKey();
  const normalizedPem = validateRsaPrivateKey(privateKeyPem);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(normalizedPem, 'utf8'),
    cipher.final(),
  ]);
  const record: EncryptedPrivateKey = {
    version: SECRET_FORMAT_VERSION,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  const filePath = getSecretFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeJsonAtomically(filePath, record, { mode: 0o600 });
  await fs.chmod(path.dirname(filePath), 0o700);
}

export async function loadGitHubPrivateKey(): Promise<string> {
  const key = getMasterKey();
  const filePath = getSecretFilePath();
  let record: EncryptedPrivateKey;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (!isEncryptedPrivateKey(parsed)) throw new Error('invalid encrypted key record');
    record = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('GitHub 配置未就绪：App 私钥尚未配置。');
    }
    throw new Error('GitHub App 私钥密文格式无效。');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(record.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return validateRsaPrivateKey(plaintext);
  } catch {
    throw new Error('GitHub App 私钥无法解密或格式无效。');
  }
}
