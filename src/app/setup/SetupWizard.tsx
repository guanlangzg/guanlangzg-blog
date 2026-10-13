'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Database, KeyRound, Save, ShieldCheck } from 'lucide-react';
import { StatusMessage } from '@/app/components/ui';
import {
    EditorButton,
    EditorMain,
    EditorPage,
    EditorPanel,
    EditorTopBar,
    editorInputClassName,
} from '@/app/editor/components/EditorShell';
import { createEditorCsrfHeaders } from '@/app/editor/editor-csrf';

type RuntimeForm = {
    publicSiteUrl: string;
    cookieSecure: boolean;
    trustedProxyIps: string;
};

type SetupResponse = {
    authConfigured?: boolean;
    setupEnabled?: boolean;
    setupTokenRequired?: boolean;
    editable?: {
        publicSiteUrl: string;
        cookieSecure: boolean;
        trustedProxyIps: string[];
    };
    message?: string;
};

type SetupMessage = {
    tone: 'success' | 'danger' | 'loading' | 'info';
    text: string;
};

function createEmptyRuntimeForm(): RuntimeForm {
    return {
        publicSiteUrl: '',
        cookieSecure: true,
        trustedProxyIps: '',
    };
}

function Field({
    id,
    label,
    value,
    onChange,
    type = 'text',
    multiline = false,
}: {
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    type?: 'text' | 'password';
    multiline?: boolean;
}) {
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
                    className={`${editorInputClassName} mt-2 resize-y leading-6`}
                />
            ) : (
                <input
                    id={id}
                    type={type}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    className={`${editorInputClassName} mt-2`}
                />
            )}
        </div>
    );
}

function Toggle({
    label,
    checked,
    onChange,
    danger = false,
}: {
    label: string;
    checked: boolean;
    onChange: (value: boolean) => void;
    danger?: boolean;
}) {
    return (
        <label className={`flex items-start gap-3 rounded-token-card border px-3 py-3 text-sm transition focus-within:ring-2 focus-within:ring-link/20 ${danger ? 'border-error-light bg-error-50 text-error-600' : 'border-border-soft bg-background text-muted'}`}>
            <input
                type="checkbox"
                checked={checked}
                onChange={(event) => onChange(event.target.checked)}
                className="mt-0.5 h-5 w-5 shrink-0 rounded border-border text-accent focus:ring-link"
            />
            <span className="font-medium">{label}</span>
        </label>
    );
}

