import snapshot from '@/public-site/snapshot';

export function GET() {
    return new Response(`# ${snapshot.site.title}\n\n${snapshot.site.description}\n`, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
}
