import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./tests/setup.ts'],
        include: ['tests/**/*.test.{ts,tsx}'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['src/**/*.{ts,tsx}'],
            exclude: ['src/app/layout.tsx', 'src/app/**/layout.tsx'],
            thresholds: {
                statements: 60,
                branches: 50,
                functions: 57,
                lines: 61,
            },
        },
    },
    resolve: {
        alias: [
            {
                find: /^@\/content\/(.*)$/,
                replacement: path.resolve(__dirname, './content/$1'),
            },
            {
                find: /^@\//,
                replacement: `${path.resolve(__dirname, './src')}/`,
            },
        ],
    },
});
