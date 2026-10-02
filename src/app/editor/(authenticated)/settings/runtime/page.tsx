'use client';

import { useCallback, useEffect, useState } from 'react';
import { Info, KeyRound, Save, ShieldCheck } from 'lucide-react';
import { StatusMessage } from '@/app/components/ui';
import type { AppVersionInfo } from '@/lib/app-version';
import { createEditorCsrfHeaders } from '../../../editor-csrf';
import { LogoutButton } from '../../../components/LogoutButton';
import {
    EditorButton,
    EditorMain,
    EditorPage,
    EditorPanel,
    EditorTopBar,
    editorInputClassName,
} from '../../../components/EditorShell';

type RuntimeConfigResponse = {
    editable?: RuntimeFormPayload;
    revision?: string | null;
    version?: AppVersionInfo;
    message?: string;
};

type RuntimeForm = {
    publicSiteUrl: string;
    cookieSecure: boolean;
    trustedProxyIps: string;
    editorSecret: string;
    confirmEditorSecret: string;
};

type RuntimeFormPayload = {
    publicSiteUrl: string;
    cookieSecure: boolean;
    trustedProxyIps: string[];
};

type RuntimeMessage = {
    tone: 'success' | 'danger' | 'loading' | 'info';
    text: string;
};

type RuntimeFieldError = {
    text: string;
};

function createEmptyRuntimeForm(): RuntimeForm {
    return {
        publicSiteUrl: '',
        cookieSecure: true,
        trustedProxyIps: '',
        editorSecret: '',
        confirmEditorSecret: '',
    };
}

function toRuntimeForm(
    editable?: RuntimeFormPayload,
    secrets?: Pick<RuntimeForm, 'editorSecret' | 'confirmEditorSecret'>
): RuntimeForm {
    return {
        publicSiteUrl: editable?.publicSiteUrl ?? '',
        cookieSecure: editable?.cookieSecure ?? true,
        trustedProxyIps: editable?.trustedProxyIps.join('\n') ?? '',
        editorSecret: secrets?.editorSecret ?? '',
        confirmEditorSecret: secrets?.confirmEditorSecret ?? '',
    };
}

function RuntimeField({
    id,
    label,
    help,
    value,
    onChange,
    type = 'text',
    multiline = false,
    error,
}: {
    id: string;
    label: string;
    help: string;
    value: string;
    onChange: (value: string) => void;
    type?: 'text' | 'password';
    multiline?: boolean;
    error?: RuntimeFieldError | null;
}) {
    const descriptionId = `${id}-description`;
    const errorId = `${id}-error`;
    const describedBy = error ? `${descriptionId} ${errorId}` : descriptionId;

    return (
        <div>
            <label htmlFor={id} className="block text-sm font-medium text-fg">
                {label}
            </label>
            {multiline ? (
                <textarea
                    id={id}
                    value={value}
                    rows={4}
                    onChange={(event) => onChange(event.target.value)}
                    aria-describedby={describedBy}
                    aria-invalid={Boolean(error)}
                    className={`${editorInputClassName} mt-2 resize-y leading-6`}
                />
            ) : (
                <input
                    id={id}
                    type={type}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    aria-describedby={describedBy}
                    aria-invalid={Boolean(error)}
                    className={`${editorInputClassName} mt-2`}
                />
            )}
            <p id={descriptionId} className="mt-1.5 text-xs leading-5 text-subtle">
                {help}
            </p>
            {error ? (
                <p id={errorId} className="mt-1.5 text-xs leading-5 text-error-600" role="alert">
                    {error.text}
                </p>
            ) : null}
        </div>
    );
}

function RuntimeToggle({
    id,
    label,
    help,
    checked,
    onChange,
}: {
    id: string;
    label: string;
    help: string;
    checked: boolean;
    onChange: (value: boolean) => void;
}) {
    const descriptionId = `${id}-description`;

    return (
        <label
            htmlFor={id}
            className="flex items-start gap-3 rounded-token-card border border-border-soft bg-background p-3 text-sm text-muted transition focus-within:border-link focus-within:ring-2 focus-within:ring-link/20"
        >
            <input
                id={id}
                type="checkbox"
                checked={checked}
                onChange={(event) => onChange(event.target.checked)}
                aria-describedby={descriptionId}
                className="mt-0.5 h-5 w-5 shrink-0 rounded border-border text-accent focus:ring-link"
            />
            <span>
                <span className="block font-medium text-fg">{label}</span>
                <span id={descriptionId} className="mt-1 block text-xs leading-5 text-subtle">
                    {help}
                </span>
            </span>
        </label>
    );
}

function formatVersionValue(value: string | null | undefined): string {
    return value?.trim() || '未注入';
}

function formatRevision(value: string | null | undefined): string {
    const revision = value?.trim();

    return revision ? revision.slice(0, 12) : '未注入';
}

