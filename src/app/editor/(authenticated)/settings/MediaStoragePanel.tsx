'use client';

import { useCallback, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { StatusMessage } from '@/app/components/ui';
import { EditorButton, EditorPanel } from '../../components/EditorShell';
import { createEditorCsrfHeaders } from '../../editor-csrf';

type MediaGcMessage = {
    tone: 'success' | 'danger' | 'loading' | 'info';
    text: string;
};

type MediaGcResponse = {
    message?: string;
    deleted?: number;
    freedBytes?: number;
};

export function MediaStoragePanel() {
    const [isArmed, setIsArmed] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [message, setMessage] = useState<MediaGcMessage | null>(null);
    const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleClick = useCallback(async () => {
        if (!isArmed) {
            setIsArmed(true);
            setMessage({ tone: 'info', text: '再次点击确认清理未引用的媒体文件。' });

            if (disarmTimer.current) {
                clearTimeout(disarmTimer.current);
            }

            disarmTimer.current = setTimeout(() => setIsArmed(false), 3000);
            return;
        }

        setIsRunning(true);
        setMessage({ tone: 'loading', text: '正在清理未引用的媒体文件...' });

        try {
            const response = await fetch('/api/data/media/gc', {
                method: 'POST',
                credentials: 'include',
                headers: createEditorCsrfHeaders({ 'Content-Type': 'application/json' }),
            });
            const payload = (await response.json().catch(() => null)) as MediaGcResponse | null;

            if (!response.ok) {
                throw new Error(payload?.message || '媒体清理失败。');
            }

            setIsArmed(false);
            const deleted = payload?.deleted ?? 0;
            const freedKb = Math.round((payload?.freedBytes ?? 0) / 1024);
            setMessage({
                tone: 'success',
                text: `已清理 ${deleted} 个未引用的媒体文件，释放约 ${freedKb} KB。`,
            });
        } catch (error) {
            setMessage({
                tone: 'danger',
                text: error instanceof Error ? error.message : '媒体清理失败。',
            });
        } finally {
            setIsRunning(false);
        }
    }, [isArmed]);

    return (
        <EditorPanel className="p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-fg">
                <Trash2 className="h-4 w-4 text-accent" />
                媒体存储
            </div>
            <p className="mt-2 text-sm leading-6 text-muted">
                清理不再被文章或导航引用的媒体文件。此操作不可撤销，执行前请确认已启用 R2 备份。
            </p>
            {message ? (
                <div className="mt-3">
                    <StatusMessage tone={message.tone}>{message.text}</StatusMessage>
                </div>
            ) : null}
            <div className="mt-4">
                <EditorButton
                    type="button"
                    variant={isArmed ? 'danger' : 'secondary'}
                    onClick={handleClick}
                    disabled={isRunning}
                >
                    <Trash2 className="h-4 w-4" />
                    {isRunning ? '清理中...' : isArmed ? '再次点击确认清理' : '清理未引用媒体'}
                </EditorButton>
            </div>
        </EditorPanel>
    );
}
