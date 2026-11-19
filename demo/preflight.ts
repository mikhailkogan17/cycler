import { existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { command } from './lib.js';

const statePath = process.env.DEMO_STORAGE_STATE;
const configPath = process.env.DEMO_CYCLER_CONFIG;
if (!statePath || !configPath || !existsSync(statePath) || !existsSync(configPath)) throw new Error('browser state or Cycler demo config missing');
const state = JSON.parse(readFileSync(statePath, 'utf8')) as { cookies?: unknown[]; origins?: unknown[] };
if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error('invalid Playwright storage state');
if (!existsSync(chromium.executablePath())) throw new Error('Playwright Chromium missing: cd demo && npx playwright install chromium');
command('linear', ['auth', 'whoami']);
command('gh', ['auth', 'status']);
if (!/\bdrawtext\b/.test(command('ffmpeg', ['-hide_banner', '-filters']))) throw new Error('ffmpeg lacks drawtext; install a build with libfreetype');
if (process.env.DEMO_CAPTURE !== 'asciinema') {
  if (!/^\d+$/.test(process.env.DEMO_CAP_WINDOW ?? '')) throw new Error('DEMO_CAP_WINDOW must be a Cap window target ID');
  const cap = JSON.parse(command('/Applications/Cap.app/Contents/MacOS/cap-cli', ['doctor', '--json'])) as { captureReady?: boolean; permissions?: { screenRecording?: string } };
  if (!cap.captureReady || cap.permissions?.screenRecording !== 'granted') throw new Error('Cap Screen Recording permission is not granted');
}
process.stdout.write('demo prerequisites ready\n');
