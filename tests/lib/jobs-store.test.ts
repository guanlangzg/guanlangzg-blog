import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeArticlesToDisk, writeSiteSettingsToDisk } from '@/lib/editor-data-storage';
import { createArticleSlug } from '@/lib/article-data';
import type { Article } from '@/app/types/article';
import { storeEditorMediaFile } from '@/lib/editor-media-storage';
import {
    createJob,
    listJobs,
    MAX_JOB_ATTEMPTS,
    MAX_RETRY_DELAY_MS,
    BASE_RETRY_DELAY_MS,
    claimNextJob,
    failClaimedJob,
    deferClaimedJob,
    retryDelayMs,
    recoverPersistedJobs,
    setArtifactManifestFactoryForTests,
} from '@/lib/jobs/store';
import {
    isBackupCaughtUp,
    readBackupWatermark,
    recordVerifiedFullBackup,
} from '@/lib/jobs/watermark';
import { readLivePointer, writeLivePointer, writeRelease } from '@/lib/publishing/store';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import { createArtifactManifest } from '@/lib/public-build/runner';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';
import type { SiteSnapshot } from '@/lib/publishing/types';
import { DEFAULT_SITE_SETTINGS } from '@/lib/site-settings';

const originalDataRoot = process.env.BLOG_DATA_ROOT;
const roots: string[] = [];
const artifactHashGate = vi.hoisted(() => ({ wait: null as (() => Promise<void>) | null, started: null as (() => void) | null }));

vi.mock('@/lib/public-build/runner', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/public-build/runner')>();
    return {
        ...actual,
        createArtifactManifest: vi.fn(async (...args: Parameters<typeof actual.createArtifactManifest>) => {
            if (artifactHashGate.wait) {
                artifactHashGate.started?.();
                await artifactHashGate.wait();
            }
            return actual.createArtifactManifest(...args);
        }),
    };
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function createArticle(id: string): Article {
    const article = {
        id,
        title: id,
        date: '2026-06-17',
        description: 'Valid test article',
        tags: ['test'],
        content: '# Valid test article',
        createdAt: 1,
        updatedAt: 2,
    };
    return {
        ...article,
        slug: createArticleSlug(article),
        kind: 'essay',
        status: 'draft',
        featured: false,
        sourceLinks: [],
        revisionNotes: [],
    };
}

function createDataRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-jobs-store-'));
    roots.push(root);
    process.env.BLOG_DATA_ROOT = root;
    return root;
}

afterEach(() => {
    if (originalDataRoot === undefined) {
        delete process.env.BLOG_DATA_ROOT;
    } else {
        process.env.BLOG_DATA_ROOT = originalDataRoot;
    }

    while (roots.length > 0) {
        fs.rmSync(roots.pop() as string, { recursive: true, force: true });
    }
});

