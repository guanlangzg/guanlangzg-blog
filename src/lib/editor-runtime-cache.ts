const resetCallbacks = new Set<() => void>();

export function registerEditorRuntimeCacheReset(callback: () => void): void {
    resetCallbacks.add(callback);
}

export function resetEditorRuntimeCaches(): void {
    for (const callback of resetCallbacks) {
        callback();
    }
}
