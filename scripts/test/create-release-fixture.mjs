#!/usr/bin/env node
// Generates a self-contained, repeatable first-release fixture: the frozen private candidate,
// the public projection the isolated build consumes, and the identity document that binds both
// digests to those exact bytes.
//
// Two entry points exist:
//   - createReleaseFixture({ root }) writes into a caller-owned disposable directory. test:release
//     creates that directory with os.tmpdir()+mkdtemp and removes only the directory it created.
//   - the standalone CLI (npm run test:release:fixture) keeps the legacy .tmp/ location and only
//     ever replaces its own marker-tagged directory there.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { fromReleaseSnapshot } from '../../src/lib/public-build/from-release.ts';
import { validatePublicSiteSnapshot } from '../../src/lib/public-build/runner.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const legacyFixtureRoot = path.join(projectRoot, '.tmp', 'first-release-fixture');
const legacyMarkerPath = path.join(legacyFixtureRoot, '.fixture-marker.json');
const MARKER = 'guanlangzg-first-release-fixture-v1';

export const RELEASE_ID = 'first-release-candidate';
export const DRAFT_SECRET_MARKER = 'DRAFT_ONLY_SECRET_9f3c1a';

const candidateIdentityFile = 'candidate-identity.json';
const frozenSnapshotFile = 'snapshot.json';
const candidateSnapshotFile = 'candidate-snapshot.json';
const draftFile = 'draft-a.json';
const blockedDataRootDirectory = 'must-not-be-read';