export function SetupWizard({ nextPath }: { nextPath: string }) {
    const router = useRouter();
    const [runtimeForm, setRuntimeForm] = useState<RuntimeForm>(createEmptyRuntimeForm);
    const [authConfigured, setAuthConfigured] = useState(false);
    const [setupEnabled, setSetupEnabled] = useState(true);
    const [setupTokenRequired, setSetupTokenRequired] = useState(false);
    const [setupToken, setSetupToken] = useState('');
    const [editorSecret, setEditorSecret] = useState('');
    const [confirmEditorSecret, setConfirmEditorSecret] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [message, setMessage] = useState<SetupMessage | null>(null);

    useEffect(() => {
        let isMounted = true;

        async function loadSetup() {
            try {
                const response = await fetch('/api/setup', {
                    cache: 'no-store',
                    credentials: 'include',
                });
                const payload = (await response.json().catch(() => null)) as SetupResponse | null;

                if (!response.ok) {
                    throw new Error(payload?.message || '初始化状态加载失败。');
                }

                if (!isMounted) {
                    return;
                }

                setAuthConfigured(Boolean(payload?.authConfigured));
                setSetupEnabled(payload?.setupEnabled !== false);
                setSetupTokenRequired(Boolean(payload?.setupTokenRequired));
                setRuntimeForm({
                    publicSiteUrl: payload?.editable?.publicSiteUrl ?? '',
                    cookieSecure: payload?.editable?.cookieSecure ?? true,
                    trustedProxyIps: payload?.editable?.trustedProxyIps?.join('\n') ?? '',
                });
            } catch (error) {
                if (isMounted) {
                    setMessage({
                        tone: 'danger',
                        text: error instanceof Error ? error.message : '初始化状态加载失败。',
                    });
                }
            } finally {
                if (isMounted) {
                    setIsLoading(false);
                }
            }
        }

        loadSetup();

        return () => {
            isMounted = false;
        };
    }, []);

    const updateRuntime = <Key extends keyof RuntimeForm>(key: Key, value: RuntimeForm[Key]) => {
        setRuntimeForm((current) => ({
            ...current,
            [key]: value,
        }));
    };

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!authConfigured && !setupEnabled) {
            setMessage({
                tone: 'danger',
                text: '服务器未开启网页首次初始化，请先配置 EDITOR_RUNTIME_AUTH_SETUP_TOKEN 或 EDITOR_ACCESS_TOKEN。',
            });
            return;
        }

        if (!authConfigured && editorSecret.trim().length < 12) {
            setMessage({ tone: 'danger', text: '编辑口令至少需要 12 个字符。' });
            return;
        }

        if (editorSecret.trim() !== confirmEditorSecret.trim()) {
            setMessage({ tone: 'danger', text: '两次输入的编辑口令不一致。' });
            return;
        }

        setIsSaving(true);
        setMessage({ tone: 'loading', text: '正在写入首次启动配置...' });

        try {
            const response = await fetch('/api/setup', {
                method: 'PUT',
                credentials: 'include',
                headers: createEditorCsrfHeaders({
                    'Content-Type': 'application/json',
                }),
                body: JSON.stringify({
                    config: {
                        ...runtimeForm,
                        trustedProxyIps: runtimeForm.trustedProxyIps,
                    },
                    editorSecret: editorSecret.trim(),
                    confirmEditorSecret: confirmEditorSecret.trim(),
                    setupToken: setupToken.trim(),
                }),
            });
            const payload = (await response.json().catch(() => null)) as SetupResponse | null;

            if (!response.ok) {
                throw new Error(payload?.message || '首次启动初始化失败。');
            }

            router.replace(nextPath);
            router.refresh();
        } catch (error) {
            setMessage({
                tone: 'danger',
                text: error instanceof Error ? error.message : '首次启动初始化失败。',
            });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <EditorPage className="pb-12">
            <EditorTopBar
                title="首次启动引导"
                description="初始化运行时配置和编辑口令"
                eyebrow="setup"
                width="lg"
                actions={(
                    <EditorButton
                        type="submit"
                        form="setup-form"
                        variant="primary"
                        disabled={isLoading || isSaving || (!authConfigured && !setupEnabled)}
                    >
                        <Save className="h-4 w-4" />
                        {isSaving ? '保存中...' : '完成初始化'}
                    </EditorButton>
                )}
            />

            <EditorMain width="lg" className="space-y-4">
                {message ? (
                    <StatusMessage tone={message.tone}>{message.text}</StatusMessage>
                ) : null}

                {isLoading ? (
                    <EditorPanel className="p-4">
                        <div className="animate-pulse text-sm text-subtle">加载初始化配置...</div>
                    </EditorPanel>
                ) : (
                    <form id="setup-form" onSubmit={handleSubmit} className="grid gap-4">
                        <EditorPanel className="p-4">
                            <div className="mb-4 flex items-start gap-3">
                                <ShieldCheck className="mt-1 h-5 w-5 text-accent" />
                                <div>
                                    <h2 className="text-lg font-semibold text-fg">基础运行时变量</h2>
                                    <p className="mt-1 text-sm leading-6 text-muted">对应 NEXT_PUBLIC_SITE_URL、COOKIE_SECURE 和 TRUSTED_PROXY_IPS。</p>
                                </div>
                            </div>
                            <div className="grid gap-4 md:grid-cols-2">
                                <Field id="setup-public-site-url" label="公开站点 URL" value={runtimeForm.publicSiteUrl} onChange={(value) => updateRuntime('publicSiteUrl', value)} />
                                <div className="md:col-span-2">
                                    <Field id="setup-trusted-proxy-ips" label="可信代理 IP" value={runtimeForm.trustedProxyIps} onChange={(value) => updateRuntime('trustedProxyIps', value)} multiline />
                                </div>
                                <Toggle label="启用安全 Cookie" checked={runtimeForm.cookieSecure} onChange={(value) => updateRuntime('cookieSecure', value)} />
                            </div>
                        </EditorPanel>

                        <EditorPanel className="p-4">
                            <div className="mb-4 flex items-start gap-3">
                                <KeyRound className="mt-1 h-5 w-5 text-accent" />
                                <div>
                                    <h2 className="text-lg font-semibold text-fg">编辑口令</h2>
                                    <p className="mt-1 text-sm leading-6 text-muted">对应 EDITOR_ACCESS_TOKEN，保存为服务器运行时口令哈希。</p>
                                </div>
                            </div>
                            {!authConfigured && !setupEnabled ? (
                                <StatusMessage tone="danger">
                                    当前服务器未开启网页首次初始化。生产环境请先配置
                                    {' '}
                                    <code className="rounded border border-border-soft bg-surface px-1 py-0.5 font-mono text-xs">EDITOR_RUNTIME_AUTH_SETUP_TOKEN</code>
                                    ，或直接提供
                                    {' '}
                                    <code className="rounded border border-border-soft bg-surface px-1 py-0.5 font-mono text-xs">EDITOR_ACCESS_TOKEN</code>
                                    。
                                </StatusMessage>
                            ) : null}
                            <div className="grid gap-4 md:grid-cols-2">
                                {setupTokenRequired ? (
                                    <div className="md:col-span-2">
                                        <Field id="setup-token" label="初始化密钥" value={setupToken} onChange={setSetupToken} type="password" />
                                    </div>
                                ) : null}
                                <Field id="setup-editor-secret" label={authConfigured ? '新的编辑口令' : '编辑口令'} value={editorSecret} onChange={setEditorSecret} type="password" />
                                <Field id="setup-confirm-editor-secret" label="确认编辑口令" value={confirmEditorSecret} onChange={setConfirmEditorSecret} type="password" />
                            </div>
                        </EditorPanel>

                        <EditorPanel className="p-3">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div className="flex items-start gap-2">
                                    <Database className="mt-0.5 h-4 w-4 text-accent" />
                                    <p className="text-sm leading-6 text-muted">
                                        数据目录变更会写入待生效状态，重启后按部署配置切换。
                                    </p>
                                </div>
                                <EditorButton type="submit" variant="primary" disabled={isSaving}>
                                    <Save className="h-4 w-4" />
                                    {isSaving ? '保存中...' : '完成初始化'}
                                </EditorButton>
                            </div>
                        </EditorPanel>
                    </form>
                )}
            </EditorMain>
        </EditorPage>
    );
}
