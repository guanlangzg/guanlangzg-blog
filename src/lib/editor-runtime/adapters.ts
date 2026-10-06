import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import type { EditorMediaAsset, EditorMediaManifest } from '@/lib/editor-media-storage';
import { readEditorMediaFile, readEditorMediaManifest } from '@/lib/editor-media-storage';
import {
    getEditorDataResourceManifest,
    readArticlesFromDisk,
    readNavigationFromDisk,
    readSiteSettingsFromDisk,
} from '@/lib/editor-data-storage';
import { readNavigationIdentities } from '@/lib/publishing/store';
import { createNavigationIdentityMap } from '@/lib/navigation-identities';
import { readBackupWatermarkUnderLock } from '@/lib/jobs/watermark';
import { readLivePointer, readRelease, writeLivePointer, writeRelease } from '@/lib/publishing/store';
import { createPublishingService, type PublishingInputs } from '@/lib/publishing/service';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import { createJsonRevision } from '@/lib/json-revision';
import { createJobUnderLock, createOrReuseActiveJobUnderLock, listJobsUnderLock, type JobRecord } from '@/lib/jobs/store';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { withRuntimeDataRootLock } from '@/lib/runtime-data-lock';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '@/lib/site-settings';
import type { BackupProof, MediaRef, PublishScope, ReleaseRecord, SiteSnapshot } from '@/lib/publishing/types';

const SAFE_RELEASE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Managed media becomes part of the frozen snapshot by content hash, so a byte change
 * in a referenced image invalidates the candidate even when the Markdown text is unchanged.
 */
function readSnapshotMedia(): MediaRef[] {
    const manifest: EditorMediaManifest = readEditorMediaManifest();
    return manifest.assets.map((asset: EditorMediaAsset): MediaRef => ({
        originalPath: asset.path,
        publicPath: asset.publicPath,
        sha256: asset.hash,
        size: asset.size,
        mimeType: asset.mimeType,
    }));
}

export function readDraftSnapshot(): SiteSnapshot {
    const articles: Article[] = readArticlesFromDisk();
    const navigation: Category[] = readNavigationFromDisk();
    const settings: SiteSettings = readSiteSettingsFromDisk();
    const workflowFormat = readWorkflowFormat();

    return {
        schemaVersion: 1,
        siteId: workflowFormat.siteId,
        articles,
        navigation,
        settings,
        media: readSnapshotMedia(),
        redirects: [],
        removedPaths: [],
    };
}

/** First release has no live snapshot yet: the public site starts empty, not with drafts. */
export function readBaseSnapshot(): SiteSnapshot {
  const live = readLivePointer();
  if (live) return readRelease(live.releaseId).snapshot;
  return {
    schemaVersion: 1,
    siteId: readWorkflowFormat().siteId,
    articles: [],
    navigation: [],
    settings: { ...DEFAULT_SITE_SETTINGS },
    media: [],
    redirects: [],
    removedPaths: [],
  };
}



function readWorkflowFormat(): { schemaVersion: 1; siteId: string } {
    const filePath = path.join(getRuntimeDataRootPath(), 'workflow', 'format.json');
    if (!fs.existsSync(filePath)) {
        const created = { schemaVersion: 1 as const, siteId: randomUUID() };
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(filePath, JSON.stringify(created, null, 2), { encoding: 'utf8', mode: 0o600 });
        return created;
    }
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { schemaVersion?: unknown; siteId?: unknown };
    if (value.schemaVersion !== 1 || typeof value.siteId !== 'string' || !value.siteId.trim()) {
        throw new Error('Workflow format is invalid or unsupported.');
    }
    return { schemaVersion: 1, siteId: value.siteId };
}

/**
 * §5.2: selectedInputs is the scope-specific projection that must invalidate a candidate
 * when it changes. Media is supplied separately by the candidate snapshot itself.
 */
