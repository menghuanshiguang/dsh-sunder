/**
 * Update checking for Sunder.
 *
 * The canonical release feed is the GitHub Releases API of the repository that
 * ships this package. `checkForUpdate()` reports the newest published release,
 * whether it is newer than the running version, and the release page URL. The
 * result is cached in the state file so a normal session costs at most one
 * request per `updateIntervalHours`.
 */

import { fetchJson } from './net.js';
import { isNewer } from './version.js';

export const DEFAULT_REPO = 'menghuanshiguang/dsh-sunder';

/**
 * @param {string} repo `owner/name`
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ ok: true, latest: string, url: string, publishedAt?: string, notes?: string, newer: boolean } | { ok: false, error: string }>}
 */
export async function fetchLatestRelease(repo = DEFAULT_REPO, options = {}) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const result = await fetchJson(url, {
    timeoutMs: options.timeoutMs,
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!result.ok) {
    // No published release yet: fall back to tags so a fresh repository still
    // reports versions.
    const tags = await fetchJson(`https://api.github.com/repos/${repo}/tags`, {
      timeoutMs: options.timeoutMs,
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!tags.ok || !Array.isArray(tags.data) || tags.data.length === 0) {
      return { ok: false, error: result.error };
    }
    const tag = tags.data.find((entry) => typeof entry?.name === 'string');
    const name = tag?.name ?? '';
    return { ok: true, latest: name.replace(/^v/u, ''), url: `https://github.com/${repo}/releases/tag/${name}`, newer: false };
  }
  const release = result.data ?? {};
  const latest = String(release.tag_name ?? release.name ?? '').replace(/^v/u, '');
  if (latest.length === 0) return { ok: false, error: 'release has no tag_name' };
  return {
    ok: true,
    latest,
    url: typeof release.html_url === 'string' ? release.html_url : `https://github.com/${repo}/releases`,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined,
    notes: typeof release.body === 'string' ? release.body.slice(0, 4_000) : undefined,
    newer: isNewer(latest, options.currentVersion ?? '0.0.0'),
  };
}

/** @returns {boolean} whether a cached check is still fresh. */
export function isCacheFresh(cached, intervalHours, now = Date.now()) {
  if (cached === null || typeof cached !== 'object' || typeof cached.checkedAt !== 'string') return false;
  const checkedAt = Date.parse(cached.checkedAt);
  if (!Number.isFinite(checkedAt)) return false;
  return now - checkedAt < intervalHours * 3_600_000;
}

/**
 * Run a check at most once per interval, persisting the result.
 * @param {object} options
 * @param {string} options.repo
 * @param {string} options.currentVersion
 * @param {Record<string, unknown>} options.state
 * @param {number} options.intervalHours
 * @param {(state: Record<string, unknown>) => boolean} [options.persist]
 * @param {boolean} [options.force]
 * @returns {Promise<{ latest: string, url: string, newer: boolean, checkedAt: string, fromCache: boolean } | { error: string, checkedAt: string } | undefined>}
 */
export async function checkForUpdate(options) {
  const { state, intervalHours = 6, force = false } = options;
  const cached = state.lastUpdateCheck ?? null;
  if (!force && isCacheFresh(cached, intervalHours)) {
    return typeof cached.newer === 'boolean'
      ? { latest: cached.latest, url: cached.url, newer: cached.newer, checkedAt: cached.checkedAt, fromCache: true }
      : undefined;
  }
  const checkedAt = new Date().toISOString();
  const result = await fetchLatestRelease(options.repo, { timeoutMs: options.timeoutMs, currentVersion: options.currentVersion });
  if (!result.ok) {
    state.lastUpdateCheck = { checkedAt, error: result.error };
    options.persist?.(state);
    return { error: result.error, checkedAt };
  }
  const record = {
    checkedAt,
    latest: result.latest,
    url: result.url,
    publishedAt: result.publishedAt,
    newer: isNewer(result.latest, options.currentVersion),
  };
  state.lastUpdateCheck = record;
  options.persist?.(state);
  return { ...record, fromCache: false };
}
