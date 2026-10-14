'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Cloud, RefreshCcw, Save } from 'lucide-react';
import { StatusMessage } from '@/app/components/ui';
import { readApiErrorMessage } from '../../api-error-message';
import { createEditorCsrfHeaders } from '../../editor-csrf';
import {
    EditorButton,
    EditorPanel,
    editorInputClassName,
} from '../../components/EditorShell';

type GitHubRepositoryReference = { owner: string; name: string; id: number };
type GitHubConnectionStatus = 'not_configured' | 'pending' | 'connected' | 'permission_error' | 'private_required' | 'network_error' | 'installation_revoked';
type GitHubConnectionDto = {
    privateKeyConfigured: boolean;
    appId: string | null;
    installationId: number | null;
    repos: { source: GitHubRepositoryReference; pages: GitHubRepositoryReference; backup: GitHubRepositoryReference } | null;
    status: GitHubConnectionStatus;
};
type DiscoveredRepository = { id: number; owner: string; name: string; isPrivate: boolean; defaultBranch: string };
type RepositoryRole = 'source' | 'pages' | 'backup';
type PanelMessage = { tone: 'success' | 'warning' | 'danger' | 'loading' | 'info'; text: string };

const STATUS_LABELS: Record<GitHubConnectionStatus, string> = {
    not_configured: '未配置',
    pending: '待验证',
    connected: '已连接',
    permission_error: '权限不足',
    private_required: '私钥缺失或无效',
    network_error: '网络不可达',
    installation_revoked: '安装不可用',
};

const STATUS_GUIDANCE: Record<GitHubConnectionStatus, string> = {
    not_configured: '填写 App 信息并保存后，系统会自动发起连接验证。',
    pending: '配置已保存，点击“验证连接”发起检查。',
    connected: '发布工作台与 GitHub 备份现已可用。',
    permission_error: 'App 安装缺少所需权限：请确认 GitHub App 授权了全部三个仓库，并具有 Contents 读写、Actions 与 Pages 权限。',
    private_required: 'App 私钥未配置或格式无效：请粘贴 GitHub App 的 PEM 私钥后重新保存。',
    network_error: '服务器无法访问 GitHub API：请检查服务器出网网络或代理设置后重新验证。',
    installation_revoked: 'App 安装不可用：可能已卸载、仓库不再授权或凭据不匹配。请重新安装 App 并确认仓库后重新保存。',
};

const ROLE_LABELS: Record<RepositoryRole, string> = {
    source: '源码仓库',
    pages: 'Pages 仓库',
    backup: '备份仓库',
};

const JOB_POLL_INTERVAL_MS = 2_000;
const JOB_POLL_MAX_ATTEMPTS = 40;
const CONNECTION_ANCHOR_ID = 'github-connection';

function formatRepos(repos: NonNullable<GitHubConnectionDto['repos']>): string {
    return `源码 ${repos.source.owner}/${repos.source.name} · Pages ${repos.pages.owner}/${repos.pages.name} · 备份 ${repos.backup.owner}/${repos.backup.name}`;
}

