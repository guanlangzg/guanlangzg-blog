'use client';

import { useEffect, useState } from 'react';

function getReadingProgress(): number {
    const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;

    if (scrollableHeight <= 0) {
        return 0;
    }

    return Math.min(Math.max(window.scrollY / scrollableHeight, 0), 1);
}

export function ReadingProgress() {
    const [progress, setProgress] = useState(0);

    useEffect(() => {
        let frameId = 0;

        function updateProgress() {
            window.cancelAnimationFrame(frameId);
            frameId = window.requestAnimationFrame(() => {
                setProgress(getReadingProgress());
            });
        }

        updateProgress();
        window.addEventListener('scroll', updateProgress, { passive: true });
        window.addEventListener('resize', updateProgress);

        return () => {
            window.cancelAnimationFrame(frameId);
            window.removeEventListener('scroll', updateProgress);
            window.removeEventListener('resize', updateProgress);
        };
    }, []);

    return (
        <div className="fixed left-0 right-0 top-14 z-token-fixed h-0.5 bg-transparent" aria-hidden="true">
            <div
                className="h-full bg-accent transition-[width] duration-token-fast ease-token-out"
                style={{ width: `${progress * 100}%` }}
            />
        </div>
    );
}
