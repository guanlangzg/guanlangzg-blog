import { getSafeAppRuntimeConfig, getRuntimePublicSiteUrl } from '@/lib/app-runtime-config';
import { isLocalRuntime } from '@/lib/runtime-environment';

const FALLBACK_SITE_URL = 'http://localhost:3000';

let warnedAboutDefaultSiteUrl = false;

// A localhost site URL silently poisons every absolute URL we emit: sitemap
// entries, RSS links and canonical tags. Throwing here would take down
// /sitemap.xml and /feed.xml on an otherwise healthy site, so stay serving and
// make the misconfiguration impossible to miss in the logs instead.
function warnAboutUnconfiguredSiteUrl(): void {
    if (warnedAboutDefaultSiteUrl || isLocalRuntime()) {
        return;
    }

    warnedAboutDefaultSiteUrl = true;
    console.error(
        `[site-url] NEXT_PUBLIC_SITE_URL is not configured, falling back to ${FALLBACK_SITE_URL}. ` +
        'Sitemap, RSS and canonical URLs will point at localhost and search engines will index them as such. ' +
        'Set the public site URL in /setup, /editor/settings or NEXT_PUBLIC_SITE_URL.'
    );
}

export function getSiteUrl(): URL {
    if (getSafeAppRuntimeConfig().publicSiteUrl.source === 'default') {
        warnAboutUnconfiguredSiteUrl();
    }

    try {
        return new URL(getRuntimePublicSiteUrl());
    } catch {
        return new URL(FALLBACK_SITE_URL);
    }
}

export function createCanonicalUrl(pathname: string): string {
    return new URL(pathname, getSiteUrl()).toString();
}

export function createOgImagePath(input: { title: string; description?: string }): string {
    const params = new URLSearchParams({
        title: input.title,
    });

    if (input.description?.trim()) {
        params.set('description', input.description.trim());
    }

    return `/og?${params.toString()}`;
}

export function resetSiteUrlWarningForTests(): void {
    warnedAboutDefaultSiteUrl = false;
}
