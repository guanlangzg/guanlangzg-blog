import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register } from '@/instrumentation';

vi.mock('@/lib/startup-tasks', () => ({
  startServerStartupTasks: vi.fn(),
}));

import { startServerStartupTasks } from '@/lib/startup-tasks';

const mockedStartServerStartupTasks = vi.mocked(startServerStartupTasks);

const ORIGINAL_ENV: Record<string, string | undefined> = {
  NEXT_RUNTIME: process.env.NEXT_RUNTIME,
  NEXT_PHASE: process.env.NEXT_PHASE,
  npm_lifecycle_event: process.env.npm_lifecycle_event,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(() => {
  mockedStartServerStartupTasks.mockClear();
});

afterEach(() => {
  restoreEnv();
});

describe('instrumentation register', () => {
  it('starts server startup tasks on the Node runtime outside builds', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    delete process.env.NEXT_PHASE;
    delete process.env.npm_lifecycle_event;

    await register();

    expect(mockedStartServerStartupTasks).toHaveBeenCalledTimes(1);
  });

  it('skips startup tasks on non-Node runtimes', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    delete process.env.NEXT_PHASE;
    delete process.env.npm_lifecycle_event;

    await register();

    expect(mockedStartServerStartupTasks).not.toHaveBeenCalled();
  });

  it('skips startup tasks during the production build phase', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    process.env.NEXT_PHASE = 'phase-production-build';
    delete process.env.npm_lifecycle_event;

    await register();

    expect(mockedStartServerStartupTasks).not.toHaveBeenCalled();
  });

  it('skips startup tasks when a build lifecycle command is running', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    delete process.env.NEXT_PHASE;
    process.env.npm_lifecycle_event = 'build';

    await register();

    expect(mockedStartServerStartupTasks).not.toHaveBeenCalled();
  });
});
