import { mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export class FileLock {
  constructor(private path: string) {}

  acquire(): boolean {
    mkdirSync(dirname(this.path), { recursive: true });
    try {
      const fd = openSync(this.path, 'wx');
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    try {
      unlinkSync(this.path);
    } catch {
      // noop
    }
  }
}
