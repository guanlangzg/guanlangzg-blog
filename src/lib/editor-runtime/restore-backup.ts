import type { Article } from '@/app/types/article';
import type { Category } from '@/app/types/navigation';
import { parseEditorMediaManifest, type EditorMediaAsset } from '@/lib/editor-media-storage';
import { parseSiteSettingsOrThrow, type SiteSettings } from '@/lib/site-settings';
import { sha256Hex } from '@/lib/stable-json';
import type { NavigationIdentityMap } from '@/lib/navigation-identities';
import {
  UnsupportedBackupSchemaError,
  parseBackupSnapshotManifest,
  decodeBackupArticle,
  verifyBackupManifestFiles,
} from '@/lib/github/backup-decode';
import { createConfiguredGitHubBackupClient } from '@/lib/github/backup-service';
import type { RestorableEditorData } from '@/lib/restoring/plan';

const ARTICLE_METADATA_PATTERN = /^articles\/([a-f0-9]{64})\/metadata\.json$/;
const MEDIA_OBJECT_PATTERN = /^media\/objects\/([a-f0-9]{64})\.([a-z0-9]{1,10})$/;

export class RestoreBackupDecodeError extends Error {
  constructor(message: string, public readonly code: 'UNSUPPORTED_SCHEMA' | 'INVALID_BACKUP') {
    super(message);
    this.name = 'RestoreBackupDecodeError';
  }
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
}

function toBytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== 'string') throw new RestoreBackupDecodeError(`${label} is not a blob`, 'INVALID_BACKUP');
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function readJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new RestoreBackupDecodeError(`${label} is not valid JSON`, 'INVALID_BACKUP');
  }
}

/**
 * Rebuilds the current editor data from a private backup commit.
 *
 * The decode mirrors what `src/lib/github/backup.ts` writes; unknown fields and future schema
 * versions are rejected before any normalization so a newer backup is never silently truncated
 * into an older shape.
 */
