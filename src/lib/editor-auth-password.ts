import { scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// The password rule is shared with scripts/admin/init-auth.mjs so the CLI cannot
// drift from the runtime verifier. Changing anything here invalidates existing
// stored hashes, which is why it carries an explicit version namespace.
const EDITOR_PASSWORD_NAMESPACE = 'blog-navigation-editor-password:v1';
const MIN_EDITOR_SECRET_LENGTH = 12;
const EDITOR_PASSWORD_KEY_LENGTH = 64;

// Passwords that must never protect a public admin port.
const FORBIDDEN_EDITOR_SECRETS = [
    'admin',
    'password',
    'changeme',
    'editor',
    'guanlan',
    '123456789012',
] as const;

export function normalizeEditorSecret(secret: string): string {
    return secret.trim();
}

export function isValidEditorSecretShape(secret: string): boolean {
    const normalized = normalizeEditorSecret(secret);
    return normalized.length >= MIN_EDITOR_SECRET_LENGTH
        && !FORBIDDEN_EDITOR_SECRETS.includes(normalized.toLowerCase() as (typeof FORBIDDEN_EDITOR_SECRETS)[number]);
}

export async function createEditorPasswordHash(secret: string, salt: string): Promise<string> {
    const hash = await scryptAsync(
        `${EDITOR_PASSWORD_NAMESPACE}:${normalizeEditorSecret(secret)}`,
        salt,
        EDITOR_PASSWORD_KEY_LENGTH
    ) as Buffer;

    return hash.toString('hex');
}