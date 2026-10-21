/**
 * Network helpers for Sunder's update and announcement feeds.
 *
 * Both feeds are best effort: any failure (offline machine, rate limit, GitHub
 * outage, proxy interference) resolves to `{ ok: false }` and never throws into
 * the harness.
 */

const USER_AGENT = 'dsh-sunder';
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Fetch JSON with a hard timeout.
 * @param {string} url
 * @param {{ timeoutMs?: number, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ ok: true, data: unknown, status: number } | { ok: false, error: string, status?: number }>}
 */
export async function fetchJson(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const headers = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
    ...options.headers,
  };
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!response.ok) {
      return { ok: false, error: `${response.status} ${response.statusText}`, status: response.status };
    }
    const text = await response.text();
    try {
      return { ok: true, data: JSON.parse(text), status: response.status };
    } catch {
      return { ok: false, error: 'response is not valid JSON', status: response.status };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** @returns {boolean} whether `value` is a positive finite interval in hours. */
export function validHours(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
