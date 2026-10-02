const LOCAL_NODE_ENVS = new Set(['development', 'test']);

// Security gates must not open just because NODE_ENV is unset. A bare
// `node server.js` deploy leaves it undefined, which is why "not local" and
// "explicitly production" are kept separate: gates fail closed on unset, while
// operator opt-ins may only relax the unset case, never explicit production.
export function isLocalRuntime(): boolean {
    const nodeEnv = process.env.NODE_ENV?.trim();
    return Boolean(nodeEnv) && LOCAL_NODE_ENVS.has(nodeEnv as string);
}

export function isExplicitProductionRuntime(): boolean {
    return process.env.NODE_ENV?.trim() === 'production';
}
