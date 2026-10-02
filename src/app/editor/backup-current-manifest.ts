type CurrentBackupResponse = {
  manifest?: unknown;
  mediaHash?: unknown;
  message?: string;
};

export async function loadCurrentBackupManifest(): Promise<unknown> {
  const response = await fetch('/api/data/backup/current-manifest', {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => null)) as CurrentBackupResponse | null;

  if (!response.ok || !payload?.manifest) {
    throw new Error(payload?.message || '当前数据状态读取失败。');
  }

  if (payload.mediaHash === undefined) {
    return payload.manifest;
  }

  return {
    manifest: payload.manifest,
    mediaHash: payload.mediaHash,
  };
}
