import Link from 'next/link';

export default function PostNotFound() {
    return (
        <div className="mx-auto max-w-3xl py-10">
            <Link
                href="/blog"
                className="mb-5 inline-flex min-h-[44px] items-center gap-2 rounded-token-button border border-border bg-surface px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-border-focus hover:text-fg"
            >
                返回归档
            </Link>
            <div className="rounded-token-card border border-border bg-surface p-6 text-center">
                <p className="font-mono text-sm text-accent">404</p>
                <h1 className="mt-2 text-xl font-semibold text-fg">文章未找到</h1>
                <p className="mt-2 text-sm text-muted">
                    这篇文章不存在或已被删除。
                </p>
            </div>
        </div>
    );
}
