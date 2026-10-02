import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Article } from '@/app/types/article';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import type { ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';
import {
  readLivePointer,
  readNavigationIdentities,
  readRelease,
  UnsupportedSchemaError,
  writeLivePointer,
  writeNavigationIdentities,
  writeRelease,
} from '@/lib/publishing/store';
import { createNavigationIdentityMap } from '@/lib/navigation-identities';

let previousRoot: string | undefined;
let root: string;

function article(id: string): Article {
  return {
    id,
    slug: id,
    title: id,
    date: '2026-09-30',
    description: '',
    tags: [],
    content: 'content',
    createdAt: 1,
    updatedAt: 2,
    status: 'published',
  };
}

function snapshot(): SiteSnapshot {
  return {
    schemaVersion: 1,
    siteId: 'fixture-site',
    articles: [article('a')],
    navigation: [],
    settings: { ...DEFAULT_SITE_SETTINGS },
    media: [],
    redirects: [],
    removedPaths: [],
  };
}

function release(): ReleaseRecord {
  return {
    schemaVersion: 1,
    id: 'release-1',
    scope: { kind: 'article', articleId: 'a', action: 'publish' },
    baseLiveReleaseId: null,
    selectedRevision: 'a'.repeat(64),
    candidateDigest: 'b'.repeat(64),
    artifactDigest: null,
    status: 'preview_ready',
    backupProof: null,
    publicCommitSha: null,
    workflowRunId: null,
    workflowRunAttempt: null,
    retryFromAttempt: null,
    error: null,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  };
}

beforeEach(() => {
  previousRoot = process.env.BLOG_DATA_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-navigation-publishing-store-'));
  process.env.BLOG_DATA_ROOT = root;
});

afterEach(() => {
  if (previousRoot === undefined) {
    delete process.env.BLOG_DATA_ROOT;
  } else {
    process.env.BLOG_DATA_ROOT = previousRoot;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('publishing release and live persistence', () => {
  it('atomically persists immutable release metadata and its snapshot under the release directory', () => {
    const value = release();
    const candidate = snapshot();

    writeRelease(value, candidate);

    const directory = path.join(root, 'workflow', 'releases', value.id);
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'))).toEqual(value);
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'snapshot.json'), 'utf8'))).toEqual(candidate);
    expect(readRelease(value.id)).toEqual({ release: value, snapshot: candidate });
    expect(fs.readdirSync(directory).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('reads live only from the explicit pointer, never from Article.status', () => {
    expect(snapshot().articles[0].status).toBe('published');
    expect(readLivePointer()).toBeNull();
  });

  it('atomically persists an explicit live pointer', () => {
    const pointer = {
      schemaVersion: 1 as const,
      releaseId: 'release-1',
      candidateDigest: 'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      publicCommitSha: 'c'.repeat(40),
      workflowRunId: 42,
      workflowRunAttempt: 2,
      verifiedAt: '2026-09-30T00:00:00.000Z',
    };

    writeLivePointer(pointer);

    expect(readLivePointer()).toEqual(pointer);
    expect(fs.existsSync(path.join(root, 'workflow', 'live.json'))).toBe(true);
  });

  it('rejects release IDs that could escape the workflow directory', () => {
    expect(() => writeRelease({ ...release(), id: '../outside' }, snapshot())).toThrow(/release|id/i);
  });

  it('rejects unknown or future release schema fields before parsing them', () => {
    const directory = path.join(root, 'workflow', 'releases', 'release-1');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify({
      ...release(),
      futureProofMode: true,
    }));
    fs.writeFileSync(path.join(directory, 'snapshot.json'), JSON.stringify(snapshot()));

    expect(() => readRelease('release-1')).toThrow(UnsupportedSchemaError);
    expect(() => readRelease('release-1')).toThrow(/UNSUPPORTED_SCHEMA/);
  });

  it('rejects a future snapshot schema instead of parsing and dropping fields', () => {
    const value = release();
    const directory = path.join(root, 'workflow', 'releases', value.id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify(value));
    fs.writeFileSync(path.join(directory, 'snapshot.json'), JSON.stringify({
      ...snapshot(),
      schemaVersion: 2,
      futureField: 'must not be dropped',
    }));

    expect(() => readRelease(value.id)).toThrow(UnsupportedSchemaError);
  });

  it('persists navigation identities as a separate workflow sidecar', () => {
    const identities = createNavigationIdentityMap([{
      name: 'Resources',
      icon: 'R',
      slug: 'resources',
      tools: [{ icon: 'T', title: 'Example', description: '', url: 'https://example.com/', tags: ['ref'] }],
    }]);

    writeNavigationIdentities(identities);

    expect(readNavigationIdentities()).toEqual(identities);
    expect(fs.existsSync(path.join(root, 'workflow', 'navigation-identities.json'))).toBe(true);
  });
});
