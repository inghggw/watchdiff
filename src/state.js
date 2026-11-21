/**
 * Baseline storage: one small JSON file per watcher.
 *
 * A file per watcher (instead of one shared file) means a corrupt or
 * half-written state only ever loses that watcher's history, and two watchers
 * can run concurrently without a lock. Writes are atomic: write a temp file,
 * then rename, so a process killed mid-write never leaves a truncated baseline
 * that would read as "everything changed".
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function hashValue(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export class StateStore {
  constructor(dir) {
    this.dir = dir;
  }

  fileFor(name) {
    return path.join(this.dir, `${name}.json`);
  }

  async read(name) {
    try {
      return JSON.parse(await readFile(this.fileFor(name), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      // A damaged baseline is treated as absent: the next check re-seeds it and
      // stays quiet, which beats emitting a false "changed" alert.
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async write(name, state) {
    await mkdir(this.dir, { recursive: true });
    const target = this.fileFor(name);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, target);
    return state;
  }

  async list() {
    try {
      const entries = await readdir(this.dir);
      return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
}

/** The baseline written on a watcher's first successful check. */
export function initialState(name, reading, now) {
  const timestamp = now.toISOString();
  return {
    name,
    kind: reading.kind,
    value: reading.kind === 'single' ? reading.value : undefined,
    items: reading.kind === 'list' ? reading.items : undefined,
    hash: hashValue(reading.kind === 'single' ? reading.value : reading.items),
    firstSeen: timestamp,
    lastCheck: timestamp,
    lastChange: null,
    lastNotifiedAt: null,
    consecutiveErrors: 0,
    checks: 1,
    changeCount: 0,
  };
}
