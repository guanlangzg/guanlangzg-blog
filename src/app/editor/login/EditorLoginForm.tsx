'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { KeyRound, Lock, LogIn, SlidersHorizontal, Terminal } from 'lucide-react';
import { StatusMessage } from '@/app/components/ui';
import {
    EditorButton,
    EditorPage,
    EditorPanel,
    editorInputClassName,
} from '../components/EditorShell';

interface EditorLoginFormProps {
    authConfigured: boolean;
    setupEnabled: boolean;
    setupTokenRequired: boolean;
    nextPath: string;
    authErrorMessage?: string | null;
}

type SetupValidationField = 'token' | 'secret' | 'confirmSecret';

type SetupValidationError = {
    field: SetupValidationField;
    message: string;
};

const SETUP_FIELD_IDS: Record<SetupValidationField, string> = {
    token: 'editor-setup-token',
    secret: 'editor-setup-secret',
    confirmSecret: 'editor-setup-confirm-secret',
};

const RUNTIME_CONFIG_LOGIN_HREF = `/editor/login?next=${encodeURIComponent('/editor/settings/runtime')}`;

function focusField(id: string): void {
    window.requestAnimationFrame(() => {
        document.getElementById(id)?.focus();
    });
}

function EditorInitializationGuide() {
    return (
        <section
            className="rounded-token-card border border-border bg-warm-50 p-4"
            aria-labelledby="editor-initialization-title"
        >
            <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-token-card bg-warm-100 text-muted">
                    <Terminal className="h-4 w-4" />
                </div>
                <div>
                    <h2 id="editor-initialization-title" className="text-sm font-semibold text-fg">
                        初次使用初始化引导
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-muted">
                        设置成功后会写入服务器运行时配置文件，并立即创建登录会话。
                        之后回到本页输入这次设置的口令即可进入编辑区。
                    </p>
                </div>
            </div>
        </section>
    );
}

