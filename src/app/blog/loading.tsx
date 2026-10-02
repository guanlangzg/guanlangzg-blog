export default function BlogLoading() {
    return (
        <div className="space-y-token-section pb-10" role="status" aria-live="polite">
            <span className="sr-only">正在加载博客列表...</span>
            <div className="space-y-4 py-8">
                <div className="h-4 w-24 animate-pulse rounded bg-surface" />
                <div className="h-8 w-48 animate-pulse rounded bg-surface" />
                <div className="h-4 w-96 max-w-full animate-pulse rounded bg-surface" />
            </div>
            <div className="flex gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-9 w-20 animate-pulse rounded-token-button bg-surface" />
                ))}
            </div>
            <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-20 animate-pulse rounded-token-card bg-surface" />
                ))}
            </div>
        </div>
    );
}
