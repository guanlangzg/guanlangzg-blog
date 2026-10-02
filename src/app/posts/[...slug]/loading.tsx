const SKELETON_LINE_WIDTHS = [72, 88, 64, 96, 76, 84, 58, 90];

export default function PostLoading() {
    return (
        <div className="mx-auto max-w-3xl pb-10" role="status" aria-live="polite">
            <span className="sr-only">正在加载文章内容...</span>
            <div className="mb-5 h-9 w-24 animate-pulse rounded-token-button bg-surface" />
            <div className="space-y-4 py-8">
                <div className="h-4 w-20 animate-pulse rounded bg-surface" />
                <div className="h-8 w-3/4 animate-pulse rounded bg-surface" />
                <div className="flex gap-3">
                    <div className="h-5 w-16 animate-pulse rounded-token-badge bg-surface" />
                    <div className="h-5 w-24 animate-pulse rounded bg-surface" />
                    <div className="h-5 w-20 animate-pulse rounded bg-surface" />
                </div>
            </div>
            <div className="space-y-3 rounded-token-card border border-border bg-surface p-4 md:p-6">
                {SKELETON_LINE_WIDTHS.map((width, i) => (
                    <div
                        key={i}
                        className="h-4 animate-pulse rounded bg-surface"
                        style={{ width: `${width}%` }}
                    />
                ))}
            </div>
        </div>
    );
}
