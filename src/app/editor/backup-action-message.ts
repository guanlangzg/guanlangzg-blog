type RemoteBackupResult = {
  success?: boolean;
  message?: string;
};

type RestoreActionPayload = {
  remoteBackup?: RemoteBackupResult;
};

export type BackupActionMessage = {
  tone: 'success' | 'warning';
  text: string;
};

export function createRestoreActionMessage(
  payload: RestoreActionPayload | null,
  successText: string
): BackupActionMessage {
  if (payload?.remoteBackup?.success === false) {
    const detail = payload.remoteBackup.message ? `：${payload.remoteBackup.message}` : '';

    return {
      tone: 'warning',
      text: `恢复成功，但云端快照同步失败${detail}`,
    };
  }

  return {
    tone: 'success',
    text: successText,
  };
}
