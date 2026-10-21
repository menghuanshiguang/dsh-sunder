/**
 * Minimal, dependency-free semantic-version helpers.
 * Accepts `1.2.3`, `v1.2.3`, and prereleases like `1.2.3-rc.2`.
 */

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u;

/**
 * Parse a version string into its comparable parts.
 * @param {string} input
 * @returns {{major:number, minor:number, patch:number, prerelease:string[]} | undefined}
 */
export function parseVersion(input) {
  if (typeof input !== 'string') return undefined;
  const match = VERSION_PATTERN.exec(input.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/** @returns {boolean} whether the string is a parseable version. */
export function isVersion(input) {
  return parseVersion(input) !== undefined;
}

/**
 * Compare two versions using semver precedence.
 * @param {string} left
 * @param {string} right
 * @returns {-1|0|1} negative when `left` sorts before `right`.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) throw new TypeError(`invalid version comparison: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumber = /^\d+$/u.test(x);
    const yNumber = /^\d+$/u.test(y);
    if (xNumber && yNumber) return Number(x) < Number(y) ? -1 : 1;
    if (xNumber) return -1;
    if (yNumber) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** @returns {boolean} whether `candidate` is strictly newer than `current`. */
export function isNewer(candidate, current) {
  try {
    return compareVersions(candidate, current) > 0;
  } catch {
    return false;
  }
}

/** @returns {boolean} whether `version` satisfies the inclusive range. */
export function inRange(version, min, max) {
  try {
    if (typeof min === 'string' && min.length > 0 && compareVersions(version, min) < 0) return false;
    if (typeof max === 'string' && max.length > 0 && compareVersions(version, max) > 0) return false;
    return true;
  } catch {
    return true;
  }
}
