/**
 * dsh-sunder doctor — read-only diagnostics for an installed profile.
 *
 * Usage:
 *   node scripts/doctor.mjs [--profile <dir>] [--runtime <dir>] [--json] [--no-network] [--help]
 *
 * Exit codes: 0 = healthy (warnings allowed), 1 = at least one failure, 2 = usage error.
 *
 * Everything external (fs, fetch, DSH app-boot, module resolution) is injectable so
 * `test/doctor.mjs` can run the whole check list offline.
 */
import { existsSync, readFileSync, accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { statePath, resolveDshHome } from '../lib/state.js';

const CHECKOUT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_RUNTIME_DIR = 'D:/DSHPC/resources/app/dsh';
const DEFAULT_REPO = 'menghuanshiguang/dsh-sunder';
const PACKAGE_NAME = 'dsh-sunder';
const PURGE_BUNDLES = ['dsh-purge', 'dsh-purge-cwd-compat'];

/** Read a JSON file, returning undefined instead of throwing. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Default profile lookup, mirroring the DSH launcher's notion of a desktop profile. */
export function defaultProfileDir(env = process.env) {
  const home = env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'profiles', 'desktop');
}

/** Resolve the profile directory from options/env. */
function resolveProfileDir(options, env) {
  const candidate = options.profileDir ?? env.DSH_PROFILE ?? defaultProfileDir(env);
  return isAbsolute(candidate) ? candidate : resolve(candidate);
}