export default function RuntimeSettingsPage() {
    const [form, setForm] = useState<RuntimeForm>(createEmptyRuntimeForm);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [revision, setRevision] = useState<string | null>(null);
    const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
    const [message, setMessage] = useState<RuntimeMessage | null>(null);
    const [confirmSecretError, setConfirmSecretError] = useState<RuntimeFieldError | null>(null);

    useEffect(() => {
        let isMounted = true;

        async function loadRuntimeConfig() {
            try {
                const response = await fetch('/api/runtime-config', {
                    credentials: 'include',
                    cache: 'no-store',
                });
                const payload = (await response.json().catch(() => null)) as RuntimeConfigResponse | null;

                if (!response.ok) {
                    throw new Error(payload?.message || '运行时配置加载失败。');
                }

                if (!isMounted) {
                    return;
                }

                setForm(toRuntimeForm(payload?.editable));
                setRevision(payload?.revision ?? null);
                setVersionInfo(payload?.version ?? null);
            } catch (error) {
                if (isMounted) {
                    setMessage({
                        tone: 'danger',
                        text: error instanceof Error ? error.message : '运行时配置加载失败。',
                    });
                }
            } finally {
                if (isMounted) {
                    setIsLoading(false);
                }
            }
        }

        loadRuntimeConfig();

        return () => {
            isMounted = false;
        };
    }, []);

    const updateField = useCallback(<Key extends keyof RuntimeForm>(key: Key, value: RuntimeForm[Key]) => {
        if (key === 'editorSecret' || key === 'confirmEditorSecret') {
            setConfirmSecretError(null);
        }

        setForm((current) => ({
            ...current,
            [key]: value,
        }));
    }, []);

    const handleSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (form.editorSecret.trim() && form.editorSecret.trim() !== form.confirmEditorSecret.trim()) {
            const error = { text: '两次输入的编辑口令不一致。' };

            setConfirmSecretError(error);
            setMessage({ tone: 'danger', text: error.text });
            requestAnimationFrame(() => {
                document.getElementById('runtime-confirm-editor-secret')?.focus();
            });
            return;
        }

        setIsSaving(true);
        setConfirmSecretError(null);
        setMessage({ tone: 'loading', text: '正在保存运行时配置...' });

        try {
            const response = await fetch('/api/runtime-config', {
                method: 'PUT',
                credentials: 'include',
                headers: createEditorCsrfHeaders({
                    'Content-Type': 'application/json',
                }),
                body: JSON.stringify({
                    config: {
                        publicSiteUrl: form.publicSiteUrl,
                        cookieSecure: form.cookieSecure,
                        trustedProxyIps: form.trustedProxyIps,
                    },
                    editorSecret: form.editorSecret.trim(),
                    confirmEditorSecret: form.confirmEditorSecret.trim(),
                    revision,
                }),
            });
            const payload = (await response.json().catch(() => null)) as RuntimeConfigResponse | null;

            if (payload?.editable) {
                setForm((current) => toRuntimeForm(payload.editable, {
                    editorSecret: current.editorSecret,
                    confirmEditorSecret: current.confirmEditorSecret,
                }));
            }

            if (payload?.revision) {
                setRevision(payload.revision);
            }

            if (payload?.version) {
                setVersionInfo(payload.version);
            }

            if (!response.ok) {
                throw new Error(payload?.message || '运行时配置保存失败。');
            }

            setForm(toRuntimeForm(payload?.editable));
            setMessage({
                tone: 'success',
                text: '运行时配置已保存。',
            });
        } catch (error) {
            setMessage({
                tone: 'danger',
                text: error instanceof Error ? error.message : '运行时配置保存失败。',
            });
        } finally {
            setIsSaving(false);
        }
    }, [form, revision]);

    return (
        <EditorPage className="pb-12">
            <EditorTopBar
                title="运行时配置"
                description="管理环境变量对应的前端配置入口"
                eyebrow="editor.runtime"
                backHref="/editor/settings"
                width="lg"
                actions={(
                    <>
                        <LogoutButton />
                        <EditorButton
                            type="submit"
                            form="runtime-config-form"
                            variant="primary"
                            disabled={isLoading || isSaving}
                        >
                            <Save className="h-4 w-4" />
                            {isSaving ? '保存中...' : '保存配置'}
                        </EditorButton>
                    </>
                )}
            />

            <EditorMain width="lg" className="space-y-4">
                {message ? (
                    <StatusMessage tone={message.tone}>{message.text}</StatusMessage>
                ) : null}

                {isLoading ? (
                    <EditorPanel className="p-4">
                        <div className="animate-pulse text-sm text-subtle">加载运行时配置...</div>
                    </EditorPanel>
                ) : (
                    <>
                    {versionInfo ? (
                        <EditorPanel className="p-4">
                            <div className="mb-4 flex items-start gap-3">
                                <Info className="mt-1 h-5 w-5 text-accent" />
                                <div>
                                    <h2 className="text-lg font-semibold text-fg">版本信息</h2>
                                    <p className="mt-1 text-sm leading-6 text-muted">
                                        当前后台服务对应的项目版本和 Docker 镜像构建信息。
                                    </p>
                                </div>
                            </div>
                            <dl className="grid gap-3 text-sm md:grid-cols-2">
                                <div>
                                    <dt className="font-mono text-xs text-subtle">current</dt>
                                    <dd className="mt-1 break-all font-mono text-xs text-muted">
                                        {versionInfo.displayVersion}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="font-mono text-xs text-subtle">project</dt>
                                    <dd className="mt-1 break-all font-mono text-xs text-muted">
                                        {versionInfo.projectVersion}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="font-mono text-xs text-subtle">runtime</dt>
                                    <dd className="mt-1 text-muted">
                                        {versionInfo.runtime === 'docker' ? 'Docker 镜像' : '本地运行'}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="font-mono text-xs text-subtle">image tag</dt>
                                    <dd className="mt-1 break-all font-mono text-xs text-muted">
                                        {formatVersionValue(versionInfo.docker.imageTag)}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="font-mono text-xs text-subtle">revision</dt>
                                    <dd className="mt-1 break-all font-mono text-xs text-muted">
                                        {formatRevision(versionInfo.docker.revision)}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="font-mono text-xs text-subtle">build time</dt>
                                    <dd className="mt-1 break-all font-mono text-xs text-muted">
                                        {formatVersionValue(versionInfo.docker.buildTime)}
                                    </dd>
                                </div>
                            </dl>
                        </EditorPanel>
                    ) : null}

                    <form id="runtime-config-form" onSubmit={handleSubmit} className="grid gap-4">
                        <EditorPanel className="p-4">
                            <div className="mb-4 flex items-start gap-3">
                                <ShieldCheck className="mt-1 h-5 w-5 text-accent" />
                                <div>
                                    <h2 className="text-lg font-semibold text-fg">基础变量</h2>
                                    <p className="mt-1 text-sm leading-6 text-muted">
                                        对应 NEXT_PUBLIC_SITE_URL、COOKIE_SECURE 和 TRUSTED_PROXY_IPS。
                                    </p>
                                </div>
                            </div>
                            <div className="grid gap-4 md:grid-cols-2">
                                <RuntimeField
                                    id="runtime-public-site-url"
                                    label="公开站点 URL"
                                    help="保存后服务端生成 metadata、robots 和 sitemap 时使用。"
                                    value={form.publicSiteUrl}
                                    onChange={(value) => updateField('publicSiteUrl', value)}
                                />
                                <div className="md:col-span-2">
                                    <RuntimeField
                                        id="runtime-trusted-proxy-ips"
                                        label="可信代理 IP"
                                        help="每行一个 IP；生产环境登录和搜索限流会用它识别真实客户端。"
                                        value={form.trustedProxyIps}
                                        onChange={(value) => updateField('trustedProxyIps', value)}
                                        multiline
                                    />
                                </div>
                                <RuntimeToggle
                                    id="runtime-cookie-secure"
                                    label="启用安全 Cookie"
                                    help="关闭后适合 HTTP 部署；修改后下一次登录设置 Cookie 时生效。"
                                    checked={form.cookieSecure}
                                    onChange={(value) => updateField('cookieSecure', value)}
                                />
                            </div>
                        </EditorPanel>

                        <EditorPanel className="p-4">
                            <div className="mb-4 flex items-start gap-3">
                                <KeyRound className="mt-1 h-5 w-5 text-accent" />
                                <div>
                                    <h2 className="text-lg font-semibold text-fg">编辑口令</h2>
                                    <p className="mt-1 text-sm leading-6 text-muted">
                                        对应 EDITOR_ACCESS_TOKEN；留空表示不修改当前口令。
                                    </p>
                                </div>
                            </div>
                            <div className="grid gap-4 md:grid-cols-2">
                                <RuntimeField
                                    id="runtime-editor-secret"
                                    label="新的编辑口令"
                                    help="至少 12 个字符；保存后会刷新当前会话。"
                                    value={form.editorSecret}
                                    onChange={(value) => updateField('editorSecret', value)}
                                    type="password"
                                />
                                <RuntimeField
                                    id="runtime-confirm-editor-secret"
                                    label="确认编辑口令"
                                    help="再次输入新的编辑口令。"
                                    value={form.confirmEditorSecret}
                                    onChange={(value) => updateField('confirmEditorSecret', value)}
                                    type="password"
                                    error={confirmSecretError}
                                />
                            </div>
                        </EditorPanel>
                    </form>
                    </>
                )}
            </EditorMain>
        </EditorPage>
    );
}
