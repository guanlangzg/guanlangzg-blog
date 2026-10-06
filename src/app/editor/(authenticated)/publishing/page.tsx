'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCcw, RotateCcw } from 'lucide-react';
import { StatusMessage } from '@/app/components/ui';
import { readApiErrorMessage } from '../../api-error-message';
import { createEditorCsrfHeaders } from '../../editor-csrf';
import { EditorButton, EditorMain, EditorPage, EditorPanel, EditorTopBar } from '../../components/EditorShell';

type ScopeKind = 'article' | 'navigation' | 'settings' | 'bootstrap';
type Scope = { kind: ScopeKind; articleId?: string; action?: 'publish' | 'withdraw'; articleIds?: string[] };
type Release = { id: string; scope: Scope; status: string; candidateDigest: string; artifactDigest: string | null; hasBackupProof: boolean; publicCommitSha: string | null; workflowRunId: number | null; workflowRunAttempt: number | null; error: { code: string; retryable: boolean } | null; taskId?: string | null; createdAt: string; updatedAt: string };
type Job = { id: string; type: string; status: string; attempt: number; nextAttemptAt: string | null; remoteCommit: string | null; error: { message: string } | null };
const STATUS: Record<string, string> = { awaiting_backup: '等待备份', building: '构建中', preview_ready: '预览就绪', publishing: '提交产物', deploying: '部署中', verifying: '核验中', live: '已上线', failed: '失败', stale: '候选已过期', cancelled: '已取消', pending: '排队中', running: '处理中', succeeded: '已完成' };
async function readJson<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(readApiErrorMessage(payload, `请求失败（${response.status}）`));
  }
  if (!payload) throw new Error('服务器返回了空响应。');
  return payload as T;
}

