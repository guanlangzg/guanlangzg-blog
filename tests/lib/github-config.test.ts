import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getGitHubConnectionDto,
  readGitHubConnection,
  saveGitHubConnection,
  validateGitHubRepositories,
  type GitHubConnectionInput,
} from '@/lib/github/config';
import { saveGitHubPrivateKey } from '@/lib/github/secrets';

const repositories = {
  source: { owner: 'guanlangzg', name: 'guanlangzg-blog', id: 10 },
  pages: { owner: 'guanlangzg', name: 'guanlangzg.github.io', id: 20 },
  backup: { owner: 'guanlangzg', name: 'guanlangzg-blog-backup', id: 30 },
};

const generatedKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const validPrivateKey = generatedKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const connectionInput: GitHubConnectionInput = {
  appId: 'app-123',
  installationId: 44,
  repos: repositories,
  status: 'connected',
  revision: 'revision-1',
};

let previousDataRoot: string | undefined;
let previousSecretRoot: string | undefined;
let previousSecretKey: string | undefined;
let temporaryRoot: string;

beforeEach(() => {
  previousDataRoot = process.env.BLOG_DATA_ROOT;
  previousSecretRoot = process.env.BLOG_SECRET_ROOT;
  previousSecretKey = process.env.BLOG_SECRET_KEY;
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'github-config-test-'));
  process.env.BLOG_DATA_ROOT = path.join(temporaryRoot, 'data');
  process.env.BLOG_SECRET_ROOT = path.join(temporaryRoot, 'secrets');
  process.env.BLOG_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterEach(() => {
  if (previousDataRoot === undefined) delete process.env.BLOG_DATA_ROOT;
  else process.env.BLOG_DATA_ROOT = previousDataRoot;
  if (previousSecretRoot === undefined) delete process.env.BLOG_SECRET_ROOT;
  else process.env.BLOG_SECRET_ROOT = previousSecretRoot;
  if (previousSecretKey === undefined) delete process.env.BLOG_SECRET_KEY;
  else process.env.BLOG_SECRET_KEY = previousSecretKey;
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('GitHub connection configuration', () => {
  it('rejects using the Pages repository as the backup repository', () => {
    expect(() => validateGitHubRepositories({
      ...repositories,
      backup: repositories.pages,
    })).toThrow(/backup|Pages/i);
  });

  it('rejects using the source repository as the backup repository', () => {
    expect(() => validateGitHubRepositories({
      ...repositories,
      backup: repositories.source,
    })).toThrow(/备份|源码/);
  });

  it('persists only connection metadata under BLOG_DATA_ROOT/workflow/github.json', async () => {
    await saveGitHubPrivateKey(validPrivateKey);
    await saveGitHubConnection(connectionInput);

    const configPath = path.join(process.env.BLOG_DATA_ROOT as string, 'workflow', 'github.json');
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const dto = await getGitHubConnectionDto();

    expect(stored).toEqual({ version: 1, ...connectionInput });
    expect(JSON.stringify(stored)).not.toContain('privateKey');
    expect(dto).toEqual({
      privateKeyConfigured: true,
      appId: 'app-123',
      installationId: 44,
      repos: repositories,
      status: 'connected',
    });
    expect(JSON.stringify(dto)).not.toContain(validPrivateKey);
    expect(await readGitHubConnection()).toEqual(connectionInput);
  });

  it('returns a safe empty DTO before any connection has been configured', async () => {
    await expect(getGitHubConnectionDto()).resolves.toEqual({
      privateKeyConfigured: false,
      appId: null,
      installationId: null,
      repos: null,
      status: 'not_configured',
    });
  });
});