function parsePositiveInteger(value: string): number | null {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function GitHubConnectionPanel() {
    const [expanded, setExpanded] = useState(false);
    const [dto, setDto] = useState<GitHubConnectionDto | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [message, setMessage] = useState<PanelMessage | null>(null);

    const [appId, setAppId] = useState('');
    const [installationId, setInstallationId] = useState('');
    const [privateKeyPem, setPrivateKeyPem] = useState('');
    const [useManualRepos, setUseManualRepos] = useState(false);
    const [discovered, setDiscovered] = useState<DiscoveredRepository[]>([]);
    const [selectedRoles, setSelectedRoles] = useState<Partial<Record<RepositoryRole, number>>>({});
    const [manualRepos, setManualRepos] = useState<Record<RepositoryRole, { owner: string; name: string; id: string }>>({
        source: { owner: '', name: '', id: '' },
        pages: { owner: '', name: '', id: '' },
        backup: { owner: '', name: '', id: '' },
    });

    const [isResolving, setIsResolving] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const isVerifyingRef = useRef(false);

    useEffect(() => {
        // Publishing mounts this panel as the dependency gate, so the status
        // must load immediately; full form state stays lazy behind "展开配置".
        if (typeof window !== 'undefined' && window.location.hash === `#${CONNECTION_ANCHOR_ID}`) {
            setExpanded(true);
        }
        void loadConnection();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- status load is mount-only by design
    }, []);

    const loadConnection = useCallback(async () => {
        setIsLoading(true);
        try {
            const response = await fetch('/api/editor/github', { credentials: 'include', cache: 'no-store' });
            const payload = await response.json().catch(() => null) as (GitHubConnectionDto & { message?: string }) | null;
            if (!response.ok || !payload || typeof payload !== 'object') {
                throw new Error(readApiErrorMessage(payload, 'GitHub 连接状态读取失败。'));
            }
            setDto(payload);
            if (payload.appId) setAppId(payload.appId);
            if (payload.installationId) setInstallationId(String(payload.installationId));
            if (payload.repos?.source && payload.repos.pages && payload.repos.backup) {
                setUseManualRepos(false);
                setDiscovered([]);
                setSelectedRoles({});
                setManualRepos({
                    source: { owner: payload.repos.source.owner, name: payload.repos.source.name, id: String(payload.repos.source.id) },
                    pages: { owner: payload.repos.pages.owner, name: payload.repos.pages.name, id: String(payload.repos.pages.id) },
                    backup: { owner: payload.repos.backup.owner, name: payload.repos.backup.name, id: String(payload.repos.backup.id) },
                });
            }
        } catch (error) {
            setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'GitHub 连接状态读取失败。' });
        } finally {
            setIsLoading(false);
        }
    }, []);

    const handleExpand = useCallback(() => {
        setExpanded(true);
        if (!dto) void loadConnection();
    }, [dto, loadConnection]);

    const handleDiscover = useCallback(async () => {
        const parsedInstallationId = parsePositiveInteger(installationId);
        if (!appId.trim() || !parsedInstallationId) {
            setMessage({ tone: 'warning', text: '获取仓库前请填写有效的 App ID 和安装 ID。' });
            return;
        }

        setIsResolving(true);
        setMessage({ tone: 'loading', text: '正在读取 App 安装可访问的仓库...' });
        try {
            const response = await fetch('/api/editor/github/resolve', {
                method: 'POST',
                credentials: 'include',
                headers: createEditorCsrfHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    appId: appId.trim(),
                    installationId: parsedInstallationId,
                    ...(privateKeyPem.trim() ? { privateKeyPem: privateKeyPem.trim() } : {}),
                }),
            });
            const payload = await response.json().catch(() => null) as { repositories?: DiscoveredRepository[] } | null;
            if (!response.ok) {
                throw new Error(readApiErrorMessage(payload, '仓库列表获取失败。'));
            }
            const repositories = payload?.repositories ?? [];
            setDiscovered(repositories);
            setUseManualRepos(false);
            setSelectedRoles({});
            setMessage({
                tone: repositories.length > 0 ? 'success' : 'warning',
                text: repositories.length > 0
                    ? `已获取 ${repositories.length} 个可访问仓库，请为三个角色分别选择仓库。`
                    : '该安装当前没有可访问的仓库，请确认 GitHub App 安装已授权仓库。',
            });
        } catch (error) {
            setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '仓库列表获取失败。' });
        } finally {
            setIsResolving(false);
        }
    }, [appId, installationId, privateKeyPem]);

    const startVerification = useCallback(async () => {
        const checkResponse = await fetch('/api/editor/github/check', {
            method: 'POST',
            credentials: 'include',
            headers: createEditorCsrfHeaders({ 'Content-Type': 'application/json' }),
        });
        const checkPayload = await checkResponse.json().catch(() => null) as { jobId?: string } | null;
        if (!checkResponse.ok) {
            throw new Error(readApiErrorMessage(checkPayload, '验证请求失败。'));
        }
        if (!checkPayload?.jobId) {
            throw new Error('验证请求未返回任务 ID。');
        }

        setMessage({ tone: 'loading', text: '正在验证 GitHub 连接（拉取仓库与 Pages 配置）...' });
        for (let attempt = 0; attempt < JOB_POLL_MAX_ATTEMPTS; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
            const jobResponse = await fetch(`/api/editor/jobs/${encodeURIComponent(checkPayload.jobId)}`, {
                credentials: 'include',
                cache: 'no-store',
            }).catch(() => null);
            if (!jobResponse || !jobResponse.ok) continue;
            const jobPayload = await jobResponse.json().catch(() => null) as { status?: string } | null;
            if (jobPayload?.status === 'succeeded' || jobPayload?.status === 'failed') break;
        }

        const finalResponse = await fetch('/api/editor/github', { credentials: 'include', cache: 'no-store' });
        const finalDto = await finalResponse.json().catch(() => null) as GitHubConnectionDto | null;
        if (finalResponse.ok && finalDto) setDto(finalDto);
        return finalDto?.status ?? 'not_configured';
    }, []);

    const buildReposPayload = useCallback((): { repos: NonNullable<GitHubConnectionDto['repos']> } | { error: string } => {
        if (useManualRepos) {
            const entries = (Object.keys(manualRepos) as RepositoryRole[]).map((role) => {
                const entry = manualRepos[role];
                const id = parsePositiveInteger(entry.id);
                if (!entry.owner.trim() || !entry.name.trim() || !id) return null;
                return { role, repo: { owner: entry.owner.trim(), name: entry.name.trim(), id } };
            });
            if (entries.every((entry): entry is NonNullable<typeof entry> => entry !== null)) {
                const repos = Object.fromEntries(entries.map((entry) => [entry.role, entry.repo])) as NonNullable<GitHubConnectionDto['repos']>;
                return { repos };
            }
            return { error: '手动模式下请为三个仓库完整填写 owner、name 和数字 ID。' };
        }

        const missing = (Object.keys(ROLE_LABELS) as RepositoryRole[]).filter((role) => !selectedRoles[role]);
        if (missing.length > 0) {
            return { error: `请为以下角色选择仓库：${missing.map((role) => ROLE_LABELS[role]).join('、')}。` };
        }
        const lookup = new Map(discovered.map((repo) => [repo.id, repo]));
        const repos = (Object.keys(ROLE_LABELS) as RepositoryRole[]).reduce(
            (acc, role) => {
                const repo = lookup.get(selectedRoles[role]!);
                if (repo) acc[role] = { owner: repo.owner, name: repo.name, id: repo.id };
                return acc;
            },
            {} as NonNullable<GitHubConnectionDto['repos']>
        );
        if (Object.keys(repos).length !== 3) {
            return { error: '所选仓库信息不完整，请重新获取仓库列表。' };
        }
        return { repos };
    }, [discovered, manualRepos, selectedRoles, useManualRepos]);

    const handleSave = useCallback(async () => {
        const parsedInstallationId = parsePositiveInteger(installationId);
        if (!appId.trim() || !parsedInstallationId) {
            setMessage({ tone: 'warning', text: '请填写有效的 App ID 和安装 ID。' });
            return;
        }

        const reposResult = buildReposPayload();
        if ('error' in reposResult) {
            setMessage({ tone: 'warning', text: reposResult.error });
            return;
        }
        const repos = reposResult.repos;
        const roleKeys = (Object.keys(repos) as RepositoryRole[]).map((role) => {
            const repo = repos[role];
            return `${repo.owner}/${repo.name}`;
        });
        if (new Set(roleKeys).size !== 3) {
            setMessage({ tone: 'warning', text: '三个角色必须选择不同的仓库。' });
            return;
        }

        setIsSaving(true);
        setMessage({ tone: 'loading', text: '正在保存 GitHub 连接配置...' });
        try {
            const response = await fetch('/api/editor/github', {
                method: 'PUT',
                credentials: 'include',
                headers: createEditorCsrfHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    appId: appId.trim(),
                    installationId: parsedInstallationId,
                    repos: reposResult.repos,
                    ...(privateKeyPem.trim() ? { privateKeyPem: privateKeyPem.trim() } : {}),
                }),
            });
            const payload = await response.json().catch(() => null) as (GitHubConnectionDto & { message?: string }) | null;
            if (!response.ok || !payload) {
                throw new Error(readApiErrorMessage(payload, 'GitHub 连接配置保存失败。'));
            }
            setDto(payload);
            setPrivateKeyPem('');
            if (payload.status !== 'pending') {
                setMessage({ tone: 'info', text: STATUS_GUIDANCE[payload.status] });
                return;
            }
            setMessage({ tone: 'loading', text: '配置已保存，正在发起连接验证...' });
            const finalStatus = await startVerification();
            setMessage({
                tone: finalStatus === 'connected' ? 'success' : 'danger',
                text: finalStatus === 'connected'
                    ? 'GitHub 连接验证通过，发布工作台与 GitHub 备份现已可用。'
                    : `验证未通过（${STATUS_LABELS[finalStatus] ?? finalStatus}）。${STATUS_GUIDANCE[finalStatus] ?? ''} 修正后请重新保存并验证。`,
            });
        } catch (error) {
            setMessage({ tone: 'danger', text: error instanceof Error ? error.message : 'GitHub 连接配置保存失败。' });
        } finally {
            setIsSaving(false);
            isVerifyingRef.current = false;
        }
    }, [appId, buildReposPayload, installationId, privateKeyPem, startVerification]);

    const handleVerify = useCallback(async () => {
        if (isVerifyingRef.current) return;
        isVerifyingRef.current = true;
        setIsSaving(true);
        setMessage({ tone: 'loading', text: '正在验证 GitHub 连接...' });
        try {
            const finalStatus = await startVerification();
            setMessage({
                tone: finalStatus === 'connected' ? 'success' : 'danger',
                text: finalStatus === 'connected'
                    ? 'GitHub 连接验证通过。'
                    : `验证未通过（${STATUS_LABELS[finalStatus] ?? finalStatus}）。${STATUS_GUIDANCE[finalStatus] ?? ''}`,
            });
        } catch (error) {
            setMessage({ tone: 'danger', text: error instanceof Error ? error.message : '验证请求失败。' });
        } finally {
            setIsSaving(false);
            isVerifyingRef.current = false;
        }
    }, [startVerification]);

    const status = dto?.status ?? 'not_configured';
    const canVerify = status === 'pending' && !isSaving;

    return (
        <EditorPanel className="p-4">
            <section id={CONNECTION_ANCHOR_ID} aria-label="GitHub 连接配置">
                <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="flex items-start gap-3">
                        <div className="rounded-token-card border border-accent-200 bg-accent-50 p-2 text-accent">
                            <Cloud className="h-5 w-5" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-fg">GitHub 连接</h2>
                            <p className="mt-1 text-sm leading-6 text-muted">
                                发布到 GitHub Pages 和私有备份都依赖此连接：配置 GitHub App 与三个仓库（源码、Pages、备份），并验证通过后即可创建候选。
                            </p>
                        </div>
                    </div>
                    {expanded ? (
                        <EditorButton type="button" onClick={() => void loadConnection()} disabled={isLoading}>
                            <RefreshCcw className="h-4 w-4" />刷新状态
                        </EditorButton>
                    ) : (
                        <EditorButton type="button" variant="primary" onClick={handleExpand}>
                            展开配置
                        </EditorButton>
                    )}
                </div>

                {!expanded ? (
                    <>
                        <div className="mb-4 grid grid-cols-2 gap-3 rounded-token-card border border-border-soft bg-background p-3 text-sm md:grid-cols-4">
                            <div>
                                <p className="font-mono text-xs text-subtle">status</p>
                                <p className="mt-1 flex items-center gap-1 text-muted">
                                    {status === 'connected' ? <CheckCircle2 className="h-4 w-4 text-success" aria-label="已连接" /> : null}
                                    {isLoading && !dto ? '读取中…' : STATUS_LABELS[status]}
                                </p>
                            </div>
                            <div>
                                <p className="font-mono text-xs text-subtle">app id</p>
                                <p className="mt-1 break-all text-muted">{dto?.appId ?? '-'}</p>
                            </div>
                            <div>
                                <p className="font-mono text-xs text-subtle">installation</p>
                                <p className="mt-1 text-muted">{dto?.installationId ?? '-'}</p>
                            </div>
                            <div>
                                <p className="font-mono text-xs text-subtle">repos</p>
                                <p className="mt-1 text-muted">{dto?.repos ? '已配置' : '未配置'}</p>
                            </div>
                        </div>
                        <p className="text-sm text-muted">{STATUS_GUIDANCE[status]}</p>
                    </>
                ) : (
                    <>
                        {message ? <div className="mb-4"><StatusMessage tone={message.tone}>{message.text}</StatusMessage></div> : null}

                        <div className="mb-4 grid grid-cols-2 gap-3 rounded-token-card border border-border-soft bg-background p-3 text-sm md:grid-cols-4">
                            <div>
                                <p className="font-mono text-xs text-subtle">status</p>
                                <p className="mt-1 flex items-center gap-1 text-muted">
                                    {status === 'connected' ? <CheckCircle2 className="h-4 w-4 text-success" aria-label="已连接" /> : null}
                                    {STATUS_LABELS[status]}
                                </p>
                            </div>
                            <div>
                                <p className="font-mono text-xs text-subtle">app id</p>
                                <p className="mt-1 break-all text-muted">{dto?.appId ?? '-'}</p>
                            </div>
                            <div>
                                <p className="font-mono text-xs text-subtle">installation</p>
                                <p className="mt-1 text-muted">{dto?.installationId ?? '-'}</p>
                            </div>
                            <div>
                                <p className="font-mono text-xs text-subtle">private key</p>
                                <p className="mt-1 text-muted">{dto?.privateKeyConfigured ? '已保存' : '未保存'}</p>
                            </div>
                        </div>

                        {dto?.repos ? (
                            <p className="mb-4 break-all rounded-token-card border border-border-soft bg-background p-3 text-sm text-muted">
                                {formatRepos(dto.repos)}
                            </p>
                        ) : null}

                        {status !== 'not_configured' && status !== 'pending' ? (
                            <div className="mb-4">
                                <StatusMessage tone={status === 'connected' ? 'success' : 'warning'}>{STATUS_GUIDANCE[status]}</StatusMessage>
                            </div>
                        ) : null}

                        <div className="grid gap-4 md:grid-cols-2">
                            <div>
                                <label htmlFor="github-app-id" className="block text-sm font-medium text-fg">App ID</label>
                                <input
                                    id="github-app-id"
                                    value={appId}
                                    onChange={(event) => setAppId(event.target.value)}
                                    placeholder="GitHub App 设置页的 App ID（数字）"
                                    className={`${editorInputClassName} mt-2`}
                                />
                            </div>
                            <div>
                                <label htmlFor="github-installation-id" className="block text-sm font-medium text-fg">Installation ID</label>
                                <input
                                    id="github-installation-id"
                                    value={installationId}
                                    onChange={(event) => setInstallationId(event.target.value)}
                                    placeholder="安装后的 Installation ID（数字）"
                                    className={`${editorInputClassName} mt-2`}
                                />
                            </div>
                            <div className="md:col-span-2">
                                <label htmlFor="github-private-key" className="block text-sm font-medium text-fg">App 私钥（PEM）</label>
                                <textarea
                                    id="github-private-key"
                                    rows={4}
                                    value={privateKeyPem}
                                    onChange={(event) => setPrivateKeyPem(event.target.value)}
                                    placeholder={dto?.privateKeyConfigured ? '已保存过私钥，无需修改请留空' : '-----BEGIN RSA PRIVATE KEY-----'}
                                    className={`${editorInputClassName} mt-2 resize-y leading-6`}
                                />
                                <p className="mt-1 text-xs text-subtle">
                                    私钥加密保存在服务器且不会回显；获取仓库列表与保存都会使用此处粘贴的私钥。
                                </p>
                            </div>
                        </div>

                        <div className="mt-4 flex flex-wrap items-center gap-3">
                            <EditorButton type="button" onClick={() => void handleDiscover()} disabled={isResolving || isSaving}>
                                {isResolving ? '读取中...' : '获取可选仓库'}
                            </EditorButton>
                            <label className="flex items-center gap-2 text-sm text-muted">
                                <input
                                    type="checkbox"
                                    checked={useManualRepos}
                                    onChange={(event) => setUseManualRepos(event.target.checked)}
                                    className="h-4 w-4 rounded border-border text-accent focus:ring-link"
                                />
                                手动填写仓库（无法自动获取时）
                            </label>
                        </div>

                        {useManualRepos ? (
                            <div className="mt-4 grid gap-3">
                                <p className="text-xs leading-5 text-subtle">
                                    手动模式需要仓库的数字 ID：公开仓库可通过 https://api.github.com/repos/&lt;owner&gt;/&lt;name&gt; 查询；私有仓库需在已登录 GitHub 的环境中查询。三个仓库必须互不相同。
                                </p>
                                {(Object.keys(ROLE_LABELS) as RepositoryRole[]).map((role) => (
                                    <div key={role} className="grid gap-2 rounded-token-card border border-border-soft bg-background p-3 md:grid-cols-[110px_1fr_1fr_140px]">
                                        <p className="self-center text-sm font-medium text-fg">{ROLE_LABELS[role]}</p>
                                        <input
                                            aria-label={`${ROLE_LABELS[role]} owner`}
                                            value={manualRepos[role].owner}
                                            onChange={(event) => setManualRepos((current) => ({ ...current, [role]: { ...current[role], owner: event.target.value } }))}
                                            placeholder="owner"
                                            className={editorInputClassName}
                                        />
                                        <input
                                            aria-label={`${ROLE_LABELS[role]} name`}
                                            value={manualRepos[role].name}
                                            onChange={(event) => setManualRepos((current) => ({ ...current, [role]: { ...current[role], name: event.target.value } }))}
                                            placeholder="name"
                                            className={editorInputClassName}
                                        />
                                        <input
                                            aria-label={`${ROLE_LABELS[role]} 数字 ID`}
                                            value={manualRepos[role].id}
                                            onChange={(event) => setManualRepos((current) => ({ ...current, [role]: { ...current[role], id: event.target.value } }))}
                                            placeholder="数字 ID"
                                            className={editorInputClassName}
                                        />
                                    </div>
                                ))}
                            </div>
                        ) : discovered.length > 0 ? (
                            <div className="mt-4 overflow-x-auto">
                                <table className="w-full text-sm">
                                    <caption className="sr-only">选择各角色使用的仓库</caption>
                                    <thead>
                                        <tr className="text-left text-xs text-subtle">
                                            <th scope="col" className="py-2">仓库</th>
                                            <th scope="col" className="py-2">属性</th>
                                            {(['source', 'pages', 'backup'] as RepositoryRole[]).map((role) => (
                                                <th scope="col" key={role} className="py-2">{ROLE_LABELS[role]}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {discovered.map((repo) => (
                                            <tr key={repo.id} className="border-t border-border-soft">
                                                <td className="py-2 pr-3 font-mono text-xs text-fg">{repo.owner}/{repo.name}</td>
                                                <td className="py-2 pr-3 text-xs text-muted">
                                                    {repo.isPrivate ? '私有' : '公开'} · 默认分支 {repo.defaultBranch}
                                                </td>
                                                {(['source', 'pages', 'backup'] as RepositoryRole[]).map((role) => (
                                                    <td key={role} className="py-2 pr-3">
                                                        <input
                                                            type="radio"
                                                            name={`github-role-${role}`}
                                                            aria-label={`将 ${repo.owner}/${repo.name} 用作${ROLE_LABELS[role]}`}
                                                            checked={selectedRoles[role] === repo.id}
                                                            onChange={() => setSelectedRoles((current) => ({ ...current, [role]: repo.id }))}
                                                        />
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : null}

                        <div className="mt-4 flex flex-wrap gap-2">
                            <EditorButton type="button" variant="primary" onClick={() => void handleSave()} disabled={isSaving}>
                                <Save className="h-4 w-4" />
                                {isSaving ? '处理中...' : status === 'pending' ? '保存并重新验证' : '保存并验证'}
                            </EditorButton>
                            <EditorButton type="button" onClick={() => void handleVerify()} disabled={!canVerify}
                                title={canVerify ? undefined : '仅“待验证”状态可直接验证；其他状态请先重新保存。'}>
                                验证连接
                            </EditorButton>
                        </div>
                    </>
                )}
            </section>
        </EditorPanel>
    );
}
