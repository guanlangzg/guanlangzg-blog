import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { GET as getArticles } from '@/app/api/data/articles/route';
import { GET as getCloudflareR2 } from '@/app/api/data/cloudflare-r2/route';
import { GET as getNavigation } from '@/app/api/data/navigation/route';
import { GET as getSettings } from '@/app/api/data/settings/route';
import {
  cleanupTempDirectories,
  createAuthedEditorRequest,
  createTempDirectory,
  restoreEnv,
} from '../helpers/api-route';

const ORIGINAL_ENV = {
  BLOG_DATA_ROOT: process.env.BLOG_DATA_ROOT,
  EDITOR_ACCESS_TOKEN: process.env.EDITOR_ACCESS_TOKEN,
};
const tempDirectories: string[] = [];

function createTempRoot(): string {
  const root = createTempDirectory('blog-navigation-runtime-data-persistence-');
  tempDirectories.push(root);
  return root;
}

function createCreatableDataRoot(): string {
  return path.join(createTempRoot(), 'runtime-data');
}

function createBlockedDataRoot(): string {
  const root = createTempRoot();
  const blockingFile = path.join(root, 'blocked.txt');

  fs.writeFileSync(blockingFile, 'blocked', 'utf8');
  return path.join(blockingFile, 'runtime-data');
}

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
  cleanupTempDirectories(tempDirectories);
});

async function expectPersistent(expected: boolean): Promise<void> {
  const routes = [
    {
      url: 'http://localhost/api/data/settings',
      get: getSettings,
    },
    {
      url: 'http://localhost/api/data/cloudflare-r2',
      get: getCloudflareR2,
    },
    {
      url: 'http://localhost/api/data/articles',
      get: getArticles,
    },
    {
      url: 'http://localhost/api/data/navigation',
      get: getNavigation,
    },
  ];
  const authHeaders = await createAuthenticatedHeaders();

  for (const route of routes) {
    const response = await route.get(new NextRequest(route.url, {
      headers: authHeaders,
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.persistent).toBe(expected);
  }
}

async function createAuthenticatedHeaders(): Promise<Headers> {
  const currentRoot = process.env.BLOG_DATA_ROOT;

  process.env.BLOG_DATA_ROOT = createCreatableDataRoot();

  try {
    const request = await createAuthedEditorRequest('http://localhost/api/data/settings');

    return new Headers(request.headers);
  } finally {
    if (currentRoot === undefined) {
      delete process.env.BLOG_DATA_ROOT;
    } else {
      process.env.BLOG_DATA_ROOT = currentRoot;
    }
  }
}

describe('editor data route persistence', () => {
  it('marks routes persistent when the runtime data root can be created', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createCreatableDataRoot();

    await expectPersistent(true);
  });

  it('marks routes non-persistent when the runtime data root is blocked by a file path', async () => {
    process.env.EDITOR_ACCESS_TOKEN = 'test-editor-token';
    process.env.BLOG_DATA_ROOT = createBlockedDataRoot();

    await expectPersistent(false);
  });
});
