import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const entrypointPath = path.join(repoRoot, 'deploy', 'docker-entrypoint.sh');
const sandboxes: string[] = [];
const shellAvailable = spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf8' }).status === 0;

function readEntrypoint(): string {
  return fs.readFileSync(entrypointPath, 'utf8').replace(/\r\n/g, '\n');
}

// The container lacks the real su-exec/chown/chmod privileges in a unit test, so the
// stub set models ownership and mode in a `.sim` file per root. `su-exec` only lets
// the app user write (and create storage children) when the simulated ownership and
// mode actually allow it, which is what makes the ordering observable.
const simulationLibrary = `
sim_field() {
    sed -n "s/^$2=//p" "$1/.sim"
}

sim_writable() {
    [ -f "$1/.sim" ] || return 1
    sim_owner=$(sim_field "$1" owner)
    sim_mode=$(sim_field "$1" mode)
    sim_owner_write=$(printf '%s' "$sim_mode" | cut -c1)
    sim_group_write=$(printf '%s' "$sim_mode" | cut -c2)
    if [ "$sim_owner" = "nextjs" ]; then
        [ "$sim_owner_write" -ge 2 ] && return 0
        return 1
    fi
    # The app user is a member of the nodejs group, so the group write bit counts.
    [ "$sim_group_write" -ge 2 ] && return 0
    return 1
}

sim_set() {
    printf 'owner=%s\\nmode=%s\\n' "$2" "$3" > "$1/.sim"
}
`;

const suExecStub = `#!/bin/sh
. "$SIM_LIB"
shift
sim_command="$1"
shift
case "$sim_command" in
    test)
        sim_writable "$2"
        exit $?
        ;;
    mkdir)
        sim_flag="$1"
        shift
        sim_target="$1"
        sim_parent=$(dirname "$sim_target")
        while [ ! -d "$sim_parent" ]; do sim_parent=$(dirname "$sim_parent"); done
        sim_writable "$sim_parent" || exit 1
        exec mkdir "$sim_flag" "$@"
        ;;
    *)
        exec "$sim_command" "$@"
        ;;
esac
`;

const chmodStub = `#!/bin/sh
. "$SIM_LIB"
if [ "$1" != "700" ]; then
    echo "unexpected chmod mode: $1" >&2
    exit 1
fi
sim_set "$2" "$(sim_field "$2" owner)" 700
`;

const chownStub = `#!/bin/sh
. "$SIM_LIB"
if [ "$1" != "nextjs:nodejs" ]; then
    echo "unexpected chown target: $1" >&2
    exit 1
fi
sim_set "$2" nextjs "$(sim_field "$2" mode)"
`;

function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function readSim(sandbox: string, root: string): { owner: string; mode: string } {
  const content = fs.readFileSync(path.join(sandbox, root, '.sim'), 'utf8');
  return {
    owner: /^owner=(.*)$/m.exec(content)?.[1] ?? '',
    mode: /^mode=(.*)$/m.exec(content)?.[1] ?? '',
  };
}

interface Sandbox {
  sandbox: string;
  stubDirectory: string;
  libraryPath: string;
}

function createSandbox(owners: Record<string, { owner: string; mode: string }>): Sandbox {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-sim-'));
  sandboxes.push(sandbox);
  const stubDirectory = path.join(sandbox, 'stubs');
  fs.mkdirSync(stubDirectory, { recursive: true });
  const libraryPath = path.join(stubDirectory, 'sim-lib.sh');
  fs.writeFileSync(libraryPath, simulationLibrary);
  // On POSIX the shell walks PATH and skips entries it cannot execute, which would
  // hand the call to the real chown/chmod/su-exec and fail on a host that has no
  // `nextjs` user. Windows hosts do not enforce the exec bit, so the mode is set
  // explicitly to keep the simulation portable.
  for (const [name, stub] of [['su-exec', suExecStub], ['chmod', chmodStub], ['chown', chownStub]] as const) {
    const stubPath = path.join(stubDirectory, name);
    fs.writeFileSync(stubPath, stub);
    fs.chmodSync(stubPath, 0o755);
  }
  for (const [root, state] of Object.entries(owners)) {
    const rootDirectory = path.join(sandbox, root);
    fs.mkdirSync(rootDirectory, { recursive: true });
    fs.writeFileSync(path.join(rootDirectory, '.sim'), `owner=${state.owner}\nmode=${state.mode}\n`);
  }
  return { sandbox, stubDirectory, libraryPath };
}

