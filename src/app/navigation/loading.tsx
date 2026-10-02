export default function NavigationLoading() {
    return (
        <div className="space-y-3 pb-8" role="status" aria-live="polite">
            <span className="sr-only">正在加载导航目录...</span>
            <header className="border-b border-border pb-3">
                <div className="mb-1.5 flex items-center gap-2">
                    <div className="h-4 w-32 animate-pulse rounded bg-surface" />
                    <div className="h-5 w-24 animate-pulse rounded-token-badge bg-surface" />
                </div>
                <div className="h-8 w-48 animate-pulse rounded bg-surface" />
                <div className="mt-1.5 h-4 w-96 max-w-full animate-pulse rounded bg-surface" />
            </header>
            <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-32 animate-pulse rounded-token-card bg-surface" />
                ))}
            </div>
        </div>
    );
}
