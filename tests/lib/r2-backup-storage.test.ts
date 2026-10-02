import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { EditorBackupPayload } from '@/lib/editor-data-backup';
import { createDefaultSiteSettings } from '@/lib/site-settings';
import {
  downloadLatestBackupPayloadFromR2,
  getEditableR2BackupSettings,
  getR2BackupConfig,
  getR2BackupStatus,
  R2BackupPayloadTooLargeError,
  R2BackupSettingsInvalidError,
  saveEditableR2BackupSettings,
} from '@/lib/r2-backup-storage';

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  R2_BACKUP_ENABLED: process.env.R2_BACKUP_ENABLED,
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
  R2_BUCKET: process.env.R2_BUCKET,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_PREFIX: process.env.R2_PREFIX,
  R2_ENDPOINT: process.env.R2_ENDPOINT,
  R2_SNAPSHOT_ON_WRITE: process.env.R2_SNAPSHOT_ON_WRITE,
};
const tempDirectories: string[] = [];
const sentCommands: Array<GetObjectCommand | PutObjectCommand> = [];
let latestUploadedBody = '';
let latestDownloadedBody: unknown = null;
let latestDownloadedContentLength: number | null = null;

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');

  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(function MockS3Client() {
      return {
      send: vi.fn(async (command: GetObjectCommand | PutObjectCommand) => {
        sentCommands.push(command);

        if (command instanceof actual.PutObjectCommand) {
          if (command.input.ContentType === 'application/json; charset=utf-8') {
            latestUploadedBody = String(command.input.Body);
          }
          return {};
        }

        if (command instanceof actual.GetObjectCommand) {
          const body = latestDownloadedBody ?? latestUploadedBody;
          const contentLength = latestDownloadedContentLength ?? (
            body instanceof Uint8Array
              ? body.byteLength
              : Buffer.byteLength(String(body), 'utf8')
          );

          return {
            Body: body,
            ContentLength: contentLength,
          };
        }

        return {};
      }),
      };
    }),
  };
});

function createTempDataRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-navigation-r2-settings-'));
  tempDirectories.push(directory);
  return directory;
}

function getSettingsFile(dataRoot: string): string {
  return path.join(dataRoot, 'settings', 'cloudflare-r2.json');
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, JSON.stringify(value, null, 2));
}

