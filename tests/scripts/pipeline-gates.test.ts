import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function readRepoFile(...segments: string[]): string {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');
}

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  on: Record<string, { branches?: string[] } | null>;
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

function workflow(): Workflow {
  return parse(readRepoFile('.github', 'workflows', 'ci.yml')) as Workflow;
}

function jobEntries(predicate: (job: WorkflowJob) => boolean): [string, WorkflowJob][] {
  return Object.entries(workflow().jobs).filter(([, job]) => predicate(job));
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function imageBuildSteps(job: WorkflowJob): WorkflowStep[] {
  return (job.steps ?? []).filter((step) => step.uses?.startsWith('docker/build-push-action'));
}

describe('ci workflow gates', () => {
  it('runs the static checks for pull requests as well as pushes', () => {
    const { on } = workflow();

    expect(Object.keys(on)).toEqual(expect.arrayContaining(['push', 'pull_request', 'workflow_dispatch']));
    expect(on.push?.branches).toEqual(['main', 'dev']);
    expect(on.pull_request?.branches).toEqual(['main', 'dev']);
  });

  it('keeps the pull request run read-only and pushes only on non-PR events', () => {
    const parsed = workflow();
    expect(parsed.permissions).toEqual({ contents: 'read' });

    const publishes = jobEntries((job) => imageBuildSteps(job).some((step) => step.with?.push === true));
    expect(publishes).toHaveLength(1);
    const [publishName, publishJob] = publishes[0];

    expect(publishJob.if).toContain("github.event_name != 'pull_request'");
    expect(publishJob.permissions).toEqual({ contents: 'read', packages: 'write' });

    for (const [name, job] of Object.entries(parsed.jobs)) {
      if (name === publishName) continue;
      expect(job.permissions?.packages, name).toBeUndefined();
      expect(imageBuildSteps(job).some((step) => step.with?.push === true), name).toBe(false);
      expect((job.steps ?? []).some((step) => step.uses?.startsWith('docker/login-action')), name).toBe(false);
    }
  });

  it('keeps the existing release semantics of a push to main or dev', () => {
    const [, publishJob] = jobEntries((job) => imageBuildSteps(job).some((step) => step.with?.push === true))[0];
    const steps = publishJob.steps ?? [];
    const buildStep = imageBuildSteps(publishJob)[0];

    expect(steps.some((step) => step.uses?.startsWith('docker/login-action'))).toBe(true);
    const metadata = steps.find((step) => step.uses?.startsWith('docker/metadata-action'));
    expect(metadata?.with?.images).toContain('ghcr.io/');
    expect(String(metadata?.with?.tags)).toContain('type=ref,event=branch');
    expect(String(metadata?.with?.tags)).toContain('type=sha,format=long');
    expect(buildStep.with?.tags).toBeDefined();
    expect(buildStep.with?.push).toBe(true);
  });

  it('verifies the runner image in CI without pushing it', () => {
    const verifications = jobEntries((job) => (job.steps ?? []).some((step) => step.run?.includes('scripts/test/verify-builder-container.mjs')));
    expect(verifications).toHaveLength(1);
    const [name, job] = verifications[0];
    const steps = job.steps ?? [];
    const verifyStep = steps.find((step) => step.run?.includes('scripts/test/verify-builder-container.mjs'));
    const buildStep = imageBuildSteps(job)[0] ?? steps.find((step) => step.run?.includes('docker build'));

    // The gate only runs once the static checks passed, and it consumes the image
    // the job itself built instead of building a second one.
    expect(asArray(job.needs)).toContain('check');
    expect(buildStep, name).toBeDefined();
    if (buildStep.uses) {
      expect(buildStep.with?.target).toBe('runner');
      expect(buildStep.with?.load).toBe(true);
      expect(buildStep.with?.push).not.toBe(true);
      expect(verifyStep?.env?.RUNNER_IMAGE).toBe(buildStep.with?.tags);
    } else {
      expect(String(buildStep.run)).toContain('--target runner');
      expect(verifyStep?.env?.RUNNER_IMAGE).toBeDefined();
    }
    expect(verifyStep?.env?.RUNNER_SKIP_BUILD).toBe('1');
  });

  it('runs the first-release acceptance inside the read-only runner job', () => {
    const acceptances = jobEntries((job) => (job.steps ?? []).some((step) => step.run?.includes('test:release')));
    expect(acceptances).toHaveLength(1);
    const [name, job] = acceptances[0];
    const steps = job.steps ?? [];
    const acceptanceIndex = steps.findIndex((step) => step.run?.includes('test:release'));
    const installIndex = steps.findIndex((step) => step.run?.includes('npm ci'));

    // The acceptance builds the isolated public export for real, so it belongs to the job
    // that already verifies the runner image - and that job never publishes anything.
    expect(steps.some((step) => step.run?.includes('scripts/test/verify-builder-container.mjs')), name).toBe(true);
    expect(imageBuildSteps(job).some((step) => step.with?.push === true), name).toBe(false);
    expect(job.permissions?.packages, name).toBeUndefined();

    // The isolated export needs the locked dependency tree, installed before it runs.
    expect(installIndex, name).toBeGreaterThanOrEqual(0);
    expect(installIndex, name).toBeLessThan(acceptanceIndex);
    expect(asArray(job.needs)).toContain('check');
  });

  it('keeps the first-release acceptance on a disposable fixture outside the repository', () => {
    const acceptance = readRepoFile('scripts', 'test', 'verify-first-release.mjs');

    // It must create and remove its own OS-temp directory instead of reusing the in-repo
    // .tmp fixture that the standalone fixture CLI owns and replaces.
    expect(acceptance).toContain('mkdtemp');
    expect(acceptance).toContain('os.tmpdir()');
    expect(acceptance).not.toContain('first-release-fixture');
    // Both the release build and the mutation build are bound to the identity document
    // they froze, so neither can silently fall back to a stale sibling identity.
    expect(acceptance).toContain("'--identity', fixture.identityPath");
    expect(acceptance).toContain("'--identity', mutantIdentityPath");
    expect(acceptance).toContain("'--candidate-digest'");
    expect(acceptance).toContain("'--snapshot-digest'");
  });

  it('keeps the static check job gates that already existed', () => {
    const steps = workflow().jobs.check?.steps ?? [];
    const runs = steps.map((step) => step.run ?? '').join('\n');

    ['npm ci', 'npm run check:env', 'npm run lint', 'npm run typecheck', 'vitest run', 'npm run deadcode', 'python -m unittest'].forEach((command) => {
      expect(runs, command).toContain(command);
    });
  });
});

describe('credential ignore rules', () => {
  it('keeps the compose credential directory out of git', () => {
    const gitIgnore = readRepoFile('.gitignore');

    expect(gitIgnore).toMatch(/^secrets\/$/m);
  });

  it('keeps the compose credential directory out of the build context', () => {
    const dockerIgnore = readRepoFile('.dockerignore');

    expect(dockerIgnore).toMatch(/^secrets$/m);
    expect(dockerIgnore).toMatch(/^\*\*\/secrets$/m);
  });
});
