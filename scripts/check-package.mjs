#!/usr/bin/env node
/**
 * Static checks for the packaged plugin: manifest keys, files referenced by the
 * manifest, JSON validity, bundle-patch sanity, version/changelog agreement, and
 * the announcement feed.
 *
 * Run: node scripts/check-package.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1');
const readJson = (relative) => JSON.parse(readFileSync(join(ROOT, relative), 'utf8'));

const pkg = readJson('package.json');
const problems = [];
const check = (condition, label) => {
  if (!condition) problems.push(label);
};

check(typeof pkg.name === 'string' && pkg.name === 'dsh-sunder', 'package name is dsh-sunder');
check(/^\d+\.\d+\.\d+/u.test(pkg.version), 'package version is semver');
check(pkg.type === 'module', 'package is ESM');
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch declared');
check(pkg.dependencies === undefined && pkg.peerDependencies === undefined, 'bundle ships with no runtime dependencies');
check(pkg.exports?.['./package.json'] === './package.json', 'package.json is exported');
check(pkg.engines?.node === '>=18', 'node engine declared');
check(pkg.license === 'MIT', 'license is MIT');
check(Array.isArray(pkg.files) && pkg.files.includes('index.js') && pkg.files.includes('lib'), 'files list covers the runtime');
check(typeof pkg.icon === 'string' && existsSync(join(ROOT, pkg.icon)), 'icon file exists');
check(pkg.dsh?.client === undefined || pkg.dsh?.client?.platform === 'web', 'client platform (when present) is web');

for (const relative of ['index.js', 'lib/prompt.js', 'lib/update.js', 'lib/announcements.js', 'lib/version.js', 'lib/state.js', 'lib/net.js', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'announcements.json', 'LICENSE']) {
  check(existsSync(join(ROOT, relative)), `required file exists: ${relative}`);
}

for (const relative of ['locale/en.json', 'locale/zh.json', 'announcements.json']) {
  try {
    readJson(relative);
  } catch {
    problems.push(`invalid JSON: ${relative}`);
  }
}

const localeEn = readJson('locale/en.json');
const localeZh = readJson('locale/zh.json');
check(typeof localeEn.meta?.title === 'string' && typeof localeEn.meta?.description === 'string', 'en locale has meta title+description');
check(typeof localeZh.meta?.title === 'string' && typeof localeZh.meta?.description === 'string', 'zh locale has meta title+description');

const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
check(patch.includes('id: sunder'), 'bundle patch inserts the sunder entry');
check(patch.includes('name: dsh-sunder'), 'bundle patch names the plugin dsh-sunder');

const announcements = readJson('announcements.json');
check(Array.isArray(announcements) && announcements.length > 0, 'announcement feed is a non-empty array');
for (const item of announcements) {
  check(typeof item.id === 'string' && item.id.length > 0, `announcement ${item.id ?? '(missing)'} has an id`);
  check(typeof item.title === 'object' && typeof item.body === 'object', `announcement ${item.id} is localized`);
  check(['info', 'warn', 'critical'].includes(item.level), `announcement ${item.id} has a valid level`);
}

const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
check(changelog.includes(`## [${pkg.version}]`), `CHANGELOG contains an entry for ${pkg.version}`);

const entry = readFileSync(join(ROOT, 'index.js'), 'utf8');
check(entry.includes('export const name'), 'index.js exports a plugin name');
check(entry.includes('systemPrompt'), 'index.js registers system prompt sections');

if (problems.length > 0) {
  console.error(`check-package: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`check-package: OK (${pkg.name} ${pkg.version})`);
}
