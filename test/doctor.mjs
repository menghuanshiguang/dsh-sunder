/**
 * Offline tests for scripts/doctor.mjs.
 *
 * Every external edge is injected: no network, no DSH runtime, no real profile.
 * Fixtures live in an OS temp directory and are removed at the end.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'sunder-doctor-home-'));

const { runDoctor, defaultProfileDir, resolveProfileDir } = await import('../scripts/doctor.mjs');

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const root = mkdtempSync(join(tmpdir(), 'sunder-doctor-'));
const profileDir = join(root, 'profile');
const sunderDir = join(profileDir, 'node_modules', 'dsh-sunder');

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

// --- fixture: a profile that has dsh-sunder installed and selected -------------
writeJson(join(profileDir, 'package.json'), {
  name: 'fake-profile',
  dsh: { profile: { bundles: ['dsh-sunder'] } },
});
writeJson(join(sunderDir, 'package.json'), {
  name: 'dsh-sunder',
  version: '9.9.9',
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  exports: { './client': './lib/client.js' },
});
writeFileSync(join(sunderDir, 'cordis.patch.yml'), '[]\n');
mkdirSync(join(sunderDir, 'lib'), { recursive: true });
writeFileSync(join(sunderDir, 'lib', 'client.js'), 'export {};\n');

// A stand-in runtime: only its existence is probed, the composition itself is injected.
const runtimeDir = join(root, 'runtime');
const missingRuntimeDir = join(root, 'no-runtime');
mkdirSync(runtimeDir, { recursive: true });

const healthyDeps = {
  profileDir,
  runtimeDir,
  env: { DSH_HOME: process.env.DSH_HOME },
  loadProfileImpl: async () => ({
    ok: true,
    skippedBundles: [],
    rows: [
      { id: 'sunder', name: 'dsh-sunder', disabled: false },
      { id: 'system-prompt', config: { includeHarnessIdentity: false } },
    ],
  }),
  fetchAnnouncementsImpl: async () => ({ ok: true, source: 'https://api.github.com/x', items: [1, 2] }),
  checkUpdateImpl: async () => ({ latest: '9.9.9', newer: false, url: 'https://example.test' }),
};

// 1. happy path -----------------------------------------------------------------
{
  const report = await runDoctor(healthyDeps);
  check(report.ok === true, 'healthy profile reports ok', JSON.stringify(report.checks.filter((c) => c.status === 'fail')));
  check(report.checks.length === 10, 'all ten checks run', String(report.checks.length));
  check(report.checks.some((c) => c.id === 'bundle' && c.status === 'ok'), 'bundle check is ok');
  check(report.checks.some((c) => c.id === 'composition' && c.status === 'ok'), 'composition check is ok');
  check(report.checks.some((c) => c.id === 'feed' && c.status === 'ok'), 'feed check is ok');
  check(report.checks.some((c) => c.id === 'update' && c.status === 'ok'), 'update check is ok');
  check(report.profileDir === profileDir, 'report carries the profile dir', report.profileDir);
  const state = report.checks.find((c) => c.id === 'state');
  check(state?.status === 'ok' && state.detail.startsWith(process.env.DSH_HOME), 'state path follows the injected DSH_HOME', state?.detail);
}

// 2. missing profile ------------------------------------------------------------
{
  const report = await runDoctor({ ...healthyDeps, profileDir: join(root, 'absent') });
  check(report.ok === false, 'missing profile fails');
  check(report.checks.find((c) => c.id === 'profile')?.status === 'fail', 'profile check is fail');
  check(report.checks.find((c) => c.id === 'bundle')?.status === 'skip', 'bundle check skips without a profile');
}

// 3. purge selected alongside -----------------------------------------------------
{
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    dsh: { profile: { bundles: ['dsh-sunder', 'dsh-purge'] } },
  });
  const report = await runDoctor(healthyDeps);
  const bundle = report.checks.find((c) => c.id === 'bundle');
  check(bundle?.status === 'warn', 'dsh-purge alongside dsh-sunder warns', bundle?.detail);
  check(report.ok === true, 'warnings do not fail the doctor');
  writeJson(join(profileDir, 'package.json'), {
    name: 'fake-profile',
    dsh: { profile: { bundles: ['dsh-sunder'] } },
  });
}

// 4. link missing ----------------------------------------------------------------
{
  const profileWithoutLink = join(root, 'profile-no-link');
  writeJson(join(profileWithoutLink, 'package.json'), {
    name: 'fake-profile',
    dsh: { profile: { bundles: ['dsh-sunder'] } },
  });
  const report = await runDoctor({
    ...healthyDeps,
    profileDir: profileWithoutLink,
    resolvePackageImpl: () => {
      throw new Error('MODULE_NOT_FOUND');
    },
  });
  const link = report.checks.find((c) => c.id === 'link');
  check(link?.status === 'fail', 'missing node_modules link fails', link?.detail);
  check(report.ok === false, 'link failure fails the doctor');
}

// 5. network unreachable ----------------------------------------------------------
{
  const report = await runDoctor({
    ...healthyDeps,
    fetchAnnouncementsImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com');
    },
    checkUpdateImpl: async () => ({ error: 'http-403', checkedAt: new Date().toISOString() }),
  });
  check(report.checks.find((c) => c.id === 'feed')?.status === 'warn', 'unreachable feed is a warning');
  check(report.checks.find((c) => c.id === 'update')?.status === 'warn', 'failed update lookup is a warning');
  check(report.ok === true, 'network problems do not fail the doctor');
}

// 6. --no-network ------------------------------------------------------------------
{
  const report = await runDoctor({ ...healthyDeps, runtimeDir: missingRuntimeDir, noNetwork: true });
  check(report.checks.find((c) => c.id === 'feed')?.status === 'skip', 'no-network skips the feed check');
  check(report.checks.find((c) => c.id === 'update')?.status === 'skip', 'no-network skips the update check');
  check(report.checks.find((c) => c.id === 'composition')?.status === 'skip', 'missing runtime skips composition');
}

// 7. CLI smoke ---------------------------------------------------------------------
{
  const doctorScript = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));
  const env = { ...process.env, DSH_HOME: process.env.DSH_HOME };
  const offline = ['--no-network', '--runtime', missingRuntimeDir];

  const output = execFileSync(
    process.execPath,
    [doctorScript, '--json', ...offline, '--profile', profileDir],
    { cwd: root, encoding: 'utf8', env },
  );
  const report = JSON.parse(output);
  check(report.ok === true, 'CLI exits healthy and prints JSON', String(report.checks?.length));
  check(report.profileDir === profileDir, 'CLI resolves --profile', report.profileDir);

  const help = spawnSync(process.execPath, [doctorScript, '--help'], { cwd: root, encoding: 'utf8', env });
  check(help.status === 0 && /usage:/.test(help.stdout), 'CLI --help exits 0', `status=${help.status}`);

  const bogus = spawnSync(process.execPath, [doctorScript, '--bogus'], { cwd: root, encoding: 'utf8', env });
  check(bogus.status === 2 && /unknown argument/.test(bogus.stderr), 'CLI rejects unknown flags with exit 2', `status=${bogus.status}`);

  const broken = spawnSync(process.execPath, [doctorScript, ...offline, '--profile', join(root, 'absent')], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  check(broken.status === 1, 'CLI exits 1 when a check fails', `status=${broken.status}`);
}

// 8. profile resolution: --profile is a PATH, DSH_PROFILE is a NAME -----------------
{
  check(defaultProfileDir({ DSH_HOME: 'C:/fake-home' }) === join('C:/fake-home', 'profiles', 'desktop'), 'default profile uses DSH_HOME');
  check(
    resolveProfileDir({}, { DSH_HOME: 'C:/fake-home', DSH_PROFILE: 'desktop' }) === join('C:/fake-home', 'profiles', 'desktop'),
    'DSH_PROFILE is a profile NAME under DSH_HOME',
    resolveProfileDir({}, { DSH_HOME: 'C:/fake-home', DSH_PROFILE: 'desktop' }),
  );
  check(
    resolveProfileDir({}, { DSH_HOME: 'C:/fake-home', DSH_PROFILE: 'nightly' }) === join('C:/fake-home', 'profiles', 'nightly'),
    'DSH_PROFILE name is not resolved against the cwd',
    resolveProfileDir({}, { DSH_HOME: 'C:/fake-home', DSH_PROFILE: 'nightly' }),
  );
  check(
    resolveProfileDir({}, { DSH_HOME: 'C:/fake-home', DSH_PROFILE: 'C:/elsewhere/profile' }) === 'C:/elsewhere/profile',
    'absolute DSH_PROFILE is honoured as a path',
  );
  check(
    resolveProfileDir({ profileDir: 'C:/explicit/profile' }, { DSH_PROFILE: 'desktop' }) === 'C:/explicit/profile',
    '--profile wins over DSH_PROFILE',
  );
  check(
    resolveProfileDir({ profileDir: 'relative/profile' }, {}) === join(process.cwd(), 'relative', 'profile'),
    'relative --profile resolves from the cwd',
    resolveProfileDir({ profileDir: 'relative/profile' }, {}),
  );
}

// 9. DSH_PROFILE=<name> points the doctor at <DSH_HOME>/profiles/<name> --------------
{
  const namedHome = mkdtempSync(join(tmpdir(), 'sunder-doctor-named-home-'));
  const namedProfile = join(namedHome, 'profiles', 'desktop');
  writeJson(join(namedProfile, 'package.json'), {
    name: 'named-profile',
    dsh: { profile: { bundles: ['dsh-sunder'] } },
  });
  const namedSunder = join(namedProfile, 'node_modules', 'dsh-sunder');
  writeJson(join(namedSunder, 'package.json'), {
    name: 'dsh-sunder',
    version: '7.7.7',
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    exports: { './client': './lib/client.js' },
  });
  writeFileSync(join(namedSunder, 'cordis.patch.yml'), '[]\n');
  mkdirSync(join(namedSunder, 'lib'), { recursive: true });
  writeFileSync(join(namedSunder, 'lib', 'client.js'), 'export {};\n');

  const report = await runDoctor({
    env: { DSH_HOME: namedHome, DSH_PROFILE: 'desktop' },
    runtimeDir: missingRuntimeDir,
    noNetwork: true,
    loadProfileImpl: async () => ({ ok: true, skippedBundles: [], rows: [] }),
  });
  check(report.profileDir === namedProfile, 'runDoctor follows DSH_PROFILE as a name', report.profileDir);
  check(report.checks.find((c) => c.id === 'profile')?.status === 'ok', 'named profile is readable');
  check(report.checks.find((c) => c.id === 'link')?.status === 'ok', 'named profile link resolves');
  check(report.checks.find((c) => c.id === 'manifest')?.status === 'ok', 'named profile manifest is complete');
  rmSync(namedHome, { recursive: true, force: true });
}

rmSync(root, { recursive: true, force: true });
rmSync(process.env.DSH_HOME, { recursive: true, force: true });

console.log(failures === 0 ? `\ndoctor: OK` : `\ndoctor: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
