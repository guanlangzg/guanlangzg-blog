import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import nextPlugin from '@next/eslint-plugin-next';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';

const globals = {
    alert: 'readonly',
    Blob: 'readonly',
    console: 'readonly',
    crypto: 'readonly',
    document: 'readonly',
    fetch: 'readonly',
    FileReader: 'readonly',
    FormData: 'readonly',
    Headers: 'readonly',
    localStorage: 'readonly',
    navigator: 'readonly',
    process: 'readonly',
    Request: 'readonly',
    Response: 'readonly',
    sessionStorage: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    TextEncoder: 'readonly',
    URL: 'readonly',
    window: 'readonly',
};

export default [
    {
        ignores: [
            '.next/**',
            '**/.next/**',
            'coverage/**',
            'dist/**',
            '**/dist/**',
            'out/**',
            'build/**',
            'node_modules/**',
            '**/node_modules/**',
            '**/.vitepress/**',
            'blog-nevigation/**',
            '.playwright-mcp/**',
            'output/**',
            'content/posts/**',
            'docs/**',
        ],
    },
    js.configs.recommended,
    {
        files: ['**/*.{js,mjs,cjs,jsx,ts,tsx}'],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 'latest',
            sourceType: 'module',
            parserOptions: {
                ecmaFeatures: {
                    jsx: true,
                },
            },
            globals,
        },
        settings: {
            react: {
                version: 'detect',
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
            '@next/next': nextPlugin,
            react: reactPlugin,
            'react-hooks': reactHooksPlugin,
            'jsx-a11y': jsxA11yPlugin,
        },
        rules: {
            ...reactPlugin.configs.recommended.rules,
            ...nextPlugin.configs.recommended.rules,
            ...nextPlugin.configs['core-web-vitals'].rules,
            ...jsxA11yPlugin.configs.recommended.rules,
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
            'jsx-a11y/label-has-associated-control': 'off',
            'jsx-a11y/no-autofocus': 'off',
            'no-undef': 'off',
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
            'react/jsx-no-comment-textnodes': 'off',
            'react/no-unescaped-entities': 'off',
            'react/no-unknown-property': 'off',
            'react/prop-types': 'off',
            'react/react-in-jsx-scope': 'off',
        },
    },
];
