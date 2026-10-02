#!/usr/bin/env node
// Runs the first-release acceptance loop against a real isolated static export:
// fixture -> build -> leak/manifest assertions -> preview authorization -> mutation check.
// Every check prints its own line so a failure points at one concrete behavior.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { servePreviewArtifact } from '../../src/lib/public-build/preview.ts';
import { createReleaseFixture, DRAFT_SECRET_MARKER } from './create-release-fixture.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(projectRoot, '.tmp', 'first-release-fixture');
const outputRoot = path.join(fixtureRoot, 'out');
const mutantOutputRoot = path.join(fixtureRoot, 'mutant-out');

const results = [];

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'}  ${name}${!condition && detail ? ` — ${detail}` : ''}\n`);
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(`${label} failed:\n${result.stdout || ''}\n${result.stderr || ''}\n`);
  }
  return result;
}

async function walk(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory() ? walk(path.join(directory, entry.name), relative) : [relative];
  }));
  return files.flat().sort();
}

// Recomputes the sealed manifest and returns the text of every public artifact.
async function readArtifacts(outRoot) {
  const releaseRoot = path.join(outRoot, 'first-release-candidate');
  const manifest = JSON.parse(await fs.readFile(path.join(releaseRoot, 'artifacts.json'), 'utf8'));
  const artifactRoot = path.join(releaseRoot, 'app', 'out');
  const files = await walk(artifactRoot);
  const textParts = [];
  for (const file of files) {
    if (/\.(html|json|js|css|txt|xml)$/i.test(file)) {
      textParts.push(await fs.readFile(path.join(artifactRoot, file), 'utf8'));
    }
  }
  return { releaseRoot, manifest, artifactRoot, files, text: textParts.join('\n') };
}

