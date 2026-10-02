import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDITOR_BACKUP_VERSION,
  createEditorBackupPayload,
  createCurrentEditorRemoteBackupPackage,
  parseEditorBackupData,
  parseEditorBackupDataOrThrow,
  restoreEditorBackupPayload,
} from '@/lib/editor-data-backup';
import { createArticleSlug } from '@/lib/article-data';
import { readEditorMediaManifest, storeEditorMediaFile } from '@/lib/editor-media-storage';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';

const ORIGINAL_BLOG_DATA_ROOT = process.env.BLOG_DATA_ROOT;
const tempDirectories: string[] = [];

const article = {
  id: 'article-1',
  title: 'Runtime Article',
  date: '2026-05-22',
  description: 'Portable backup article',
  tags: ['backup'],
  content: '# Runtime Article',
  createdAt: 1,
  updatedAt: 2,
};

const navigation = [
  {
    name: '开发文档',
    icon: 'blog',
    slug: 'developer-docs',
    tools: [
      {
        icon: 'blog',
        title: 'MDN Web Docs',
        description: 'Web 平台权威文档，覆盖 HTML、CSS、JavaScript 和浏览器 API',
        url: 'https://developer.mozilla.org',
        tags: ['文档', 'Web'],
      },
    ],
  },
];

const settings = {
  ...DEFAULT_SITE_SETTINGS,
  siteName: 'Runtime Site',
};
const normalizedArticle = {
  ...article,
  slug: createArticleSlug(article),
  kind: 'essay',
  status: 'published',
  featured: false,
  sourceLinks: [],
  revisionNotes: [],
};
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PNG_BYTES_ALT = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

function createInlineMediaData(bytes: Uint8Array, updatedAt = '2026-06-19T00:00:00.000Z') {
  const hash = createHash('sha256')
    .update(bytes)
    .digest('hex');
  const mediaPath = `files/2026/06/${hash}.png`;
  const asset = {
    id: hash,
    path: mediaPath,
    publicPath: `/media/${mediaPath}`,
    mimeType: 'image/png' as const,
    size: bytes.byteLength,
    hash,
    createdAt: updatedAt,
    updatedAt,
  };

  return {
    asset,
    manifest: {
      version: 1 as const,
      updatedAt,
      assets: [asset],
    },
    files: [
      {
        path: mediaPath,
        bytes,
      },
    ],
  };
}

function createTempDataRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-navigation-backup-'));
  tempDirectories.push(root);
  return root;
}

function createBlockedDataRoot(): string {
  const root = createTempDataRoot();
  const blockingFile = path.join(root, 'blocked.txt');

  fs.writeFileSync(blockingFile, 'blocked', 'utf8');
  return path.join(blockingFile, 'runtime-data');
}

