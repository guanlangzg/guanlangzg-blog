import { readFile } from 'node:fs/promises';
import type { PublicSiteSnapshot } from './types';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isCalendarDay(year: number, month: number, day: number): boolean {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * `post.date` is the only publication date the frozen public site may publish, and the editor
 * writes it as a calendar day in UTC. A value the editor never validated must be dropped by
 * the feeds instead of being formatted, so this returns null for anything that is not a real
 * calendar day (`new Date` alone silently normalises e.g. 2026-02-31 and parses non-date-only
 * strings in the local timezone).
 */
export function parseSnapshotDate(value: string): Date | null {
    const dateOnly = DATE_ONLY.exec(value);
    const match = dateOnly ?? DATE_TIME.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!isCalendarDay(year, month, day)) return null;
    if (dateOnly) return new Date(Date.UTC(year, month - 1, day));
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

const snapshotPath = process.env.PUBLIC_SITE_SNAPSHOT_PATH;
if (!snapshotPath) throw new Error('PUBLIC_SITE_SNAPSHOT_PATH is required');

const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as PublicSiteSnapshot;
export default snapshot;
