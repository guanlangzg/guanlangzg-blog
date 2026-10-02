export default function Loading() {
    return (
        <div className="flex min-h-[60vh] items-center justify-center">
            <div className="flex items-center gap-3 text-muted" role="status" aria-live="polite">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden="true" />
                <span className="font-mono text-sm">loading...</span>
            </div>
        </div>
    );
}
