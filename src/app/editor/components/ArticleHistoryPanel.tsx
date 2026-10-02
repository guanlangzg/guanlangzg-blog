'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createEditorCsrfHeaders } from '@/app/editor/editor-csrf';
import { EditorButton, EditorPanel } from './EditorShell';

interface HistoryItem {
  commitSha: string;
  message: string;
  committedAt: string;
  title: string;
  slug: string | null;
  updatedAt: number;
  summary: { contentDigest: string; metadataDigest: string };
}

interface HistoryPayload {
  items: HistoryItem[];
  nextCursor: string | null;
}

interface Props {
  articleId: string;
  articleTitle: string;
  onClose: () => void;
}

function responseMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
    return payload.message;
  }
  return fallback;
}

export function ArticleHistoryPanel({ articleId, articleTitle, onClose }: Props) {
  const router = useRouter();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringSha, setRestoringSha] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadPage = useCallback(async (pageCursor: string | null, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: '20' });
      if (pageCursor) query.set('cursor', pageCursor);
      const response = await fetch(`/api/editor/articles/${encodeURIComponent(articleId)}/history?${query}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => null) as Partial<HistoryPayload> & { code?: string; message?: string } | null;
      if (!response.ok) {
        const detail = response.status === 503 || payload?.code === 'GITHUB_NOT_READY'
          ? 'GitHub 备份未连接或当前不可用，无法查询远端历史。请检查 GitHub 设置后重试。'
          : responseMessage(payload, `历史读取失败（HTTP ${response.status}），请稍后重试。`);
        throw new Error(detail);
      }
      const pageItems = Array.isArray(payload?.items) ? payload.items : [];
      setItems((current) => append ? [...current, ...pageItems] : pageItems);
      setNextCursor(typeof payload?.nextCursor === 'string' ? payload.nextCursor : null);
      setCursor(pageCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '文章历史暂时无法读取，请检查网络连接后重试。');
    } finally {
      setLoading(false);
    }
  }, [articleId]);

  useEffect(() => {
    void loadPage(null, false);
  }, [loadPage]);

  const restore = async (item: HistoryItem) => {
    if (!window.confirm(`将“${item.title}”的此版本写入当前文章草稿。现有草稿会被替换并先行保护；不会发布。继续吗？`)) return;
    setRestoringSha(item.commitSha);
    setMessage(null);
    try {
      const response = await fetch(`/api/editor/articles/${encodeURIComponent(articleId)}/history-restores`, {
        method: 'POST',
        credentials: 'include',
        headers: createEditorCsrfHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ commitSha: item.commitSha }),
      });
      const payload = await response.json().catch(() => null) as { status?: unknown; jobId?: unknown; message?: unknown } | null;
      if (!response.ok) {
        if (response.status === 503) throw new Error('GitHub 备份未就绪或当前离线，历史版本未恢复。');
        throw new Error(responseMessage(payload, `恢复失败（HTTP ${response.status}）。`));
      }
      const job = typeof payload?.jobId === 'string' ? ` 作业 ${payload.jobId}：${String(payload.status ?? '已排队')}。` : '';
      setMessage(`已将历史版本恢复为新的当前草稿；尚未发布。${job}`);
      router.push(`/editor/blog/new?edit=${encodeURIComponent(articleId)}`);
      router.refresh();
    } catch (restoreError) {
      setMessage(restoreError instanceof Error ? restoreError.message : '历史版本恢复失败，请重试。');
    } finally {
      setRestoringSha(null);
    }
  };

  return (
    <EditorPanel className="p-4 sm:p-5" aria-label={`${articleTitle}文章历史`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-fg">文章历史：{articleTitle}</h3>
          <p className="mt-1 text-sm text-muted">按文章稳定 ID 查询 GitHub 远端版本；恢复只写当前草稿，不会发布。</p>
        </div>
        <EditorButton onClick={onClose} aria-label="关闭文章历史">关闭</EditorButton>
      </div>
      {error ? (
        <div role="alert" className="mt-4 rounded-token-card border border-warning-light bg-warning-50 p-3 text-sm text-warning-600">
          <p>{error}</p>
          <EditorButton className="mt-2" onClick={() => void loadPage(cursor, false)}>重试</EditorButton>
        </div>
      ) : null}
      {message ? <p role="status" className="mt-4 text-sm text-fg">{message}</p> : null}
      {loading ? <p className="mt-4 text-sm text-muted" role="status">正在读取远端历史…</p> : null}
      {!loading && !error && items.length === 0 ? <p className="mt-4 text-sm text-muted">远端没有此文章的历史版本。</p> : null}
      <ol className="mt-4 space-y-3">
        {items.map((item) => (
          <li key={item.commitSha} className="flex flex-col gap-3 rounded-token-card border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium text-fg">{item.title || '无标题'}</p>
              <p className="mt-1 text-xs text-muted">{new Date(item.committedAt).toLocaleString('zh-CN')} · {item.message || '无提交说明'}</p>
              <p className="mt-1 break-all font-mono text-xs text-subtle">{item.commitSha}</p>
            </div>
            <EditorButton
              variant="secondary"
              disabled={Boolean(restoringSha)}
              onClick={() => void restore(item)}
              aria-label={`恢复版本 ${item.commitSha}`}
            >{restoringSha === item.commitSha ? '正在恢复…' : '恢复为草稿'}</EditorButton>
          </li>
        ))}
      </ol>
      {nextCursor && !error ? (
        <div className="mt-4">
          <EditorButton disabled={loading} onClick={() => void loadPage(nextCursor, true)}>
            {loading ? '正在加载…' : '加载更早版本'}
          </EditorButton>
        </div>
      ) : null}
    </EditorPanel>
  );
}
