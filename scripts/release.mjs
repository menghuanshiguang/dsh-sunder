#!/usr/bin/env node
/**
 * Release helper for dsh-sunder.
 *
 *   node scripts/release.mjs patch|minor|major|X.Y.Z [--yes] [--dry-run] [--no-push]
 *   node scripts/release.mjs --changelog        # print the commits since the last tag
 *
 * Steps: bump package.json + CHANGELOG, commit, create annotated tag, push, then
 * `gh release create` with generated notes. Nothing is pushed unless --yes is
 * passed (or --dry-run is absent and stdin is a TTY that confirms).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseVersion, compareVersions } from '../lib/version.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1');
const ARGS = process.argv.slice(2);
const FLAGS = new Set(ARGS.filter((arg) => arg.startsWith('--')));
const TARGET = ARGS.find((arg) => !arg.startsWith('--'));
const DRY = FLAGS.has('--dry-run');
const CONFIRMED = FLAGS.has('--yes');
const NO_PUSH = FLAGS.has('--no-push');

const run = (command, args, options = {}) => execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: options.capture === false ? 'inherit' : 'pipe', ...options });

function git(args) {
  return run('git', args).trim();
}

function packageJson() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
}

function bumpVersion(current, target) {
  if (target === undefined) throw new Error('usage: node scripts/release.mjs patch|minor|major|X.Y.Z');
  const parsed = parseVersion(current);
  if (parsed === undefined) throw new Error(`current version is not semver: ${current}`);
  if (parseVersion(target) !== undefined) return target.replace(/^v/u, '');
  const next = { ...parsed };
  if (target === 'patch') next.patch += 1;
  else if (target === 'minor') (next.minor += 1), (next.patch = 0);
  else if (target === 'major') (next.major += 1), (next.minor = 0), (next.patch = 0);
  else throw new Error(`unknown bump target: ${target}`);
  return `${next.major}.${next.minor}.${next.patch}`;
}

function lastTag() {
  try {
    return git(['describe', '--tags', '--abbrev=0']);
  } catch {
    return undefined;
  }
}

function commitsSince(tag) {
  const range = tag === undefined ? 'HEAD' : `${tag}..HEAD`;
  try {
    return git(['log', '--pretty=format:- %s (%h)', range]).split('\n').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function updateChangelog(path, version, notes) {
  const text = readFileSync(path, 'utf8');
  const date = new Date().toISOString().slice(0, 10);
  const entry = `## [${version}] - ${date}\n\n${notes.length > 0 ? notes.join('\n') : '- Release.'}\n\n`;
  const marker = '## [Unreleased]\n';
  if (!text.includes(marker)) throw new Error(`CHANGELOG.md is missing the "${marker.trim()}" section`);
  const updated = text.replace(marker, `${marker}\n${entry}`);
  writeFileSync(path, updated, 'utf8');
  return version;
}

function main() {
  if (FLAGS.has('--changelog') || TARGET === 'changelog') {
    const tag = lastTag();
    console.log(`last tag: ${tag ?? '(none)'}\n`);
    console.log(commitsSince(tag).join('\n'));
    return;
  }
  const pkg = packageJson();
  const version = bumpVersion(pkg.version, TARGET);
  if (compareVersions(version, pkg.version) <= 0 && FLAGS.has('--no-downgrade')) {
    throw new Error(`refusing to release ${version}, not newer than ${pkg.version}`);
  }
  const tag = `v${version}`;
  const existing = (() => {
    try {
      return git(['tag', '--list', tag]);
    } catch {
      return '';
    }
  })();
  if (existing.length > 0) throw new Error(`tag ${tag} already exists`);

  console.log(`bump ${pkg.version} -> ${version}`);

  pkg.version = version;
  const pkgPath = join(ROOT, 'package.json');
  if (!DRY) writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  const notes = commitsSince(lastTag());
  if (!DRY) updateChangelog(join(ROOT, 'CHANGELOG.md'), version, notes);
  console.log(notes.length > 0 ? `\nrelease notes:\n${notes.join('\n')}` : '\nrelease notes: (no commits since last tag)');

  if (!DRY) {
    git(['add', 'package.json', 'CHANGELOG.md']);
    git(['commit', '-m', `chore(release): ${tag}`]);
    git(['tag', '-a', tag, '-m', `dsh-sunder ${version}`]);
  }

  const shouldPush = !NO_PUSH && (CONFIRMED || (!DRY && process.stdin.isTTY === true));
  if (DRY || !shouldPush) {
    console.log(`\n${DRY ? 'dry run' : 'not confirmed'}: wrote nothing to remotes.`);
    return;
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  git(['push', 'origin', branch]);
  git(['push', 'origin', tag]);
  run('gh', ['release', 'create', tag, '--title', tag, '--generate-notes'], { capture: false });
  console.log(`\nreleased ${tag}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
