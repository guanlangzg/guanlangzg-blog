function shouldStartServerStartupTasks(): boolean {
    if (process.env.NEXT_RUNTIME !== 'nodejs') {
        return false;
    }

    if (process.env.NEXT_PHASE === 'phase-production-build') {
        return false;
    }

    if (process.env.npm_lifecycle_event === 'build') {
        return false;
    }

    return true;
}

export async function register() {
    if (!shouldStartServerStartupTasks()) {
        return;
    }

    const { startServerStartupTasks } = await import('@/lib/startup-tasks');

    startServerStartupTasks();
}
