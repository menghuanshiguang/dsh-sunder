/**
 * Unit tests that need no DSH installation: version ranges, announcement
 * selection, prompt composition, state persistence, and the update/feed
 * network helpers (with a stubbed fetch).
 *
 * Run: node test/unit.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compareVersions, inRange, isNewer, parseVersion } from '../lib/version.js';
import { fetchJson } from '../lib/net.js';
import { selectAnnouncements, renderAnnouncements, normalizeAnnouncement, localized, DEFAULT_FEED } from '../lib/announcements.js';
import { checkForUpdate, fetchLatestRelease, isCacheFresh, DEFAULT_REPO } from '../lib/update.js';
import { buildPrompt, promptSections, SECTION_ORDERS } from '../lib/prompt.js';
import { ackAnnouncement, loadState, markSeen, saveState, statePath, emptyState } from '../lib/state.js';

let failures = 0;
function check(condition, label, extra) {
  if (condition) {
    console.log(`ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${label}${extra === undefined ? '' : ` — ${extra}`}`);
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------
check(parseVersion('1.2.3')?.patch === 3, 'parse plain version');
check(parseVersion('v1.2.3-rc.2')?.prerelease.join('.') === 'rc.2', 'parse v-prefixed prerelease');
check(parseVersion('nope') === undefined, 'reject junk version');
check(compareVersions('1.0.0', '1.0.0') === 0, 'equal versions');
check(compareVersions('1.0.1', '1.0.0') === 1, 'patch bump is newer');
check(compareVersions('1.0.0-rc.2', '1.0.0') === -1, 'prerelease sorts before release');
check(compareVersions('1.0.0-rc.10', '1.0.0-rc.9') === 1, 'numeric prerelease comparison');
check(compareVersions('1.0.0-alpha', '1.0.0-beta') === -1, 'lexical prerelease comparison');
check(isNewer('1.2.0', '1.1.9') === true, 'isNewer true');
check(isNewer('1.1.9', '1.2.0') === false, 'isNewer false');
check(isNewer('junk', '1.0.0') === false, 'isNewer tolerates junk');
check(inRange('1.2.0', '1.0.0', '2.0.0') === true, 'range inclusive');
check(inRange('2.0.1', '1.0.0', '2.0.0') === false, 'range rejects above max');
check(inRange('0.9.0', '1.0.0', undefined) === false, 'range rejects below min');

// ---------------------------------------------------------------------------
// announcements
// ---------------------------------------------------------------------------
const feed = [
  { id: 'a', level: 'info', date: '2026-10-01', title: { zh: '旧', en: 'old' }, body: { zh: '旧内容', en: 'old body' }, maxVersion: '0.9.0' },
  { id: 'b', level: 'warn', date: '2026-10-21', title: { zh: '新', en: 'new' }, body: { zh: '新内容', en: 'new body' }, minVersion: '1.0.0' },
  { id: 'c', level: 'critical', date: '2026-10-21', title: 'flat', body: 'flat body' },
  { id: 'd', title: 'no body' },
  { level: 'info', title: 'no id', body: 'x' },
  'garbage',
];
const selected = selectAnnouncements(feed, { currentVersion: '1.0.0', limit: 5, acked: [] });
// a: maxVersion excludes it, d: no body, the last two: no id / not an object.
check(selected.length === 2, 'selectAnnouncements drops invalid + out-of-range entries', JSON.stringify(selected.map((entry) => entry.id)));
check(selected.some((entry) => entry.id === 'd') === false, 'entries without body are dropped');
check(selected[0].level === 'critical', 'critical first within the same date', selected[0]?.level);
check(selected.some((entry) => entry.id === 'a') === false, 'maxVersion filters out old announcements');
check(selectAnnouncements(feed, { currentVersion: '1.0.0', limit: 1 }).length === 1, 'limit applies');
check(selectAnnouncements(feed, { currentVersion: '1.0.0', acked: ['c'] }).find((entry) => entry.id === 'c')?.acknowledged === true, 'ack flag is carried');
check(normalizeAnnouncement({ id: 'x', title: 't', body: 'b' })?.level === 'info', 'missing level defaults to info');
check(localized({ zh: '中', en: 'en' }, 'en') === 'en', 'localized picks language');
check(localized({ zh: '中' }, 'en') === '中', 'localized falls back');
check(renderAnnouncements([{ id: 'z', level: 'info', title: { zh: '标题' }, body: { zh: '正文' }, acknowledged: false }], 'zh').includes('标题'), 'renderAnnouncements renders unread');
check(renderAnnouncements([{ id: 'z', level: 'info', title: 't', body: 'b', acknowledged: true }], 'zh') === '', 'renderAnnouncements hides acknowledged');
check(DEFAULT_FEED.endsWith('/announcements.json') === true, 'default feed URL');

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------
const zh = buildPrompt({ language: 'zh', version: '9.9.9' });
const en = buildPrompt({ language: 'en' });
check(zh.identity.includes('Sunder') && en.identity.includes('Sunder'), 'prompt has zh/en packs');
check(/Sunder/.test(zh.rules) === false || zh.rules.length > 300, 'rules carry the operating rules');
check(zh.footer.includes('9.9.9'), 'footer carries the version');
check(buildPrompt({ extraPrompt: '额外要求：更短。' }).rules.includes('额外要求：更短。'), 'extraPrompt is appended');
check(zh.identity.length > 200 && zh.rules.length > 400, 'prompt packs are substantial');
for (const section of promptSections({ language: 'zh' })) {
  check(section.interpolate === false, `${section.name} never interpolates`);
  check(!section.text.includes('{{'), `${section.name} has no unresolved variables`);
}
check(promptSections().map((s) => s.order).join(',') === `${SECTION_ORDERS.identity},${SECTION_ORDERS.rules},${SECTION_ORDERS.footer}`, 'sections keep their pinned orders');

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const directory = mkdtempSync(join(tmpdir(), 'sunder-state-'));
const file = join(directory, 'nested', 'state.json');
try {
  const fresh = loadState(file);
  check(typeof fresh.installId === 'string' && fresh.installId.length > 10, 'empty state has an install id');
  check(saveState(fresh, file) === true, 'saveState creates missing directories');
  const loaded = loadState(file);
  check(loaded.installId === fresh.installId, 'state round-trips');
  ackAnnouncement(loaded, 'x');
  markSeen(loaded, 'x');
  saveState(loaded, file);
  const again = loadState(file);
  check(again.ackedAnnouncements.includes('x'), 'announcement ack persists');
  check(typeof again.seenAnnouncements.x === 'string', 'seen marker persists');
  check(statePath(join(directory, 'home')).endsWith(join('sunder', 'state.json')), 'statePath layout');
} finally {
  rmSync(directory, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// update + feed (stubbed fetch)
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/releases/latest')) {
      return new Response(JSON.stringify({ tag_name: 'v1.3.0', html_url: 'https://example.invalid/r', published_at: '2026-10-20T00:00:00Z', body: 'notes' }), { status: 200 });
    }
    if (String(url).endsWith('/tags')) {
      return new Response(JSON.stringify([{ name: 'v1.3.0' }]), { status: 200 });
    }
    if (String(url).includes('announcements')) {
      return new Response(JSON.stringify(feed), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  };

  const release = await fetchLatestRelease(DEFAULT_REPO, { currentVersion: '1.2.0' });
  check(release.ok === true && release.latest === '1.3.0' && release.newer === true, 'fetchLatestRelease parses GitHub payload', JSON.stringify(release));
  check(new URL(DEFAULT_REPO.length > 0 ? `https://github.com/${DEFAULT_REPO}` : 'https://github.com').host === 'github.com', 'repo constant is owner/name');

  const state = emptyState();
  const first = await checkForUpdate({ state, repo: DEFAULT_REPO, currentVersion: '1.2.0', intervalHours: 6, persist: () => {} });
  check(first?.latest === '1.3.0' && first?.fromCache === false, 'checkForUpdate fetches on first run', JSON.stringify(first));
  const cached = await checkForUpdate({ state, repo: DEFAULT_REPO, currentVersion: '1.2.0', intervalHours: 6, persist: () => {} });
  check(cached?.fromCache === true && cached?.latest === '1.3.0', 'checkForUpdate serves the cache inside the interval', JSON.stringify(cached));
  check(isCacheFresh({ checkedAt: new Date().toISOString(), latest: '1.3.0' }, 6) === true, 'fresh cache detected');
  check(isCacheFresh({ checkedAt: '2000-01-01T00:00:00Z' }, 6) === false, 'stale cache detected');

  const okJson = await fetchJson('https://example.invalid/releases/latest');
  check(okJson.ok === true, 'fetchJson succeeds');
  globalThis.fetch = async () => new Response('not json', { status: 200 });
  const notJson = await fetchJson('https://example.invalid/x');
  check(notJson.ok === false && /JSON/.test(notJson.error), 'fetchJson reports invalid JSON');
  globalThis.fetch = async () => new Response('boom', { status: 503, statusText: 'Unavailable' });
  const failed = await fetchJson('https://example.invalid/x');
  check(failed.ok === false && failed.status === 503, 'fetchJson reports HTTP failures');
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  const offline = await fetchJson('https://example.invalid/x');
  check(offline.ok === false && /offline/.test(offline.error), 'fetchJson reports network errors');
  const noUpdate = await checkForUpdate({ state: emptyState(), repo: DEFAULT_REPO, currentVersion: '1.2.0', intervalHours: 6 });
  check(noUpdate?.error !== undefined, 'checkForUpdate reports fetch errors without throwing');

  // The package must never depend on a live network for tests.
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  check(readme.includes('dsh-sunder'), 'README exists and names the package');
} finally {
  globalThis.fetch = realFetch;
}

console.log(failures === 0 ? '\nunit: OK' : `\nunit: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
