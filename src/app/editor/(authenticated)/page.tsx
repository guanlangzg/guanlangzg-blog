'use client';

import { useCallback, useRef, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Compass,
  Download,
  FileText,
  Settings,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import { StatusMessage } from '@/app/components/ui';
import { LogoutButton } from '../components/LogoutButton';
import { loadCurrentBackupManifest } from '../backup-current-manifest';
import { createEditorCsrfHeaders } from '../editor-csrf';
import {
  EditorActionCard,
  EditorButton,
  EditorMain,
  EditorPage,
  EditorPanel,
  EditorTopBar,
} from '../components/EditorShell';

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

export default function EditorHomePage() {
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
    <EditorPage>
      <EditorTopBar
        title="编辑中心"
        description="管理博客文章、导航链接和可迁移数据"
        actions={(
          <>
            <LogoutButton />
          </>
        )}
      />

      <EditorMain className="space-y-4">
        {message ? (
          <StatusMessage tone={message.tone}>
            {message.text}
          </StatusMessage>
        ) : null}

        <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <EditorActionCard
            href="/editor/blog"
            icon={FileText}
            title="博客编辑器"
            description="使用 Markdown 编写文章，保留实时预览、模板和本地优先保存。"
            action="开始写作"
          />

          <EditorActionCard
            href="/editor/navigation"
            icon={Compass}
            title="导航编辑器"
            description="管理分类、工具链接和标签，让公开导航页保持可搜索、可迁移。"
            action="编辑导航"
          />

          <EditorActionCard
            href="/editor/settings"
            icon={Settings}
            title="站点设置"
            description="管理公开站点名称、描述和首页首屏文案，并随备份一起迁移。"
            action="调整设置"
          />

          <EditorActionCard
            href="/editor/publishing"
            icon={CheckCircle2}
            title="发布工作台"
            description="按范围创建冻结候选、预览版本并跟踪真实发布任务。"
            action="查看发布状态"
          />

          <EditorActionCard
            href="/editor/backups"
            icon={Archive}
            title="GitHub 备份与恢复"
            description="查看私有远端备份历史，审阅逐项冲突后合并恢复当前草稿。"
            action="管理备份与恢复"
          />

          <EditorActionCard
            href="/editor/settings/runtime"
            icon={SlidersHorizontal}
            title="运行时配置"
            description="管理首次启动变量、Cookie、代理、站点 URL、数据目录和编辑口令。"
            action="配置变量"
          />
        </section>

        <EditorPanel className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div>
            <p className="font-mono text-xs text-accent">portable data</p>
            <h2 className="mt-1 text-lg font-semibold text-fg">运行时数据边界</h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              服务器数据集中在 <code className="rounded-token-card bg-surface px-1.5 py-0.5 font-mono text-fg">data/</code>，
              本页提供 JSON 离线备份与恢复。
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:justify-end">
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
      </EditorMain>
    </EditorPage>
  );
}
