import Link from 'next/link';

export default function NotFound() {
    return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
            <p className="font-mono text-sm text-accent">404</p>
            <h1 className="text-2xl font-semibold text-fg">页面未找到</h1>
            <p className="max-w-md text-sm leading-relaxed text-muted">
                你访问的页面不存在或已被移除。
            </p>
            <Link
                href="/"
                className="mt-2 inline-flex min-h-[44px] items-center rounded-token-button border border-border bg-surface px-4 py-2 text-sm font-medium text-fg transition hover:border-accent-300 hover:text-accent"
            >
                返回首页
            </Link>
        </div>
    );
}
