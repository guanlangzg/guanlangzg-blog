import { LegacyRemovedView } from '@/public-site/components/LegacyRemovedView';
import snapshot from '@/public-site/snapshot';

export const dynamicParams = false;

function getLegacyPaths(): string[] {
    return (snapshot.removedPaths ?? []).filter((route) => route.toLowerCase().startsWith('/blog/'));
}

export function generateStaticParams() {
    return getLegacyPaths().map((route) => ({
        slug: route.slice('/blog/'.length).split('/').filter(Boolean).map((segment) => decodeURIComponent(segment)),
    }));
}

export default function RemovedLegacyBlogPage() {
    return <LegacyRemovedView />;
}
