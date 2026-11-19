import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { command, runDir } from './lib.js';

const bin = '/Applications/Cap.app/Contents/MacOS/cap-cli';
if (!runDir || !existsSync(bin)) throw new Error('Cap CLI or DEMO_RUN_DIR missing');
const action = process.argv[2];
const project = join(runDir, 'cap-recording.cap');
const idFile = join(runDir, 'cap-recording-id');
function lastJson(output: string): Record<string, unknown> {
  const lines = output.split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try { return JSON.parse(lines[index]) as Record<string, unknown>; } catch { /* progress text */ }
  }
  throw new Error('Cap returned no JSON result');
}
if (action === 'doctor') {
  const result = JSON.parse(command(bin, ['doctor', '--json'])) as { captureReady?: boolean; permissions?: { screenRecording?: string } };
  if (!result.captureReady || result.permissions?.screenRecording !== 'granted') throw new Error('Cap Screen Recording permission is not granted');
} else if (action === 'start') {
  const windowId = process.env.DEMO_CAP_WINDOW;
  if (!windowId || !/^\d+$/.test(windowId)) throw new Error('DEMO_CAP_WINDOW must be a Cap window target ID');
  const result = lastJson(command(bin, ['record', 'start', '--window', windowId, '--path', project, '--fps', '30', '--detach', '--json']));
  const recordingId = result.recordingId;
  if (result.error || typeof recordingId !== 'string' || !recordingId) throw new Error(`Cap start failed: ${JSON.stringify(result)}`);
  writeFileSync(idFile, recordingId, { mode: 0o600 });
  process.stdout.write(`Cap recording ${recordingId} started\n`);
} else if (action === 'stop') {
  if (!existsSync(idFile)) throw new Error('Cap recording ID missing');
  const id = readFileSync(idFile, 'utf8').trim();
  const result = lastJson(command(bin, ['record', 'stop', '--id', id, '--json']));
  if (result.error || result.type !== 'stopped') throw new Error(`Cap stop failed: ${JSON.stringify(result)}`);
  if (process.argv.includes('--export')) {
    const exported = lastJson(command(bin, ['export', project, '--output', join(runDir, 'cap-raw.mp4'), '--resolution', '1920x1080', '--quality', 'web', '--json'], undefined, 600_000));
    if (exported.error || !existsSync(join(runDir, 'cap-raw.mp4'))) throw new Error(`Cap export failed: ${JSON.stringify(exported)}`);
  }
} else throw new Error('usage: cap.ts doctor|start|stop [--export]');
