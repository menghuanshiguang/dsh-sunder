#!/usr/bin/env node
/**
 * Explore the harness web UI and capture a few states.
 *
 *   node preview.mjs <url> <outDir> [--wait <ms>]
 *
 * The first screenshot is the landing view; after that the script dismisses the
 * preview notice and tries the obvious navigation entries (Plugins, More,
 * Settings) so one run covers the surfaces a reviewer would open by hand.
 * Every step prints the visible interactive labels, which is how the next
 * iteration picks the right selector instead of guessing.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [url, outDir] = process.argv.slice(2);
const waitIndex = process.argv.indexOf('--wait');
const wait = waitIndex === -1 ? 8000 : Number(process.argv[waitIndex + 1]);

if (url === undefined || outDir === undefined) {
  console.error('usage: node preview.mjs <url> <outDir> [--wait <ms>]');
  process.exit(2);
}

const { chromium } = await import('playwright');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});

let shot = 0;
const capture = async (name) => {
  shot += 1;
  const file = join(outDir, `${String(shot).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`shot=${file}`);
};

const labels = async (step) => {
  const texts = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], li')];
    return nodes
      .map((node) => (node.textContent ?? '').replace(/\s+/gu, ' ').trim())
      .filter((text) => text.length > 0 && text.length < 60)
      .slice(0, 60);
  });
  console.log(`labels[${step}]=${texts.join(' | ')}`);
};

/** Click by exact visible text through the DOM, bypassing actionability checks. */
const clickIf = async (name) => {
  const clicked = await page.evaluate((wanted) => {
    const nodes = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], li, div, span')];
    const hit = nodes.reverse().find((node) => (node.textContent ?? '').trim() === wanted);
    if (hit === undefined) return false;
    hit.click();
    return true;
  }, name);
  if (clicked) await page.waitForTimeout(1500);
  return clicked;
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(wait);
  await capture('landing');
  await labels('landing');

  if (await clickIf('Continue')) {
    await capture('notice-dismissed');
    await labels('after-continue');
  }

  if (await clickIf('Plugins')) {
    await capture('plugins');
    await labels('plugins');
  }

  if (await clickIf('More')) {
    await capture('more');
    await labels('more');
  }

  console.log(`title=${await page.title()}`);
} catch (error) {
  console.error(`preview failed: ${error.message}`);
  await page.screenshot({ path: join(outDir, 'error.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (problems.length > 0) console.log(`problems=${problems.slice(0, 8).join(' | ')}`);
  await browser.close();
}
