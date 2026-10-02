import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isApplicationSetupComplete } from '@/lib/setup-state';

vi.mock('@/lib/app-runtime-config', () => ({
  readStoredAppRuntimeConfig: vi.fn(),
}));
vi.mock('@/lib/editor-auth-runtime', () => ({
  isRuntimeEditorAuthConfigured: vi.fn(),
}));

import { readStoredAppRuntimeConfig } from '@/lib/app-runtime-config';
import { isRuntimeEditorAuthConfigured } from '@/lib/editor-auth-runtime';

type StoredAppRuntimeConfig = ReturnType<typeof readStoredAppRuntimeConfig>;

const mockedReadConfig = vi.mocked(readStoredAppRuntimeConfig);
const mockedAuthConfigured = vi.mocked(isRuntimeEditorAuthConfigured);

function storedConfigWithSetup(completedAt: string | null): StoredAppRuntimeConfig {
  return {
    setupCompletedAt: completedAt,
  } as StoredAppRuntimeConfig;
}

beforeEach(() => {
  mockedReadConfig.mockReset();
  mockedAuthConfigured.mockReset();
});

describe('isApplicationSetupComplete', () => {
  it('returns true only when both setup completion and editor auth are configured', () => {
    mockedReadConfig.mockReturnValue(storedConfigWithSetup('2026-01-01T00:00:00.000Z'));
    mockedAuthConfigured.mockReturnValue(true);

    expect(isApplicationSetupComplete()).toBe(true);
  });

  it('returns false when no stored runtime config exists', () => {
    mockedReadConfig.mockReturnValue(null);
    mockedAuthConfigured.mockReturnValue(true);

    expect(isApplicationSetupComplete()).toBe(false);
  });

  it('returns false when setup completion is not recorded', () => {
    mockedReadConfig.mockReturnValue(storedConfigWithSetup(null));
    mockedAuthConfigured.mockReturnValue(true);

    expect(isApplicationSetupComplete()).toBe(false);
  });

  it('returns false when editor auth is not configured yet', () => {
    mockedReadConfig.mockReturnValue(storedConfigWithSetup('2026-01-01T00:00:00.000Z'));
    mockedAuthConfigured.mockReturnValue(false);

    expect(isApplicationSetupComplete()).toBe(false);
  });
});
