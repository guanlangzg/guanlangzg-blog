#!/usr/bin/env node
// Generates a self-contained, repeatable first-release fixture under .tmp/.
// It never touches a real data root, .env, credentials, or the source project,
// and it only replaces its own marker-tagged directory.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { validatePublicSiteSnapshot } from '../../src/lib/public-build/runner.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(projectRoot, '.tmp', 'first-release-fixture');
const markerPath = path.join(fixtureRoot, '.fixture-marker.json');
const MARKER = 'guanlangzg-first-release-fixture-v1';

export const DRAFT_SECRET_MARKER = 'DRAFT_ONLY_SECRET_9f3c1a';

// The share-image step decodes the cover with sharp, so the fixture must ship a
// real PNG rather than a hand-written byte string.
async function createManagedPng() {
  return sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 184, g: 92, b: 56 } },
  }).png().toBuffer();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildCandidateSnapshot() {
  return {
    releaseId: 'first-release-candidate',
    site: { title: '观澜志', description: '首期验收冻结候选' },
    posts: [
      {
        slug: '已上线文章',
        title: '已上线文章 B',
        description: '此前已经上线的公开文章。',
        date: '2026-09-01',
        tags: ['已上线'],
        content: '# 已上线文章 B\n\n这篇是 live B 的正文，包含中文检索词：静态构建。',
        managedImage: { source: 'media/article.png', alt: '已上线文章配图' },
      },
      {
        slug: '本次新增文章',
        title: '本次新增文章 C',
        description: '本次发布首次上线的文章。',
        date: '2026-09-30',
        tags: ['新增'],
        content: '# 本次新增文章 C\n\n候选 C 的正文，用于验证搜索与订阅包含新文章。',
      },
      {
        slug: '中文单段文章',
        title: '中文单段文章',
        description: '验证中文单段 slug 原样保留。',
        date: '2026-09-30',
        tags: ['中文'],
        content: '# 中文单段文章\n\n中文单段 slug 必须原样导出。',
      },
    ],
    navigation: [
      {
        name: '开发工具',
        items: [
          { title: '示例入口', description: '用于验证导航搜索字段。', url: 'https://example.com/tools', tags: ['示例'] },
        ],
      },
    ],
    redirects: [{ from: '/posts/旧文章/', to: '/posts/中文单段文章/' }],
    removedPaths: ['/blog/legacy-post/'],
  };
}

async function assertMarkerOwnership() {
  const existing = await fs.lstat(fixtureRoot).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!existing) return;
  if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Fixture root must be a real directory');
  const marker = await fs.readFile(markerPath, 'utf8').catch(() => null);
  if (!marker || JSON.parse(marker).marker !== MARKER) {
    throw new Error('Refusing to replace a directory without this fixture marker');
  }
}

export async function createReleaseFixture() {
  const relativeToTmp = path.relative(path.join(projectRoot, '.tmp'), fixtureRoot);
  if (relativeToTmp.startsWith('..') || path.isAbsolute(relativeToTmp) || relativeToTmp === '') {
    throw new Error('Fixture root must stay under .tmp/');
  }

  await assertMarkerOwnership();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(fixtureRoot, 'media'), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, 'rejects'), { recursive: true });

  // Managed media: one referenced by the candidate, one intentionally unreferenced.
  const managedPng = await createManagedPng();
  await fs.writeFile(path.join(fixtureRoot, 'media', 'article.png'), managedPng);
  await fs.writeFile(path.join(fixtureRoot, 'media', 'unreferenced.png'), managedPng);

  const candidate = buildCandidateSnapshot();
  await fs.writeFile(path.join(fixtureRoot, 'candidate.json'), `${JSON.stringify(candidate, null, 2)}\n`);

  // Draft A lives in its own file: the frozen snapshot schema has no draft field,
  // so A can only leak if something wrongly reads local drafts during a build.
  await fs.writeFile(path.join(fixtureRoot, 'draft-a.json'), `${JSON.stringify({
    note: 'Draft-only article that must never reach the public artifacts.',
    secretMarker: DRAFT_SECRET_MARKER,
    article: {
      slug: '私密草稿',
      title: '私密草稿 A',
      description: '未发布草稿。',
      date: '2026-09-30',
      tags: ['草稿'],
      content: `# 私密草稿 A\n\n这段包含秘密标记：${DRAFT_SECRET_MARKER}`,
    },
  }, null, 2)}\n`);

  // Rejection fixtures: each must be refused by the real validator.
  const rejected = [
    ['illegal-slug.json', { ...candidate, posts: [{ ...candidate.posts[0], slug: 'nested/post' }] }],
    ['unknown-field.json', { ...candidate, draft: DRAFT_SECRET_MARKER }],
    ['future-schema.json', { ...candidate, schemaVersion: 99 }],
  ];

  const failures = [];
  for (const [fileName, value] of rejected) {
    await fs.writeFile(path.join(fixtureRoot, 'rejects', fileName), `${JSON.stringify(value, null, 2)}\n`);
    try {
      validatePublicSiteSnapshot(value);
      failures.push(fileName);
    } catch {
      // Expected: the validator rejected it.
    }
  }

  // The valid candidate must be accepted, otherwise the fixture itself is broken.
  validatePublicSiteSnapshot(candidate);

  if (failures.length > 0) {
    throw new Error(`Fixture rejection cases were wrongly accepted: ${failures.join(', ')}`);
  }

  await fs.writeFile(markerPath, `${JSON.stringify({
    marker: MARKER,
    createdAt: '2026-09-30',
    candidateDigest: sha256(await fs.readFile(path.join(fixtureRoot, 'candidate.json'))),
  }, null, 2)}\n`);

  return { fixtureRoot };
}

async function main() {
  const { fixtureRoot: root } = await createReleaseFixture();
  process.stdout.write(`First-release fixture written to ${root}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
