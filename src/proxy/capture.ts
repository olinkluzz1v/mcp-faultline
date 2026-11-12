import { access, lstat, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ProxyCapture } from './types.js';

/** Validate without starting the upstream process or changing an existing path. */
export async function validateCapturePath(input: string): Promise<string> {
  if (!input.trim()) throw new Error('Capture path must not be empty');
  const path = resolve(input);
  try {
    await lstat(path); // Includes directories and both live/dangling symlinks.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (!(await stat(parent)).isDirectory()) throw new Error('Capture parent is not a directory');
    await access(parent, constants.W_OK | constants.X_OK);
    return path;
  }
  throw new Error(`Capture destination already exists: ${path}`);
}

/**
 * Exclusive creation also guards collisions after preflight. Never overwrite
 * or unlink another capture. A failed/interrupted write can leave partial JSON;
 * durability across SIGKILL or machine failure is not guaranteed.
 */
export async function writeCapture(path: string, capture: ProxyCapture): Promise<void> {
  await writeFile(path, JSON.stringify(capture, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