export function EditorLoginForm({
    authConfigured,
    setupEnabled,
    setupTokenRequired,
    nextPath,
    authErrorMessage = null,
}: EditorLoginFormProps) {
    const router = useRouter();
    const [secret, setSecret] = useState('');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [setupSecret, setSetupSecret] = useState('');
    const [setupConfirmSecret, setSetupConfirmSecret] = useState('');
    const [setupToken, setSetupToken] = useState('');
    const [setupValidationError, setSetupValidationError] = useState<SetupValidationError | null>(null);
    const [isInitializing, setIsInitializing] = useState(false);
    const setupErrorMessage = setupValidationError?.message ?? null;

    const setSetupFieldValue = (
        field: SetupValidationField,
        setter: (value: string) => void,
        value: string
    ) => {
        setter(value);
        setSetupValidationError((current) => current?.field === field ? null : current);
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!authConfigured || !secret.trim()) {
            return;
        }

        setIsSubmitting(true);
        setErrorMessage(null);

        try {
            const response = await fetch('/api/editor-auth', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ secret }),
            });

            if (!response.ok) {
                const payload = await response.json().catch(() => null);
                throw new Error(payload?.message ?? '登录失败，请稍后重试。');
            }

            router.replace(nextPath);
            router.refresh();
        } catch (error) {
            setErrorMessage(
                error instanceof Error ? error.message : '登录失败，请稍后重试。'
            );
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleInitialize = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const normalizedSecret = setupSecret.trim();

        if (normalizedSecret.length < 12) {
            const validationError = {
                field: 'secret',
                message: '编辑口令至少需要 12 个字符。',
            } satisfies SetupValidationError;

            setSetupValidationError(validationError);
            focusField(SETUP_FIELD_IDS[validationError.field]);
            return;
        }

        if (normalizedSecret !== setupConfirmSecret.trim()) {
            const validationError = {
                field: 'confirmSecret',
                message: '两次输入的编辑口令不一致。',
            } satisfies SetupValidationError;

            setSetupValidationError(validationError);
            focusField(SETUP_FIELD_IDS[validationError.field]);
            return;
        }

        if (setupTokenRequired && !setupToken.trim()) {
            const validationError = {
                field: 'token',
                message: '请输入初始化密钥。',
            } satisfies SetupValidationError;

            setSetupValidationError(validationError);
            focusField(SETUP_FIELD_IDS[validationError.field]);
            return;
        }

        setIsInitializing(true);
        setSetupValidationError(null);

        try {
            const response = await fetch('/api/editor-auth', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    secret: normalizedSecret,
                    confirmSecret: setupConfirmSecret.trim(),
                    setupToken: setupToken.trim(),
                }),
            });

            if (!response.ok) {
                const payload = await response.json().catch(() => null);
                throw new Error(payload?.message ?? '初始化失败，请稍后重试。');
            }

            router.replace(nextPath);
            router.refresh();
        } catch (error) {
            setSetupValidationError({
                field: 'confirmSecret',
                message: error instanceof Error ? error.message : '初始化失败，请稍后重试。',
            });
            focusField(SETUP_FIELD_IDS.confirmSecret);
        } finally {
            setIsInitializing(false);
        }
    };

    return (
        <EditorPage className="flex items-center justify-center px-4 py-8">
            <EditorPanel className="w-full max-w-md p-6 sm:p-8">
                <div className="flex items-center gap-3 text-fg">
                    <div className="flex h-11 w-11 items-center justify-center rounded-token-card border border-accent-200 bg-accent-50 text-accent">
                        <Lock className="h-5 w-5" />
                    </div>
                    <div>
                        <h1 className="text-xl font-semibold">编辑区登录</h1>
                        <p className="mt-1 text-sm text-muted">
                            通过服务端校验后才可进入 `/editor/*`
                        </p>
                    </div>
                </div>

                {authErrorMessage ? (
                    <div className="mt-8 space-y-4">
                        <StatusMessage tone="danger">
                            {authErrorMessage}
                        </StatusMessage>
                    </div>
                ) : authConfigured ? (
                    <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
                        <div>
                            <label htmlFor="editor-login-secret" className="mb-2 block text-sm font-medium text-fg">
                                编辑口令
                            </label>
                            <input
                                id="editor-login-secret"
                                type="password"
                                value={secret}
                                onChange={(event) => setSecret(event.target.value)}
                                disabled={isSubmitting}
                                autoComplete="current-password"
                                aria-describedby={errorMessage ? 'editor-login-error' : undefined}
                                aria-invalid={Boolean(errorMessage)}
                                className={`${editorInputClassName} px-4 py-3`}
                                placeholder="输入编辑口令"
                            />
                        </div>

                        {errorMessage && (
                            <StatusMessage id="editor-login-error" tone="danger">
                                {errorMessage}
                            </StatusMessage>
                        )}

                        <EditorButton
                            type="submit"
                            disabled={isSubmitting || !secret.trim()}
                            className="w-full py-3"
                            variant="primary"
                        >
                            <LogIn className="h-4 w-4" />
                            <span>{isSubmitting ? '登录中...' : '进入编辑区'}</span>
                        </EditorButton>

                        <div className="border-t border-border-soft pt-4 text-sm leading-6 text-muted">
                            <div className="flex items-start gap-2">
                                <SlidersHorizontal className="mt-1 h-4 w-4 shrink-0 text-accent" />
                                <div>
                                    <p>公开站点 URL、Cookie、代理和数据目录在运行时配置里调整。</p>
                                    <Link
                                        href={RUNTIME_CONFIG_LOGIN_HREF}
                                        className="mt-2 inline-flex min-h-11 items-center rounded-token-card text-fg underline underline-offset-4 transition hover:bg-surface focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9"
                                    >
                                        登录后进入运行时配置
                                    </Link>
                                </div>
                            </div>
                        </div>
                    </form>
                ) : setupEnabled ? (
                    <form className="mt-8 space-y-4" onSubmit={handleInitialize}>
                        <StatusMessage tone="warning">
                            当前还没有初始化编辑口令。请在这里设置一个新口令，完成后会自动进入编辑区。
                        </StatusMessage>
                        <EditorInitializationGuide />

                        {setupTokenRequired ? (
                            <div>
                                <label htmlFor="editor-setup-token" className="mb-2 block text-sm font-medium text-fg">
                                    初始化密钥
                                </label>
                                <input
                                    id="editor-setup-token"
                                    type="password"
                                    value={setupToken}
                                    onChange={(event) => setSetupFieldValue('token', setSetupToken, event.target.value)}
                                    disabled={isInitializing}
                                    autoComplete="one-time-code"
                                    aria-describedby={setupValidationError?.field === 'token' ? 'editor-setup-error' : undefined}
                                    aria-invalid={setupValidationError?.field === 'token'}
                                    className={`${editorInputClassName} px-4 py-3`}
                                    placeholder="输入服务器配置的初始化密钥"
                                />
                            </div>
                        ) : null}

                        <div>
                            <label htmlFor="editor-setup-secret" className="mb-2 block text-sm font-medium text-fg">
                                设置编辑口令
                            </label>
                            <input
                                id="editor-setup-secret"
                                type="password"
                                value={setupSecret}
                                onChange={(event) => setSetupFieldValue('secret', setSetupSecret, event.target.value)}
                                disabled={isInitializing}
                                autoComplete="new-password"
                                aria-describedby={setupValidationError?.field === 'secret' ? 'editor-setup-error' : undefined}
                                aria-invalid={setupValidationError?.field === 'secret'}
                                className={`${editorInputClassName} px-4 py-3`}
                                placeholder="至少 12 个字符"
                            />
                        </div>

                        <div>
                            <label htmlFor="editor-setup-confirm-secret" className="mb-2 block text-sm font-medium text-fg">
                                确认编辑口令
                            </label>
                            <input
                                id="editor-setup-confirm-secret"
                                type="password"
                                value={setupConfirmSecret}
                                onChange={(event) => setSetupFieldValue('confirmSecret', setSetupConfirmSecret, event.target.value)}
                                disabled={isInitializing}
                                autoComplete="new-password"
                                aria-describedby={setupValidationError?.field === 'confirmSecret' ? 'editor-setup-error' : undefined}
                                aria-invalid={setupValidationError?.field === 'confirmSecret'}
                                className={`${editorInputClassName} px-4 py-3`}
                                placeholder="再次输入编辑口令"
                            />
                        </div>

                        {setupErrorMessage && (
                            <StatusMessage id="editor-setup-error" tone="danger">
                                {setupErrorMessage}
                            </StatusMessage>
                        )}

                        <EditorButton
                            type="submit"
                            disabled={
                                isInitializing ||
                                !setupSecret.trim() ||
                                !setupConfirmSecret.trim() ||
                                (setupTokenRequired && !setupToken.trim())
                            }
                            className="w-full py-3"
                            variant="primary"
                        >
                            <KeyRound className="h-4 w-4" />
                            <span>{isInitializing ? '初始化中...' : '初始化并进入编辑区'}</span>
                        </EditorButton>
                    </form>
                ) : (
                    <div className="mt-8 space-y-4">
                        <StatusMessage tone="danger">
                            编辑口令尚未初始化，且服务器未开启首次初始化。请先在服务器设置
                            <code className="mx-1 rounded border border-border-soft bg-surface px-1 py-0.5 font-mono text-xs">
                                EDITOR_RUNTIME_AUTH_SETUP_TOKEN
                            </code>
                            或配置
                            <code className="mx-1 rounded border border-border-soft bg-surface px-1 py-0.5 font-mono text-xs">
                                EDITOR_ACCESS_TOKEN
                            </code>
                            。
                        </StatusMessage>
                    </div>
                )}

                <div className="mt-6 text-sm text-muted">
                    <Link
                        href="/"
                        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-card px-3 text-fg underline underline-offset-4 transition hover:bg-surface focus:ring-2 focus:ring-link focus:ring-offset-2 sm:min-h-9 sm:min-w-0"
                    >
                        返回首页
                    </Link>
                </div>
            </EditorPanel>
        </EditorPage>
    );
}