export default function PublishingPage() {
  const [kind, setKind] = useState<ScopeKind>('article');
  const [articleId, setArticleId] = useState('');
  const [action, setAction] = useState<'publish' | 'withdraw'>('publish');
  const [articleIds, setArticleIds] = useState('');
  const [revisions, setRevisions] = useState<Partial<Record<ScopeKind, string>>>({});
  const [releases, setReleases] = useState<Release[]>([]);
  const [jobs, setJobs] = useState<Record<string, Job | null>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const selectedScope: Scope = useMemo(() => kind === 'article' ? { kind, articleId, action } : kind === 'bootstrap' ? { kind, articleIds: articleIds.split(/\s*,\s*/).filter(Boolean) } : { kind }, [kind, articleId, action, articleIds]);
  const loadSequenceRef = useRef(0);

  const load = useCallback(async () => {
    // Polls can overlap; only the newest request may publish its result.
    const sequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = sequence;
    setBusy(true);
    try {
      const [releasePayload, revisionPayload] = await Promise.all([
        fetch('/api/editor/releases', { credentials: 'include', cache: 'no-store' }).then(readJson<{ releases: Release[] }>),
        fetch('/api/editor/publishing-revision', { credentials: 'include', cache: 'no-store' }).then(readJson<{ revisions: Partial<Record<ScopeKind, string>> }>),
      ]);
      if (sequence !== loadSequenceRef.current) return;
      setReleases(releasePayload.releases);
      setRevisions(revisionPayload.revisions);
      const nextJobs: Record<string, Job | null> = {};
      await Promise.all(releasePayload.releases.filter((release) => release.taskId && ['publishing', 'deploying', 'verifying'].includes(release.status)).map(async (release) => {
        try {
          const response = await fetch(`/api/editor/jobs/${encodeURIComponent(release.taskId!)}`, { credentials: 'include', cache: 'no-store' });
          if (response.ok) nextJobs[release.id] = await response.json() as Job;
        } catch { nextJobs[release.id] = null; }
      }));
      if (sequence !== loadSequenceRef.current) return;
      setJobs(nextJobs);
    } catch (error) {
      if (sequence !== loadSequenceRef.current) return;
      setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '发布状态读取失败。' });
    } finally { if (sequence === loadSequenceRef.current) setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!releases.some((release) => ['awaiting_backup', 'building', 'publishing', 'deploying', 'verifying'].includes(release.status))) return;
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => window.clearInterval(timer);
  }, [releases, load]);

  async function createCandidate() {
    const expectedRevision = revisions[kind];
    if (!expectedRevision) { setMessage({ tone: 'warning', text: '当前范围 revision 尚未读取；刷新状态后再创建候选。' }); return; }
    if (kind === 'article' && !articleId.trim()) { setMessage({ tone: 'warning', text: '请输入稳定文章 ID。' }); return; }
    if (kind === 'bootstrap' && !articleIds.trim()) { setMessage({ tone: 'warning', text: '首次发布请选择至少一篇文章 ID（逗号分隔）。' }); return; }
    setBusy(true); setMessage(null);
    try {
      const response = await fetch('/api/editor/releases', { method: 'POST', credentials: 'include', headers: createEditorCsrfHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ scope: selectedScope, expectedRevision }) });
      const payload = await readJson<{ releaseId: string }>(response);
      setMessage({ tone: 'success', text: `候选 ${payload.releaseId} 已创建。` });
      await load();
    } catch (error) { setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '候选创建失败。' }); }
    finally { setBusy(false); }
  }

  async function postRelease(release: Release, actionName: 'preview' | 'confirmation' | 'retries') {
    setBusy(true); setMessage(null);
    try {
      const body = actionName === 'confirmation' ? { candidateDigest: release.candidateDigest, artifactDigest: release.artifactDigest } : undefined;
      const response = await fetch(`/api/editor/releases/${encodeURIComponent(release.id)}/${actionName}`, { method: 'POST', credentials: 'include', headers: createEditorCsrfHeaders(body ? { 'Content-Type': 'application/json' } : {}), ...(body ? { body: JSON.stringify(body) } : {}) });
      const payload = await readJson<{ entry?: string; status?: string; taskId?: string }>(response);
      if (actionName === 'preview' && payload.entry) window.open(payload.entry, '_blank', 'noopener,noreferrer');
      setMessage({ tone: 'success', text: actionName === 'preview' ? '已在新标签页打开固定版本预览。' : actionName === 'retries' ? `已提交安全复跑请求${payload.taskId ? `（任务 ${payload.taskId}）` : ''}。` : '已确认封存摘要并提交发布。' });
      await load();
    } catch (error) { setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '操作失败。' }); }
    finally { setBusy(false); }
  }

  return <EditorPage><EditorTopBar title="发布工作台" description="候选、固定版本预览与 Pages 状态" backHref="/editor" /><EditorMain width="lg" className="space-y-4">
    {message ? <StatusMessage tone={message.tone}>{message.text}</StatusMessage> : null}
    <EditorPanel className="p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-xs text-accent">candidate</p><h2 className="mt-1 text-lg font-semibold">创建发布候选</h2><p className="mt-1 text-sm text-muted">候选从当前工作副本按选定范围冻结；编辑文章状态不会直接上线。</p></div><EditorButton onClick={() => void load()} disabled={busy}><RefreshCcw className="h-4 w-4" />刷新状态</EditorButton></div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-sm font-medium">发布范围<select className="mt-1 min-h-11 w-full rounded-token-card border border-border bg-surface px-3 text-sm" value={kind} onChange={(event) => setKind(event.target.value as ScopeKind)}><option value="article">单篇文章</option><option value="navigation">导航</option><option value="settings">站点设置</option><option value="bootstrap">首次发布选择</option></select></label>
      {kind === 'article' ? <><label className="text-sm font-medium">文章稳定 ID<input className="mt-1 min-h-11 w-full rounded-token-card border border-border bg-surface px-3 text-sm" value={articleId} onChange={(event) => setArticleId(event.target.value)} placeholder="从文章管理复制 ID" /></label><label className="text-sm font-medium">操作<select className="mt-1 min-h-11 w-full rounded-token-card border border-border bg-surface px-3 text-sm" value={action} onChange={(event) => setAction(event.target.value as 'publish' | 'withdraw')}><option value="publish">发布</option><option value="withdraw">从线上撤回（保留草稿）</option></select></label></> : null}
      {kind === 'bootstrap' ? <label className="text-sm font-medium sm:col-span-2">首次发布文章 ID（逗号分隔）<input className="mt-1 min-h-11 w-full rounded-token-card border border-border bg-surface px-3 text-sm" value={articleIds} onChange={(event) => setArticleIds(event.target.value)} placeholder="id-1, id-2" /></label> : null}</div>
      <p className="mt-3 break-all text-xs text-muted">当前范围 revision：<code>{revisions[kind] ?? (busy ? '读取中…' : '不可用')}</code></p><div className="mt-3"><EditorButton variant="primary" onClick={() => void createCandidate()} disabled={busy || !revisions[kind]}>创建候选</EditorButton></div></EditorPanel>
    <section aria-labelledby="release-list-title"><div className="mb-3 flex items-center justify-between"><h2 id="release-list-title" className="text-lg font-semibold">发布记录</h2><span className="text-xs text-muted">每 5 秒自动刷新处理中状态</span></div>{releases.length === 0 ? <EditorPanel className="p-5 text-sm text-muted">暂无发布记录。创建候选后，状态会在此按 release ID 恢复查询。</EditorPanel> : <div className="space-y-3">{releases.map((release) => { const canConfirm = release.status === 'preview_ready' && Boolean(release.artifactDigest); const canPreview = Boolean(release.artifactDigest); const canRetry = release.status === 'failed' && release.error?.retryable === true && Boolean(release.workflowRunId && release.workflowRunAttempt); const job = jobs[release.id]; return <EditorPanel key={release.id} className="p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-mono text-sm font-semibold">{release.id}</h3><span className="rounded-full border border-border px-2 py-0.5 text-xs">{STATUS[release.status] ?? '状态未知'}</span>{release.status === 'live' ? <CheckCircle2 className="h-4 w-4 text-success" aria-label="已上线核验" /> : null}</div><p className="mt-2 text-xs text-muted">{release.scope.kind === 'article' ? `文章 ${release.scope.articleId} · ${release.scope.action === 'withdraw' ? '撤回' : '发布'}` : release.scope.kind === 'bootstrap' ? `首次发布 · ${(release.scope.articleIds ?? []).length} 篇文章` : release.scope.kind === 'navigation' ? '导航' : '站点设置'} · 候选 {release.candidateDigest.slice(0, 12)}…</p><p className="mt-1 text-xs text-muted">备份门槛：{release.hasBackupProof ? '候选证明已记录；全局水位仍由确认接口复核' : '尚无有效候选备份证明，确认将被后端阻止'}{release.status === 'awaiting_backup' ? ' · 等待私有备份追平' : ''}</p>{release.error ? <p className="mt-1 flex items-center gap-1 text-xs text-error-600"><AlertTriangle className="h-3.5 w-3.5" />{release.error.code}（{release.error.retryable ? '确定可安全复跑' : '不可复跑'}）</p> : null}{job ? <p className="mt-1 text-xs text-muted">任务 {job.id} · {STATUS[job.status] ?? job.status} · 尝试 {job.attempt}{job.nextAttemptAt ? ` · 下次 ${job.nextAttemptAt}` : ''}</p> : null}{job?.error ? <p className="mt-1 flex items-center gap-1 text-xs text-error-600"><AlertTriangle className="h-3.5 w-3.5" />{job.error.message}</p> : null}{release.workflowRunId ? <p className="mt-1 text-xs text-muted">Workflow {release.workflowRunId} / attempt {release.workflowRunAttempt ?? '未知'}{release.publicCommitSha ? ` · ${release.publicCommitSha.slice(0, 10)}` : ''}</p> : null}</div><div className="flex flex-wrap gap-2">{canPreview ? <EditorButton onClick={() => void postRelease(release, 'preview')} disabled={busy}><ExternalLink className="h-4 w-4" />固定版本预览</EditorButton> : null}{canConfirm ? <EditorButton variant="primary" onClick={() => void postRelease(release, 'confirmation')} disabled={busy || !release.hasBackupProof} title={!release.hasBackupProof ? '候选备份证明未就绪' : undefined}>确认发布</EditorButton> : null}{canRetry ? <EditorButton onClick={() => void postRelease(release, 'retries')} disabled={busy}><RotateCcw className="h-4 w-4" />安全复跑</EditorButton> : null}</div></div><details className="mt-3"><summary className="cursor-pointer text-xs text-muted">查看核验摘要</summary><dl className="mt-2 grid gap-2 break-all text-xs sm:grid-cols-2"><div><dt className="text-muted">candidateDigest</dt><dd className="font-mono">{release.candidateDigest}</dd></div><div><dt className="text-muted">artifactDigest</dt><dd className="font-mono">{release.artifactDigest ?? '尚未封存'}</dd></div></dl></details></EditorPanel>; })}</div>}</section>
  </EditorMain></EditorPage>;
}
