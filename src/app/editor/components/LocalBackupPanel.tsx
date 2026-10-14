'use client';

import { useCallback, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { StatusMessage } from '@/app/components/ui';
import { loadCurrentBackupManifest } from '../backup-current-manifest';
import { createEditorCsrfHeaders } from '../editor-csrf';
import { EditorButton, EditorPanel } from './EditorShell';

type BackupPayload = {
  version?: number;
  exportedAt?: string;
  articles?: unknown;
  navigation?: unknown;
  message?: string;
};

type BackupActionResponse = {
  message?: string;
};

function createBackupFileName(exportedAt?: string): string {
  const timestamp = exportedAt
    ? exportedAt.replace(/[:]/g, '-').replace(/\..+$/, '')
    : new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');

  return `blog-navigation-backup-${timestamp}.json`;
}

export function LocalBackupPanel() {
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'warning' | 'danger' | 'loading'; text: string } | null>(null);

  const handleBackup = useCallback(async () => {
    setIsBusy(true);
    setMessage({ tone: 'loading', text: '正在生成备份文件...' });

    try {
      const response = await fetch('/api/data/backup', {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = (await response.json().catch(() => null)) as BackupPayload | null;

      if (!response.ok) {
        throw new Error(payload?.message || '备份失败，请稍后重试。');
      }

      if (!payload) {
        throw new Error('备份文件读取失败，请稍后重试。');
      }

      const fileContent = JSON.stringify(payload, null, 2);
      const blob = new Blob([fileContent], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');

      anchor.href = url;
      anchor.download = createBackupFileName(payload.exportedAt);
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      setMessage({ tone: 'success', text: '备份已下载。' });
    } catch (error) {
      console.error('Failed to create backup:', error);
      setMessage({
        tone: 'danger',
        text: error instanceof Error ? error.message : '备份失败，请稍后重试。',
      });
    } finally {
      setIsBusy(false);
    }
  }, []);

  const openRestorePicker = useCallback(() => {
    restoreInputRef.current?.click();
  }, []);

  const handleRestore = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    if (!window.confirm('恢复会覆盖当前文章和导航数据，确定继续吗？')) {
      return;
    }

    setIsBusy(true);
    setMessage({ tone: 'loading', text: '正在恢复本地备份...' });

    try {
      const content = await file.text();
      let backupPayload: BackupPayload;

      try {
        backupPayload = JSON.parse(content) as BackupPayload;
      } catch {
        throw new Error('备份文件格式无效，恢复失败。');
      }

      const currentManifest = await loadCurrentBackupManifest();

      const response = await fetch('/api/data/backup', {
        method: 'POST',
        credentials: 'include',
        headers: createEditorCsrfHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ ...backupPayload, currentManifest }),
      });

      const actionPayload = (await response.json().catch(() => null)) as BackupActionResponse | null;

      if (!response.ok) {
        throw new Error(actionPayload?.message || '恢复失败，请确认备份文件格式正确。');
      }

      setMessage({ tone: 'success', text: '恢复成功，刷新页面后可见最新数据。' });
    } catch (error) {
      console.error('Failed to restore backup:', error);
      setMessage({
        tone: 'danger',
        text: error instanceof Error ? error.message : '恢复失败，请确认备份文件格式正确。',
      });
    } finally {
      setIsBusy(false);
    }
  }, []);

  return (
    <EditorPanel className="p-4">
      <p className="font-mono text-xs text-accent">portable data</p>
      <h2 className="mt-1 text-lg font-semibold text-fg">本地 JSON 备份</h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        将服务器 <code className="rounded-token-card bg-surface px-1.5 py-0.5 font-mono text-fg">data/</code> 中的文章、导航和站点设置导出为 JSON 文件，或从本地备份整体恢复。
      </p>
      {message ? (
        <div className="mt-3">
          <StatusMessage tone={message.tone}>
            {message.text}
          </StatusMessage>
        </div>
      ) : null}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <EditorButton
          type="button"
          onClick={handleBackup}
          disabled={isBusy}
          className="w-full sm:w-auto"
        >
          <Download className="h-4 w-4" />
          <span>{isBusy ? '处理中...' : '备份数据'}</span>
        </EditorButton>

        <EditorButton
          type="button"
          onClick={openRestorePicker}
          disabled={isBusy}
          className="w-full sm:w-auto"
        >
          <Upload className="h-4 w-4" />
          <span>{isBusy ? '处理中...' : '恢复数据'}</span>
        </EditorButton>
        <input
          ref={restoreInputRef}
          type="file"
          accept=".json"
          className="sr-only"
          aria-label="选择本地备份 JSON"
          onChange={handleRestore}
        />
      </div>
    </EditorPanel>
  );
}
