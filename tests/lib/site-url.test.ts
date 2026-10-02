import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeConfig = {
    publicSiteUrl: {
        value: 'https://blog.example.com',
        source: 'file' as 'file' | 'env' | 'default',
    },
};

vi.mock('@/lib/app-runtime-config', () => ({
    getSafeAppRuntimeConfig: () => runtimeConfig,
    getRuntimePublicSiteUrl: () => runtimeConfig.publicSiteUrl.value,
}));

async function loadSiteUrl() {
    vi.resetModules();
    return import('@/lib/site-url');
}

beforeEach(() => {
    runtimeConfig.publicSiteUrl = {
        value: 'https://blog.example.com',
        source: 'file',
    };
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('getSiteUrl', () => {
    it('uses the configured public site URL', async () => {
        const { getSiteUrl } = await loadSiteUrl();

        expect(getSiteUrl().toString()).toBe('https://blog.example.com/');
    });

    it('resolves canonical URLs against the configured origin', async () => {
        const { createCanonicalUrl } = await loadSiteUrl();

        expect(createCanonicalUrl('/blog')).toBe('https://blog.example.com/blog');
        expect(createCanonicalUrl('/')).toBe('https://blog.example.com/');
    });

    it('falls back to localhost and reports the misconfiguration outside local runtimes', async () => {
        runtimeConfig.publicSiteUrl = {
            value: 'http://localhost:3000',
            source: 'default',
        };
        vi.stubEnv('NODE_ENV', 'production');

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { getSiteUrl } = await loadSiteUrl();

        expect(getSiteUrl().toString()).toBe('http://localhost:3000/');
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][0]).toContain('NEXT_PUBLIC_SITE_URL is not configured');
    });

    it('reports the unconfigured site URL only once per process', async () => {
        runtimeConfig.publicSiteUrl = {
            value: 'http://localhost:3000',
            source: 'default',
        };
        vi.stubEnv('NODE_ENV', 'production');

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { getSiteUrl } = await loadSiteUrl();

        getSiteUrl();
        getSiteUrl();
        getSiteUrl();

        expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('warns when NODE_ENV is unset, because a bare node server.js deploy is not local', async () => {
        runtimeConfig.publicSiteUrl = {
            value: 'http://localhost:3000',
            source: 'default',
        };
        vi.stubEnv('NODE_ENV', undefined);

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { getSiteUrl } = await loadSiteUrl();

        getSiteUrl();

        expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('stays quiet about the default site URL in local runtimes', async () => {
        runtimeConfig.publicSiteUrl = {
            value: 'http://localhost:3000',
            source: 'default',
        };
        vi.stubEnv('NODE_ENV', 'development');

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { getSiteUrl } = await loadSiteUrl();

        getSiteUrl();

        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('falls back to localhost when the configured URL cannot be parsed', async () => {
        runtimeConfig.publicSiteUrl = {
            value: 'not-a-url',
            source: 'file',
        };

        const { getSiteUrl } = await loadSiteUrl();

        expect(getSiteUrl().toString()).toBe('http://localhost:3000/');
    });
});

describe('createOgImagePath', () => {
    it('encodes the title and omits a blank description', async () => {
        const { createOgImagePath } = await loadSiteUrl();

        expect(createOgImagePath({ title: 'Hello World' })).toBe('/og?title=Hello+World');
        expect(createOgImagePath({ title: 'A', description: '   ' })).toBe('/og?title=A');
        expect(createOgImagePath({ title: 'A', description: 'B' })).toBe('/og?title=A&description=B');
    });
});
