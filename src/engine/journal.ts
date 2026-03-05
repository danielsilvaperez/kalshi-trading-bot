import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function journal(path: string, event: Record<string, unknown>) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}
