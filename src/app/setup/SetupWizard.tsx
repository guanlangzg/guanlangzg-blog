'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Cloud, Database, KeyRound, Save, ShieldCheck } from 'lucide-react';
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

type R2Form = {
    enabled: boolean;
    accountId: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
    endpoint: string;
    snapshotOnWrite: boolean;
};

type R2SetupMode = 'manual' | 'cloudflare';

type CloudflareR2SetupForm = {
    authEmail: string;
    globalApiKey: string;
    accountId: string;
    bucket: string;
    prefix: string;
    snapshotOnWrite: boolean;
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
    r2Settings?: {
        enabled: boolean;
        accountId: string;
        bucket: string;
        prefix: string;
        endpoint: string;
        snapshotOnWrite: boolean;
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

function createEmptyR2Form(): R2Form {
    return {
        enabled: false,
        accountId: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: '',
        prefix: 'blog-navigation',
        endpoint: '',
        snapshotOnWrite: false,
    };
}

function createEmptyCloudflareR2SetupForm(): CloudflareR2SetupForm {
    return {
        authEmail: '',
        globalApiKey: '',
        accountId: '',
        bucket: 'blog-navigation',
        prefix: 'blog-navigation',
        snapshotOnWrite: false,
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
    const [r2Form, setR2Form] = useState<R2Form>(createEmptyR2Form);
    const [r2SetupMode, setR2SetupMode] = useState<R2SetupMode>('cloudflare');
    const [cloudflareR2SetupForm, setCloudflareR2SetupForm] = useState<CloudflareR2SetupForm>(createEmptyCloudflareR2SetupForm);
    const [r2RiskAccepted, setR2RiskAccepted] = useState(false);
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
                const loadedR2Form = {
                    ...createEmptyR2Form(),
                    enabled: Boolean(payload?.r2Settings?.enabled),
                    accountId: payload?.r2Settings?.accountId ?? '',
                    bucket: payload?.r2Settings?.bucket ?? '',
                    prefix: payload?.r2Settings?.prefix ?? 'blog-navigation',
                    endpoint: payload?.r2Settings?.endpoint ?? '',
                    snapshotOnWrite: Boolean(payload?.r2Settings?.snapshotOnWrite),
                };
                setR2Form(loadedR2Form);
                setCloudflareR2SetupForm({
                    ...createEmptyCloudflareR2SetupForm(),
                    accountId: loadedR2Form.accountId,
                    bucket: loadedR2Form.bucket || 'blog-navigation',
                    prefix: loadedR2Form.prefix || 'blog-navigation',
                    snapshotOnWrite: loadedR2Form.snapshotOnWrite,
                });
                setR2RiskAccepted(false);
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

    const updateR2 = <Key extends keyof R2Form>(key: Key, value: R2Form[Key]) => {
        setR2Form((current) => ({
            ...current,
            [key]: value,
        }));

        if (key === 'enabled' && value === true) {
            setR2RiskAccepted(false);
        }
    };

    const updateCloudflareR2Setup = <Key extends keyof CloudflareR2SetupForm>(key: Key, value: CloudflareR2SetupForm[Key]) => {
        setCloudflareR2SetupForm((current) => ({
            ...current,
            [key]: value,
        }));
    };

    const handleAcceptR2Risk = () => {
        if (!window.confirm('数据风险：未配置 R2 备份，磁盘故障将导致全部内容丢失。确定跳过远端备份吗？')) {
            return;
        }

        setR2RiskAccepted(true);
        setR2Form((current) => ({
            ...current,
            enabled: false,
            accessKeyId: '',
            secretAccessKey: '',
        }));
    };

    const createR2Payload = () => {
        if (!r2Form.enabled) {
            return {
                r2SetupMode: 'disabled',
                r2Settings: {
                    ...r2Form,
                    enabled: false,
                    accessKeyId: '',
                    secretAccessKey: '',
                },
            };
        }

        if (r2SetupMode === 'cloudflare') {
            return {
                r2SetupMode,
                cloudflareR2Setup: cloudflareR2SetupForm,
            };
        }

        return {
            r2SetupMode,
            r2Settings: r2Form,
        };
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

        if (!r2Form.enabled && !r2RiskAccepted) {
            setMessage({ tone: 'danger', text: '请配置 R2 远端备份，或点击“跳过并接受风险”。' });
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
                    ...createR2Payload(),
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
                description="初始化运行时配置、编辑口令和远端备份"
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

                        <EditorPanel className="p-4">
                            <div className="mb-4 flex items-start gap-3">
                                <Cloud className="mt-1 h-5 w-5 text-accent" />
                                <div>
                                    <h2 className="text-lg font-semibold text-fg">Cloudflare R2 变量</h2>
                                    <p className="mt-1 text-sm leading-6 text-muted">对应 R2_BACKUP_ENABLED、R2_ACCOUNT_ID、R2_BUCKET、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY、R2_PREFIX、R2_ENDPOINT 和 R2_SNAPSHOT_ON_WRITE；备份会以明文 JSON 写入 R2。</p>
                                </div>
                            </div>
                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="md:col-span-2">
                                    <Toggle label="启用 R2 远端备份" checked={r2Form.enabled} onChange={(value) => updateR2('enabled', value)} />
                                </div>
                                {r2Form.enabled ? (
                                    <div className="md:col-span-2 grid gap-3 rounded-token-card border border-border-soft bg-background/70 p-3">
                                        <div className="flex flex-col gap-2 sm:flex-row">
                                            <EditorButton type="button" variant={r2SetupMode === 'cloudflare' ? 'primary' : 'secondary'} onClick={() => setR2SetupMode('cloudflare')}>
                                                一键配置 Cloudflare R2
                                            </EditorButton>
                                            <EditorButton type="button" variant={r2SetupMode === 'manual' ? 'primary' : 'secondary'} onClick={() => setR2SetupMode('manual')}>
                                                手动填写 R2 变量
                                            </EditorButton>
                                        </div>
                                        <p className="text-xs leading-5 text-subtle">
                                            一键配置会临时使用 Cloudflare 邮箱和 Global API Key 创建 bucket 与 R2 专用凭证，初始化完成后不会保存 Global API Key。
                                        </p>
                                    </div>
                                ) : (
                                    <div className="md:col-span-2 grid gap-3 rounded-token-card border border-error-light bg-error-50 px-3 py-3 text-sm leading-6 text-error-600">
                                        <p className="font-medium">数据风险：未配置 R2 备份，磁盘故障将导致全部内容丢失。</p>
                                        <div className="flex flex-col gap-2 sm:flex-row">
                                            <EditorButton type="button" variant="primary" onClick={() => updateR2('enabled', true)}>
                                                配置 R2 备份
                                            </EditorButton>
                                            <EditorButton type="button" variant="danger" onClick={handleAcceptR2Risk}>
                                                跳过并接受风险
                                            </EditorButton>
                                        </div>
                                        {r2RiskAccepted ? (
                                            <p>已确认跳过 R2 备份风险，本次初始化将只保存本地数据。</p>
                                        ) : null}
                                    </div>
                                )}
                                {r2Form.enabled && r2SetupMode === 'cloudflare' ? (
                                    <>
                                        <Field id="setup-cloudflare-auth-email" label="Cloudflare 邮箱" value={cloudflareR2SetupForm.authEmail} onChange={(value) => updateCloudflareR2Setup('authEmail', value)} />
                                        <Field id="setup-cloudflare-global-api-key" label="Global API Key" value={cloudflareR2SetupForm.globalApiKey} onChange={(value) => updateCloudflareR2Setup('globalApiKey', value)} type="password" />
                                        <Field id="setup-cloudflare-account-id" label="Account ID" value={cloudflareR2SetupForm.accountId} onChange={(value) => updateCloudflareR2Setup('accountId', value)} />
                                        <Field id="setup-cloudflare-bucket" label="Bucket" value={cloudflareR2SetupForm.bucket} onChange={(value) => updateCloudflareR2Setup('bucket', value)} />
                                        <Field id="setup-cloudflare-prefix" label="对象前缀" value={cloudflareR2SetupForm.prefix} onChange={(value) => updateCloudflareR2Setup('prefix', value)} />
                                        <Toggle label="每次写入都创建 snapshot" checked={cloudflareR2SetupForm.snapshotOnWrite} onChange={(value) => updateCloudflareR2Setup('snapshotOnWrite', value)} />
                                    </>
                                ) : null}
                                {r2Form.enabled && r2SetupMode === 'manual' ? (
                                    <>
                                        <Field id="setup-r2-account-id" label="Account ID" value={r2Form.accountId} onChange={(value) => updateR2('accountId', value)} />
                                        <Field id="setup-r2-bucket" label="Bucket" value={r2Form.bucket} onChange={(value) => updateR2('bucket', value)} />
                                        <Field id="setup-r2-access-key-id" label="Access Key ID" value={r2Form.accessKeyId} onChange={(value) => updateR2('accessKeyId', value)} />
                                        <Field id="setup-r2-secret-access-key" label="Secret Access Key" value={r2Form.secretAccessKey} onChange={(value) => updateR2('secretAccessKey', value)} type="password" />
                                        <Field id="setup-r2-prefix" label="对象前缀" value={r2Form.prefix} onChange={(value) => updateR2('prefix', value)} />
                                        <Field id="setup-r2-endpoint" label="Endpoint" value={r2Form.endpoint} onChange={(value) => updateR2('endpoint', value)} />
                                        <Toggle label="每次写入都创建 snapshot" checked={r2Form.snapshotOnWrite} onChange={(value) => updateR2('snapshotOnWrite', value)} />
                                    </>
                                ) : null}
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
