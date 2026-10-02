'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Archive, GitCommitHorizontal, RefreshCcw, RotateCcw } from 'lucide-react';
import { StatusMessage } from '@/app/components/ui';
import { EditorButton, EditorMain, EditorPage, EditorPanel, EditorTopBar } from '@/app/editor/components/EditorShell';
import { LogoutButton } from '@/app/editor/components/LogoutButton';
import { createEditorCsrfHeaders } from '@/app/editor/editor-csrf';

type BackupRecord = { commitSha: string; committedAt: string; digest: string | null; source: 'remote' };
type BackupList = { status?: 'available' | 'unavailable'; items?: BackupRecord[]; nextCursor?: string | null; unavailableReason?: 'not_connected' | 'remote_error' };
type Choice = 'keep-current' | 'use-backup' | 'keep-both';
type RestoreConflict = { conflictId: string; kind: string; summary: string; resolutions: Choice[] };
type InventoryItem = { itemId: string; summary: string };
type RestorePlanDto = {
  binding: { currentRevision: string; backupCommit: string };
  added: Record<string, InventoryItem[]>;
  identical: Record<string, InventoryItem[]>;
  conflicts: RestoreConflict[];
};
type Message = { tone: 'success' | 'danger' | 'loading' | 'info'; text: string };

async function readPayload<T>(response: Response): Promise<T | null> {
  return response.json().catch(() => null) as Promise<T | null>;
}

