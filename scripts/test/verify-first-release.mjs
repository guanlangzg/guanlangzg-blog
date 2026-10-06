#!/usr/bin/env node
// Runs the first-release acceptance loop against a real isolated static export:
// fixture -> build -> leak/manifest assertions -> preview authorization -> mutation check.
// Every check prints its own line so a failure points at one concrete behavior.
// The fixture is a fresh os.tmpdir() directory this run creates with mkdtemp: it never reads,
// writes or replaces the in-repo .tmp fixture kept by the standalone test:release:fixture CLI,
// and it removes only the directory it created.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { servePreviewArtifact } from '../../src/lib/public-build/preview.ts';
import { createReleaseFixture, DRAFT_SECRET_MARKER, RELEASE_ID } from './create-release-fixture.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const buildScript = path.join(projectRoot, 'scripts', 'public-site', 'build.mjs');

const results = [];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'}  ${name}${!condition && detail ? ` — ${detail}` : ''}\n`);
}

function run(args, label, extraEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...extraEnv },
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
  const releaseRoot = path.join(outRoot, RELEASE_ID);
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

function readReleaseMarker(artifacts) {
  return fs.readFile(path.join(artifacts.artifactRoot, '_release.json'), 'utf8').then((value) => JSON.parse(value));
}

function readIdentity(fixture) {
  return fs.readFile(fixture.identityPath, 'utf8').then((value) => JSON.parse(value));
}

