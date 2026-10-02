import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { getRuntimeDataRoot } from '@/lib/runtime-config';

function isMissingPathError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function canWriteDirectory(pathname: string): Promise<boolean> {
    const stats = await fsPromises.stat(pathname);

    if (!stats.isDirectory()) {
        return false;
    }

    await fsPromises.access(pathname, fs.constants.W_OK);
    return true;
}

function canWriteDirectorySync(pathname: string): boolean {
    const stats = fs.statSync(pathname);

    if (!stats.isDirectory()) {
        return false;
    }

    fs.accessSync(pathname, fs.constants.W_OK);
    return true;
}

async function canAccessDirectory(pathname: string, mode: number): Promise<boolean> {
    const stats = await fsPromises.stat(pathname);

    if (!stats.isDirectory()) {
        return false;
    }

    await fsPromises.access(pathname, mode);
    return true;
}

function canAccessDirectorySync(pathname: string, mode: number): boolean {
    const stats = fs.statSync(pathname);

    if (!stats.isDirectory()) {
        return false;
    }

    fs.accessSync(pathname, mode);
    return true;
}

export async function isRuntimeDataRootWritable(pathname: string): Promise<boolean> {
    let currentPath = path.resolve(pathname);

    while (true) {
        try {
            return await canWriteDirectory(currentPath);
        } catch (error) {
            if (!isMissingPathError(error)) {
                return false;
            }
        }

        const parentPath = path.dirname(currentPath);

        if (parentPath === currentPath) {
            return false;
        }

        currentPath = parentPath;
    }
}

export function isRuntimeDataRootWritableSync(pathname: string): boolean {
    let currentPath = path.resolve(pathname);

    while (true) {
        try {
            return canWriteDirectorySync(currentPath);
        } catch (error) {
            if (!isMissingPathError(error)) {
                return false;
            }
        }

        const parentPath = path.dirname(currentPath);

        if (parentPath === currentPath) {
            return false;
        }

        currentPath = parentPath;
    }
}

export async function isRuntimeDataRootAvailable(pathname: string): Promise<boolean> {
    const resolvedRoot = path.resolve(pathname);
    let currentPath = resolvedRoot;

    while (true) {
        try {
            return await canAccessDirectory(
                currentPath,
                currentPath === resolvedRoot
                    ? fs.constants.R_OK | fs.constants.X_OK
                    : fs.constants.W_OK | fs.constants.X_OK
            );
        } catch (error) {
            if (!isMissingPathError(error)) {
                return false;
            }
        }

        const parentPath = path.dirname(currentPath);

        if (parentPath === currentPath) {
            return false;
        }

        currentPath = parentPath;
    }
}

export function isRuntimeDataRootAvailableSync(pathname: string): boolean {
    const resolvedRoot = path.resolve(pathname);
    let currentPath = resolvedRoot;

    while (true) {
        try {
            return canAccessDirectorySync(
                currentPath,
                currentPath === resolvedRoot
                    ? fs.constants.R_OK | fs.constants.X_OK
                    : fs.constants.W_OK | fs.constants.X_OK
            );
        } catch (error) {
            if (!isMissingPathError(error)) {
                return false;
            }
        }

        const parentPath = path.dirname(currentPath);

        if (parentPath === currentPath) {
            return false;
        }

        currentPath = parentPath;
    }
}

export async function hasWritableRuntimeDataRoot(): Promise<boolean> {
    return isRuntimeDataRootWritable(getRuntimeDataRoot().path);
}
