import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function readRepoFile(...segments: string[]): string {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');
}

describe('deployment boundaries', () => {
  it('requires an explicit image and keeps data, secrets, and build roots separate', () => {
    const compose = readRepoFile('deploy', 'compose.prod.yaml');

    expect(compose).toMatch(/^\s+image:\s+\$\{DEPLOY_IMAGE:\?Set DEPLOY_IMAGE/m);
    expect(compose).toContain('./data:/var/lib/guanlan/data');
    expect(compose).toContain('./secrets:/var/lib/guanlan/secrets');
    expect(compose).toContain('./build:/var/lib/guanlan/build');
    expect(compose).not.toContain('ghcr.io/242282218');
    expect(compose).not.toContain('blog-nevigation:latest');
  });

  it('publishes the HTTP admin port and uses insecure cookies only for accepted HTTP', () => {
    const compose = readRepoFile('deploy', 'compose.prod.yaml');

    expect(compose).toContain('0.0.0.0:5678:3000');
    expect(compose).toContain('COOKIE_SECURE: "false"');
    expect(compose).toContain('HTTP');
  });

  it('keeps the runtime public builder workspace writable', () => {
    const compose = readRepoFile('deploy', 'compose.prod.yaml');

    expect(compose).not.toContain('read_only: true');
    expect(compose).toContain('/app/management/.next/cache:size=256m,uid=1001,gid=1001,mode=0770');
  });

  it('creates writable runtime subdirectories as the non-root app user', () => {
    const entrypoint = readRepoFile('deploy', 'docker-entrypoint.sh');

    expect(entrypoint).toMatch(/su-exec nextjs mkdir -p \\\s+"\$DATA_ROOT\/articles"/);
    expect(entrypoint).not.toContain('mkdir -p "$DATA_ROOT/articles"');
  });

  it('keeps image updates data-safe and supports rollback to an immutable local tag', () => {
    const update = readRepoFile('deploy', 'docker-update.sh');

    expect(update).toContain('docker tag');
    expect(update).toContain('rollback');
    expect(update).not.toMatch(/rm\s+-rf\s+.*(data|secrets)/i);
    expect(update).not.toMatch(/(rm|mv|cp).*\.env/i);
  });

  it('registers an interactive initializer that reuses runtime auth and never accepts argv passwords', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> };
    const initializer = readRepoFile('scripts', 'admin', 'init-auth.mjs');

    expect(packageJson.scripts['admin:init']).toBe('node scripts/admin/init-auth.mjs');
    expect(initializer).toContain('initializeRuntimeEditorAuth');
    expect(initializer).toContain('updateRuntimeEditorAuthSecret');
    expect(initializer).toContain('setRawMode');
    expect(initializer).not.toContain('process.argv');
    expect(initializer).not.toMatch(/scrypt\s*\(/i);
  });

  it('keeps unvalidated copy-paste production deployment commands out of the README', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('npm run dev');
    expect(readme).not.toContain('/opt/blog-nevigation');
    expect(readme).not.toContain('docker run -d');
    expect(readme).not.toContain('EDITOR_ACCESS_TOKEN=');
  });

  it('escapes dynamic route brackets in Docker COPY source patterns', () => {
    const dockerfile = readRepoFile('Dockerfile');

    expect(dockerfile).toContain('/app/src/public-site/app/blog/[[]...slug]/page.tsx');
    expect(dockerfile).toContain('/app/src/public-site/app/posts/[[]slug]/page.tsx');
  });

  it('keeps the offline public builder check aligned with its builder stage', () => {
    const dockerfile = readRepoFile('Dockerfile');
    const builderCheck = readRepoFile('scripts', 'test', 'verify-builder-container.mjs');

    expect(builderCheck).toContain("['build', '--target', 'builder', '-t', image, '.']");
    expect(builderCheck).toContain("'scripts/public-site/build.mjs'");
    expect(builderCheck).toContain('Docker is unavailable on this machine');
    expect(dockerfile).toContain('BLOG_BUILD_ROOT=/var/lib/guanlan/build node scripts/public-site/build.mjs');
    expect(dockerfile).toContain('/var/lib/guanlan/build/image-probe-output/image-probe/app/out/index.html');
    expect(dockerfile).not.toContain('npm prune');
  });

  it('keeps the production image liveness probe on the health endpoint', () => {
    const dockerfile = readRepoFile('Dockerfile');

    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('/api/health');
  });
});
