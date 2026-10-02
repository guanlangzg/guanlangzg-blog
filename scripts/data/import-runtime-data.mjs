#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  createBackupPayload,
  DATA_SCHEMA_VERSION,
  parseBackupPayloadData,
  readJsonFile,
  readSchemaVersion,
  readRuntimeBackupData,
  restoreRuntimeDataAtomically,
  resolveDataRoot,
  writeJsonAtomically,
} from './runtime-data.mjs';

const [backupFileArg, dataRootArg] = process.argv.slice(2);

if (!backupFileArg) {
  console.error('Usage: node scripts/data/import-runtime-data.mjs <backup-file> [data-root]');
  process.exit(1);
}

const backupFile = path.resolve(backupFileArg);
const dataRoot = resolveDataRoot(dataRootArg);
const payload = readJsonFile(backupFile);
const schemaVersion = readSchemaVersion(payload);
const data = parseBackupPayloadData(payload);

if (schemaVersion < DATA_SCHEMA_VERSION && fs.existsSync(dataRoot)) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(dataRoot, 'backups', `pre-migration-${timestamp}.json`);
  const currentData = readRuntimeBackupData(dataRoot);

  writeJsonAtomically(snapshotPath, createBackupPayload(dataRoot, currentData));
}

restoreRuntimeDataAtomically(dataRoot, data);

console.log(JSON.stringify({
  dataRoot,
  backupFile,
  articles: data.articles.length,
  categories: data.navigation.length,
  settings: true,
  manifest: true,
}, null, 2));