function readSelectedInputs(
    scope: PublishScope,
    draft: SiteSnapshot
): unknown {
    if (scope.kind === 'article') {
        const article = draft.articles.find((item) => item.id === scope.articleId) ?? null;
        if (scope.action === 'withdraw') {
            const base = readBaseSnapshot();
            return {
                articleId: scope.articleId,
                baseLiveReleaseId: readLivePointer()?.releaseId ?? null,
                publishedArticle: base.articles.find((item) => item.id === scope.articleId) ?? null,
            };
        }
        return { scope, article };
    }

    if (scope.kind === 'navigation') {
        return {
            navigation: draft.navigation,
            identities: readNavigationIdentities() ?? createNavigationIdentityMap(draft.navigation),
        };
    }

    if (scope.kind === 'settings') {
        return { settings: draft.settings };
    }

    const requested = new Set(scope.articleIds);
    return {
        articles: draft.articles
            .filter((article) => requested.has(article.id))
            .sort((left, right) => left.id.localeCompare(right.id)),
        navigation: draft.navigation,
        identities: readNavigationIdentities() ?? createNavigationIdentityMap(draft.navigation),
        settings: draft.settings,
    };
}

/** Local managed media must still hash to the value frozen into the candidate. */
export function verifyMediaHashes(snapshot: SiteSnapshot): boolean {
    const manifest = readEditorMediaManifest();
    const byPath = new Map(manifest.assets.map((asset) => [asset.path, asset]));
    for (const ref of snapshot.media) {
        const asset = byPath.get(ref.originalPath);
        if (!asset || asset.hash !== ref.sha256 || asset.size !== ref.size) return false;
    }
    return true;
}

function releaseDirectoryPath(releaseId: string): string {
    if (!SAFE_RELEASE_ID.test(releaseId)) throw new Error('Invalid release ID.');
    return path.join(getRuntimeDataRootPath(), 'workflow', 'releases', releaseId);
}

/** New artifact writes land in a sibling directory so app and manifest commit together. */
export function releaseArtifactsRoot(releaseId: string): string {
    return path.join(releaseDirectoryPath(releaseId), 'public-artifact');
}

/** Reads the new sealed tree first and falls back to the pre-S2 layout for existing releases. */
export function findSealedArtifactRoot(releaseId: string): string | null {
    const currentRoot = releaseArtifactsRoot(releaseId);
    if (fs.existsSync(currentRoot)) return currentRoot;

    const legacyRoot = releaseDirectoryPath(releaseId);
    if (fs.existsSync(path.join(legacyRoot, 'artifacts.json')) || fs.existsSync(path.join(legacyRoot, 'app'))) {
        return legacyRoot;
    }
    return null;
}

export function readSealedArtifactIdentity(releaseId: string): { releaseId: string; candidateDigest: string; artifactDigest: string } | null {
    const sealedRoot = findSealedArtifactRoot(releaseId);
    if (!sealedRoot) return null;
    const manifestPath = path.join(sealedRoot, 'artifacts.json');
    if (!fs.existsSync(manifestPath)) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    if (manifest.version !== 1 || typeof manifest.artifactDigest !== 'string' || typeof manifest.candidateDigest !== 'string') {
        return null;
    }
    return { releaseId, candidateDigest: manifest.candidateDigest, artifactDigest: manifest.artifactDigest };
}

/** A proof only qualifies when it points at a content hash the private repo actually stored. */
export function verifyBackupProof(proof: BackupProof | null, release: ReleaseRecord): boolean {
    if (!proof) return false;
    const proofPath = path.join(getRuntimeDataRootPath(), 'workflow', 'backup-proofs', `${proof.snapshotId}.json`);
    if (!fs.existsSync(proofPath)) return false;
    const stored = JSON.parse(fs.readFileSync(proofPath, 'utf8')) as BackupProof;
    return stored.commitSha === proof.commitSha
        && stored.snapshotId === proof.snapshotId
        && stored.contentDigest === proof.contentDigest
        && stored.candidateDigest === release.candidateDigest;
}

function publishingTaskStatus(job: JobRecord): 'pending' | 'running' | 'succeeded' | 'failed' {
    if (job.status === 'succeeded') return 'succeeded';
    if (job.status === 'failed') return 'failed';
    if (job.status === 'running') return 'running';
    return 'pending';
}

function findPublishingJobUnderLock(releaseId: string): JobRecord | null {
    return listJobsUnderLock(getRuntimeDataRootPath()).find((job) => {
        if (job.type !== 'publish') return false;
        const input = job.input as { releaseId?: unknown } | null;
        return input?.releaseId === releaseId;
    }) ?? null;
}

export interface DraftResourceRevisions {
    article: string;
    navigation: string;
    settings: string;
    bootstrap: string;
}

/**
 * Single source of truth for the scope revisions compared against the UI's
 * expectedRevision. The revision endpoint and the publishing service lock must
 * compute identical values or every candidate creation fails with RELEASE_CONFLICT.
 */