function runEntrypoint({ sandbox, stubDirectory, libraryPath }: Sandbox) {
  return spawnSync('sh', [entrypointPath, 'true'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${toPosixPath(stubDirectory)}:${process.env.PATH ?? ''}`,
      SIM_LIB: toPosixPath(libraryPath),
      BLOG_DATA_ROOT: toPosixPath(path.join(sandbox, 'data')),
      BLOG_SECRET_ROOT: toPosixPath(path.join(sandbox, 'secrets')),
      BLOG_BUILD_ROOT: toPosixPath(path.join(sandbox, 'build')),
    },
  });
}

afterEach(() => {
  while (sandboxes.length > 0) {
    fs.rmSync(sandboxes.pop() as string, { recursive: true, force: true });
  }
});

describe('container entrypoint permissions', () => {
  it('restricts every mount root before probing whether the app user can write it', () => {
    const entrypoint = readEntrypoint();
    const loopStart = entrypoint.indexOf('for root in "$DATA_ROOT" "$SECRET_ROOT" "$BUILD_ROOT"');
    expect(loopStart).toBeGreaterThan(-1);

    const loopBody = entrypoint.slice(loopStart, entrypoint.indexOf('\ndone', loopStart));
    const chmodIndex = loopBody.indexOf('chmod 700 "$root"');
    const probeIndex = loopBody.indexOf('su-exec nextjs test -w "$root"');
    const chownIndex = loopBody.indexOf('chown nextjs:nodejs "$root"');

    expect(chmodIndex).toBeGreaterThan(-1);
    expect(probeIndex).toBeGreaterThan(chmodIndex);
    expect(chownIndex).toBeGreaterThan(probeIndex);
    // The secrets root is restricted by the same loop, not by a later chmod that
    // would run after the app user has already lost write access.
    expect(entrypoint.match(/chmod 700/g)).toHaveLength(1);
  });

  // A Windows host shells out through MSYS, where every stub invocation costs a
  // process spawn; the generous timeout keeps the simulation portable.
  it.runIf(shellAvailable)('keeps a group-writable root-owned mount usable for the app user', () => {
    const sandbox = createSandbox({
      data: { owner: 'root', mode: '775' },
      secrets: { owner: 'root', mode: '700' },
      build: { owner: 'nextjs', mode: '700' },
    });
    const result = runEntrypoint(sandbox);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(readSim(sandbox.sandbox, 'data')).toEqual({ owner: 'nextjs', mode: '700' });
    expect(readSim(sandbox.sandbox, 'secrets')).toEqual({ owner: 'nextjs', mode: '700' });
    expect(readSim(sandbox.sandbox, 'build')).toEqual({ owner: 'nextjs', mode: '700' });
    for (const child of ['articles', 'navigation', 'settings', 'media']) {
      expect(fs.existsSync(path.join(sandbox.sandbox, 'data', child)), child).toBe(true);
    }
  }, 60_000);

  it.runIf(shellAvailable)('hands a root-only mount to the app user before creating storage', () => {
    const sandbox = createSandbox({
      data: { owner: 'root', mode: '700' },
      secrets: { owner: 'root', mode: '700' },
      build: { owner: 'root', mode: '700' },
    });
    const result = runEntrypoint(sandbox);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(readSim(sandbox.sandbox, 'data').owner).toBe('nextjs');
    expect(fs.existsSync(path.join(sandbox.sandbox, 'data', 'articles'))).toBe(true);
  }, 60_000);
});