// The share-image step decodes the cover with sharp, so the fixture must ship a
// real PNG rather than a hand-written byte string.
async function createManagedPng(background) {
  return sharp({ create: { width: 32, height: 32, channels: 3, background } }).png().toBuffer();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Values mirror DEFAULT_SITE_SETTINGS in src/lib/site-settings.ts; that module is inlined here
// because its runtime imports only resolve through the Next.js alias setup, not under plain Node.
function fixtureSettings() {
  return {
    siteName: '观澜志',
    siteDescription: '首期验收冻结候选',
    workspaceLabel: '观澜志 / 文章与导航',
    heroTitleLineOne: '记录值得回看的内容，',
    heroTitleLineTwo: '整理实用的知识与导航',
    heroDescription: '观澜志收录公开文章与常用导航，帮助读者查找、阅读和整理信息。',
    showIntroCard: true,
    introCardEyebrow: '观澜志',
    introCardTitle: '文章与导航，一处查阅',
    introCardDescription: '浏览站点公开文章，或从分类导航中查找常用网站与参考资料。',
    introCardMetaOneLabel: '内容',
    introCardMetaOneValue: '公开文章与实用导航',
    introCardMetaTwoLabel: '文章',
    introCardMetaTwoValue: '按主题查阅文章与笔记',
    introCardMetaThreeLabel: '导航',
    introCardMetaThreeValue: '按分类查找网站与工具',
    introCardStartLabel: '开始浏览',
  };
}

// The private candidate a release would publish. The frozen public projection cannot reproduce
// its digest, which is exactly why the identity document travels next to the frozen bytes.
function buildCandidateSnapshot(media) {
  return {
    schemaVersion: 1,
    siteId: 'first-release-fixture',
    articles: [
      {
        id: 'live-b',
        slug: '已上线文章',
        title: '已上线文章 B',
        date: '2026-09-01',
        description: '此前已经上线的公开文章。',
        tags: ['已上线'],
        content: '# 已上线文章 B\n\n这篇是 live B 的正文，包含中文检索词：静态构建。',
        createdAt: 1,
        updatedAt: 1,
        managedImage: { source: 'media/article.png', alt: '已上线文章配图' },
      },
      {
        id: 'candidate-c',
        slug: '本次新增文章',
        title: '本次新增文章 C',
        date: '2026-09-30',
        description: '本次发布首次上线的文章。',
        tags: ['新增'],
        content: '# 本次新增文章 C\n\n候选 C 的正文，用于验证搜索与订阅包含新文章。',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'cjk-slug',
        slug: '中文单段文章',
        title: '中文单段文章',
        date: '2026-09-30',
        description: '验证中文单段 slug 原样保留。',
        tags: ['中文'],
        content: '# 中文单段文章\n\n中文单段 slug 必须原样导出。',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    navigation: [
      {
        name: '开发工具',
        icon: 'link',
        slug: '开发工具',
        tools: [
          { icon: 'link', title: '示例入口', description: '用于验证导航搜索字段。', url: 'https://example.com/tools', tags: ['示例'] },
        ],
      },
    ],
    settings: fixtureSettings(),
    media,
    redirects: [{ from: '/posts/旧文章/', to: '/posts/中文单段文章/' }],
    removedPaths: ['/blog/legacy-post/'],
  };
}

function mediaRef(originalPath, bytes) {
  return { originalPath, publicPath: originalPath, sha256: sha256(bytes), size: bytes.byteLength, mimeType: 'image/png' };
}

async function assertLegacyRootIsUnderTmp() {
  const relativeToTmp = path.relative(path.join(projectRoot, '.tmp'), legacyFixtureRoot);
  if (relativeToTmp.startsWith('..') || path.isAbsolute(relativeToTmp) || relativeToTmp === '') {
    throw new Error('Legacy fixture root must stay under .tmp/');
  }
}

// Only the legacy in-repo location is replaced, and only when it carries this fixture's marker.
async function assertMarkerOwnership() {
  const existing = await fs.lstat(legacyFixtureRoot).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!existing) return;
  if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Fixture root must be a real directory');
  const marker = await fs.readFile(legacyMarkerPath, 'utf8').catch(() => null);
  if (!marker || JSON.parse(marker).marker !== MARKER) {
    throw new Error('Refusing to replace a directory without this fixture marker');
  }
}

// A caller-provided root is created and owned by the caller; this module never removes it.
async function assertCallerOwnedRoot(root) {
  const info = await fs.lstat(root).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new Error('A caller-provided fixture root must be an existing real directory');
  const entries = await fs.readdir(root);
  if (entries.length > 0) throw new Error(`Refusing to write into a directory this run does not own: ${root}`);
}

async function writeFixtureFiles(root) {
  await fs.mkdir(path.join(root, 'media'), { recursive: true });
  await fs.mkdir(path.join(root, 'rejects'), { recursive: true });

  // Managed media: one referenced by a frozen post, one deliberately unreferenced.
  const coverBytes = await createManagedPng({ r: 184, g: 92, b: 56 });
  const unreferencedBytes = await createManagedPng({ r: 90, g: 120, b: 200 });
  await fs.writeFile(path.join(root, 'media', 'article.png'), coverBytes, { flag: 'wx' });
  await fs.writeFile(path.join(root, 'media', 'unreferenced.png'), unreferencedBytes, { flag: 'wx' });

  const candidate = buildCandidateSnapshot([
    mediaRef('article.png', coverBytes),
    mediaRef('unreferenced.png', unreferencedBytes),
  ]);
  const frozenSnapshot = fromReleaseSnapshot(RELEASE_ID, candidate);
  const candidateBytes = Buffer.from(JSON.stringify(candidate));
  const frozenBytes = Buffer.from(JSON.stringify(frozenSnapshot));
  const identity = {
    schemaVersion: 1,
    releaseId: RELEASE_ID,
    candidateDigest: sha256(candidateBytes),
    snapshotDigest: sha256(frozenBytes),
  };
  await fs.writeFile(path.join(root, candidateSnapshotFile), candidateBytes, { flag: 'wx' });
  await fs.writeFile(path.join(root, frozenSnapshotFile), frozenBytes, { flag: 'wx' });
  await fs.writeFile(path.join(root, candidateIdentityFile), JSON.stringify(identity), { flag: 'wx' });

  // Draft A lives in its own file with the public post shape: the frozen snapshot schema has no
  // draft field, so A can only leak if something wrongly reads local drafts during a build.
  await fs.writeFile(path.join(root, draftFile), `${JSON.stringify({
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
  }, null, 2)}\n`, { flag: 'wx' });

  // The build child receives this data root; nothing in the public closure may read it.
  const blockedDataRoot = path.join(root, blockedDataRootDirectory);
  await fs.mkdir(blockedDataRoot, { recursive: true });
  await fs.writeFile(path.join(blockedDataRoot, 'draft.json'), `${JSON.stringify({
    note: 'Runtime drafts that must never reach a public artifact.',
    secretMarker: DRAFT_SECRET_MARKER,
  }, null, 2)}\n`, { flag: 'wx' });

  // Rejection fixtures: each must be refused by the real validator.
  const rejected = [
    ['illegal-slug.json', { ...frozenSnapshot, posts: [{ ...frozenSnapshot.posts[0], slug: 'nested/post' }] }],
    ['unknown-field.json', { ...frozenSnapshot, draft: DRAFT_SECRET_MARKER }],
    ['future-schema.json', { ...frozenSnapshot, schemaVersion: 99 }],
  ];

  const failures = [];
  for (const [fileName, value] of rejected) {
    await fs.writeFile(path.join(root, 'rejects', fileName), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    try {
      validatePublicSiteSnapshot(value);
      failures.push(fileName);
    } catch {
      // Expected: the validator rejected it.
    }
  }

  // The valid public projection must be accepted, otherwise the fixture itself is broken.
  validatePublicSiteSnapshot(frozenSnapshot);

  if (failures.length > 0) {
    throw new Error(`Fixture rejection cases were wrongly accepted: ${failures.join(', ')}`);
  }

  return {
    fixtureRoot: root,
    releaseId: RELEASE_ID,
    identityPath: path.join(root, candidateIdentityFile),
    identity,
    frozenSnapshotPath: path.join(root, frozenSnapshotFile),
    candidateSnapshotPath: path.join(root, candidateSnapshotFile),
    draftPath: path.join(root, draftFile),
    blockedDataRoot,
  };
}

export async function createReleaseFixture(options = {}) {
  const callerRoot = options.root === undefined ? null : path.resolve(options.root);
  if (callerRoot) {
    await assertCallerOwnedRoot(callerRoot);
    return writeFixtureFiles(callerRoot);
  }

  await assertLegacyRootIsUnderTmp();
  await assertMarkerOwnership();
  await fs.rm(legacyFixtureRoot, { recursive: true, force: true });
  await fs.mkdir(legacyFixtureRoot, { recursive: true });
  const fixture = await writeFixtureFiles(legacyFixtureRoot);
  await fs.writeFile(legacyMarkerPath, `${JSON.stringify({
    marker: MARKER,
    createdAt: '2026-09-30',
    candidateDigest: fixture.identity.candidateDigest,
  }, null, 2)}\n`, { flag: 'wx' });
  return fixture;
}

async function main() {
  const fixture = await createReleaseFixture();
  process.stdout.write(`First-release fixture written to ${fixture.fixtureRoot}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
