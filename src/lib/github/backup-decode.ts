import type { Article } from '@/app/types/article';
import { isRecord, parseArticleDataOrThrow } from '@/lib/article-data';
import { validateArticlePaths } from '@/lib/publishing/snapshot';

const ARTICLE_FIELDS = new Set([
  'id', 'slug', 'title', 'date', 'description', 'tags', 'content', 'createdAt', 'updatedAt',
  'kind', 'status', 'category', 'series', 'featured', 'updatedDate', 'sourceLinks', 'revisionNotes', 'templateId',
]);
const SOURCE_LINK_FIELDS = new Set(['title', 'url', 'note']);
const REVISION_NOTE_FIELDS = new Set(['date', 'note']);

export class UnsupportedBackupSchemaError extends Error {
  constructor(message: string) {
    super(`UNSUPPORTED_SCHEMA: ${message}`);
    this.name = 'UnsupportedBackupSchemaError';
  }
}

function assertExactKeys(record: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unknownFields = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknownFields.length > 0) {
    throw new UnsupportedBackupSchemaError(`${path} contains unsupported field(s): ${unknownFields.join(', ')}`);
  }
}

function assertOptionalString(record: Record<string, unknown>, key: string): void {
  if (record[key] !== undefined && typeof record[key] !== 'string') {
    throw new Error(`Invalid article metadata field: ${key}`);
  }
}

function validateArticleMetadata(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Article metadata must be an object.');
  if (value.schemaVersion !== 1) {
    throw new UnsupportedBackupSchemaError(`article metadata schemaVersion ${String(value.schemaVersion)} is unsupported.`);
  }
  assertExactKeys(value, new Set([...ARTICLE_FIELDS].filter((field) => field !== 'content').concat('schemaVersion')), 'Article metadata');

  for (const key of ['slug', 'kind', 'status', 'category', 'series', 'updatedDate', 'templateId']) {
    assertOptionalString(value, key);
  }
  if (value.featured !== undefined && typeof value.featured !== 'boolean') {
    throw new Error('Invalid article metadata field: featured');
  }
  if (value.sourceLinks !== undefined) {
    if (!Array.isArray(value.sourceLinks)) throw new Error('Invalid article metadata field: sourceLinks');
    value.sourceLinks.forEach((link, index) => {
      if (!isRecord(link)) throw new Error(`Invalid article source link at index ${index}.`);
      assertExactKeys(link, SOURCE_LINK_FIELDS, `Article sourceLinks[${index}]`);
    });
  }
  if (value.revisionNotes !== undefined) {
    if (!Array.isArray(value.revisionNotes)) throw new Error('Invalid article metadata field: revisionNotes');
    value.revisionNotes.forEach((note, index) => {
      if (!isRecord(note)) throw new Error(`Invalid article revision note at index ${index}.`);
      assertExactKeys(note, REVISION_NOTE_FIELDS, `Article revisionNotes[${index}]`);
    });
  }
  return value;
}

export function decodeBackupArticle(metadataBytes: Uint8Array, contentBytes: Uint8Array): Article {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(metadataBytes).toString('utf8')) as unknown;
  } catch {
    throw new Error('Article metadata JSON is invalid.');
  }

  const metadata = validateArticleMetadata(parsed);
  const articleValue: Record<string, unknown> = { ...metadata, content: Buffer.from(contentBytes).toString('utf8') };
  delete articleValue.schemaVersion;

  // The established parser remains the base Article contract validator; preserve its raw input
  // because normalizing optional fields would make historical metadata lossy.
  parseArticleDataOrThrow(articleValue);
  const article = articleValue as unknown as Article;
  validateArticlePaths([article]);
  return article;
}

export function assertSupportedBackupSchema(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (value.schemaVersion !== 1) {
    throw new UnsupportedBackupSchemaError(`${label} schemaVersion ${String(value.schemaVersion)} is unsupported.`);
  }
}
