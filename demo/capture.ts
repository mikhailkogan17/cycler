import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runDir } from './lib.js';

export async function capture(type: string, issueUrl: string, prUrl?: string): Promise<void> {
  if (!runDir) throw new Error('DEMO_RUN_DIR missing');
  const storageState = process.env.DEMO_STORAGE_STATE;
  if (!storageState) throw new Error('DEMO_STORAGE_STATE missing');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', storageState, reducedMotion: 'reduce' });
    const dir = join(runDir, 'frames');
    await mkdir(dir, { recursive: true });
    for (const [name, url] of [['linear', issueUrl], ['pr', prUrl]] as const) {
      if (!url) continue;
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
      await page.addStyleTag({ content: `
        img[alt*="avatar" i], [class*="avatar" i], [data-testid*="avatar" i],
        a[href^="mailto:"] { filter: blur(20px) !important; visibility: hidden !important; }
        * { animation: none !important; transition: none !important; }
      ` });
      await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.textContent) node.textContent = node.textContent.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email hidden]');
        }
      });
      await page.screenshot({ path: join(dir, `${type}-${name}.png`), animations: 'disabled' });
      await page.close();
    }
    await context.close();
  } finally { await browser.close(); }
}
