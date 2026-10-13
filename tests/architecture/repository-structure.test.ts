import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function readRepoFile(...segments: string[]): string {
    return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');
}

function repoPath(...segments: string[]): string {
    return path.join(repoRoot, ...segments);
}

describe('repository architecture boundaries', () => {
    it('keeps application source and runtime assets in stable paths', () => {
        [
            ['src', 'app', 'page.tsx'],
            ['src', 'app', 'api', 'ready', 'route.ts'],
            ['src', 'app', 'layout.tsx'],
            ['src', 'lib', 'markdown.ts'],
            ['src', 'middleware.ts'],
            ['content', 'seeds', 'posts'],
            ['content', 'seeds', 'navigation', 'data', 'tools.json'],
            ['public', 'guanlan-logo.png'],
            ['public', 'favicon-16.png'],
            ['public', 'favicon-32.png'],
            ['public', 'favicon-48.png'],
            ['public', 'favicon-64.png'],
            ['compose.yaml'],
        ].forEach((segments) => {
            expect(fs.existsSync(repoPath(...segments)), segments.join('/')).toBe(true);
        });

        ['app', 'lib', 'middleware.ts'].forEach((legacyPath) => {
            expect(fs.existsSync(repoPath(legacyPath)), legacyPath).toBe(false);
        });
    });

    it('keeps public request paths on asynchronous data reads', () => {
        [
            ['src', 'app', 'page.tsx'],
            ['src', 'app', 'blog', 'page.tsx'],
            ['src', 'app', 'posts', '[...slug]', 'page.tsx'],
            ['src', 'app', 'navigation', 'page.tsx'],
            ['src', 'app', 'api', 'search', 'route.ts'],
            ['src', 'app', 'layout.tsx'],
        ].forEach((segments) => {
            const source = readRepoFile(...segments);
            expect(source, segments.join('/')).not.toMatch(/\bgetPosts\b/);
            expect(source, segments.join('/')).not.toMatch(/\breadNavigationFromDisk\b/);
            expect(source, segments.join('/')).not.toMatch(/\breadSiteSettingsFromDisk\b/);
        });
    });

    it('keeps local restore preconditions and GitHub backup APIs while removing R2 APIs', () => {
        expect(fs.existsSync(repoPath('src', 'app', 'api', 'data', 'backup', 'current-manifest', 'route.ts'))).toBe(true);
        expect(fs.existsSync(repoPath('src', 'app', 'api', 'editor', 'backups', 'route.ts'))).toBe(true);
        expect(fs.existsSync(repoPath('src', 'app', 'api', 'data', 'backup', 'remote'))).toBe(false);
        expect(fs.existsSync(repoPath('src', 'app', 'api', 'data', 'cloudflare-r2'))).toBe(false);
    });

    it('enforces production container and deployment safety boundaries', () => {
        const dockerfile = readRepoFile('Dockerfile');
        const dockerIgnore = readRepoFile('.dockerignore');
        const deployCompose = readRepoFile('deploy', 'compose.prod.yaml');

        expect(dockerIgnore).toMatch(/^data$/m);
        expect(dockerIgnore).toMatch(/^\.env$/m);
        expect(dockerfile).toContain('HEALTHCHECK');
        expect(dockerfile).toContain('/api/health');
        // The standalone management server is placed under /app/management so the
        // container also keeps the public-site builder sources and dependencies.
        expect(dockerfile).toContain('COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone /app/management');
        expect(dockerfile).toContain('/app/src/public-site/app/manifest.ts');
        expect(dockerfile).toContain('/app/src/public-site/app/llms.txt/route.ts');
        expect(deployCompose).toMatch(/^\s+image:\s+\$\{DEPLOY_IMAGE:\?Set DEPLOY_IMAGE/m);
        // Three independent roots keep content, credentials and the rebuildable build
        // workspace under separate persistence and retention rules.
        expect(deployCompose).toContain('./data:/var/lib/guanlan/data');
        expect(deployCompose).toContain('./secrets:/var/lib/guanlan/secrets');
        expect(deployCompose).toContain('./build:/var/lib/guanlan/build');
        // Plain HTTP admin access is a confirmed decision, so the port must not be
        // limited to loopback, and the cookie must drop Secure while keeping the rest.
        expect(deployCompose).toContain('0.0.0.0:5678:3000');
        expect(deployCompose).toContain('COOKIE_SECURE: "false"');
    });

    it('keeps local-only artifacts ignored', () => {
        const gitIgnore = readRepoFile('.gitignore');
        expect(gitIgnore).toMatch(/^\.tmp\/$/m);
        expect(gitIgnore).toMatch(/^\.zread\/$/m);
        expect(gitIgnore).toMatch(/^__pycache__\/$/m);
        expect(gitIgnore).toMatch(/^\/editor-\*\.png$/m);
    });
});
