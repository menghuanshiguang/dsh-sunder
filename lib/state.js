/**
 * Small persistent state file for Sunder: update-check cache, announcement
 * read markers, and install identity. Lives under `$DSH_HOME/sunder/state.json`
 * (`$DSH_HOME` defaults to `~/.dsh`). Every failure is non-fatal: Sunder must
 * never break prompt assembly because a state file is unreadable.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const STATE_SCHEMA = 1;

/** Resolve the DSH home the same way the harness does: `$DSH_HOME`, else `~/.dsh`. */
export function resolveDshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (configured.length > 0) return configured;
  return join(homedir(), '.dsh');
}

/** Absolute path of the state file. */
export function statePath(home = resolveDshHome()) {
  return join(home, 'sunder', 'state.json');
}

/** @returns {Record<string, unknown>} a fresh, empty state document. */
export function emptyState() {
  return {
    schema: STATE_SCHEMA,
    installId: randomUUID(),
    firstRunAt: new Date().toISOString(),
    lastUpdateCheck: null,
    seenAnnouncements: {},
    ackedAnnouncements: [],
    lastAnnouncementCheck: null,
  };
}

/**
 * Read the state file, tolerating absence and corruption.
 * @returns {Record<string, unknown>}
 */
export function loadState(path = statePath()) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyState();
    return { ...emptyState(), ...parsed, schema: STATE_SCHEMA };
  } catch {
    return emptyState();
  }
}

/**
 * Persist the state document atomically (write-then-rename). Never throws.
 * @returns {boolean} whether the write succeeded.
 */
export function saveState(state, path = statePath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  }
}

/** Mark one announcement id as acknowledged. */
export function ackAnnouncement(state, id) {
  const acked = Array.isArray(state.ackedAnnouncements) ? state.ackedAnnouncements : [];
  if (!acked.includes(id)) acked.push(id);
  state.ackedAnnouncements = acked;
  return state;
}

/** Record the first time an announcement id was surfaced. */
export function markSeen(state, id, at = new Date().toISOString()) {
  const seen = typeof state.seenAnnouncements === 'object' && state.seenAnnouncements !== null ? state.seenAnnouncements : {};
  if (seen[id] === undefined) seen[id] = at;
  state.seenAnnouncements = seen;
  return state;
}
