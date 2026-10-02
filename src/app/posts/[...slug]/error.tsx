'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function PostError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error('[post-error]', error);
    }, [error]);

    return (
        <div className="mx-auto max-w-3xl py-10">
            <Link
                href="/blog"
                className="mb-5 inline-flex min-h-[44px] items-center gap-2 rounded-token-button border border-border bg-surface px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-border-focus hover:text-fg"
            >
                返回归档
            </Link>
            <div className="rounded-token-card border border-border bg-surface p-6 text-center">
                <h1 className="text-xl font-semibold text-fg">文章加载失败</h1>
                <p className="mt-2 text-sm text-muted">
                    文章内容读取时发生错误，请尝试重新加载。
                </p>
                <button
                    onClick={reset}
                    className="mt-4 min-h-[44px] rounded-token-button border border-accent bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition hover:bg-accent-800"
                >
                    重新加载
                </button>
            </div>
        </div>
    );
}
