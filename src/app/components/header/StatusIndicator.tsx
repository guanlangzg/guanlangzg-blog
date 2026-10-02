'use client';

import { useState, useEffect } from 'react';

function formatTime(date: Date) {
    return date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
}

export function StatusIndicator() {
    const [time, setTime] = useState<string | null>(null);

    useEffect(() => {
        const updateTime = () => setTime(formatTime(new Date()));

        updateTime();
        const interval = setInterval(() => {
            updateTime();
        }, 1000);

        return () => clearInterval(interval);
    }, []);

    return (
        <div className="hidden min-h-9 items-center gap-3 rounded-token-button border border-border bg-surface px-3 py-1.5 md:flex">
            <div className="flex items-center gap-2">
                <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success"></span>
                </span>
                <span className="text-xs font-mono text-subtle">online</span>
            </div>
            <div className="text-xs font-mono text-muted tabular-nums border-l border-border pl-3">
                {time ?? '--:--'}
            </div>
        </div>
    );
}
