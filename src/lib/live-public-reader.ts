import { readLivePointer, readRelease } from '@/lib/publishing/store';
import { computeCandidateDigest } from '@/lib/publishing/snapshot';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '@/lib/site-settings';
import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import type { LivePointer, SiteSnapshot } from '@/lib/publishing/types';

export interface VerifiedLiveSnapshot {
    pointer: LivePointer;
    snapshot: SiteSnapshot;
}

export interface PublicLiveSnapshot {
    releaseId: string | null;
    articles: Article[];
    navigation: Category[];
    settings: SiteSettings;
    media: SiteSnapshot['media'];
}

export function toPublicLiveSnapshot(snapshot: SiteSnapshot, releaseId: string): PublicLiveSnapshot {
    return {
        releaseId,
        articles: structuredClone(snapshot.articles),
        navigation: structuredClone(snapshot.navigation),
        settings: structuredClone(snapshot.settings),
        media: structuredClone(snapshot.media),
    };
}

/**
 * Next renders the metadata, the layout and the page body as separate calls, so a pointer write
 * between them would otherwise mix two releases inside one response. The reader therefore reuses
 * the snapshot it verified for a window that covers a single request and re-reads (and re-verifies)
 * after that. The window is short on purpose: a finished publish, and equally a pointer that just
 * became invalid, stay masked for at most that time, while a response can never mix two releases.
 * The media route and the media GC deliberately keep using the raw, always-fresh read.
 */
const VERIFIED_SNAPSHOT_REUSE_MS = 2_000;

let reusedVerifiedSnapshot: {
    dataRoot: string;
    readAt: number;
    value: VerifiedLiveSnapshot | null;
} | null = null;

function readVerifiedLiveSnapshotForRequest(): VerifiedLiveSnapshot | null {
    const dataRoot = getRuntimeDataRootPath();
    const now = Date.now();
    const reusable = reusedVerifiedSnapshot;

    if (reusable && reusable.dataRoot === dataRoot && now - reusable.readAt < VERIFIED_SNAPSHOT_REUSE_MS) {
        return reusable.value;
    }

    const value = readVerifiedLiveSnapshot();
    reusedVerifiedSnapshot = { dataRoot, readAt: now, value };
    return value;
}

export function resetLivePublicSnapshotCacheForTests(): void {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('resetLivePublicSnapshotCacheForTests must not be called in production.');
    }

    reusedVerifiedSnapshot = null;
}

export function getPublicLiveSnapshot(): PublicLiveSnapshot {
    const live = readVerifiedLiveSnapshotForRequest();
    return live
        ? toPublicLiveSnapshot(live.snapshot, live.pointer.releaseId)
        : { releaseId: null, articles: [], navigation: [], settings: { ...DEFAULT_SITE_SETTINGS }, media: [] };
}

export function readVerifiedLiveSnapshot(): VerifiedLiveSnapshot | null {
    const pointer = readLivePointer();
    if (!pointer) return null;

    const stored = readRelease(pointer.releaseId);
    if (stored.release.status !== 'live'
        || stored.release.candidateDigest !== pointer.candidateDigest
        || stored.release.artifactDigest !== pointer.artifactDigest
        || computeCandidateDigest(stored.snapshot) !== pointer.candidateDigest) {
        throw new Error('Live pointer does not match its frozen published release.');
    }

    return { pointer, snapshot: stored.snapshot };
}

export function isLiveReaderRuntime(): boolean {
    return process.env.BLOG_NAVIGATION_DOCKER === 'true';
}
