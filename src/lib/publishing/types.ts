import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import type { SiteSettings } from '@/lib/site-settings';

export type PublishScope =
  | { kind: 'article'; articleId: string; action: 'publish' | 'withdraw' }
  | { kind: 'navigation' }
  | { kind: 'settings' }
  | { kind: 'bootstrap'; articleIds: string[] };

export interface MediaRef {
  originalPath: string;
  publicPath: string;
  sha256: string;
  size: number;
  mimeType: string;
}

export interface SiteSnapshot {
  schemaVersion: 1;
  siteId: string;
  articles: Article[];
  navigation: Category[];
  settings: SiteSettings;
  media: MediaRef[];
  redirects: Array<{ from: string; to: string }>;
  removedPaths: string[];
}

export type ReleaseStatus =
  | 'awaiting_backup'
  | 'building'
  | 'preview_ready'
  | 'publishing'
  | 'deploying'
  | 'verifying'
  | 'live'
  | 'failed'
  | 'stale'
  | 'cancelled';

export interface BackupProof {
  repository: string;
  commitSha: string;
  snapshotId: string;
  contentDigest: string;
  candidateDigest: string;
  verifiedAt: string;
}

export interface ReleaseRecord {
  schemaVersion: 1;
  id: string;
  scope: PublishScope;
  baseLiveReleaseId: string | null;
  selectedRevision: string;
  candidateDigest: string;
  artifactDigest: string | null;
  status: ReleaseStatus;
  backupProof: BackupProof | null;
  publicCommitSha: string | null;
  workflowRunId: number | null;
  workflowRunAttempt: number | null;
  retryFromAttempt: number | null;
  error: { code: string; message: string; retryable: boolean } | null;
  createdAt: string;
  updatedAt: string;
}

export interface LivePointer {
  schemaVersion: 1;
  releaseId: string;
  candidateDigest: string;
  artifactDigest: string;
  publicCommitSha: string;
  workflowRunId: number;
  workflowRunAttempt: number;
  verifiedAt: string;
}