/** Default composition helper: real dsh-app-boot, or undefined when the runtime is absent. */
async function defaultLoadProfile(runtimeDir, profileDir) {
  const bootFile = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  if (!existsSync(bootFile)) return undefined;
  try {
    const boot = await import(pathToFileURL(bootFile).href);
    const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    const profile = boot.loadProfileDirectory('dsh', profileDir, installAnchor);
    const groups = profile.layers.map((layer) => layer.patches).concat([profile.patches]);
    const rows = boot.composeEntries(groups, () => {});
    return { ok: true, rows, skippedBundles: profile.skippedBundles ?? [] };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Run every check.
 * @param {object} [options] injectable dependencies (see the top-of-file contract)
 * @returns {Promise<{ok: boolean, profileDir: string, runtimeDir: string, version: string, checks: Array<object>}>}
 */
export async function runDoctor(options = {}) {
  const env = options.env ?? process.env;
  const profileDir = resolveProfileDir(options, env);
  const runtimeDir = options.runtimeDir ?? env.DSH_RUNTIME_DIR ?? DEFAULT_RUNTIME_DIR;
  const checkoutDir = options.checkoutDir ?? CHECKOUT_DIR;
  const noNetwork = options.noNetwork === true;
  const exists = options.existsSyncImpl ?? existsSync;
  const readJsonImpl = options.readJsonImpl ?? ((file) => readJson(file));
  const access = options.accessSyncImpl ?? accessSync;
  const loadProfile = options.loadProfileImpl ?? defaultLoadProfile;
  const fetchAnnouncements = options.fetchAnnouncementsImpl ?? (await import('../lib/announcements.js')).fetchAnnouncements;
  const checkUpdate = options.checkUpdateImpl ?? (await import('../lib/update.js')).checkForUpdate;
  const resolvePackage = options.resolvePackageImpl
    ?? ((fromDir, id) => createRequire(join(fromDir, 'package.json')).resolve(id));

  const checks = [];
  const add = (id, title, status, detail = '') => {
    checks.push({ id, title, status, detail });
    return status;
  };

  // 1. Node.js -----------------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', 'Node.js >= 18', nodeMajor >= 18 ? 'ok' : 'fail', `v${process.versions.node}`);

  // 2. Profile -----------------------------------------------------------------
  const profileManifestPath = join(profileDir, 'package.json');
  const profileManifest = exists(profileManifestPath) ? readJsonImpl(profileManifestPath) : undefined;
  const bundles = Array.isArray(profileManifest?.dsh?.profile?.bundles) ? profileManifest.dsh.profile.bundles : undefined;
  const profileOk = add(
    'profile',
    'DSH profile directory',
    profileManifest !== undefined && bundles !== undefined ? 'ok' : 'fail',
    profileManifest === undefined
      ? `no readable ${profileManifestPath}`
      : bundles === undefined
        ? 'package.json has no dsh.profile.bundles array'
        : profileDir,
  );

  // 3. Bundle selection --------------------------------------------------------
  if (profileOk !== 'ok' || bundles === undefined) {
    add('bundle', 'dsh-sunder selected in dsh.profile.bundles', 'skip', 'profile unavailable');
  } else if (!bundles.includes(PACKAGE_NAME)) {
    add('bundle', 'dsh-sunder selected in dsh.profile.bundles', 'fail', `bundles: ${bundles.join(', ')}`);
  } else {
    const purge = bundles.filter((name) => PURGE_BUNDLES.includes(name));
    add(
      'bundle',
      'dsh-sunder selected in dsh.profile.bundles',
      purge.length > 0 ? 'warn' : 'ok',
      purge.length > 0
        ? `also selected: ${purge.join(', ')} — dsh-purge rewrites the same prompt sections, pick one`
        : 'ok',
    );
  }

  // 4. Link / resolution -------------------------------------------------------
  const linkDir = join(profileDir, 'node_modules', PACKAGE_NAME);
  let installedDir;
  let linkStatus = 'fail';
  let linkDetail = `missing ${linkDir}`;
  if (exists(linkDir)) {
    installedDir = linkDir;
    const linkManifest = readJsonImpl(join(linkDir, 'package.json'));
    linkStatus = linkManifest?.name === PACKAGE_NAME ? 'ok' : 'fail';
    linkDetail = linkManifest?.name === PACKAGE_NAME ? linkDir : `unexpected package name: ${linkManifest?.name ?? 'none'}`;
  } else {
    try {
      installedDir = dirname(resolvePackage(profileDir, PACKAGE_NAME));
      linkStatus = 'ok';
      linkDetail = `resolved: ${installedDir}`;
    } catch (error) {
      linkDetail = `${linkDetail} (${String(error?.message ?? error)})`;
    }
  }
  add('link', 'profile node_modules contains dsh-sunder', linkStatus, linkDetail);

  // 5. Manifest ----------------------------------------------------------------
  const installedManifest = installedDir === undefined ? undefined : readJsonImpl(join(installedDir, 'package.json'));
  if (installedManifest === undefined) {
    add('manifest', 'bundle manifest is complete', 'skip', 'no installed package.json');
  } else {
    const patch = installedManifest.dsh?.bundle?.patch;
    const clientExport = installedManifest.exports?.['./client'];
    const problems = [];
    if (typeof patch !== 'string' || !exists(join(installedDir, patch))) problems.push(`missing bundle patch: ${String(patch)}`);
    if (installedManifest.dsh?.client?.platform !== 'web') problems.push('dsh.client.platform is not "web"');
    if (typeof clientExport !== 'string' || !exists(join(installedDir, clientExport))) problems.push(`missing client export: ${String(clientExport)}`);
    add('manifest', 'bundle manifest is complete', problems.length === 0 ? 'ok' : 'fail', problems.join('; ') || `v${installedManifest.version ?? '?'}`);
  }

  // 6. Composition -------------------------------------------------------------
  const runtimePresent = exists(runtimeDir);
  if (!runtimePresent) {
    add('composition', 'profile composition includes the sunder row', 'skip', `DSH runtime not found: ${runtimeDir}`);
  } else {
    let composed;
    try {
      composed = await loadProfile(runtimeDir, profileDir);
    } catch (error) {
      composed = { ok: false, error: String(error?.message ?? error) };
    }
    if (composed === undefined) {
      add('composition', 'profile composition includes the sunder row', 'skip', 'dsh-app-boot not loadable');
    } else if (composed.ok === false) {
      add('composition', 'profile composition includes the sunder row', 'fail', composed.error);
    } else {
      const rows = composed.rows ?? [];
      const sunderRow = rows.find((row) => row.id === 'sunder');
      const spRow = rows.find((row) => row.id === 'system-prompt');
      const problems = [];
      if (sunderRow === undefined) problems.push('row "sunder" missing');
      else if (sunderRow.disabled === true) problems.push('row "sunder" is disabled');
      if (spRow?.config?.includeHarnessIdentity !== false) problems.push('system-prompt.includeHarnessIdentity is not false');
      const warnings = [];
      if (Array.isArray(composed.skippedBundles) && composed.skippedBundles.length > 0) {
        warnings.push(`skipped bundles: ${composed.skippedBundles.join(', ')}`);
      }
      add(
        'composition',
        'profile composition includes the sunder row',
        problems.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'ok',
        [...problems, ...warnings].join('; ') || `${rows.length} rows`,
      );
    }
  }

  // 7. Announcement feed -------------------------------------------------------
  if (noNetwork) {
    add('feed', 'announcement feed reachable', 'skip', '--no-network');
  } else {
    try {
      const feed = await fetchAnnouncements({ timeoutMs: 4000 });
      const items = Array.isArray(feed?.items) ? feed.items.length : 0;
      add(
        'feed',
        'announcement feed reachable',
        feed?.ok === true ? 'ok' : 'warn',
        feed?.ok === true ? `source=${feed.source} items=${items}` : `unreachable: ${feed?.error ?? 'unknown error'}`,
      );
    } catch (error) {
      add('feed', 'announcement feed reachable', 'warn', String(error?.message ?? error));
    }
  }

  // 8. Update check ------------------------------------------------------------
  const installedVersion = installedManifest?.version ?? '0.0.0';
  if (noNetwork) {
    add('update', 'latest release known', 'skip', '--no-network');
  } else {
    try {
      const update = await checkUpdate({
        repo: DEFAULT_REPO,
        currentVersion: installedVersion,
        state: {},
        persist: () => false,
        force: true,
      });
      if (update === undefined) {
        add('update', 'latest release known', 'warn', 'release lookup returned nothing');
      } else if (typeof update.error === 'string') {
        add('update', 'latest release known', 'warn', `lookup failed: ${update.error}`);
      } else {
        add('update', 'latest release known', 'ok', `installed=${installedVersion} latest=${update.latest} upgrade=${update.newer ? 'yes' : 'no'}`);
      }
    } catch (error) {
      add('update', 'latest release known', 'warn', String(error?.message ?? error));
    }
  }

  // 9. State directory ---------------------------------------------------------
  try {
    const file = statePath(resolveDshHome(env));
    const dir = dirname(file);
    if (!exists(dir)) access(dirname(dir), fsConstants.W_OK);
    else access(dir, fsConstants.W_OK);
    add('state', 'state directory writable', 'ok', file);
  } catch (error) {
    add('state', 'state directory writable', 'fail', String(error?.message ?? error));
  }

  // 10. Installed version ------------------------------------------------------
  const checkoutManifest = readJsonImpl(join(checkoutDir, 'package.json'));
  add(
    'version',
    'checkout version readable',
    typeof checkoutManifest?.version === 'string' ? 'ok' : 'fail',
    typeof checkoutManifest?.version === 'string' ? `v${checkoutManifest.version}` : `no version in ${join(checkoutDir, 'package.json')}`,
  );

  const ok = checks.every((entry) => entry.status !== 'fail');
  return { ok, profileDir, runtimeDir, version: installedVersion, checks };
}

/** Render a report as aligned human-readable lines. */
export function renderReport(report) {
  const icon = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };
  const lines = [`dsh-sunder doctor — profile ${report.profileDir}`, `runtime ${report.runtimeDir}  version ${report.version}`, ''];
  for (const check of report.checks) {
    lines.push(`[${icon[check.status] ?? check.status}] ${check.id}: ${check.detail || check.title}`);
  }
  const failures = report.checks.filter((entry) => entry.status === 'fail').length;
  const warnings = report.checks.filter((entry) => entry.status === 'warn').length;
  lines.push('', report.ok ? `doctor: OK${warnings > 0 ? ` (${warnings} warning(s))` : ''}` : `doctor: ${failures} problem(s)`);
  return lines.join('\n');
}

/** CLI entry point. */
async function main(argv) {
  const args = { json: false, noNetwork: false, profileDir: undefined, runtimeDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/doctor.mjs [--profile <dir>] [--runtime <dir>] [--json] [--no-network]');
      console.log('read-only: checks the profile, the bundle, the prompt composition, the feed, updates and the state dir.');
      return 0;
    }
    if (arg === '--json') args.json = true;
    else if (arg === '--no-network') args.noNetwork = true;
    else if (arg === '--profile' || arg === '-p') {
      args.profileDir = argv[++index];
      if (args.profileDir === undefined) return usageError(`missing value for ${arg}`);
    } else if (arg === '--runtime' || arg === '-r') {
      args.runtimeDir = argv[++index];
      if (args.runtimeDir === undefined) return usageError(`missing value for ${arg}`);
    } else return usageError(`unknown argument: ${arg}`);
  }
  const report = await runDoctor(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report));
  return report.ok ? 0 : 1;
}

function usageError(message) {
  console.error(`doctor: ${message}`);
  return 2;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`doctor: unexpected failure — ${error?.stack ?? error}`);
      process.exitCode = 1;
    });
}
