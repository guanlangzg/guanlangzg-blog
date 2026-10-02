#!/usr/bin/env node
import path from 'node:path';
import {
  parseBackupPayloadData,
  readJsonFile,
  restoreRuntimeDataAtomically,
  resolveDataRoot,
} from './runtime-data.mjs';
import {
  decryptBackupPayload,
  getBackupEncryptionSecret,
} from './encrypted-backup.mjs';

function main() {
  const [encryptedBackupFileArg, dataRootArg] = process.argv.slice(2);

  if (!encryptedBackupFileArg) {
    throw new Error('Usage: node scripts/data/restore-encrypted-backup.mjs <encrypted-backup-file> [data-root]');
  }

  const encryptedBackupFile = path.resolve(encryptedBackupFileArg);
  const dataRoot = resolveDataRoot(dataRootArg);
  const encryptedPayload = readJsonFile(encryptedBackupFile);
  const backupPayload = decryptBackupPayload(encryptedPayload, getBackupEncryptionSecret());
  const data = parseBackupPayloadData(backupPayload);

  restoreRuntimeDataAtomically(dataRoot, data);

  console.log(JSON.stringify({
    dataRoot,
    encryptedBackupFile,
    articles: data.articles.length,
    categories: data.navigation.length,
    settings: true,
    manifest: true,
  }, null, 2));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Encrypted backup restore failed: ${message}`);
  process.exit(1);
}