async function verifyLeakage(artifacts, label) {
  // Note: Next's own client runtime legitimately contains the literal "/api/",
  // so the closure check targets management endpoints and route directories instead.
  const forbidden = [
    [DRAFT_SECRET_MARKER, 'draft-only secret marker'],
    ['BLOG_DATA_ROOT', 'runtime data root reference'],
    ['/api/search', 'management search API reference'],
    ['/api/editor-auth', 'editor auth API reference'],
    ['/api/data/', 'management data API reference'],
    ['/api/setup', 'setup API reference'],
    ['/editor/', 'editor route reference'],
    ['/setup/', 'setup route reference'],
    ['"must-not-be-read"', 'blocked data root marker'],
  ];
  const leaked = forbidden.filter(([needle]) => artifacts.text.includes(needle));
  check(`${label}: draft and management references stay out of the artifacts`, leaked.length === 0,
    leaked.map(([needle]) => needle).join(', '));
  const routeDirectories = artifacts.files.filter((file) => /^(api|editor|setup)\//i.test(file));
  check(`${label}: no management route directory is exported`, routeDirectories.length === 0,
    routeDirectories.slice(0, 5).join(', '));
}

async function verifyManifest(artifacts, label) {
  const { releaseRoot, manifest, artifactRoot } = artifacts;
  const onDisk = await walk(artifactRoot);
  const manifestPaths = manifest.files.map((entry) => entry.path.startsWith('app/out/')
    ? entry.path.slice('app/out/'.length)
    : entry.path);
  const missing = onDisk.filter((file) => !manifestPaths.includes(file));
  check(`${label}: manifest lists every artifact file`, missing.length === 0, missing.join(', '));

  const mismatched = [];
  for (const entry of manifest.files) {
    const bytes = await fs.readFile(path.join(releaseRoot, ...entry.path.split('/')));
    const digest = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256').update(bytes).digest('hex'));
    if (bytes.byteLength !== entry.size || digest !== entry.sha256) mismatched.push(entry.path);
  }
  check(`${label}: manifest sizes and hashes match the sealed bytes`, mismatched.length === 0, mismatched.join(', '));

  const marker = JSON.parse(await fs.readFile(path.join(artifactRoot, '_release.json'), 'utf8'));
  const markerRecorded = manifest.files.some((entry) => entry.path.endsWith('_release.json'));
  check(`${label}: release marker is recorded but excluded from the digest`,
    markerRecorded && marker.artifactDigest === manifest.artifactDigest && marker.releaseId === manifest.releaseId);
}

async function verifySearchAndFeeds(artifacts, label) {
  const { artifactRoot } = artifacts;
  const search = await fs.readFile(path.join(artifactRoot, 'search-index.json'), 'utf8');
  const feed = await fs.readFile(path.join(artifactRoot, 'feed.xml'), 'utf8');
  const sitemap = await fs.readFile(path.join(artifactRoot, 'sitemap.xml'), 'utf8');
  const robots = await fs.readFile(path.join(artifactRoot, 'robots.txt'), 'utf8');
  check(`${label}: search index includes the new post C`, search.includes('本次新增文章'));
  check(`${label}: search index includes live post B`, search.includes('已上线文章'));
  check(`${label}: search index does not include draft A`, !search.includes('私密草稿'));
  check(`${label}: feed and sitemap use the fixed public origin`,
    feed.includes('https://guanlangzg.github.io/') && sitemap.includes('https://guanlangzg.github.io/'));
  check(`${label}: robots points at the public sitemap`,
    robots.includes('https://guanlangzg.github.io/sitemap.xml'));
  check(`${label}: legacy path renders the removal notice`,
    (await fs.readFile(path.join(artifactRoot, 'blog', 'legacy-post', 'index.html'), 'utf8')).includes('内容已移除'));
}

async function verifyPreviewAuthorization(artifacts, label) {
  const { releaseRoot, manifest, artifactRoot } = artifacts;
  const htmlPath = manifest.files
    .map((entry) => entry.path)
    .find((entryPath) => entryPath.endsWith('.html') && entryPath.includes('posts/'));
  if (!htmlPath) {
    check(`${label}: found an HTML page to exercise preview authorization`, false);
    return;
  }
  const relativeHtml = htmlPath.startsWith('app/out/') ? htmlPath.slice('app/out/'.length) : htmlPath;
  const scriptPath = manifest.files
    .map((entry) => entry.path)
    .find((entryPath) => entryPath.endsWith('.js'));
  const relativeScript = scriptPath
    ? (scriptPath.startsWith('app/out/') ? scriptPath.slice('app/out/'.length) : scriptPath)
    : null;

  const base = {
    requestedReleaseId: 'first-release-candidate',
    expectedReleaseId: 'first-release-candidate',
    activeReleaseId: 'first-release-candidate',
    previewRelease: 'first-release-candidate',
    releaseRoot,
  };

  const paths = [
    relativeHtml,
    'first-release-candidate/search-index.json',
    'posts/%E4%B8%AD%E6%96%87%E5%8D%95%E6%AE%B5%E6%96%87%E7%AB%A0/index.txt',
    ...(relativeScript ? [relativeScript] : []),
  ];

  const anonymous = await Promise.all(paths.map((relativePath) =>
    servePreviewArtifact({ ...base, authorized: false, relativePath, method: 'GET' })));
  check(`${label}: anonymous artifact and data requests are refused`,
    anonymous.every((response) => response.status === 401),
    anonymous.map((response) => response.status).join(','));

  const prefetch = await servePreviewArtifact({ ...base, authorized: false, relativePath: relativeHtml, method: 'HEAD' });
  check(`${label}: anonymous prefetch/HEAD is refused`, prefetch.status === 401, String(prefetch.status));

  const stale = await servePreviewArtifact({
    ...base,
    authorized: true,
    activeReleaseId: 'first-release-later',
    relativePath: relativeHtml,
    method: 'GET',
  });
  check(`${label}: a superseded preview release id is refused`, stale.status === 409, String(stale.status));

  const sealed = await fs.readFile(path.join(artifactRoot, ...relativeHtml.split('/')));
  const authorized = await servePreviewArtifact({ ...base, authorized: true, relativePath: relativeHtml, method: 'GET' });
  const servedBytes = Buffer.from(await authorized.arrayBuffer());
  check(`${label}: authorized preview returns the sealed bytes unchanged`,
    authorized.status === 200 && Buffer.compare(servedBytes, sealed) === 0, `status ${authorized.status}`);
  const csp = authorized.headers.get('content-security-policy') || '';
  const scriptDirective = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src')) || '';
  check(`${label}: preview HTML carries a per-page script-hash CSP`,
    scriptDirective.includes('sha256-') && !scriptDirective.includes("'unsafe-inline'") && !scriptDirective.includes("'unsafe-eval'"),
    scriptDirective.slice(0, 90));
  check(`${label}: preview responses are private and no-store`,
    authorized.headers.get('cache-control') === 'private, no-store'
    && authorized.headers.get('x-robots-tag') === 'noindex, nofollow');
}

// Mutation check: if the build were to read all drafts, this build MUST leak and the
// leak assertion MUST fail. Running it on a temp copy proves the check is not vacuous.
async function verifyMutationDetectsLeak(mutantSnapshotPath) {
  const mutantOut = mutantOutputRoot;
  await fs.rm(mutantOut, { recursive: true, force: true });
  const built = run(process.execPath, [
    path.join(projectRoot, 'scripts', 'public-site', 'build.mjs'),
    '--snapshot', mutantSnapshotPath,
    '--out', mutantOut,
  ], 'mutant build');
  if (built.status !== 0) {
    check('mutation: leaking candidate fails the leak assertion', false, 'mutant build did not run');
    return;
  }
  const artifacts = await readArtifacts(mutantOut);
  const leaked = artifacts.text.includes(DRAFT_SECRET_MARKER);
  check('mutation: leaking candidate fails the leak assertion', leaked,
    'the leak check would not have caught a build that read drafts');
  await fs.rm(mutantOut, { recursive: true, force: true });
}

async function main() {
  await createReleaseFixture();

  const build = run(process.execPath, [
    path.join(projectRoot, 'scripts', 'public-site', 'build.mjs'),
    '--snapshot', path.join(fixtureRoot, 'candidate.json'),
    '--out', outputRoot,
  ], 'public build');
  check('isolated public build succeeds', build.status === 0, `exit ${build.status}`);
  if (build.status !== 0) throw new Error('Public build failed; stopping before artifact assertions.');

  const artifacts = await readArtifacts(outputRoot);
  await verifyLeakage(artifacts, 'release');
  await verifyManifest(artifacts, 'release');
  await verifySearchAndFeeds(artifacts, 'release');
  await verifyPreviewAuthorization(artifacts, 'release');

  // Mutation: build the same snapshot with draft A merged into the public posts.
  const candidate = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'candidate.json'), 'utf8'));
  const draft = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'draft-a.json'), 'utf8'));
  const mutantSnapshotPath = path.join(fixtureRoot, 'candidate-with-draft.json');
  await fs.writeFile(mutantSnapshotPath, `${JSON.stringify({
    ...candidate,
    posts: [...candidate.posts, draft.article],
  }, null, 2)}\n`);
  await verifyMutationDetectsLeak(mutantSnapshotPath);

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed.\n`);
  if (failed.length > 0) {
    process.stdout.write(`Failed checks:\n${failed.map((entry) => `  - ${entry.name}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
