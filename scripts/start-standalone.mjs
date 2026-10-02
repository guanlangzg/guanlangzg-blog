import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = process.cwd();
const standaloneRoot = path.join(repoRoot, '.next', 'standalone');
const standaloneServer = path.join(standaloneRoot, 'server.js');

function copyRuntimeAsset(sourcePath, targetPath) {
    if (!fs.existsSync(sourcePath)) {
        return;
    }

    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.cpSync(sourcePath, targetPath, { recursive: true });
}

if (!fs.existsSync(standaloneServer)) {
    console.error('Standalone server not found. Run `npm run build` before `npm run start`.');
    process.exit(1);
}

copyRuntimeAsset(path.join(repoRoot, '.next', 'static'), path.join(standaloneRoot, '.next', 'static'));
copyRuntimeAsset(path.join(repoRoot, 'public'), path.join(standaloneRoot, 'public'));
copyRuntimeAsset(path.join(repoRoot, 'content', 'seeds'), path.join(standaloneRoot, 'content', 'seeds'));

const server = spawn(process.execPath, ['server.js'], {
    cwd: standaloneRoot,
    env: process.env,
    stdio: 'inherit',
});

function stopServer(signal) {
    if (!server.killed) {
        server.kill(signal);
    }
}

process.on('SIGINT', () => stopServer('SIGINT'));
process.on('SIGTERM', () => stopServer('SIGTERM'));

server.on('exit', (code, signal) => {
    process.exit(signal ? 0 : code ?? 0);
});
