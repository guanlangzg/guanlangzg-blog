import packageJson from '../../package.json';

export interface AppVersionInfo {
    projectVersion: string;
    displayVersion: string;
    runtime: 'docker' | 'local';
    docker: {
        enabled: boolean;
        imageTag: string | null;
        revision: string | null;
        buildTime: string | null;
    };
}

function getEnv(name: string): string | null {
    const value = process.env[name]?.trim();

    if (!value || value === 'unknown') {
        return null;
    }

    return value;
}

export function getAppVersionInfo(): AppVersionInfo {
    const projectVersion = getEnv('BLOG_NAVIGATION_VERSION') ?? packageJson.version;
    const imageTag = getEnv('BLOG_NAVIGATION_IMAGE_TAG');
    const revision = getEnv('BLOG_NAVIGATION_REVISION');
    const buildTime = getEnv('BLOG_NAVIGATION_BUILD_TIME');
    const dockerEnabled = process.env.BLOG_NAVIGATION_DOCKER === 'true';

    return {
        projectVersion,
        displayVersion: imageTag ?? projectVersion,
        runtime: dockerEnabled ? 'docker' : 'local',
        docker: {
            enabled: dockerEnabled,
            imageTag,
            revision,
            buildTime,
        },
    };
}
