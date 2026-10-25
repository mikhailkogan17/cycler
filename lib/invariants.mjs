// Stage-boundary enforcement for runtimes that do not run Claude's PreToolUse hooks.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export function digest(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
export function protect(paths) {
  const original = paths.map(path => [path, digest(path)]);
  return () => {
    for (const [path, before] of original) if (digest(path) !== before)
      throw new Error(`Protected contract/gate changed during the run: ${path}`);
  };
}
