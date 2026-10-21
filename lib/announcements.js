/**
 * Announcement feed for Sunder.
 *
 * The feed is `announcements.json` at the root of the repository:
 *   [{ id, level: "info"|"warn"|"critical", date, title{zh,en}, body{zh,en},
 *      link?, minVersion?, maxVersion? }]
 *
 * Announcements are matched against the running version, deduplicated against
 * the state file, and surfaced through the runtime context plus the
 * `sunder_notice` tool.
 */

import { fetchJson } from './net.js';
import { inRange, compareVersions } from './version.js';

export const DEFAULT_FEED = 'https://raw.githubusercontent.com/menghuanshiguang/dsh-sunder/main/announcements.json';
export const LEVELS = new Set(['info', 'warn', 'critical']);

/** @returns {Record<string, string> | undefined} a localized text pair, or the raw string. */
export function localized(value, language) {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const preferred = language === 'en' ? value.en : value.zh;
  return preferred ?? value.zh ?? value.en ?? undefined;
}

/**
 * Normalize one feed entry, dropping entries that cannot be rendered.
 * @param {unknown} raw
 * @returns {{ id: string, level: string, date?: string, title: Record<string,string>|string, body: Record<string,string>|string, link?: string, minVersion?: string, maxVersion?: string } | undefined}
 */
export function normalizeAnnouncement(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const id = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id.trim() : undefined;
  if (id === undefined) return undefined;
  const title = raw.title;
  const body = raw.body;
  const hasTitle = typeof title === 'string' || (typeof title === 'object' && title !== null);
  const hasBody = typeof body === 'string' || (typeof body === 'object' && body !== null);
  if (!hasTitle || !hasBody) return undefined;
  const level = LEVELS.has(raw.level) ? raw.level : 'info';
  return {
    id,
    level,
    date: typeof raw.date === 'string' ? raw.date : undefined,
    title,
    body,
    link: typeof raw.link === 'string' ? raw.link : undefined,
    minVersion: typeof raw.minVersion === 'string' ? raw.minVersion : undefined,
    maxVersion: typeof raw.maxVersion === 'string' ? raw.maxVersion : undefined,
  };
}

/**
 * Select the announcements that apply to `currentVersion`, newest first.
 * @param {unknown} data raw feed payload
 * @param {{ currentVersion: string, limit?: number, acked?: string[] }} options
 */
export function selectAnnouncements(data, options) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.announcements) ? data.announcements : [];
  const limit = Number.isFinite(options.limit) ? options.limit : 3;
  const acked = new Set(Array.isArray(options.acked) ? options.acked : []);
  const entries = [];
  for (const raw of list) {
    const entry = normalizeAnnouncement(raw);
    if (entry === undefined) continue;
    if (!inRange(options.currentVersion, entry.minVersion, entry.maxVersion)) continue;
    entries.push({ ...entry, acknowledged: acked.has(entry.id) });
  }
  entries.sort((a, b) => {
    const dateCompare = String(b.date ?? '').localeCompare(String(a.date ?? ''));
    if (dateCompare !== 0) return dateCompare;
    // Critical entries first inside the same date.
    const weight = { critical: 3, warn: 2, info: 1 };
    return (weight[b.level] ?? 0) - (weight[a.level] ?? 0);
  });
  return entries.slice(0, limit);
}

/**
 * Fetch and select announcements.
 * @returns {Promise<{ ok: true, items: ReturnType<typeof selectAnnouncements> } | { ok: false, error: string }>}
 */
export async function fetchAnnouncements(options) {
  const url = options.url ?? DEFAULT_FEED;
  const result = await fetchJson(url, { timeoutMs: options.timeoutMs });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, items: selectAnnouncements(result.data, options) };
}

/**
 * Render announcements for the runtime context, or `''` when there is nothing
 * worth surfacing (no unacknowledged entry, or only acknowledged `info` ones).
 */
export function renderAnnouncements(items, language = 'zh') {
  const visible = items.filter((item) => item.acknowledged !== true);
  if (visible.length === 0) return '';
  const lines = visible.map((item) => {
    const title = localized(item.title, language) ?? item.id;
    const body = localized(item.body, language) ?? '';
    const link = item.link === undefined ? '' : ` (${item.link})`;
    return `- [${item.level}] ${title}: ${body}${link}`;
  });
  return `Sunder announcements (unread):\n${lines.join('\n')}`;
}

/** Compare two announcement dates for stability (used by tests). */
export function isNewerDate(left, right) {
  return String(left ?? '').localeCompare(String(right ?? '')) > 0;
}

export { compareVersions };
