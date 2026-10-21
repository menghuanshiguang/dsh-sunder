#!/usr/bin/env node
/**
 * Publish the current git tree to GitHub through the REST API.
 *
 * Why this exists: `scripts/release.mjs` uses `git push`, which needs working
 * git-over-HTTPS access to github.com. On networks where that is blocked (or
 * where a proxy rewrite breaks authentication) but the GitHub API is reachable,
 * this script performs the same publish: one commit on `main`, the `vX.Y.Z`
 * tag, and a GitHub Release whose notes are taken from `CHANGELOG.md`.
 *
 * Requirements: `gh auth login` once (the token is read from `gh auth token`),
 * every file already committed or at least `git add`-ed.
 *
 * Usage:
 *   node scripts/publish-api.mjs            # publish package.json's version
 *   node scripts/publish-api.mjs --dry-run  # print the plan, write nothing
 *   node scripts/publish-api.mjs --notes-file notes.md
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const notesFileIndex = argv.indexOf('--notes-file');
const notesFile = notesFileIndex === -1 ? undefined : argv[notesFileIndex + 1];

const ghBin = process.env.GH_BIN ?? 'gh';
const repo = process.env.SUNDER_REPO ?? `${new URL(pkg.repository.url.replace(/^git\+/u, '')).pathname.slice(1).replace(/\.git$/u, '')}`;
const tag = `v${pkg.version}`;
const token = dryRun ? '' : execFileSync(ghBin, ['auth', 'token'], { encoding: 'utf8' }).trim();

const api = async (method, route, body) => {
  if (dryRun) {
    console.log(`[dry-run] ${method} ${route}`);
    return {};
  }
  const response = await fetch(`https://api.github.com/repos/${repo}/${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'dsh-sunder-publish',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${route} failed (${response.status}): ${data.message ?? text}`);
  }
  return data;
};

/** Release notes: the CHANGELOG section for this version, or an explicit file. */
function releaseNotes() {
  if (notesFile !== undefined) return readFileSync(notesFile, 'utf8');
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const header = `## [${pkg.version}]`;
  const start = changelog.indexOf(header);
  if (start === -1) return `dsh-sunder ${pkg.version}`;
  const rest = changelog.slice(start + header.length);
  const next = rest.search(/^## \[/mu);
  return `${header}${next === -1 ? rest : rest.slice(0, next)}`.trim();
}

const listed = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
if (listed.length === 0) {
  console.error('publish-api: no tracked files; run git add first');
  process.exitCode = 1;
} else if (dryRun) {
  console.log(`publish-api: dry run — would publish ${listed.length} files to ${repo} as ${tag}`);
} else {
  const tip = await api('GET', 'git/ref/heads/main');
  const tipSha = tip.object?.sha;
  if (tipSha === undefined) throw new Error('main has no commit');
  const tipCommit = await api('GET', `git/commits/${tipSha}`);
  const baseTree = tipCommit.tree?.sha;

  const entries = listed.map((relative) => ({
    path: relative,
    mode: '100644',
    type: 'blob',
    content: readFileSync(join(ROOT, relative), 'utf8'),
  }));
  const tree = await api('POST', 'git/trees', { base_tree: baseTree, tree: entries });
  const commit = await api('POST', 'git/commits', {
    message: `chore(release): ${tag}`,
    tree: tree.sha,
    parents: [tipSha],
  });
  await api('PATCH', 'git/refs/heads/main', { sha: commit.sha, force: true });

  // Idempotent tag: move it when it already exists (re-publishing a version).
  let tagMoved = false;
  try {
    await api('POST', 'git/refs', { ref: `refs/tags/${tag}`, sha: commit.sha });
  } catch (error) {
    if (!String(error.message).includes('422')) throw error;
    await api('PATCH', `git/refs/tags/${tag}`, { sha: commit.sha, force: true });
    tagMoved = true;
  }

  // Idempotent release: update the notes when the release already exists.
  let release;
  try {
    release = await api('POST', 'releases', {
      tag_name: tag,
      name: `dsh-sunder ${tag}`,
      body: releaseNotes(),
    });
  } catch (error) {
    if (!String(error.message).includes('422')) throw error;
    const existing = await api('GET', `releases/tags/${tag}`);
    release = await api('PATCH', `releases/${existing.id}`, { name: `dsh-sunder ${tag}`, body: releaseNotes() });
    tagMoved = true;
  }
  console.log(`publish-api: ${tag} published — ${release.html_url}${tagMoved ? ' (tag moved, release updated)' : ''}`);
}
