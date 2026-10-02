import fs from 'node:fs';
import path from 'node:path';

export function fsyncFile(filePath: string): void {
    const fileDescriptor = fs.openSync(filePath, 'r+');

    try {
        fs.fsyncSync(fileDescriptor);
    } finally {
        fs.closeSync(fileDescriptor);
    }
}

export function fsyncDirectory(directoryPath: string): void {
    try {
        const fileDescriptor = fs.openSync(directoryPath, 'r');

        try {
            fs.fsyncSync(fileDescriptor);
        } finally {
            fs.closeSync(fileDescriptor);
        }
    } catch (error) {
        if (process.platform !== 'win32') {
            throw error;
        }
    }
}

export function writeJsonAtomically(
    filePath: string,
    value: unknown,
    options: { mode?: number } = {}
): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
        fs.writeFileSync(tempFilePath, JSON.stringify(value, null, 2), 'utf8');
        if (options.mode !== undefined) {
            fs.chmodSync(tempFilePath, options.mode);
        }
        fsyncFile(tempFilePath);
        fs.renameSync(tempFilePath, filePath);
        if (options.mode !== undefined) {
            fs.chmodSync(filePath, options.mode);
        }
        fsyncDirectory(path.dirname(filePath));
    } catch (error) {
        fs.rmSync(tempFilePath, { force: true });
        throw error;
    }
}
