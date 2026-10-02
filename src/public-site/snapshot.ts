import { readFile } from 'node:fs/promises';
import type { PublicSiteSnapshot } from './types';

const snapshotPath = process.env.PUBLIC_SITE_SNAPSHOT_PATH;
if (!snapshotPath) throw new Error('PUBLIC_SITE_SNAPSHOT_PATH is required');

const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as PublicSiteSnapshot;
export default snapshot;