export async function decodeBackupCommit(commit: string): Promise<{ data: RestorableEditorData; commit: string }> {
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new RestoreBackupDecodeError('Backup commit is invalid', 'INVALID_BACKUP');

  const client = await createConfiguredGitHubBackupClient();
  const commitValue = await client.getCommit('backup', commit) as { tree?: { sha?: unknown } };
  const treeSha = commitValue.tree?.sha;
  if (typeof treeSha !== 'string') throw new RestoreBackupDecodeError('Backup commit tree is unavailable', 'INVALID_BACKUP');

  const treeValue = await client.getTree('backup', treeSha, true) as { tree?: unknown };
  if (!Array.isArray(treeValue.tree)) throw new RestoreBackupDecodeError('Backup tree is unavailable', 'INVALID_BACKUP');
  const entries = new Map<string, TreeEntry>();
  for (const raw of treeValue.tree) {
    const entry = raw as Record<string, unknown>;
    if (typeof entry.path !== 'string' || typeof entry.sha !== 'string' || typeof entry.type !== 'string') continue;
    if (entry.type === 'blob') entries.set(entry.path, { path: entry.path, type: entry.type, sha: entry.sha });
  }

  const readBlob = async (filePath: string): Promise<Uint8Array> => {
    const entry = entries.get(filePath);
    if (!entry) throw new RestoreBackupDecodeError(`Backup is missing ${filePath}`, 'INVALID_BACKUP');
    const blob = await client.getBlob('backup', entry.sha) as { content?: unknown; encoding?: unknown };
    const bytes = toBytes(blob.content, filePath);
    // GitHub returns base64 for every blob; a non-base64 encoding would decode to garbage.
    if (blob.encoding !== undefined && blob.encoding !== 'base64') {
      throw new RestoreBackupDecodeError(`${filePath} uses an unsupported blob encoding`, 'INVALID_BACKUP');
    }
    return bytes;
  };

  const snapshotBytes = await readBlob('snapshot.json');
  const snapshot = readJson(snapshotBytes, 'snapshot.json');
  let snapshotManifest;
  try {
    snapshotManifest = parseBackupSnapshotManifest(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup snapshot manifest is invalid.';
    if (error instanceof UnsupportedBackupSchemaError) {
      throw new RestoreBackupDecodeError(message, 'UNSUPPORTED_SCHEMA');
    }
    throw new RestoreBackupDecodeError(message, 'INVALID_BACKUP');
  }

  const manifestBlobs = new Map<string, Uint8Array>();
  for (const filePath of Object.keys(snapshotManifest.files)) {
    manifestBlobs.set(filePath, await readBlob(filePath));
  }
  try {
    verifyBackupManifestFiles(snapshotManifest, manifestBlobs);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup manifest integrity check failed.';
    throw new RestoreBackupDecodeError(message, 'INVALID_BACKUP');
  }

  const declaredFiles = snapshotManifest.files;
  const readDeclaredBlob = async (filePath: string): Promise<Uint8Array> => {
    const bytes = manifestBlobs.get(filePath);
    if (!bytes) throw new RestoreBackupDecodeError(`Backup manifest does not declare ${filePath}`, 'INVALID_BACKUP');
    return bytes;
  };

  // Articles: metadata and content stay in separate blobs so the original Markdown bytes survive.
  const articles: Article[] = [];
  for (const filePath of Object.keys(declaredFiles)) {
    const match = ARTICLE_METADATA_PATTERN.exec(filePath);
    if (!match) continue;
    const directory = match[1];
    const contentPath = `articles/${directory}/content.md`;
    const metadata = await readDeclaredBlob(filePath);
    const content = await readDeclaredBlob(contentPath);
    articles.push(decodeBackupArticle(metadata, content));
  }

  const navigationValue = readJson(await readDeclaredBlob('navigation/tools.json'), 'navigation/tools.json');
  if (!Array.isArray(navigationValue)) throw new RestoreBackupDecodeError('navigation/tools.json is not an array', 'INVALID_BACKUP');
  const navigation = navigationValue as Category[];

  const identitiesValue = readJson(await readDeclaredBlob('navigation/identities.json'), 'navigation/identities.json');
  const navigationIdentities = identitiesValue as NavigationIdentityMap | null;

  const settingsValue = readJson(await readDeclaredBlob('settings/site.json'), 'settings/site.json');
  let settings: SiteSettings;
  try {
    settings = parseSiteSettingsOrThrow(settingsValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'settings/site.json is invalid';
    throw new RestoreBackupDecodeError(message, 'INVALID_BACKUP');
  }

  const manifestValue = readJson(await readDeclaredBlob('media/manifest.json'), 'media/manifest.json');
  const manifest = parseEditorMediaManifest(manifestValue);
  if (!manifest) throw new RestoreBackupDecodeError('media/manifest.json is invalid', 'INVALID_BACKUP');

  // Media bytes are content-addressed: look them up by hash rather than trusting a stored path.
  const objectsByDigest = new Map<string, string>();
  for (const filePath of Object.keys(declaredFiles)) {
    const match = MEDIA_OBJECT_PATTERN.exec(filePath);
    if (match) objectsByDigest.set(match[1], filePath);
  }

  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const asset of manifest.assets as EditorMediaAsset[]) {
    const objectPath = objectsByDigest.get(asset.hash);
    if (!objectPath) {
      throw new RestoreBackupDecodeError(`Managed media object is missing for ${asset.path}`, 'INVALID_BACKUP');
    }
    const bytes = await readDeclaredBlob(objectPath);
    if (sha256Hex(bytes) !== asset.hash || bytes.byteLength !== asset.size) {
      throw new RestoreBackupDecodeError(`Managed media bytes do not match the media manifest for ${asset.path}`, 'INVALID_BACKUP');
    }
    files.push({ path: asset.path, bytes });
  }

  return {
    commit,
    data: {
      articles,
      navigation,
      settings,
      navigationIdentities,
      media: { manifest, files },
    },
  };
}