describe('persistent jobs and backup watermark', () => {
    it('keeps a newer content write dirty when an older full backup completes', async () => {
        createDataRoot();
        await writeArticlesToDisk([]);
        const olderSnapshot = await readBackupWatermark();
        await writeArticlesToDisk([createArticle('newer-content')]);

        const state = await recordVerifiedFullBackup({
            generation: olderSnapshot.generation,
            contentSequence: olderSnapshot.contentSequence,
            remoteCommit: 'commit-old',
        });

        expect(state.contentSequence).toBe(olderSnapshot.contentSequence + 1);
        expect(state.backedUpThrough).toBe(olderSnapshot.contentSequence);
        expect(isBackupCaughtUp(state)).toBe(false);
        expect((await listJobs()).filter((job) => job.type === 'backup')).toHaveLength(2);
    });

    it('recovers a persisted pending job when scanning after restart', async () => {
        const root = createDataRoot();
        const record = {
            id: 'persisted-before-dispatch',
            type: 'backup',
            inputDigest: 'digest',
            input: { revision: 'r1' },
            status: 'pending',
            attempt: 0,
            nextAttemptAt: new Date(0).toISOString(),
            claimedAt: null,
            remoteCommit: null,
            lastError: null,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
        };
        const jobsDirectory = path.join(root, 'workflow', 'jobs');
        fs.mkdirSync(jobsDirectory, { recursive: true });
        fs.writeFileSync(path.join(jobsDirectory, `${record.id}.json`), JSON.stringify(record));

        const recovered = await recoverPersistedJobs();

        expect(recovered.map((job) => job.id)).toContain(record.id);
        expect((await listJobs()).find((job) => job.id === record.id)?.status).toBe('pending');
    });

    it('does not keep the runtime data lock while hashing sealed publication artifacts', async () => {
        const root = createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1, siteId: 'site-lock', articles: [], navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        const artifactRoot = path.join(root, 'workflow', 'releases', 'short-lock', 'public-artifact');
        const appOut = path.join(artifactRoot, 'app', 'out');
        fs.mkdirSync(appOut, { recursive: true });
        fs.writeFileSync(path.join(appOut, 'index.html'), '<html>sealed</html>');
        const manifest = await createArtifactManifest(artifactRoot, 'short-lock', new Set(), candidateDigest);
        fs.writeFileSync(path.join(artifactRoot, 'artifacts.json'), JSON.stringify(manifest));
        writeRelease({
            schemaVersion: 1, id: 'short-lock', scope: { kind: 'bootstrap', articleIds: [] },
            baseLiveReleaseId: null, selectedRevision: 'a'.repeat(64), candidateDigest, artifactDigest: manifest.artifactDigest,
            status: 'publishing', backupProof: null, publicCommitSha: null, workflowRunId: null,
            workflowRunAttempt: null, retryFromAttempt: null, error: null,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }, snapshot);
        let unblockHash!: () => void;
        let hashStarted!: () => void;
        const hashGate = new Promise<void>((resolve) => { unblockHash = resolve; });
        const hashing = new Promise<void>((resolve) => { hashStarted = resolve; });
        const originalHash = createArtifactManifest;
        setArtifactManifestFactoryForTests(async (...args) => {
            hashStarted();
            await hashGate;
            return originalHash(...args);
        });

        try {
            const recovery = recoverPersistedJobs();
            await hashing;
            let acquired = false;
            await withRuntimeDataRootLock(() => { acquired = true; });
            expect(acquired).toBe(true);
            unblockHash();
            await recovery;
            expect((await listJobs()).some((job) => job.type === 'publish' && (job.input as Record<string, unknown>).releaseId === 'short-lock')).toBe(true);
        } finally {
            unblockHash();
            setArtifactManifestFactoryForTests(null);
        }
    });

    it('revalidates release identity after hashing before creating a recovered job', async () => {
        const root = createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1, siteId: 'site-race', articles: [], navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        const artifactRoot = path.join(root, 'workflow', 'releases', 'changed-during-hash', 'public-artifact');
        const appOut = path.join(artifactRoot, 'app', 'out');
        fs.mkdirSync(appOut, { recursive: true });
        fs.writeFileSync(path.join(appOut, 'index.html'), '<html>sealed</html>');
        const manifest = await createArtifactManifest(artifactRoot, 'changed-during-hash', new Set(), candidateDigest);
        fs.writeFileSync(path.join(artifactRoot, 'artifacts.json'), JSON.stringify(manifest));
        const release = {
            schemaVersion: 1 as const, id: 'changed-during-hash', scope: { kind: 'bootstrap' as const, articleIds: [] },
            baseLiveReleaseId: null, selectedRevision: 'a'.repeat(64), candidateDigest, artifactDigest: manifest.artifactDigest,
            status: 'publishing' as const, backupProof: null, publicCommitSha: null, workflowRunId: null,
            workflowRunAttempt: null, retryFromAttempt: null, error: null,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        writeRelease(release, snapshot);
        let unblockHash!: () => void;
        let hashStarted!: () => void;
        const hashGate = new Promise<void>((resolve) => { unblockHash = resolve; });
        const hashing = new Promise<void>((resolve) => { hashStarted = resolve; });
        const originalHash = createArtifactManifest;
        setArtifactManifestFactoryForTests(async (...args) => {
            hashStarted();
            await hashGate;
            return originalHash(...args);
        });

        try {
            const recovery = recoverPersistedJobs();
            await hashing;
            await withRuntimeDataRootLock(() => writeRelease({ ...release, status: 'failed', updatedAt: new Date().toISOString() }, snapshot));
            unblockHash();
            await recovery;
            expect((await listJobs()).filter((job) => job.type === 'publish')).toEqual([]);
        } finally {
            unblockHash();
            setArtifactManifestFactoryForTests(null);
        }
    });

    it('recovers a missing publish job for an authorized publishing release', async () => {
        createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1, siteId: 'site-1', articles: [], navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        const artifactRoot = path.join(process.env.BLOG_DATA_ROOT as string, 'workflow', 'releases', 'publishing-release', 'public-artifact');
        fs.mkdirSync(artifactRoot, { recursive: true });
        const appOut = path.join(artifactRoot, 'app', 'out');
        fs.mkdirSync(appOut, { recursive: true });
        fs.writeFileSync(path.join(appOut, 'index.html'), '<html></html>');
        const sealed = await createArtifactManifest(artifactRoot, 'publishing-release', new Set(), candidateDigest);
        fs.writeFileSync(path.join(artifactRoot, 'artifacts.json'), JSON.stringify(sealed));
        writeRelease({
            schemaVersion: 1, id: 'publishing-release', scope: { kind: 'bootstrap', articleIds: [] },
            baseLiveReleaseId: null, selectedRevision: 'a'.repeat(64), candidateDigest, artifactDigest: sealed.artifactDigest,
            status: 'publishing', backupProof: null, publicCommitSha: null, workflowRunId: null,
            workflowRunAttempt: null, retryFromAttempt: null, error: null,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }, snapshot);

        await recoverPersistedJobs();

        expect((await listJobs()).filter((job) => job.type === 'publish')).toEqual([
            expect.objectContaining({
                input: { releaseId: 'publishing-release', candidateDigest, artifactDigest: sealed.artifactDigest }, status: 'pending',
            }),
        ]);
    });

    it('does not overwrite a terminal publish job when recovering a missing publication', async () => {
        const root = createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1, siteId: 'site-1', articles: [], navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        const artifactRoot = path.join(root, 'workflow', 'releases', 'terminal-collision', 'public-artifact');
        fs.mkdirSync(artifactRoot, { recursive: true });
        const appOut = path.join(artifactRoot, 'app', 'out');
        fs.mkdirSync(appOut, { recursive: true });
        fs.writeFileSync(path.join(appOut, 'index.html'), '<html></html>');
        const sealed = await createArtifactManifest(artifactRoot, 'terminal-collision', new Set(), candidateDigest);
        const artifactDigest = sealed.artifactDigest;
        fs.writeFileSync(path.join(artifactRoot, 'artifacts.json'), JSON.stringify(sealed));
        writeRelease({
            schemaVersion: 1, id: 'terminal-collision', scope: { kind: 'bootstrap', articleIds: [] },
            baseLiveReleaseId: null, selectedRevision: 'a'.repeat(64), candidateDigest, artifactDigest,
            status: 'publishing', backupProof: null, publicCommitSha: null, workflowRunId: null,
            workflowRunAttempt: null, retryFromAttempt: null, error: null,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }, snapshot);
        const jobsDirectory = path.join(root, 'workflow', 'jobs');
        fs.mkdirSync(jobsDirectory, { recursive: true });
        const terminal = {
            id: 'publish-terminal-collision', type: 'publish', inputDigest: 'old-digest', input: { releaseId: 'terminal-collision' },
            status: 'failed', attempt: 1, nextAttemptAt: new Date().toISOString(), claimedAt: null,
            remoteCommit: null, lastError: 'terminal history', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(jobsDirectory, `${terminal.id}.json`), JSON.stringify(terminal));

        await recoverPersistedJobs();

        expect((await listJobs()).find((job) => job.id === terminal.id)).toMatchObject(terminal);
        expect((await listJobs()).some((job) => job.type === 'publish' && job.status === 'pending'
            && (job.input as Record<string, unknown>).releaseId === 'terminal-collision'
            && job.id !== terminal.id)).toBe(true);
    });

    it('does not let a legacy active job without artifact identity suppress publication recovery', async () => {
        const root = createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1, siteId: 'site-1', articles: [], navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        const artifactRoot = path.join(root, 'workflow', 'releases', 'legacy-active', 'public-artifact');
        fs.mkdirSync(artifactRoot, { recursive: true });
        const appOut = path.join(artifactRoot, 'app', 'out');
        fs.mkdirSync(appOut, { recursive: true });
        fs.writeFileSync(path.join(appOut, 'index.html'), '<html></html>');
        const sealed = await createArtifactManifest(artifactRoot, 'legacy-active', new Set(), candidateDigest);
        const artifactDigest = sealed.artifactDigest;
        fs.writeFileSync(path.join(artifactRoot, 'artifacts.json'), JSON.stringify(sealed));
        writeRelease({
            schemaVersion: 1, id: 'legacy-active', scope: { kind: 'bootstrap', articleIds: [] },
            baseLiveReleaseId: null, selectedRevision: 'a'.repeat(64), candidateDigest, artifactDigest,
            status: 'publishing', backupProof: null, publicCommitSha: null, workflowRunId: null,
            workflowRunAttempt: null, retryFromAttempt: null, error: null,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }, snapshot);
        const jobsDirectory = path.join(root, 'workflow', 'jobs');
        fs.mkdirSync(jobsDirectory, { recursive: true });
        fs.writeFileSync(path.join(jobsDirectory, 'legacy-active.json'), JSON.stringify({
            id: 'legacy-active', type: 'publish', inputDigest: 'old-digest', input: { releaseId: 'legacy-active' },
            status: 'pending', attempt: 0, nextAttemptAt: new Date().toISOString(), claimedAt: null,
            remoteCommit: null, lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }));

        await recoverPersistedJobs();

        expect((await listJobs()).some((job) => job.type === 'publish'
            && (job.input as Record<string, unknown>).artifactDigest === artifactDigest)).toBe(true);
    });

    it('does not enqueue publish when sealed artifact bytes have been tampered with', async () => {
        const root = createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1, siteId: 'site-1', articles: [], navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        const artifactRoot = path.join(root, 'workflow', 'releases', 'tampered-artifact', 'public-artifact');
        const appOut = path.join(artifactRoot, 'app', 'out');
        fs.mkdirSync(appOut, { recursive: true });
        fs.writeFileSync(path.join(appOut, 'index.html'), '<html>sealed</html>');
        const sealed = await createArtifactManifest(artifactRoot, 'tampered-artifact', new Set(), candidateDigest);
        fs.writeFileSync(path.join(artifactRoot, 'artifacts.json'), JSON.stringify(sealed));
        fs.writeFileSync(path.join(appOut, 'index.html'), '<html>tampered</html>');
        writeRelease({
            schemaVersion: 1, id: 'tampered-artifact', scope: { kind: 'bootstrap', articleIds: [] },
            baseLiveReleaseId: null, selectedRevision: 'a'.repeat(64), candidateDigest, artifactDigest: sealed.artifactDigest,
            status: 'publishing', backupProof: null, publicCommitSha: null, workflowRunId: null,
            workflowRunAttempt: null, retryFromAttempt: null, error: null,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }, snapshot);

        await recoverPersistedJobs();

        expect((await listJobs()).filter((job) => job.type === 'publish')).toEqual([]);
    });

    it('does not enqueue publish when the sealed artifact identity is unavailable or mismatched', async () => {
        const root = createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1, siteId: 'site-1', articles: [], navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        for (const [id, artifactDigest] of [['missing-seal', 'd'.repeat(64)], ['mismatched-seal', 'e'.repeat(64)]] as const) {
            const releaseDirectory = path.join(root, 'workflow', 'releases', id);
            const artifactRoot = path.join(releaseDirectory, 'public-artifact');
            fs.mkdirSync(artifactRoot, { recursive: true });
            const appOut = path.join(artifactRoot, 'app', 'out');
            fs.mkdirSync(appOut, { recursive: true });
            fs.writeFileSync(path.join(appOut, 'index.html'), '<html></html>');
            const sealed = await createArtifactManifest(artifactRoot, id, new Set(), candidateDigest);
            fs.writeFileSync(path.join(artifactRoot, 'artifacts.json'), JSON.stringify(sealed));
            if (sealed.artifactDigest !== artifactDigest) {
                const identitySeal = { ...sealed, artifactDigest };
                fs.writeFileSync(path.join(artifactRoot, 'artifacts.json'), JSON.stringify(identitySeal));
            }
            writeRelease({
                schemaVersion: 1, id, scope: { kind: 'bootstrap', articleIds: [] }, baseLiveReleaseId: null,
                selectedRevision: 'a'.repeat(64), candidateDigest, artifactDigest, status: 'publishing',
                backupProof: null, publicCommitSha: null, workflowRunId: null, workflowRunAttempt: null,
                retryFromAttempt: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            }, snapshot);
        }
        await recoverPersistedJobs();
        expect((await listJobs()).filter((job) => job.type === 'publish')).toEqual([]);
    });

    it('does not recover publish jobs for unauthorized preview-ready or failed releases', async () => {
        createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1, siteId: 'site-1', articles: [], navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        for (const [id, status] of [['preview-release', 'preview_ready'], ['failed-release', 'failed']] as const) {
            writeRelease({
                schemaVersion: 1, id, scope: { kind: 'bootstrap', articleIds: [] }, baseLiveReleaseId: null,
                selectedRevision: 'a'.repeat(64), candidateDigest, artifactDigest: 'd'.repeat(64), status,
                backupProof: null, publicCommitSha: null, workflowRunId: null, workflowRunAttempt: null,
                retryFromAttempt: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            }, snapshot);
        }

        await recoverPersistedJobs();

        expect((await listJobs()).filter((job) => job.type === 'publish')).toEqual([]);
    });

    it('recovers reconcile jobs for committed deployments and retry placeholders', async () => {
        createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1, siteId: 'site-1', articles: [], navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        const artifactDigests = new Map<string, string>();
        for (const [id, status, retryFromAttempt] of [
            ['deploying-release', 'deploying', null], ['verifying-release', 'verifying', 2],
        ] as const) {
            const artifactRoot = path.join(process.env.BLOG_DATA_ROOT as string, 'workflow', 'releases', id, 'public-artifact');
            fs.mkdirSync(artifactRoot, { recursive: true });
            const appOut = path.join(artifactRoot, 'app', 'out');
            fs.mkdirSync(appOut, { recursive: true });
            fs.writeFileSync(path.join(appOut, 'index.html'), `<html>${id}</html>`);
            const sealed = await createArtifactManifest(artifactRoot, id, new Set(), candidateDigest);
            artifactDigests.set(id, sealed.artifactDigest);
            fs.writeFileSync(path.join(artifactRoot, 'artifacts.json'), JSON.stringify(sealed));
            writeRelease({
                schemaVersion: 1, id, scope: { kind: 'bootstrap', articleIds: [] }, baseLiveReleaseId: null,
                selectedRevision: 'a'.repeat(64), candidateDigest, artifactDigest: sealed.artifactDigest, status, backupProof: null,
                publicCommitSha: 'b'.repeat(40), workflowRunId: 10, workflowRunAttempt: 1, retryFromAttempt,
                error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            }, snapshot);
        }

        await recoverPersistedJobs();

        expect((await listJobs()).filter((job) => job.type === 'reconcile').map((job) => job.input)).toEqual([
            { releaseId: 'deploying-release', candidateDigest, artifactDigest: artifactDigests.get('deploying-release') },
            { releaseId: 'verifying-release', candidateDigest, artifactDigest: artifactDigests.get('verifying-release') },
        ]);
        expect((await listJobs()).filter((job) => job.type === 'publish')).toEqual([
            expect.objectContaining({
                input: { releaseId: 'verifying-release', candidateDigest, artifactDigest: artifactDigests.get('verifying-release'), retry: true, retryFromAttempt: 2 },
                status: 'pending',
            }),
        ]);
    });

    it('recovers current pointer publication windows without reviving historical live releases', async () => {
        createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1, siteId: 'site-1', articles: [], navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        const pointer: { schemaVersion: 1; releaseId: string; candidateDigest: string; artifactDigest: string; publicCommitSha: string; workflowRunId: number; workflowRunAttempt: number; verifiedAt: string } = {
            schemaVersion: 1, releaseId: 'current-live', candidateDigest, artifactDigest: '',
            publicCommitSha: 'b'.repeat(40), workflowRunId: 11, workflowRunAttempt: 1, verifiedAt: new Date().toISOString(),
        };
        const artifactDigests = new Map<string, string>();
        for (const id of ['current-live', 'old-live']) {
            const artifactRoot = path.join(process.env.BLOG_DATA_ROOT as string, 'workflow', 'releases', id, 'public-artifact');
            fs.mkdirSync(artifactRoot, { recursive: true });
            const appOut = path.join(artifactRoot, 'app', 'out');
            fs.mkdirSync(appOut, { recursive: true });
            fs.writeFileSync(path.join(appOut, 'index.html'), `<html>${id}</html>`);
            const sealed = await createArtifactManifest(artifactRoot, id, new Set(), candidateDigest);
            artifactDigests.set(id, sealed.artifactDigest);
            fs.writeFileSync(path.join(artifactRoot, 'artifacts.json'), JSON.stringify(sealed));
            if (id === 'current-live') pointer.artifactDigest = sealed.artifactDigest;
        }
        for (const [id, baseLiveReleaseId] of [['current-live', null], ['old-live', 'current-live']] as const) {
            writeRelease({
                schemaVersion: 1, id, scope: { kind: 'bootstrap', articleIds: [] }, baseLiveReleaseId,
                selectedRevision: 'a'.repeat(64), candidateDigest, artifactDigest: artifactDigests.get(id)!, status: 'live', backupProof: null,
                publicCommitSha: pointer.publicCommitSha, workflowRunId: pointer.workflowRunId,
                workflowRunAttempt: pointer.workflowRunAttempt, retryFromAttempt: null, error: null,
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            }, snapshot);
        }
        writeLivePointer(pointer);
        const jobsDirectory = path.join(process.env.BLOG_DATA_ROOT as string, 'workflow', 'jobs');
        fs.mkdirSync(jobsDirectory, { recursive: true });
        const pointerBackup = {
            reason: 'live-pointer',
            snapshotId: `pointer-${pointer.releaseId}-${pointer.workflowRunAttempt}`,
            pointer,
        };
        fs.writeFileSync(path.join(jobsDirectory, 'completed-pointer-backup.json'), JSON.stringify({
            id: 'completed-pointer-backup', type: 'backup', inputDigest: 'digest', input: pointerBackup,
            status: 'succeeded', attempt: 1, nextAttemptAt: new Date().toISOString(), claimedAt: null,
            remoteCommit: null, lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }));

        await recoverPersistedJobs();

        expect((await listJobs()).filter((job) => job.type === 'reconcile').map((job) => job.input)).toEqual([
            { releaseId: 'old-live', candidateDigest, artifactDigest: artifactDigests.get('old-live') },
        ]);
        expect((await listJobs()).some((job) => job.type === 'reconcile'
            && (job.input as Record<string, unknown>).releaseId === 'current-live')).toBe(false);
        expect(readLivePointer()?.releaseId).toBe('current-live');
    });

    it('does not recreate reconcile for a live release with completed matching pointer backup', async () => {
        const root = createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1, siteId: 'site-1', articles: [], navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        let artifactDigest = '';
        const pointer: { schemaVersion: 1; releaseId: string; candidateDigest: string; artifactDigest: string; publicCommitSha: string; workflowRunId: number; workflowRunAttempt: number; verifiedAt: string } = {
            schemaVersion: 1, releaseId: 'current-live', candidateDigest, artifactDigest,
            publicCommitSha: 'b'.repeat(40), workflowRunId: 12, workflowRunAttempt: 1, verifiedAt: new Date().toISOString(),
        };
        const artifactRoot = path.join(root, 'workflow', 'releases', 'current-live', 'public-artifact');
        fs.mkdirSync(artifactRoot, { recursive: true });
        const appOut = path.join(artifactRoot, 'app', 'out');
        fs.mkdirSync(appOut, { recursive: true });
        fs.writeFileSync(path.join(appOut, 'index.html'), '<html></html>');
        const sealed = await createArtifactManifest(artifactRoot, 'current-live', new Set(), candidateDigest);
        artifactDigest = sealed.artifactDigest;
        pointer.artifactDigest = artifactDigest;
        fs.writeFileSync(path.join(artifactRoot, 'artifacts.json'), JSON.stringify(sealed));
        writeRelease({
            schemaVersion: 1, id: 'current-live', scope: { kind: 'bootstrap', articleIds: [] },
            baseLiveReleaseId: 'older-live', selectedRevision: 'a'.repeat(64), candidateDigest, artifactDigest,
            status: 'live', backupProof: null, publicCommitSha: pointer.publicCommitSha,
            workflowRunId: pointer.workflowRunId, workflowRunAttempt: pointer.workflowRunAttempt,
            retryFromAttempt: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }, snapshot);
        const jobsDirectory = path.join(root, 'workflow', 'jobs');
        fs.mkdirSync(jobsDirectory, { recursive: true });
        const backupInput = {
            reason: 'live-pointer', pointer,
            snapshotId: `pointer-${pointer.releaseId}-${pointer.workflowRunAttempt}`,
        };
        fs.writeFileSync(path.join(jobsDirectory, 'completed-pointer-backup.json'), JSON.stringify({
            id: 'completed-pointer-backup', type: 'backup', inputDigest: 'digest', input: backupInput,
            status: 'succeeded', attempt: 1, nextAttemptAt: new Date().toISOString(), claimedAt: null,
            remoteCommit: null, lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }));

        await recoverPersistedJobs();

        expect((await listJobs()).filter((job) => job.type === 'reconcile')).toEqual([]);
    });

    it('recovers a missing backup for the exact live pointer identity', async () => {
        createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1, siteId: 'site-1', articles: [], navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        let artifactDigest = '';
        const pointer: { schemaVersion: 1; releaseId: string; candidateDigest: string; artifactDigest: string; publicCommitSha: string; workflowRunId: number; workflowRunAttempt: number; verifiedAt: string } = {
            schemaVersion: 1, releaseId: 'pointer-gap-live', candidateDigest, artifactDigest,
            publicCommitSha: 'b'.repeat(40), workflowRunId: 14, workflowRunAttempt: 2, verifiedAt: new Date().toISOString(),
        };
        const artifactRoot = path.join(process.env.BLOG_DATA_ROOT as string, 'workflow', 'releases', pointer.releaseId, 'public-artifact');
        fs.mkdirSync(artifactRoot, { recursive: true });
        const appOut = path.join(artifactRoot, 'app', 'out');
        fs.mkdirSync(appOut, { recursive: true });
        fs.writeFileSync(path.join(appOut, 'index.html'), '<html></html>');
        const sealed = await createArtifactManifest(artifactRoot, pointer.releaseId, new Set(), candidateDigest);
        artifactDigest = sealed.artifactDigest;
        pointer.artifactDigest = artifactDigest;
        fs.writeFileSync(path.join(artifactRoot, 'artifacts.json'), JSON.stringify(sealed));
        writeLivePointer(pointer);
        writeRelease({
            schemaVersion: 1, id: pointer.releaseId, scope: { kind: 'bootstrap', articleIds: [] },
            baseLiveReleaseId: 'older-live', selectedRevision: 'a'.repeat(64), candidateDigest, artifactDigest,
            status: 'live', backupProof: null, publicCommitSha: pointer.publicCommitSha,
            workflowRunId: pointer.workflowRunId, workflowRunAttempt: pointer.workflowRunAttempt,
            retryFromAttempt: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }, snapshot);

        await recoverPersistedJobs();

        expect((await listJobs()).filter((job) => job.type === 'backup')).toEqual([
            expect.objectContaining({
                input: { reason: 'live-pointer', pointer, snapshotId: `pointer-${pointer.releaseId}-${pointer.workflowRunAttempt}` },
                status: 'pending',
            }),
        ]);
    });

    it('does not infer pointer backup identity from an unrelated snapshot or pointer', async () => {
        const root = createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1, siteId: 'site-1', articles: [], navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS }, media: [], redirects: [], removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        let artifactDigest = '';
        const pointer: { schemaVersion: 1; releaseId: string; candidateDigest: string; artifactDigest: string; publicCommitSha: string; workflowRunId: number; workflowRunAttempt: number; verifiedAt: string } = {
            schemaVersion: 1, releaseId: 'current-live', candidateDigest, artifactDigest,
            publicCommitSha: 'b'.repeat(40), workflowRunId: 13, workflowRunAttempt: 1, verifiedAt: new Date().toISOString(),
        };
        const artifactRoot = path.join(root, 'workflow', 'releases', 'current-live', 'public-artifact');
        fs.mkdirSync(artifactRoot, { recursive: true });
        const appOut = path.join(artifactRoot, 'app', 'out');
        fs.mkdirSync(appOut, { recursive: true });
        fs.writeFileSync(path.join(appOut, 'index.html'), '<html></html>');
        const sealed = await createArtifactManifest(artifactRoot, 'current-live', new Set(), candidateDigest);
        artifactDigest = sealed.artifactDigest;
        pointer.artifactDigest = artifactDigest;
        fs.writeFileSync(path.join(artifactRoot, 'artifacts.json'), JSON.stringify(sealed));
        writeRelease({
            schemaVersion: 1, id: 'current-live', scope: { kind: 'bootstrap', articleIds: [] },
            baseLiveReleaseId: 'older-live', selectedRevision: 'a'.repeat(64), candidateDigest, artifactDigest,
            status: 'live', backupProof: null, publicCommitSha: pointer.publicCommitSha,
            workflowRunId: pointer.workflowRunId, workflowRunAttempt: pointer.workflowRunAttempt,
            retryFromAttempt: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }, snapshot);
        const jobsDirectory = path.join(root, 'workflow', 'jobs');
        fs.mkdirSync(jobsDirectory, { recursive: true });
        fs.writeFileSync(path.join(jobsDirectory, 'wrong-pointer-backup.json'), JSON.stringify({
            id: 'wrong-pointer-backup', type: 'backup', inputDigest: 'digest',
            input: { reason: 'live-pointer', pointer: { ...pointer, releaseId: 'other-release' }, snapshotId: 'wrong-snapshot' },
            status: 'succeeded', attempt: 1, nextAttemptAt: new Date().toISOString(), claimedAt: null,
            remoteCommit: null, lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }));

        writeLivePointer(pointer);
        await recoverPersistedJobs();

        expect((await listJobs()).filter((job) => job.type === 'backup')).toHaveLength(2);
        expect((await listJobs()).find((job) => job.id === 'wrong-pointer-backup')?.status).toBe('succeeded');
        expect((await listJobs()).some((job) => job.type === 'backup'
            && (job.input as Record<string, unknown>).snapshotId === `pointer-${pointer.releaseId}-${pointer.workflowRunAttempt}`)).toBe(true);
        expect((await listJobs()).filter((job) => job.type === 'reconcile')).toEqual([]);
    });

    it('recreates a missing candidate build job after proof persistence is recovered', async () => {
        createDataRoot();
        const snapshot: SiteSnapshot = {
            schemaVersion: 1,
            siteId: 'site-1',
            articles: [],
            navigation: [],
            settings: { ...DEFAULT_SITE_SETTINGS },
            media: [],
            redirects: [],
            removedPaths: [],
        };
        const candidateDigest = computeCandidateDigest(snapshot);
        const release = {
            schemaVersion: 1 as const,
            id: 'release-1',
            scope: { kind: 'bootstrap' as const, articleIds: [] },
            baseLiveReleaseId: null,
            selectedRevision: 'a'.repeat(64),
            candidateDigest,
            artifactDigest: null,
            status: 'building' as const,
            backupProof: {
                repository: 'owner/private-backup',
                commitSha: 'b'.repeat(40),
                snapshotId: 'candidate-proof',
                contentDigest: 'c'.repeat(64),
                candidateDigest,
                verifiedAt: '2026-09-30T04:00:00.000Z',
            },
            publicCommitSha: null,
            workflowRunId: null,
            workflowRunAttempt: null,
            retryFromAttempt: null,
            error: null,
            createdAt: '2026-09-30T00:00:00.000Z',
            updatedAt: '2026-09-30T04:00:00.000Z',
        };
        writeRelease(release, snapshot);
        const proofDirectory = path.join(process.env.BLOG_DATA_ROOT as string, 'workflow', 'backup-proofs');
        fs.mkdirSync(proofDirectory, { recursive: true });
        fs.writeFileSync(path.join(proofDirectory, 'candidate-proof.json'), JSON.stringify(release.backupProof));

        await recoverPersistedJobs();
        await recoverPersistedJobs();

        expect((await listJobs()).filter((job) => job.type === 'build')).toEqual([
            expect.objectContaining({
                id: 'build-release-1',
                input: { releaseId: 'release-1', candidateDigest },
                status: 'pending',
            }),
        ]);
    });

    it('requires a full backup through unrelated newer content before passing the gate', async () => {
        createDataRoot();
        await writeArticlesToDisk([]);
        const candidateSnapshot = await readBackupWatermark();
        await writeSiteSettingsToDisk(DEFAULT_SITE_SETTINGS);

        const afterCandidateBackup = await recordVerifiedFullBackup({
            generation: candidateSnapshot.generation,
            contentSequence: candidateSnapshot.contentSequence,
            remoteCommit: 'candidate-only',
        });
        expect(isBackupCaughtUp(afterCandidateBackup)).toBe(false);

        const caughtUp = await recordVerifiedFullBackup({
            generation: afterCandidateBackup.generation,
            contentSequence: afterCandidateBackup.contentSequence,
            remoteCommit: 'full-backup',
        });
        expect(isBackupCaughtUp(caughtUp)).toBe(true);
    });

    it('keeps other jobs claimable when one persisted job file is corrupt and leaves it untouched', async () => {
        const root = createDataRoot();
        const job = await createJob({ type: 'backup', input: { revision: 'r1' } });
        const corruptPath = path.join(root, 'workflow', 'jobs', 'corrupt-history.json');
        const corruptBytes = '{ definitely-not-a-job';
        fs.writeFileSync(corruptPath, corruptBytes, 'utf8');

        expect((await listJobs()).map((record) => record.id)).toEqual([job.id]);

        const claimed = await claimNextJob();

        expect(claimed?.id).toBe(job.id);
        expect(fs.readFileSync(corruptPath, 'utf8')).toBe(corruptBytes);
    });

    it('recovers persisted jobs when the backup watermark is corrupt without rewriting it', async () => {
        const root = createDataRoot();
        const record = {
            id: 'recoverable-despite-watermark',
            type: 'backup',
            inputDigest: 'digest',
            input: { revision: 'r1' },
            status: 'pending',
            attempt: 0,
            nextAttemptAt: new Date(0).toISOString(),
            claimedAt: null,
            remoteCommit: null,
            lastError: null,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
        };
        const jobsDirectory = path.join(root, 'workflow', 'jobs');
        fs.mkdirSync(jobsDirectory, { recursive: true });
        fs.writeFileSync(path.join(jobsDirectory, `${record.id}.json`), JSON.stringify(record));
        const watermarkPath = path.join(root, 'workflow', 'backup-state.json');
        const corruptWatermark = '{ "contentSequence": "broken"';
        fs.writeFileSync(watermarkPath, corruptWatermark, 'utf8');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const recovered = await recoverPersistedJobs();

        expect(recovered.map((job) => job.id)).toContain(record.id);
        expect(fs.readFileSync(watermarkPath, 'utf8')).toBe(corruptWatermark);
        expect(consoleError).toHaveBeenCalledWith(
            '[jobs-store] Invalid persisted state files detected; the worker keeps polling and leaves them untouched for repair:',
            'workflow/backup-state.json'
        );
    });

    it('caps exponential retry delay and stops after the attempt limit with an error', async () => {
        createDataRoot();
        await createJob({ type: 'backup', input: { revision: 'r1' } });
        let now = new Date();
        const delays: number[] = [];
        let failedJob = null;

        for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt += 1) {
            const claimed = await claimNextJob({ now });
            expect(claimed).not.toBeNull();
            if (!claimed) {
                throw new Error('Expected a retryable job to be claimed.');
            }
            failedJob = await failClaimedJob(claimed.id, new Error('remote unavailable'), { now });
            if (failedJob.status === 'retry') {
                const delay = Date.parse(failedJob.nextAttemptAt as string) - now.getTime();
                delays.push(delay);
                now = new Date(Date.parse(failedJob.nextAttemptAt as string) + 1);
            }
        }

        expect(retryDelayMs(MAX_JOB_ATTEMPTS)).toBe(MAX_RETRY_DELAY_MS);
        expect(delays.some((delay) => delay === MAX_RETRY_DELAY_MS)).toBe(true);
        expect(delays[0]).toBe(BASE_RETRY_DELAY_MS);
        expect(failedJob).toMatchObject({
            status: 'failed',
            attempt: MAX_JOB_ATTEMPTS,
            lastError: 'remote unavailable',
        });
    });

    it('keeps deferred verification claimable beyond the network attempt limit', async () => {
        createDataRoot();
        const created = await createJob({ type: 'backup', input: { revision: 'r1' } });
        let now = new Date(created.createdAt);
        let job = null;

        for (let wait = 0; wait < MAX_JOB_ATTEMPTS + 2; wait += 1) {
            const claimed = await claimNextJob({ now });
            expect(claimed).not.toBeNull();
            if (!claimed) throw new Error('Expected deferred verification to remain claimable.');
            job = await deferClaimedJob(claimed.id, 'waiting for verification', { claimToken: claimed.claimToken, now });
            now = new Date(Date.parse(job.nextAttemptAt) + 1);
        }

        expect(job).toMatchObject({ status: 'retry', attempt: 0, lastError: 'waiting for verification' });
        expect(await claimNextJob({ now })).not.toBeNull();
    });

    it('queues a backup job and advances the dirty sequence for a media manifest change', async () => {
        createDataRoot();
        const before = await readBackupWatermark();

        await storeEditorMediaFile({ bytes: PNG_BYTES, now: new Date('2026-06-17T08:00:00.000Z') });

        const after = await readBackupWatermark();
        const backupJobs = (await listJobs()).filter((job) => job.type === 'backup');
        expect(after.contentSequence).toBe(before.contentSequence + 1);
        expect(isBackupCaughtUp(after)).toBe(false);
        expect(backupJobs).toHaveLength(1);
        expect(backupJobs[0].inputDigest).toMatch(/^[a-f0-9]{64}$/);
    });
});
