import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TypeScript path aliases', () => {
    it('maps source imports to src and content imports to content seeds', () => {
        const tsconfigPath = path.join(process.cwd(), 'tsconfig.json');
        const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8')) as {
            compilerOptions?: {
                paths?: Record<string, string[]>;
            };
        };

        expect(tsconfig.compilerOptions?.paths?.['@/*']).toEqual(['./src/*']);
        expect(tsconfig.compilerOptions?.paths?.['@/content/*']).toEqual(['./content/*']);
    });
});
