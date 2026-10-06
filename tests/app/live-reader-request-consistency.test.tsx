import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PostPage, { generateMetadata } from '@/app/posts/[...slug]/page';
import {
  getPublicLiveSnapshot,
  resetLivePublicSnapshotCacheForTests,
} from '@/lib/live-public-reader';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import { writeLivePointer, writeRelease } from '@/lib/publishing/store';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';
import type { SiteSnapshot } from '@/lib/publishing/types';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('next/image', () => ({
  default: ({ alt = '' }: { alt?: string }) => <span aria-label={alt} />,
}));

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  BLOG_NAVIGATION_DOCKER: process.env.BLOG_NAVIGATION_DOCKER,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
};
const tempDirectories: string[] = [];

function createTempDataRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-live-request-'));
  tempDirectories.push(directory);
  return directory;
}

function createSnapshot(marker: string): SiteSnapshot {
  return {
    schemaVersion: 1,
    siteId: 'live-request-site',
    articles: [
      {
        id: 'live-article',
        slug: 'live-article',
        title: `${marker} article`,
        date: '2026-10-05',
        description: `${marker} description`,
        tags: ['shared-topic'],
        content: `${marker} body`,
        status: 'seedling',
        kind: 'essay',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    navigation: [],
    settings: { ...DEFAULT_SITE_SETTINGS, siteName: `${marker} site` },
    media: [],
    redirects: [],
    removedPaths: [],
  };
}

function publishLiveRelease(releaseId: string, marker: string): void {
  const snapshot = createSnapshot(marker);
  const candidateDigest = computeCandidateDigest(snapshot);
  const artifactDigest = 'a'.repeat(64);
  const now = '2026-10-05T00:00:00.000Z';

  writeRelease({
    schemaVersion: 1, id: releaseId, scope: { kind: 'bootstrap', articleIds: [] }, baseLiveReleaseId: null,
    selectedRevision: 'b'.repeat(64), candidateDigest, artifactDigest, status: 'live', backupProof: null,
    publicCommitSha: 'c'.repeat(40), workflowRunId: 1, workflowRunAttempt: 1, retryFromAttempt: null,
    error: null, createdAt: now, updatedAt: now,
  }, snapshot);
  writeLivePointer({
    schemaVersion: 1, releaseId, candidateDigest, artifactDigest, publicCommitSha: 'c'.repeat(40),
    workflowRunId: 1, workflowRunAttempt: 1, verifiedAt: now,
  });
}

beforeEach(() => {
  process.env.BLOG_DATA_ROOT = createTempDataRoot();
  process.env.BLOG_NAVIGATION_DOCKER = 'true';
  resetLivePublicSnapshotCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();

  for (const name of Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>) {
    const value = ORIGINAL_ENV[name];

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  resetLivePublicSnapshotCacheForTests();

  while (tempDirectories.length > 0) {
    fs.rmSync(tempDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe('live reader request consistency', () => {
  it('keeps metadata and body on the release that was live when the request started', async () => {
    publishLiveRelease('release-alpha', 'alpha');

    const metadata = await generateMetadata({ params: Promise.resolve({ slug: ['live-article'] }) });
    publishLiveRelease('release-beta', 'beta');
    const html = renderToStaticMarkup(
      await PostPage({ params: Promise.resolve({ slug: ['live-article'] }) })
    );

    expect(metadata.title).toBe('alpha article');
    expect(html).toContain('alpha body');
    expect(html).toContain('alpha site');
    expect(html).not.toContain('beta');
  });

  it('adopts the next release once the single-request reuse window has passed', async () => {
    publishLiveRelease('release-alpha', 'alpha');

    expect(getPublicLiveSnapshot().releaseId).toBe('release-alpha');

    publishLiveRelease('release-beta', 'beta');
    expect(getPublicLiveSnapshot().releaseId).toBe('release-alpha');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    expect(getPublicLiveSnapshot().releaseId).toBe('release-beta');
    vi.useRealTimers();
  });
});
