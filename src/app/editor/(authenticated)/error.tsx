'use client';

import { useEffect } from 'react';

export default function EditorError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error('[editor-error]', error);
    }, [error]);

    return (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 px-4 text-center">
            <p className="font-mono text-sm text-accent">editor.error</p>
            <h1 className="text-xl font-semibold text-fg">编辑器出现问题</h1>
            <p className="max-w-md text-sm leading-relaxed text-muted">
                编辑器加载时发生错误。你的本地数据不会丢失，请尝试重新加载。
            </p>
            <div className="flex flex-wrap justify-center gap-2">
                <button
                    onClick={reset}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-button border border-accent bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition hover:bg-accent-800 sm:min-h-10 sm:min-w-0"
                >
                    重新加载
                </button>
                <a
                    href="/editor"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-token-button border border-border bg-surface px-4 py-2 text-sm font-medium text-fg transition hover:border-accent-300 hover:text-accent sm:min-h-10 sm:min-w-0"
                >
                    返回编辑器首页
                </a>
            </div>
        </div>
    );
}
