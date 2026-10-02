#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  createManifest,
  getManifestProblems,
  readManifest,
  readRuntimeData,
  resolveDataRoot,
  writeManifest,
} from './runtime-data.mjs';

const args = process.argv.slice(2);
const writeManifestFlag = args.includes('--write-manifest');
const dataRootArg = args.find((arg) => !arg.startsWith('--'));
const dataRoot = resolveDataRoot(dataRootArg);

function collectMediaFiles(directory, relativeTo) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return collectMediaFiles(entryPath, relativeTo);
    }

    if (!entry.isFile()) {
      return [];
    }

    return [path.relative(relativeTo, entryPath).replace(/\\/g, '/')];
  });
}

function getMediaConsistencyProblems(dataRoot) {
  const mediaRoot = path.join(dataRoot, 'media');
  const manifestPath = path.join(mediaRoot, 'manifest.json');
  const filesRoot = path.join(mediaRoot, 'files');

  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return ['media/manifest.json is invalid JSON.'];
  }

  if (!Array.isArray(manifest.assets)) {
    return ['media/manifest.json is missing assets array.'];
  }

  const knownPaths = new Set(manifest.assets.map((asset) => asset.path));
  const storedFiles = collectMediaFiles(filesRoot, mediaRoot);
  const storedSet = new Set(storedFiles);
  const missingFiles = manifest.assets
    .filter((asset) => !storedSet.has(asset.path))
    .map((asset) => asset.path);
  const orphanFiles = storedFiles.filter((filePath) => !knownPaths.has(filePath));

  const problems = [];
  if (missingFiles.length > 0) {
    problems.push(`media: ${missingFiles.length} file(s) referenced by manifest but missing on disk.`);
  }
  if (orphanFiles.length > 0) {
    problems.push(`media: ${orphanFiles.length} orphan file(s) on disk not tracked by manifest.`);
  }

  return problems;
}

try {
  const data = readRuntimeData(dataRoot);
  const manifest = readManifest(dataRoot);
  const problems = [...getManifestProblems(data, manifest), ...getMediaConsistencyProblems(dataRoot)];

  if (problems.length > 0 && writeManifestFlag) {
    writeManifest(dataRoot, createManifest(data));
  }

  if (problems.length > 0 && !writeManifestFlag) {
    console.error(JSON.stringify({
      ok: false,
      dataRoot,
      problems,
      hint: 'Run npm run data:verify -- <data-root> --write-manifest to regenerate manifest.json.',
    }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    dataRoot,
    repaired: problems.length > 0,
    articles: data.articles.length,
    categories: data.navigation.length,
    settings: true,
    manifest: true,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    dataRoot,
    message: error instanceof Error ? error.message : 'Runtime data verification failed.',
  }, null, 2));
  process.exit(1);
}