function formatTime(value: string | undefined): string {
  if (!value) return '时间未提供';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function countInventory(groups: Record<string, InventoryItem[]>): number {
  return Object.values(groups).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
}

export default function BackupsPage() {
  const [items, setItems] = useState<BackupRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState('');
  const [planId, setPlanId] = useState('');
  const [plan, setPlan] = useState<RestorePlanDto | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [backupJobId, setBackupJobId] = useState<string | null>(null);
  const [backupResponseText, setBackupResponseText] = useState('');

  const loadBackups = useCallback(async (cursor: string | null = null, append = false) => {
    setIsLoading(true);
    setUnavailable(null);
    try {
      const query = new URLSearchParams({ limit: '20' });
      if (cursor) query.set('cursor', cursor);
      const response = await fetch(`/api/editor/backups?${query}`, { credentials: 'include', cache: 'no-store' });
      const payload = await readPayload<BackupList>(response);
      if (!response.ok) throw new Error(`HTTP ${response.status}：远端备份历史暂不可查询。`);
      if (!payload || payload.status !== 'available' || !Array.isArray(payload.items)) {
        const reason = payload?.unavailableReason === 'not_connected'
          ? 'GitHub 备份尚未连接。'
          : 'GitHub 远端备份当前不可查询。';
        setItems([]);
        setNextCursor(null);
        throw new Error(reason);
      }
      if (payload.items.some((item) => item.source !== 'remote' || !/^[a-f0-9]{40}$/i.test(item.commitSha))) {
        setItems([]);
        setNextCursor(null);
        throw new Error('远端备份列表响应格式无效。');
      }
      const remoteItems = payload.items;
      setItems((current) => append ? [...current, ...remoteItems] : remoteItems);
      setNextCursor(typeof payload.nextCursor === 'string' ? payload.nextCursor : null);
      setUnavailable(null);
    } catch (error) {
      setItems([]);
      setNextCursor(null);
      setUnavailable(error instanceof Error ? error.message : '远端备份历史暂不可查询。');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadBackups(); }, [loadBackups]);

  const selected = useMemo(() => items.find((item) => item.commitSha === selectedCommit), [items, selectedCommit]);
  const allChoicesMade = Boolean(plan && plan.conflicts.every((conflict) => choices[conflict.conflictId]));

  const createBackup = useCallback(async () => {
    setBusy(true);
    setMessage({ tone: 'loading', text: '正在请求创建 GitHub 完整备份…' });
    try {
      const response = await fetch('/api/editor/backups', {
        method: 'POST', credentials: 'include',
        headers: createEditorCsrfHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({}),
      });
      const payload = await readPayload<{ jobId?: string; snapshotId?: string; message?: string }>(response);
      if (!response.ok) throw new Error(payload?.message || `创建备份失败（HTTP ${response.status}）。`);
      const summary = `创建备份响应 HTTP ${response.status}${payload?.jobId ? `；任务 ${payload.jobId}` : ''}${payload?.snapshotId ? `；快照 ${payload.snapshotId}` : ''}${payload?.message ? `；${payload.message}` : ''}`;
      setMessage({ tone: 'info', text: summary });
      setBackupJobId(payload?.jobId ?? null);
      setBackupResponseText(summary);
      void loadBackups(null, false);
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '创建备份失败。' });
    } finally { setBusy(false); }
  }, [loadBackups]);

  const applyPlan = useCallback(async () => {
    if (!plan || !allChoicesMade || busy || !planId) return;
    if (!window.confirm('确认应用已审阅的逐项合并选择吗？此操作会更新当前数据，不会发布到 Pages。')) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/editor/restore-plans/${encodeURIComponent(planId)}/applications`, {
        method: 'POST', credentials: 'include',
        headers: createEditorCsrfHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ baseRevision: plan.binding.currentRevision, choices: plan.conflicts.map((conflict) => ({ conflictId: conflict.conflictId, resolution: choices[conflict.conflictId] })) }),
      });
      const payload = await readPayload<{ generation?: string; message?: string }>(response);
      if (response.status === 422) throw new Error(payload?.message || '冲突选择无效或不完整，请重新审阅恢复计划。');
      if (!response.ok) throw new Error(payload?.message || `应用合并恢复失败（HTTP ${response.status}）。`);
      if (!payload?.generation) throw new Error('恢复接口未返回 generation，无法确认已完成。');
      setMessage({ tone: 'success', text: `应用合并响应 HTTP ${response.status}；恢复世代 ${payload.generation}。当前数据已更新，尚未发布。` });
      setPlan(null);
      setPlanId('');
      setChoices({});
      setSelectedCommit('');
      await loadBackups(null, false);
    } catch (error) {
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '应用合并恢复失败。' });
    } finally { setBusy(false); }
  }, [allChoicesMade, busy, choices, loadBackups, plan, planId]);

  return (
    <EditorPage className="pb-12">
      <EditorTopBar title="GitHub 备份与合并恢复" description="远端备份历史、任务状态与逐项冲突审阅" eyebrow="editor.backups" backHref="/editor" width="lg" actions={<LogoutButton />} />
      <EditorMain width="lg" className="space-y-4">
        {message ? <StatusMessage tone={message.tone}>{message.text}</StatusMessage> : null}
        <EditorPanel className="p-4">
          {backupJobId ? <p className="mb-3 text-sm text-muted" role="status">最近备份任务 ID：{backupJobId}；任务读取完成后显示实际状态。</p> : null}
          {backupResponseText ? <p className="mb-3 text-sm text-muted">{backupResponseText}</p> : null}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><h2 className="flex items-center gap-2 text-lg font-semibold"><Archive className="h-5 w-5 text-accent" />GitHub 主备份历史</h2><p className="mt-2 text-sm leading-6 text-muted">仅显示 API 实际返回的数据；本地 proof 不等同于可恢复的远端世代。旧 R2 数据备份仍在编辑中心单独管理。</p></div>
            <div className="flex flex-wrap gap-2"><EditorButton onClick={() => void loadBackups(null, false)} disabled={isLoading}><RefreshCcw className="h-4 w-4" />刷新</EditorButton><EditorButton variant="primary" onClick={createBackup} disabled={busy}><GitCommitHorizontal className="h-4 w-4" />创建 GitHub 备份</EditorButton></div>
          </div>
          {isLoading ? <p className="mt-4 text-sm text-muted">正在查询备份历史…</p> : null}
          {unavailable ? <div className="mt-4 flex gap-2 rounded-token-card border border-warning-200 bg-warning-50 p-3 text-sm text-warning-600"><AlertTriangle className="h-4 w-4 shrink-0" /><span><strong>远端备份历史暂不可查询</strong><br />{unavailable}</span></div> : null}
          {items.length > 0 ? <ul className="mt-4 divide-y divide-border">{items.map((item) => <li key={item.commitSha} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><code className="break-all text-xs text-fg">{item.commitSha}</code><p className="mt-1 text-xs text-muted">{formatTime(item.committedAt)} · GitHub 远端提交 · digest {item.digest ?? '未提供'}</p></div><div className="flex items-center gap-2"><label className="flex items-center gap-2 text-sm"><input type="radio" name="backup-commit" value={item.commitSha} checked={selectedCommit === item.commitSha} disabled={busy} onChange={() => { setSelectedCommit(item.commitSha); setPlan(null); }} />选择</label><EditorButton disabled={busy} onClick={() => { setSelectedCommit(item.commitSha); void createPlanFor(item.commitSha, setBusy, setMessage, setPlanId, setPlan, setChoices); }}>生成合并计划</EditorButton></div></li>)}</ul> : null}
          {!isLoading && !unavailable && items.length === 0 ? <p className="mt-4 text-sm text-muted">暂无备份。</p> : null}
          {items.length > 0 && selected ? <p className="mt-2 text-xs text-subtle">已选远端 commit：{selected.commitSha}；恢复前会读取计划并要求逐项处理冲突。</p> : null}
          {nextCursor && !unavailable ? <div className="mt-3"><EditorButton disabled={isLoading} onClick={() => void loadBackups(nextCursor, true)}>加载更早备份</EditorButton></div> : null}
        </EditorPanel>
        {plan ? <EditorPanel className="space-y-4 p-4">
          <div><h2 className="text-lg font-semibold"><RotateCcw className="mr-2 inline h-5 w-5 text-accent" />合并计划与安全摘要</h2><p className="mt-2 break-all text-xs text-muted">备份 commit：{plan.binding.backupCommit}<br />应用基线 revision：{plan.binding.currentRevision}</p><p className="mt-2 text-sm text-muted">将新增 {countInventory(plan.added)} 项；与当前相同 {countInventory(plan.identical)} 项；冲突 {plan.conflicts.length} 项。应用会替换/合并运行时内容并生成新世代，先审阅每个冲突；R2 与此 GitHub 恢复链路分离。</p></div>
          {plan.conflicts.length === 0 ? <p className="text-sm text-muted">没有冲突；确认恢复摘要后可应用。</p> : plan.conflicts.map((conflict) => <fieldset key={conflict.conflictId} className="rounded-token-card border border-border p-3"><legend className="px-1 text-sm font-medium">{conflict.kind}</legend><p className="text-sm text-muted">{conflict.summary}</p><div className="mt-3 flex flex-wrap gap-4">{conflict.resolutions.map((resolution) => <label key={resolution} className="flex items-center gap-2 text-sm"><input type="radio" name={`choice-${conflict.conflictId}`} value={resolution} checked={choices[conflict.conflictId] === resolution} onChange={() => setChoices((current) => ({ ...current, [conflict.conflictId]: resolution }))} />{resolution === 'keep-current' ? '保留当前' : resolution === 'use-backup' ? '采用备份' : '两者都保留'}</label>)}</div></fieldset>)}
          <EditorButton variant="danger" disabled={!allChoicesMade || busy || !planId} onClick={applyPlan}>应用合并恢复</EditorButton>
          {!allChoicesMade ? <p className="text-xs text-warning-600">必须为每个冲突明确选择后才能应用。</p> : null}
        </EditorPanel> : null}
      </EditorMain>
    </EditorPage>
  );
}

async function createPlanFor(
  commit: string,
  setBusy: (value: boolean) => void,
  setMessage: (value: Message | null) => void,
  setPlanId: (value: string) => void,
  setPlan: (value: RestorePlanDto | null) => void,
  setChoices: (value: Record<string, Choice>) => void,
): Promise<void> {
  if (!/^[a-f0-9]{40}$/i.test(commit)) return;
  setBusy(true);
  setMessage({ tone: 'loading', text: '正在请求生成合并计划…' });
  setPlan(null);
  setPlanId('');
  setChoices({});
  try {
    const response = await fetch('/api/editor/restore-plans', { method: 'POST', credentials: 'include', headers: createEditorCsrfHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ backupCommit: commit }) });
    const result = await readPayload<{ planId?: string; conflictCount?: number; message?: string }>(response);
    if (!response.ok || response.status !== 200 || !result?.planId || typeof result.conflictCount !== 'number') {
      setMessage({ tone: 'danger', text: result?.message || `同步创建恢复计划失败（HTTP ${response.status}）。` });
      return;
    }
    setMessage({ tone: 'info', text: `恢复计划同步创建响应 HTTP ${response.status}；计划 ${result.planId}，冲突 ${result.conflictCount} 项。` });
    const planResponse = await fetch(`/api/editor/restore-plans/${encodeURIComponent(result.planId)}`, { credentials: 'include', cache: 'no-store' });
    const plan = await readPayload<RestorePlanDto>(planResponse);
    if (!planResponse.ok || !plan?.binding || !Array.isArray(plan.conflicts)) {
      setMessage({ tone: 'danger', text: `读取真实恢复计划失败（HTTP ${planResponse.status}）。` });
      return;
    }
    setPlanId(result.planId);
    setPlan(plan);
    setMessage({ tone: 'info', text: `恢复计划同步创建响应 HTTP ${response.status}；计划 ${result.planId}，冲突 ${result.conflictCount} 项。实际计划读取 HTTP ${planResponse.status}。` });
  } catch (error) {
    setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '创建合并计划失败。' });
  } finally { setBusy(false); }
}