// The identity document is only meaningful if it describes the bytes that were actually frozen.
async function verifyFixtureIdentity(fixture) {
  const [candidateBytes, frozenBytes, identity] = await Promise.all([
    fs.readFile(fixture.candidateSnapshotPath),
    fs.readFile(fixture.frozenSnapshotPath),
    readIdentity(fixture),
  ]);
  check('fixture: the candidate digest is the digest of the frozen candidate bytes',
    identity.schemaVersion === 1 && identity.releaseId === RELEASE_ID
    && identity.candidateDigest === sha256(candidateBytes)
    && identity.candidateDigest === fixture.identity.candidateDigest,
    `identity ${identity.candidateDigest} vs bytes ${sha256(candidateBytes)}`);
  check('fixture: the snapshot digest is the digest of the frozen snapshot bytes',
    identity.snapshotDigest === sha256(frozenBytes) && identity.snapshotDigest === fixture.identity.snapshotDigest,
    `identity ${identity.snapshotDigest} vs bytes ${sha256(frozenBytes)}`);
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

async function verifyManifest(artifacts, label, identity) {
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
    if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) mismatched.push(entry.path);
  }
  check(`${label}: manifest sizes and hashes match the sealed bytes`, mismatched.length === 0, mismatched.join(', '));

  const marker = await readReleaseMarker(artifacts);
  const markerRecorded = manifest.files.some((entry) => entry.path.endsWith('_release.json'));
  check(`${label}: release marker is recorded but excluded from the digest`,
    markerRecorded && marker.artifactDigest === manifest.artifactDigest && marker.releaseId === manifest.releaseId);

  check(`${label}: the sealed release carries the frozen candidate identity`,
    marker.candidateDigest === identity.candidateDigest && marker.snapshotDigest === identity.snapshotDigest
    && manifest.candidateDigest === identity.candidateDigest,
    `marker ${marker.candidateDigest} vs identity ${identity.candidateDigest}`);
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
  check(`${label}: unreferenced managed media is not exported`,
    !artifacts.files.includes(`_site/${RELEASE_ID}/media/unreferenced.png`));

  // The static 404 document is the shared removal view; Next.js would otherwise fall back to
  // its built-in "This page could not be found." page for every unknown GitHub Pages path.
  const notFound = await fs.readFile(path.join(artifactRoot, '404.html'), 'utf8').catch(() => null);
  check(`${label}: 404.html is the shared removal page rather than the Next.js default`,
    notFound !== null && notFound.includes('内容已移除')
    && notFound.includes('href="/"') && notFound.includes('href="/search/"')
    && !notFound.includes('This page could not be found'),
    notFound === null ? '404.html is missing from the sealed release' : '404.html does not match the shared removal view');
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
    requestedReleaseId: RELEASE_ID,
    expectedReleaseId: RELEASE_ID,
    activeReleaseId: RELEASE_ID,
    previewRelease: RELEASE_ID,
    releaseRoot,
  };

  const paths = [
    relativeHtml,
    `${RELEASE_ID}/search-index.json`,
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

// Mutation check: if the build were to read all drafts, this build MUST leak and the leak
// assertion MUST fail. Running it on a temp copy proves the check is not vacuous.
async function verifyMutationDetectsLeak(fixture, mutantOutputRoot) {
  const [candidate, frozen, draft] = await Promise.all([
    fs.readFile(fixture.candidateSnapshotPath, 'utf8').then((value) => JSON.parse(value)),
    fs.readFile(fixture.frozenSnapshotPath, 'utf8').then((value) => JSON.parse(value)),
    fs.readFile(fixture.draftPath, 'utf8').then((value) => JSON.parse(value)),
  ]);
  // A legal public snapshot (draft A merged in) plus its own identity document. The mutant
  // snapshot sits next to the fixture identity on purpose: only the explicit --identity
  // argument can make this build use the mutant digests instead of the frozen ones.
  const mutantCandidateBytes = Buffer.from(JSON.stringify({ ...candidate, articles: [...candidate.articles, draft.article] }));
  const mutantSnapshotBytes = Buffer.from(JSON.stringify({ ...frozen, posts: [...frozen.posts, draft.article] }));
  const mutantCandidatePath = path.join(fixture.fixtureRoot, 'mutant-candidate.json');
  const mutantSnapshotPath = path.join(fixture.fixtureRoot, 'mutant-snapshot.json');
  const mutantIdentityPath = path.join(fixture.fixtureRoot, 'mutant-identity.json');
  const mutantIdentity = {
    schemaVersion: 1,
    releaseId: RELEASE_ID,
    candidateDigest: sha256(mutantCandidateBytes),
    snapshotDigest: sha256(mutantSnapshotBytes),
  };
  await fs.writeFile(mutantCandidatePath, mutantCandidateBytes);
  await fs.writeFile(mutantSnapshotPath, mutantSnapshotBytes);
  await fs.writeFile(mutantIdentityPath, JSON.stringify(mutantIdentity));
  check('mutation: the mutant identity describes the mutant snapshot bytes',
    mutantIdentity.candidateDigest !== fixture.identity.candidateDigest
    && mutantIdentity.candidateDigest === sha256(await fs.readFile(mutantCandidatePath))
    && mutantIdentity.snapshotDigest === sha256(await fs.readFile(mutantSnapshotPath)),
    `mutant candidate ${mutantIdentity.candidateDigest}`);

  const built = run([
    buildScript,
    '--snapshot', mutantSnapshotPath,
    '--identity', mutantIdentityPath,
    '--candidate-digest', mutantIdentity.candidateDigest,
    '--snapshot-digest', mutantIdentity.snapshotDigest,
    '--out', mutantOutputRoot,
  ], 'mutant build', { BLOG_DATA_ROOT: fixture.blockedDataRoot });
  if (built.status !== 0) {
    check('mutation: leaking candidate fails the leak assertion', false, 'mutant build did not run');
    return;
  }
  const artifacts = await readArtifacts(mutantOutputRoot);
  check('mutation: leaking candidate fails the leak assertion', artifacts.text.includes(DRAFT_SECRET_MARKER),
    'the leak check would not have caught a build that read drafts');
  const marker = await readReleaseMarker(artifacts);
  check('mutation: the mutant release is sealed under its own candidate identity',
    mutantIdentity.candidateDigest !== fixture.identity.candidateDigest
    && marker.candidateDigest === mutantIdentity.candidateDigest
    && marker.snapshotDigest === mutantIdentity.snapshotDigest,
    `marker ${marker.candidateDigest} vs mutant ${mutantIdentity.candidateDigest}`);
}

async function runAcceptance(fixtureRoot) {
  const fixture = await createReleaseFixture({ root: fixtureRoot });
  await verifyFixtureIdentity(fixture);

  const outputRoot = path.join(fixtureRoot, 'out');
  const build = run([
    buildScript,
    '--snapshot', fixture.frozenSnapshotPath,
    '--identity', fixture.identityPath,
    '--candidate-digest', fixture.identity.candidateDigest,
    '--snapshot-digest', fixture.identity.snapshotDigest,
    '--out', outputRoot,
  ], 'public build', { BLOG_DATA_ROOT: fixture.blockedDataRoot });
  check('isolated public build succeeds', build.status === 0, `exit ${build.status}`);
  if (build.status !== 0) throw new Error('Public build failed; stopping before artifact assertions.');

  const artifacts = await readArtifacts(outputRoot);
  await verifyLeakage(artifacts, 'release');
  await verifyManifest(artifacts, 'release', fixture.identity);
  await verifySearchAndFeeds(artifacts, 'release');
  await verifyPreviewAuthorization(artifacts, 'release');

  await verifyMutationDetectsLeak(fixture, path.join(fixtureRoot, 'mutant-out'));
}

async function main() {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'guanlan-first-release-'));
  try {
    await runAcceptance(fixtureRoot);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }

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
