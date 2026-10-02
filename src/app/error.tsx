'use client';

import { useEffect } from 'react';

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error('[global-error]', error);
    }, [error]);

    return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
            <h1 className="text-2xl font-semibold text-fg">出现了一些问题</h1>
            <p className="max-w-md text-sm leading-relaxed text-muted">
                页面加载时发生了意外错误。请尝试刷新页面，如果问题持续存在，请稍后再试。
            </p>
            <button
                onClick={reset}
                className="mt-2 min-h-[44px] rounded-token-button border border-accent bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition hover:bg-accent-800"
            >
                重新加载
            </button>
        </div>
    );
}
