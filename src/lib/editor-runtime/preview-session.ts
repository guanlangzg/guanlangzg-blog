import fs from 'node:fs';
import path from 'node:path';
import { getRuntimeDataRootPath } from '@/lib/runtime-config';
import { writeJsonAtomically } from '@/lib/atomic-json-writer';

const SAFE_RELEASE_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface PreviewSessionState {
  schemaVersion: 1;
  activeReleaseId: string;
  activatedAt: string;
}

function stateFilePath(): string {
  return path.join(getRuntimeDataRootPath(), 'workflow', 'preview-session.json');
}

/**
 * The activated preview release is session state, not artifact content, so it lives
 * beside the workflow data instead of inside the sealed release directory.
 */
export function readActivePreviewReleaseId(): string | null {
  const filePath = stateFilePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<PreviewSessionState>;
    if (value.schemaVersion !== 1 || typeof value.activeReleaseId !== 'string') return null;
    return SAFE_RELEASE_ID.test(value.activeReleaseId) ? value.activeReleaseId : null;
  } catch {
    return null;
  }
}

export function activatePreviewRelease(releaseId: string): void {
  if (!SAFE_RELEASE_ID.test(releaseId)) throw new Error('Invalid release ID.');
  const state: PreviewSessionState = {
    schemaVersion: 1,
    activeReleaseId: releaseId,
    activatedAt: new Date().toISOString(),
  };
  const filePath = stateFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeJsonAtomically(filePath, state, { mode: 0o600 });
}
