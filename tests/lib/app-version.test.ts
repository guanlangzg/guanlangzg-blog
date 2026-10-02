import { afterEach, describe, expect, it } from 'vitest';
import { getAppVersionInfo } from '@/lib/app-version';
import packageJson from '../../package.json';
import { restoreEnv } from '../helpers/api-route';

const ORIGINAL_ENV = {
  BLOG_NAVIGATION_DOCKER: process.env.BLOG_NAVIGATION_DOCKER,
  BLOG_NAVIGATION_VERSION: process.env.BLOG_NAVIGATION_VERSION,
  BLOG_NAVIGATION_IMAGE_TAG: process.env.BLOG_NAVIGATION_IMAGE_TAG,
  BLOG_NAVIGATION_REVISION: process.env.BLOG_NAVIGATION_REVISION,
  BLOG_NAVIGATION_BUILD_TIME: process.env.BLOG_NAVIGATION_BUILD_TIME,
};

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
});

describe('app version metadata', () => {
  it('falls back to package version outside Docker', () => {
    delete process.env.BLOG_NAVIGATION_DOCKER;
    delete process.env.BLOG_NAVIGATION_VERSION;
    delete process.env.BLOG_NAVIGATION_IMAGE_TAG;
    delete process.env.BLOG_NAVIGATION_REVISION;
    delete process.env.BLOG_NAVIGATION_BUILD_TIME;

    expect(getAppVersionInfo()).toEqual({
      projectVersion: packageJson.version,
      displayVersion: packageJson.version,
      runtime: 'local',
      docker: {
        enabled: false,
        imageTag: null,
        revision: null,
        buildTime: null,
      },
    });
  });

  it('uses Docker build metadata when the image provides it', () => {
    process.env.BLOG_NAVIGATION_DOCKER = 'true';
    process.env.BLOG_NAVIGATION_VERSION = '2.0.1';
    process.env.BLOG_NAVIGATION_IMAGE_TAG = 'v2.0.1-build.42';
    process.env.BLOG_NAVIGATION_REVISION = 'abcdef1234567890';
    process.env.BLOG_NAVIGATION_BUILD_TIME = '2026-06-08T08:00:00Z';

    expect(getAppVersionInfo()).toEqual({
      projectVersion: '2.0.1',
      displayVersion: 'v2.0.1-build.42',
      runtime: 'docker',
      docker: {
        enabled: true,
        imageTag: 'v2.0.1-build.42',
        revision: 'abcdef1234567890',
        buildTime: '2026-06-08T08:00:00Z',
      },
    });
  });
});
