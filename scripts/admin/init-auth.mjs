#!/usr/bin/env node
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

function readLine(promptText, hidden = true) {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        const stdout = process.stdout;

        if (!stdin.isTTY) {
            reject(new Error('This command requires an interactive TTY; redirected password input is not accepted.'));
            return;
        }

        stdout.write(promptText);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        let value = '';
        const finish = (error, result) => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
            stdout.write('\n');
            if (error) reject(error);
            else resolve(result);
        };

        const onData = (chunk) => {
            for (const character of chunk) {
                if (character === '\u0003') {
                    finish(new Error('Cancelled. Nothing was written.'));
                    return;
                }
                if (character === '\r' || character === '\n') {
                    finish(null, value);
                    return;
                }
                if (character === '\u007f' || character === '\b') {
                    if (value.length > 0) {
                        value = Array.from(value).slice(0, -1).join('');
                        if (!hidden) stdout.write('\b \b');
                    }
                    continue;
                }
                value += character;
                if (!hidden) stdout.write(character);
            }
        };

        stdin.on('data', onData);
    });
}

function installSourceAliasHook(sourceRoot) {
    registerHooks({
        resolve(specifier, context, nextResolve) {
            if (!specifier.startsWith('@/')) return nextResolve(specifier, context);
            const sourcePath = path.resolve(sourceRoot, `${specifier.slice(2)}.ts`);
            return nextResolve(pathToFileURL(sourcePath).href, context);
        },
    });
}

async function main() {
    if (!process.stdin.isTTY) {
        throw new Error('This command requires an interactive TTY; redirected password input is not accepted.');
    }

    const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(scriptDirectory, '../..');
    const sourceRoot = path.join(projectRoot, 'src');
    installSourceAliasHook(sourceRoot);

    const runtime = await import(pathToFileURL(path.join(sourceRoot, 'lib/editor-auth-runtime.ts')).href);
    const passwordRules = await import(pathToFileURL(path.join(sourceRoot, 'lib/editor-auth-password.ts')).href);
    const configPath = runtime.getRuntimeEditorAuthConfigFilePath();
    const alreadyConfigured = runtime.isRuntimeEditorAuthConfigured();
    let replaceExisting = false;

    if (alreadyConfigured) {
        const confirmation = await readLine(
            `Admin authentication already exists at ${configPath}. Type RESET to replace it: `,
            false
        );
        if (confirmation.trim() !== 'RESET') {
            throw new Error('Existing admin authentication was not changed.');
        }
        replaceExisting = true;
    }

    const password = await readLine('New admin password (input hidden): ');
    const confirmation = await readLine('Repeat the password (input hidden): ');
    if (password !== confirmation) {
        throw new Error('Passwords did not match. Nothing was written.');
    }
    if (!passwordRules.isValidEditorSecretShape(password)) {
        throw new Error('Password rejected: use at least 12 characters and avoid blank or known development defaults.');
    }

    try {
        if (replaceExisting) {
            await runtime.updateRuntimeEditorAuthSecret(password);
        } else {
            await runtime.initializeRuntimeEditorAuth(password);
        }
    } catch (error) {
        if (error instanceof runtime.RuntimeEditorAuthAlreadyConfiguredError) {
            throw new Error('Editor auth became configured while this command was running. Nothing was overwritten.');
        }
        if (error instanceof runtime.RuntimeEditorAuthInvalidSecretError) {
            throw new Error('Password rejected by the runtime authentication rules.');
        }
        throw error;
    }

    process.stdout.write(`Admin password initialized at ${configPath} (mode 0600).\n`);
    process.stdout.write('Expose public port 5678 only after this command succeeds.\n');
}

main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
