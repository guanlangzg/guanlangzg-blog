'use client';

import { useEffect, useMemo, useState } from 'react';
import type { PublicSearchIndex } from '@/public-site/types';
import { matchesPublicSearchDocument } from '@/public-site/search-index';

export function SearchView({ index }: { index: PublicSearchIndex }) {
    const [query, setQuery] = useState('');
    const [documents, setDocuments] = useState(index.documents);
    const [releaseMismatch, setReleaseMismatch] = useState(false);

    useEffect(() => {
        const url = new URL(window.location.href);
        const previewRelease = url.searchParams.get('previewRelease');
        if (previewRelease && previewRelease !== index.releaseId) {
            setReleaseMismatch(true);
            setDocuments([]);
            return;
        }
        const fixedRelease = previewRelease;
        if (fixedRelease) {
            url.searchParams.set('previewRelease', fixedRelease);
            for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')) {
                const target = new URL(link.href, window.location.origin);
                target.searchParams.set('previewRelease', fixedRelease);
                link.href = `${target.pathname}${target.search}${target.hash}`;
            }
        }
        let active = true;
        fetch(`/search-index.json${fixedRelease ? `?previewRelease=${encodeURIComponent(fixedRelease)}` : ''}`, { cache: 'no-store' })
            .then((response) => response.ok ? response.json() as Promise<PublicSearchIndex> : Promise.reject(new Error('索引不可用')))
            .then((payload) => {
                if (!active) return;
                if (payload.releaseId !== index.releaseId || payload.releaseId !== fixedRelease && fixedRelease) {
                    setReleaseMismatch(true);
                    setDocuments([]);
                    return;
                }
                setDocuments(payload.documents);
            })
            .catch(() => {
                if (active) setDocuments(index.documents);
            });
        return () => { active = false; };
    }, [index]);

    const results = useMemo(() => documents.filter((document) => matchesPublicSearchDocument(document, query)), [documents, query]);

    return (
        <section>
            <label className="block max-w-2xl text-sm font-medium text-fg" htmlFor="public-search">全站搜索</label>
            <input id="public-search" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索文章、正文、标签和导航" className="mt-2 min-h-12 w-full rounded-token-input border border-border bg-surface px-4 text-base text-fg" />
            <p role="status" className="mt-3 text-sm text-muted">
                {releaseMismatch ? '此预览版本已过期，请重新打开当前版本。' : query ? `找到 ${results.length} 项` : '输入关键词开始搜索。'}
            </p>
            <div className="mt-4 space-y-3">
                {results.map((result) => <a key={`${result.type}-${result.href}-${result.title}`} href={result.href} className="block rounded-token-card border border-border bg-surface-elevated p-4"><p className="font-mono text-xs text-accent">{result.type === 'post' ? '文章' : '导航'}</p><h2 className="mt-1 font-semibold text-fg">{result.title}</h2><p className="mt-1 text-sm text-muted">{result.description}</p></a>)}
            </div>
        </section>
    );
}
