import type { Article } from '@/app/types/article';

export type ArticlePatchOperation =
    | { type: 'upsert'; article: Article }
    | { type: 'delete'; id: string };

export function applyArticlePatchOperations(
    currentArticles: Article[],
    operations: ArticlePatchOperation[]
): Article[] {
    const articlesById = new Map(currentArticles.map((article) => [article.id, article]));

    for (const operation of operations) {
        if (operation.type === 'delete') {
            articlesById.delete(operation.id);
        } else {
            articlesById.set(operation.article.id, operation.article);
        }
    }

    return Array.from(articlesById.values());
}
