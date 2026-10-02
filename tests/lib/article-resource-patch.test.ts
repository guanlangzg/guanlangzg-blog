import { describe, expect, it } from 'vitest';
import { applyArticlePatchOperations, type ArticlePatchOperation } from '@/lib/article-resource-patch';
import type { Article } from '@/app/types/article';

function article(id: string, title: string): Article {
    return {
        id,
        title,
        date: '2026-05-24',
        description: `${title} description`,
        tags: [],
        content: `# ${title}`,
        createdAt: 1,
        updatedAt: 2,
        slug: id,
        kind: 'essay',
        status: 'draft',
        featured: false,
        sourceLinks: [],
        revisionNotes: [],
    };
}

describe('applyArticlePatchOperations', () => {
    it('upserts an existing article without mutating input', () => {
        const current = [article('one', 'Old'), article('two', 'Two')];
        const nextArticle = article('one', 'New');

        const result = applyArticlePatchOperations(current, [{ type: 'upsert', article: nextArticle }]);

        expect(result).toEqual([nextArticle, current[1]]);
        expect(current[0].title).toBe('Old');
    });

    it('appends a new article and deletes an existing one', () => {
        const current = [article('one', 'One'), article('two', 'Two')];
        const operations: ArticlePatchOperation[] = [
            { type: 'delete', id: 'one' },
            { type: 'upsert', article: article('three', 'Three') },
        ];

        expect(applyArticlePatchOperations(current, operations).map((item) => item.id)).toEqual(['two', 'three']);
    });

    it('ignores deletion of an unknown article', () => {
        const current = [article('one', 'One')];

        expect(applyArticlePatchOperations(current, [{ type: 'delete', id: 'missing' }])).toEqual(current);
    });

    it('applies operations in order', () => {
        const current = [article('one', 'One')];
        const result = applyArticlePatchOperations(current, [
            { type: 'upsert', article: article('one', 'Two') },
            { type: 'upsert', article: article('one', 'Three') },
        ]);

        expect(result[0].title).toBe('Three');
    });
});
