#!/usr/bin/env node
/**
 * Boot-screen screenshot for the Web profile.
 *
 *   node scripts/preview.mjs <url> <out.png> [--wait <ms>]
 *
 * Opens the harness web UI in Chromium, waits for the app shell to settle, and
 * writes a full-page screenshot. Console errors and page failures are printed so
 * a failed run explains itself in the Action log.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [url, out] = process.argv.slice(2);
const waitIndex = process.argv.indexOf('--wait');
const wait = waitIndex === -1 ? 15000 : Number(process.argv[waitIndex + 1]);

if (url === undefined || out === undefined) {
  console.error('usage: node scripts/preview.mjs <url> <out.png> [--wait <ms>]');
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright is not installed; run `npm i playwright` first');
  process.exit(2);
}

mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) => problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`));

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(wait);
  const title = await page.title();
  const text = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')) || '';
  await page.screenshot({ path: out, fullPage: true });
  console.log(`title=${title}`);
  console.log(`screenshot=${out}`);
  console.log(`body_chars=${text.length}`);
  console.log(`body_preview=${text.replace(/\s+/gu, ' ').slice(0, 600)}`);
} catch (error) {
  console.error(`preview failed: ${error.message}`);
  await page.screenshot({ path: out, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (problems.length > 0) console.log(`problems=${problems.slice(0, 10).join(' | ')}`);
  await browser.close();
}