function resetR2Env(): void {
  for (const name of Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>) {
    const value = ORIGINAL_ENV[name];

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function clearR2Env(): void {
  process.env.BLOG_DATA_ROOT = createTempDataRoot();

  Object.keys(ORIGINAL_ENV).forEach((name) => {
    if (name === 'BLOG_DATA_ROOT') {
      return;
    }

    delete process.env[name];
  });
}

afterEach(() => {
  resetR2Env();

  while (tempDirectories.length > 0) {
    fs.rmSync(tempDirectories.pop() as string, { recursive: true, force: true });
  }
});

beforeEach(() => {
  sentCommands.length = 0;
  latestUploadedBody = '';
  latestDownloadedBody = null;
  latestDownloadedContentLength = null;
  vi.mocked(S3Client).mockClear();
});

describe('R2 backup configuration', () => {
  it('stays disabled unless explicitly enabled', () => {
    clearR2Env();

    expect(getR2BackupConfig()).toBeNull();
    expect(getR2BackupStatus()).toEqual(
      expect.objectContaining({
        enabled: false,
        configured: false,
      })
    );
  });

  it('reports missing variables when enabled without credentials', () => {
    clearR2Env();
    process.env.R2_BACKUP_ENABLED = 'true';

    expect(getR2BackupConfig()).toBeNull();
    expect(getR2BackupStatus()).toEqual(
      expect.objectContaining({
        enabled: true,
        configured: false,
        message: 'R2 backup is enabled but required variables are missing.',
      })
    );
  });

  it('builds a Cloudflare R2 S3-compatible endpoint', () => {
    clearR2Env();
    process.env.R2_BACKUP_ENABLED = 'true';
    process.env.R2_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.R2_BUCKET = 'blog-data';
    process.env.R2_ACCESS_KEY_ID = 'access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret-key';
    process.env.R2_PREFIX = '/custom-prefix/';
    process.env.R2_SNAPSHOT_ON_WRITE = 'true';

    expect(getR2BackupConfig()).toEqual({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'custom-prefix',
      snapshotOnWrite: true,
    });
  });

  it('rejects non-Cloudflare endpoints from environment configuration', () => {
    clearR2Env();
    process.env.R2_BACKUP_ENABLED = 'true';
    process.env.R2_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.R2_BUCKET = 'blog-data';
    process.env.R2_ACCESS_KEY_ID = 'access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret-key';
    process.env.R2_ENDPOINT = 'http://127.0.0.1:9000';

    expect(getR2BackupConfig()).toBeNull();
    expect(getR2BackupStatus()).toEqual(
      expect.objectContaining({
        enabled: true,
        configured: false,
      })
    );
  });

  it('rejects malformed Account IDs before creating an R2 endpoint', () => {
    clearR2Env();
    process.env.R2_BACKUP_ENABLED = 'true';
    process.env.R2_ACCOUNT_ID = '127.0.0.1:443#';
    process.env.R2_BUCKET = 'blog-data';
    process.env.R2_ACCESS_KEY_ID = 'access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret-key';

    expect(getR2BackupConfig()).toBeNull();
    expect(getR2BackupStatus()).toEqual(
      expect.objectContaining({
        enabled: true,
        configured: false,
      })
    );
  });

  it('persists editable R2 settings without exposing the secret in safe settings', () => {
    clearR2Env();
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    const safeSettings = saveEditableR2BackupSettings({
      enabled: true,
      accountId: ' 0123456789abcdef0123456789abcdef ',
      bucket: ' blog-data ',
      accessKeyId: ' access-key ',
      secretAccessKey: ' secret-key ',
      prefix: '/custom-prefix/',
      endpoint: '',
      snapshotOnWrite: true,
    });
    const settingsFile = path.join(process.env.BLOG_DATA_ROOT, 'settings', 'cloudflare-r2.json');

    expect(safeSettings).toEqual({
      enabled: true,
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'blog-data',
      hasAccessKeyId: true,
      hasSecretAccessKey: true,
      prefix: 'custom-prefix',
      endpoint: '',
      snapshotOnWrite: true,
    });
    expect(getEditableR2BackupSettings()).not.toHaveProperty('secretAccessKey');
    expect(getEditableR2BackupSettings()).not.toHaveProperty('accessKeyId');
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toEqual(
      expect.objectContaining({
        secretAccessKey: 'secret-key',
      })
    );
    if (process.platform !== 'win32') {
      expect(fs.statSync(settingsFile).mode & 0o777).toBe(0o600);
    }
    expect(getR2BackupConfig()).toEqual({
      bucket: 'blog-data',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'custom-prefix',
      snapshotOnWrite: true,
    });
    expect(getR2BackupStatus()).toEqual(
      expect.objectContaining({
        enabled: true,
        configured: true,
        source: 'file',
        hasSecretAccessKey: true,
      })
    );
  });

  it('rejects enabled stored settings with a non-Cloudflare endpoint', () => {
    clearR2Env();
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    expect(() => saveEditableR2BackupSettings({
      enabled: true,
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'blog-data',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      endpoint: 'https://example.com',
      snapshotOnWrite: false,
    })).toThrow('Cloudflare R2 Endpoint');
  });

  it('rejects enabled stored settings with a malformed Account ID', () => {
    clearR2Env();
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    expect(() => saveEditableR2BackupSettings({
      enabled: true,
      accountId: 'localhost:9000#',
      bucket: 'blog-data',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      prefix: 'blog-navigation',
      endpoint: '',
      snapshotOnWrite: false,
    })).toThrow('Cloudflare R2 Endpoint');
  });

  it('keeps an existing stored secret when the update omits it', () => {
    clearR2Env();
    process.env.BLOG_DATA_ROOT = createTempDataRoot();

    saveEditableR2BackupSettings({
      enabled: true,
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'blog-data',
      accessKeyId: 'access-key',
      secretAccessKey: 'original-secret',
      prefix: 'blog-navigation',
      endpoint: '',
      snapshotOnWrite: false,
    });
    saveEditableR2BackupSettings({
      enabled: true,
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'blog-data',
      accessKeyId: 'next-access-key',
      secretAccessKey: '',
      prefix: 'next-prefix',
      endpoint: '',
      snapshotOnWrite: false,
    });

    expect(getR2BackupConfig()).toEqual(
      expect.objectContaining({
        accessKeyId: 'next-access-key',
        secretAccessKey: 'original-secret',
        prefix: 'next-prefix',
      })
    );
  });

  it('does not copy the env secret into disabled file settings', () => {
    clearR2Env();
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    process.env.R2_ACCOUNT_ID = '33333333333333333333333333333333';
    process.env.R2_BUCKET = 'env-bucket';
    process.env.R2_ACCESS_KEY_ID = 'env-access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'env-secret-key';

    saveEditableR2BackupSettings({
      enabled: false,
      accountId: '',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      prefix: 'blog-navigation',
      endpoint: '',
      snapshotOnWrite: false,
    });

    const settingsFile = path.join(process.env.BLOG_DATA_ROOT, 'settings', 'cloudflare-r2.json');
    const storedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

    expect(storedSettings.secretAccessKey).toBe('');
    expect(getEditableR2BackupSettings()).toEqual(
      expect.objectContaining({
        enabled: false,
        accountId: '',
        bucket: '',
        hasAccessKeyId: false,
        hasSecretAccessKey: false,
      })
    );
    expect(getR2BackupStatus()).toEqual(
      expect.objectContaining({
        enabled: false,
        source: 'file',
        bucket: null,
        hasAccessKeyId: false,
        hasSecretAccessKey: false,
      })
    );
    expect(getR2BackupConfig()).toBeNull();
  });

  it('uses plaintext backups by default when R2 is fully configured', () => {
    clearR2Env();
    process.env.R2_BACKUP_ENABLED = 'true';
    process.env.R2_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.R2_BUCKET = 'blog-data';
    process.env.R2_ACCESS_KEY_ID = 'access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret-key';

    expect(getR2BackupConfig()).toEqual(
      expect.objectContaining({
        bucket: 'blog-data',
      })
    );
    expect(getR2BackupStatus()).toEqual(
      expect.objectContaining({
        configured: true,
        securityWarning: expect.stringContaining('plaintext JSON'),
      })
    );
  });

  it('downloads plaintext backup bodies and restores them without an encryption key', async () => {
    clearR2Env();
    process.env.R2_BACKUP_ENABLED = 'true';
    process.env.R2_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.R2_BUCKET = 'blog-data';
    process.env.R2_ACCESS_KEY_ID = 'access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret-key';
    const payload: EditorBackupPayload = {
      version: 1,
      exportedAt: '2026-05-26T00:00:00.000Z',
      source: 'local',
      persistent: true,
      dataRoot: '/var/lib/blog-navigation',
      data: {
        articles: [
          {
            id: 'secret-article',
            title: 'Sensitive Draft',
            date: '2026-05-26',
            description: 'Private body',
            tags: ['security'],
            content: '# Sensitive content',
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        navigation: [],
        settings: {
          ...createDefaultSiteSettings(),
          siteName: 'Private Site',
          siteDescription: 'Private settings',
          workspaceLabel: 'workspace / private',
          heroTitleLineOne: 'Private',
          heroTitleLineTwo: 'Backup',
          heroDescription: 'Private hero.',
        },
      },
      manifest: {
        version: 1,
        updatedAt: '2026-05-26T00:00:00.000Z',
        resources: {},
      },
    };
    latestDownloadedBody = JSON.stringify(payload);

    await expect(downloadLatestBackupPayloadFromR2()).resolves.toEqual(payload);
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toBeInstanceOf(GetObjectCommand);
    expect(latestDownloadedBody).toContain('Sensitive Draft');
    expect(latestDownloadedBody).toContain('Private settings');
    expect(latestDownloadedBody).not.toContain('ciphertext');
    expect(latestDownloadedBody).not.toContain('backupEncryption');
  });

  it('rejects downloaded backup bodies that exceed the download safety limit', async () => {
    clearR2Env();
    process.env.R2_BACKUP_ENABLED = 'true';
    process.env.R2_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.R2_BUCKET = 'blog-data';
    process.env.R2_ACCESS_KEY_ID = 'access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret-key';
    latestDownloadedBody = '{"version":1,"data":{"articles":[],"navigation":[]}}';
    latestDownloadedContentLength = 129 * 1024 * 1024;

    await expect(downloadLatestBackupPayloadFromR2()).rejects.toThrow(R2BackupPayloadTooLargeError);
  });

  it('configures bounded timeouts for the R2 client request handler', async () => {
    clearR2Env();
    process.env.R2_BACKUP_ENABLED = 'true';
    process.env.R2_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    process.env.R2_BUCKET = 'blog-data';
    process.env.R2_ACCESS_KEY_ID = 'timeout-check-access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'timeout-check-secret-key';
    latestDownloadedBody = '{"version":1}';

    await downloadLatestBackupPayloadFromR2();

    const firstCall = vi.mocked(S3Client).mock.calls[0]?.[0];

    expect(firstCall?.requestHandler).toBeInstanceOf(NodeHttpHandler);
  });

  it('rejects corrupt stored settings instead of falling back to env settings', () => {
    clearR2Env();
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;
    process.env.R2_BACKUP_ENABLED = 'true';
    process.env.R2_ACCOUNT_ID = '33333333333333333333333333333333';
    process.env.R2_BUCKET = 'env-bucket';
    process.env.R2_ACCESS_KEY_ID = 'env-access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'env-secret-key';
    writeText(getSettingsFile(dataRoot), '{');

    expect(() => getEditableR2BackupSettings()).toThrow(R2BackupSettingsInvalidError);
    expect(() => getR2BackupConfig()).toThrow(R2BackupSettingsInvalidError);
    expect(() => getR2BackupStatus()).toThrow(R2BackupSettingsInvalidError);
  });

  it('rejects incomplete stored settings instead of treating them as disabled settings', () => {
    clearR2Env();
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeJson(getSettingsFile(dataRoot), {
      enabled: false,
    });

    expect(() => getEditableR2BackupSettings()).toThrow(R2BackupSettingsInvalidError);
    expect(() => getR2BackupConfig()).toThrow(R2BackupSettingsInvalidError);
  });

  it('allows a complete save to replace corrupt stored settings', () => {
    clearR2Env();
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;
    writeText(getSettingsFile(dataRoot), '{');

    const safeSettings = saveEditableR2BackupSettings({
      enabled: true,
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'blog-data',
      accessKeyId: 'access-key',
      secretAccessKey: 'replacement-secret',
      prefix: 'blog-navigation',
      endpoint: '',
      snapshotOnWrite: true,
    });

    expect(safeSettings).toEqual(
      expect.objectContaining({
        enabled: true,
        hasSecretAccessKey: true,
      })
    );
    expect(getR2BackupConfig()).toEqual(
      expect.objectContaining({
        bucket: 'blog-data',
        secretAccessKey: 'replacement-secret',
      })
    );
  });

  it('allows a disabled save to replace corrupt stored settings without copying env secrets', () => {
    clearR2Env();
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;
    process.env.R2_SECRET_ACCESS_KEY = 'env-secret-key';
    writeText(getSettingsFile(dataRoot), '{');

    const safeSettings = saveEditableR2BackupSettings({
      enabled: false,
      accountId: '',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: '',
      prefix: 'blog-navigation',
      endpoint: '',
      snapshotOnWrite: false,
    });
    const storedSettings = JSON.parse(fs.readFileSync(getSettingsFile(dataRoot), 'utf8'));

    expect(safeSettings).toEqual(
      expect.objectContaining({
        enabled: false,
        hasSecretAccessKey: false,
      })
    );
    expect(storedSettings.secretAccessKey).toBe('');
    expect(getR2BackupConfig()).toBeNull();
  });
});