export function readDraftResourceRevisions(snapshot: SiteSnapshot): DraftResourceRevisions {
    const articles = getEditorDataResourceManifest('articles', snapshot.articles)?.revision ?? '';
    const navigation = getEditorDataResourceManifest('navigation', snapshot.navigation)?.revision ?? '';
    const settings = getEditorDataResourceManifest('settings', snapshot.settings)?.revision ?? '';
    return {
        article: articles,
        navigation,
        settings,
        bootstrap: createJsonRevision({ articles, navigation, settings }),
    };
}

export function createEditorPublishingService() {
    return createPublishingService({
        withContentLock: (operation) => withRuntimeDataRootLock(() => {
            const draft = readDraftSnapshot();
            const base = readBaseSnapshot();
            const watermark = readBackupWatermarkUnderLock(getRuntimeDataRootPath());
            const resourceRevisions = readDraftResourceRevisions(draft);
            return operation({
                readInputs: (scope: PublishScope): PublishingInputs => {
                    const resourceRevision = scope.kind === 'article'
                        ? resourceRevisions.article
                        : scope.kind === 'navigation'
                            ? resourceRevisions.navigation
                            : scope.kind === 'settings'
                                ? resourceRevisions.settings
                                : resourceRevisions.bootstrap;
                    return {
                        baseSnapshot: structuredClone(base),
                        draftSnapshot: structuredClone(draft),
                        generation: watermark.generation,
                        revision: resourceRevision,
                        selectedInputs: readSelectedInputs(scope, draft),
                    };
                },
                readLivePointer,
                readRelease,
                listReleases: () => listEditorReleases(),
                readWatermark: () => watermark,
                writeRelease: (release: ReleaseRecord, snapshot: SiteSnapshot) => {
                    writeRelease(release, snapshot);
                    if (release.status === 'live') {
                        writeLivePointer({
                            schemaVersion: 1,
                            releaseId: release.id,
                            candidateDigest: release.candidateDigest,
                            artifactDigest: release.artifactDigest ?? '',
                            publicCommitSha: release.publicCommitSha ?? '',
                            workflowRunId: release.workflowRunId ?? 0,
                            workflowRunAttempt: release.workflowRunAttempt ?? 0,
                            verifiedAt: release.updatedAt,
                        });
                    }
                },
                persistCandidateJobs: (release, snapshot) => {
                    const candidateDigest = computeCandidateDigest(snapshot);
                    createJobUnderLock(getRuntimeDataRootPath(), {
                        type: 'backup',
                        id: `backup-candidate-${release.id}`,
                        input: { candidateReleaseId: release.id, candidateDigest, reason: 'candidate-build', snapshotId: `candidate-${release.id}` },
                    });
                },
                persistPublishTask: (release, snapshot) => {
                    const authorizedDigest = computeCandidateDigest(snapshot);
                    const job = createOrReuseActiveJobUnderLock(getRuntimeDataRootPath(), {
                        type: 'publish',
                        id: `publish-${release.id}`,
                        input: { releaseId: release.id, candidateDigest: authorizedDigest, artifactDigest: release.artifactDigest },
                    });
                    return { id: job.id, releaseId: release.id, status: publishingTaskStatus(job) };
                },
                findPublishTask: (releaseId: string) => {
                    const job = findPublishingJobUnderLock(releaseId);
                    return job ? { id: job.id, releaseId, status: publishingTaskStatus(job) } : null;
                },
            });
        }),
        verifyMediaHashes,
        verifyArtifactIdentity: (release) => readSealedArtifactIdentity(release.id),
        isBackupProofValid: verifyBackupProof,
    });
}

export function listEditorReleases(): ReleaseRecord[] {
    const releasesRoot = path.join(getRuntimeDataRootPath(), 'workflow', 'releases');
    if (!fs.existsSync(releasesRoot)) return [];
    return fs.readdirSync(releasesRoot)
        .filter((name) => SAFE_RELEASE_ID.test(name))
        .flatMap((name) => {
            try {
                return [readRelease(name).release];
            } catch {
                return [];
            }
        });
}


export function listRecordedBackupProofs(): BackupProof[] {
    const directory = path.join(getRuntimeDataRootPath(), 'workflow', 'backup-proofs');
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .flatMap((name) => {
            try {
                const proof = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as BackupProof;
                return typeof proof.snapshotId === 'string' ? [proof] : [];
            } catch {
                return [];
            }
        })
        .sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt));
}

export { readEditorMediaFile };