afterEach(() => {
  vi.restoreAllMocks();

  if (ORIGINAL_BLOG_DATA_ROOT === undefined) {
    delete process.env.BLOG_DATA_ROOT;
  } else {
    process.env.BLOG_DATA_ROOT = ORIGINAL_BLOG_DATA_ROOT;
  }

  while (tempDirectories.length > 0) {
    fs.rmSync(tempDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe('editor backup payload', () => {
  it('creates a versioned envelope for portable backups', () => {
    const payload = createEditorBackupPayload({
      articles: [article],
      navigation,
      settings,
    });

    expect(payload).toEqual(
      expect.objectContaining({
        version: EDITOR_BACKUP_VERSION,
        source: 'local',
        data: {
          articles: [article],
          navigation,
          settings,
        },
      })
    );
    expect(Date.parse(payload.exportedAt)).not.toBeNaN();
  });

  it('marks backup payloads non-persistent when the runtime data root cannot be created', () => {
    process.env.BLOG_DATA_ROOT = createBlockedDataRoot();

    const payload = createEditorBackupPayload({
      articles: [article],
      navigation,
      settings,
    });

    expect(payload.persistent).toBe(false);
    expect(payload.dataRoot).toBe(path.resolve(process.env.BLOG_DATA_ROOT));
  });

  it('parses both envelope and legacy flat backup payloads', () => {
    const envelope = createEditorBackupPayload({
      articles: [article],
      navigation,
      settings,
    });

    expect(parseEditorBackupData(envelope)).toEqual({
      articles: [normalizedArticle],
      navigation,
      settings,
    });

    expect(
      parseEditorBackupData({
        version: 1,
        articles: [article],
        navigation,
      })
    ).toEqual({
      articles: [normalizedArticle],
      navigation,
      settings: DEFAULT_SITE_SETTINGS,
    });
  });

  it('serializes and parses inline media files in portable backups', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const storedMedia = await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-19T00:00:00.000Z'),
    });
    const manifest = readEditorMediaManifest();
    const payload = createEditorBackupPayload({
      articles: [article],
      navigation,
      settings,
      media: {
        manifest,
        files: [
          {
            path: storedMedia.asset.path,
            bytes: PNG_BYTES,
          },
        ],
      },
    });

    expect(payload.data.media).toEqual({
      manifest,
      files: [
        {
          path: storedMedia.asset.path,
          data: Buffer.from(PNG_BYTES).toString('base64'),
        },
      ],
    });
    expect(parseEditorBackupData(payload)).toEqual({
      articles: [normalizedArticle],
      navigation,
      settings,
      media: {
        manifest,
        files: [
          {
            path: storedMedia.asset.path,
            bytes: PNG_BYTES,
          },
        ],
      },
    });
  });

  it('creates remote backup packages with manifest-only payload data and R2 source', async () => {
    process.env.BLOG_DATA_ROOT = createTempDataRoot();
    const storedMedia = await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-19T00:00:00.000Z'),
    });
    const manifest = readEditorMediaManifest();

    const backupPackage = await createCurrentEditorRemoteBackupPackage();

    expect(backupPackage.payload.source).toBe('r2');
    expect(backupPackage.payload.data.media).toEqual(manifest);
    expect(backupPackage.mediaAssets).toHaveLength(1);
    expect(backupPackage.mediaAssets[0]?.asset).toEqual(storedMedia.asset);
    expect(new Uint8Array(backupPackage.mediaAssets[0]?.bytes ?? [])).toEqual(PNG_BYTES);
  });

  it('parses legacy envelope backup payloads without settings', () => {
    expect(
      parseEditorBackupData({
        version: 1,
        data: {
          articles: [article],
          navigation,
        },
      })
    ).toEqual({
      articles: [normalizedArticle],
      navigation,
      settings: DEFAULT_SITE_SETTINGS,
    });
  });

  it('rejects backup payloads with invalid settings', () => {
    expect(
      parseEditorBackupData({
        version: 1,
        data: {
          articles: [article],
          navigation,
          settings: {
            ...settings,
            siteName: '',
          },
        },
      })
    ).toBeNull();
  });

  it('throws a clear error when backup articles contain duplicate slugs', () => {
    expect(() => parseEditorBackupDataOrThrow({
      version: 1,
      data: {
        articles: [
          { ...article, id: 'article-1', slug: 'same' },
          { ...article, id: 'article-2', slug: 'same' },
        ],
        navigation,
        settings,
      },
    })).toThrow('文章 slug 重复：same');
  });

  it('throws a clear error when backup navigation contains an unsafe URL', () => {
    expect(() => parseEditorBackupDataOrThrow({
      version: 1,
      data: {
        articles: [article],
        navigation: [
          {
            ...navigation[0],
            tools: [
              {
                ...navigation[0].tools[0],
                url: 'http://developer.mozilla.org',
              },
            ],
          },
        ],
        settings,
      },
    })).toThrow('导航工具必须包含 icon、title、description 和 HTTPS URL。');
  });

  it('throws a clear error when backup settings contain an invalid boolean field', () => {
    expect(() => parseEditorBackupDataOrThrow({
      version: 1,
      data: {
        articles: [article],
        navigation,
        settings: {
          ...settings,
          showIntroCard: 'false',
        },
      },
    })).toThrow('站点设置 showIntroCard 存在时必须是布尔值。');
  });

  it('throws a clear error when the backup schemaVersion is newer than supported', async () => {
    const payload = {
      version: 1,
      schemaVersion: 999,
      data: {
        articles: [article],
        navigation,
        settings,
      },
    };

    expect(() => parseEditorBackupData(payload)).toThrow(
      '备份 schemaVersion 999 高于当前支持的 1，请先升级服务后再恢复。'
    );
    await expect(restoreEditorBackupPayload(payload)).rejects.toThrow(
      '备份 schemaVersion 999 高于当前支持的 1，请先升级服务后再恢复。'
    );
  });

  it('throws a clear error when the backup version is newer than supported', async () => {
    const payload = {
      version: 999,
      data: {
        articles: [article],
        navigation,
        settings,
      },
    };

    expect(() => parseEditorBackupData(payload)).toThrow(
      '备份 version 999 高于当前支持的 1，请先升级服务后再恢复。'
    );
    await expect(restoreEditorBackupPayload(payload)).rejects.toThrow(
      '备份 version 999 高于当前支持的 1，请先升级服务后再恢复。'
    );
  });

  it('rejects encrypted backup payloads in the editor restore parser', async () => {
    const payload = {
      magic: 'blog-navigation-encrypted-backup',
      version: 1,
      algorithm: 'aes-256-gcm',
      keyDerivation: 'scrypt',
      encryptedAt: '2026-06-19T00:00:00.000Z',
      salt: 'aaaaaaaaaaaaaaaa',
      iv: 'bbbbbbbbbbbbbbbb',
      authTag: 'cccccccccccccccc',
      ciphertext: 'dddddddddddddddd',
    };

    expect(parseEditorBackupData(payload)).toBeNull();
    await expect(restoreEditorBackupPayload(payload)).rejects.toThrow(
      '检测到加密备份文件，当前恢复入口不支持，请先使用解密导入工具。'
    );
  });

  it('restores valid backup payloads into BLOG_DATA_ROOT', async () => {
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;

    const result = await restoreEditorBackupPayload(
      createEditorBackupPayload({
        articles: [article],
        navigation,
        settings,
      })
    );

    expect(result).toEqual({
      articles: 1,
      categories: 1,
      settings: true,
      media: 0,
    });
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8'))).toEqual([normalizedArticle]);
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'navigation', 'tools.json'), 'utf8'))).toEqual(navigation);
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'settings', 'site.json'), 'utf8'))).toEqual(settings);
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'manifest.json'), 'utf8'))).toEqual(
      expect.objectContaining({
        version: 1,
        resources: expect.objectContaining({
          articles: expect.objectContaining({
            hash: expect.any(String),
            revision: expect.any(String),
          }),
          navigation: expect.objectContaining({
            hash: expect.any(String),
            revision: expect.any(String),
          }),
          settings: expect.objectContaining({
            hash: expect.any(String),
            revision: expect.any(String),
          }),
        }),
      })
    );
    expect(fs.readdirSync(dataRoot).some((entry) => entry.startsWith('.restore-'))).toBe(false);
  });

  it('restores inline media files when the backup requires them locally', async () => {
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;
    const storedMedia = await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-19T00:00:00.000Z'),
    });
    const manifest = readEditorMediaManifest();
    const payload = createEditorBackupPayload({
      articles: [article],
      navigation,
      settings,
      media: {
        manifest,
        files: [
          {
            path: storedMedia.asset.path,
            bytes: PNG_BYTES,
          },
        ],
      },
    });

    fs.rmSync(path.join(dataRoot, 'media'), { recursive: true, force: true });

    await expect(restoreEditorBackupPayload(payload, { requireInlineMediaFiles: true })).resolves.toEqual({
      articles: 1,
      categories: 1,
      settings: true,
      media: 1,
    });
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'media', 'manifest.json'), 'utf8'))).toEqual(
      expect.objectContaining({
        version: manifest.version,
        assets: manifest.assets,
        updatedAt: expect.any(String),
      })
    );
    expect(fs.readFileSync(path.join(dataRoot, 'media', storedMedia.asset.path))).toEqual(Buffer.from(PNG_BYTES));
  });

  it('replaces existing media files with the restored inline snapshot', async () => {
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;
    const existingMedia = await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-19T00:00:00.000Z'),
    });
    const replacementMedia = createInlineMediaData(PNG_BYTES_ALT, '2026-06-20T00:00:00.000Z');

    await expect(
      restoreEditorBackupPayload(
        createEditorBackupPayload({
          articles: [article],
          navigation,
          settings,
          media: replacementMedia,
        }),
        { requireInlineMediaFiles: true }
      )
    ).resolves.toEqual({
      articles: 1,
      categories: 1,
      settings: true,
      media: 1,
    });

    expect(fs.existsSync(path.join(dataRoot, 'media', existingMedia.asset.path))).toBe(false);
    expect(fs.readFileSync(path.join(dataRoot, 'media', replacementMedia.asset.path))).toEqual(Buffer.from(PNG_BYTES_ALT));
    expect(JSON.parse(fs.readFileSync(path.join(dataRoot, 'media', 'manifest.json'), 'utf8'))).toEqual(
      expect.objectContaining({
        assets: [replacementMedia.asset],
      })
    );
  });

  it('rejects local restore payloads when media manifest is present without inline files', async () => {
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;
    await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-19T00:00:00.000Z'),
    });
    const manifest = readEditorMediaManifest();

    await expect(
      restoreEditorBackupPayload(
        createEditorBackupPayload({
          articles: [article],
          navigation,
          settings,
          media: {
            manifest,
          },
        }),
        { requireInlineMediaFiles: true }
      )
    ).rejects.toThrow('备份媒体文件缺失或不完整。');
  });

  it('rolls back restored media when media directory replacement fails', async () => {
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;
    const existingMedia = await storeEditorMediaFile({
      bytes: PNG_BYTES,
      now: new Date('2026-06-19T00:00:00.000Z'),
    });
    const existingPayload = createEditorBackupPayload({
      articles: [article],
      navigation,
      settings,
      media: {
        manifest: readEditorMediaManifest(),
        files: [
          {
            path: existingMedia.asset.path,
            bytes: PNG_BYTES,
          },
        ],
      },
    });

    await expect(restoreEditorBackupPayload(existingPayload, { requireInlineMediaFiles: true })).resolves.toEqual({
      articles: 1,
      categories: 1,
      settings: true,
      media: 1,
    });

    const existingArticles = fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8');
    const existingNavigation = fs.readFileSync(path.join(dataRoot, 'navigation', 'tools.json'), 'utf8');
    const existingSettings = fs.readFileSync(path.join(dataRoot, 'settings', 'site.json'), 'utf8');
    const existingManifest = fs.readFileSync(path.join(dataRoot, 'manifest.json'), 'utf8');
    const existingMediaManifest = fs.readFileSync(path.join(dataRoot, 'media', 'manifest.json'), 'utf8');
    const existingMediaBytes = fs.readFileSync(path.join(dataRoot, 'media', existingMedia.asset.path));
    const replacementArticle = {
      ...article,
      id: 'replacement-media-rollback-article',
      title: 'Replacement Media Rollback Article',
    };
    const replacementMedia = createInlineMediaData(PNG_BYTES_ALT, '2026-06-20T00:00:00.000Z');
    const renameSync = fs.renameSync;

    vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
      const oldPathText = String(oldPath);

      if (oldPathText.includes('.restore-staging') && oldPathText.endsWith(`${path.sep}media`)) {
        throw new Error('Simulated media replacement failure.');
      }

      return renameSync(oldPath, newPath);
    });

    await expect(
      restoreEditorBackupPayload(
        createEditorBackupPayload({
          articles: [replacementArticle],
          navigation: [],
          settings: {
            ...settings,
            siteName: 'Replacement Media Rollback Site',
          },
          media: replacementMedia,
        }),
        { requireInlineMediaFiles: true }
      )
    ).rejects.toThrow('Simulated media replacement failure.');

    expect(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8')).toBe(existingArticles);
    expect(fs.readFileSync(path.join(dataRoot, 'navigation', 'tools.json'), 'utf8')).toBe(existingNavigation);
    expect(fs.readFileSync(path.join(dataRoot, 'settings', 'site.json'), 'utf8')).toBe(existingSettings);
    expect(fs.readFileSync(path.join(dataRoot, 'manifest.json'), 'utf8')).toBe(existingManifest);
    expect(fs.readFileSync(path.join(dataRoot, 'media', 'manifest.json'), 'utf8')).toBe(existingMediaManifest);
    expect(fs.readFileSync(path.join(dataRoot, 'media', existingMedia.asset.path))).toEqual(existingMediaBytes);
    expect(fs.existsSync(path.join(dataRoot, 'media', replacementMedia.asset.path))).toBe(false);
    expect(fs.readdirSync(dataRoot).some((entry) => entry.startsWith('.restore-'))).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, '.restore-state.json'))).toBe(false);
  });

  it('rolls back existing files when restore replacement fails midway', async () => {
    const dataRoot = createTempDataRoot();
    process.env.BLOG_DATA_ROOT = dataRoot;
    const existingPayload = createEditorBackupPayload({
      articles: [article],
      navigation,
      settings,
    });

    await expect(restoreEditorBackupPayload(existingPayload)).resolves.toEqual({
      articles: 1,
      categories: 1,
      settings: true,
      media: 0,
    });

    const existingArticles = fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8');
    const existingNavigation = fs.readFileSync(path.join(dataRoot, 'navigation', 'tools.json'), 'utf8');
    const existingSettings = fs.readFileSync(path.join(dataRoot, 'settings', 'site.json'), 'utf8');
    const existingManifest = fs.readFileSync(path.join(dataRoot, 'manifest.json'), 'utf8');
    const replacementArticle = {
      ...article,
      id: 'replacement-article-1',
      title: 'Replacement Article',
    };
    let stagedReplaceCount = 0;
    const renameSync = fs.renameSync;

    vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
      const oldPathText = String(oldPath);

      if (oldPathText.includes('.restore-staging') && !oldPathText.endsWith('.tmp')) {
        stagedReplaceCount += 1;
      }

      if (stagedReplaceCount === 2) {
        throw new Error('Simulated replacement failure.');
      }

      return renameSync(oldPath, newPath);
    });

    await expect(
      restoreEditorBackupPayload(
        createEditorBackupPayload({
          articles: [replacementArticle],
          navigation: [],
          settings: {
            ...settings,
            siteName: 'Replacement Site',
          },
        })
      )
    ).rejects.toThrow('Simulated replacement failure.');

    expect(fs.readFileSync(path.join(dataRoot, 'articles', 'articles.json'), 'utf8')).toBe(existingArticles);
    expect(fs.readFileSync(path.join(dataRoot, 'navigation', 'tools.json'), 'utf8')).toBe(existingNavigation);
    expect(fs.readFileSync(path.join(dataRoot, 'settings', 'site.json'), 'utf8')).toBe(existingSettings);
    expect(fs.readFileSync(path.join(dataRoot, 'manifest.json'), 'utf8')).toBe(existingManifest);
    expect(fs.readdirSync(dataRoot).some((entry) => entry.startsWith('.restore-'))).toBe(false);
  });
});
