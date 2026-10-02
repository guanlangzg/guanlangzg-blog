import type { Metadata } from 'next';
import { HomeView } from '@/public-site/views/HomeView';
import snapshot from '@/public-site/snapshot';

export const metadata: Metadata = { title: snapshot.site.title };

export default function HomePage() {
    return <HomeView />;
}
