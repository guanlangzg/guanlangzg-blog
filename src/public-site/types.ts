export interface PublicArtifactFile {
    path: string;
    size: number;
    sha256: string;
    inlineScriptHashes?: string[];
}

export interface PublicArtifactManifest {
    version: 1;
    releaseId: string;
    candidateDigest: string;
    files: PublicArtifactFile[];
    artifactDigest: string;
}

export interface PublicManagedImage {
    source: string;
    alt: string;
}

export interface PublicManagedMedia {
    source: string;
    publicPath: string;
    sha256: string;
    size: number;
    mimeType: string;
}

export interface PublicPost {
    slug: string;
    title: string;
    description: string;
    date: string;
    tags: string[];
    content: string;
    managedImage?: PublicManagedImage;
}

export interface PublicNavigationItem {
    title: string;
    description: string;
    url: string;
    tags: string[];
}

export interface PublicNavigationGroup {
    name: string;
    items: PublicNavigationItem[];
}

export interface PublicSiteRedirect {
    from: string;
    to: string;
}

export interface PublicSiteSnapshot {
    releaseId: string;
    site: {
        title: string;
        description: string;
    };
    posts: PublicPost[];
    navigation: PublicNavigationGroup[];
    redirects?: PublicSiteRedirect[];
    removedPaths?: string[];
    media?: PublicManagedMedia[];
}

export interface PublicSearchDocument {
    type: 'post' | 'navigation';
    title: string;
    description: string;
    href: string;
    text: string;
    tags: string[];
    normalizedText: string;
    tokens: string[];
}

export interface PublicSearchIndex {
    version: 1;
    releaseId: string;
    documents: PublicSearchDocument[];
}
