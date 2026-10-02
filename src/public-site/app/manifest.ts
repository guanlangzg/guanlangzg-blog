import type { MetadataRoute } from 'next';
import { STATIC_SITE_ROOT } from '@/public-site/paths';
import snapshot from '@/public-site/snapshot';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
    return {
        name: snapshot.site.title,
        short_name: snapshot.site.title,
        start_url: `${STATIC_SITE_ROOT}/${snapshot.releaseId}/`,
        display: 'minimal-ui',
        background_color: '#f7f8f5',
        theme_color: '#b85c38',
        icons: [{ src: `${STATIC_SITE_ROOT}/${snapshot.releaseId}/favicon-32.png`, sizes: '32x32', type: 'image/png' }],
    };
}
