#!/usr/bin/env node
/**
 * scripts/install.mjs 与 scripts/uninstall.mjs 的离线测试。
 *
 * 全部使用 os.tmpdir() 里的假 profile 和假仓库，不读也不写真实 DSH 配置。
 * 覆盖：junction 安装、复制回退、依赖 / bundle 修改、幂等、备份、dry-run、
 * 占用保护、卸载回滚与仓库不被删除。
 */

import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { install } from '../scripts/install.mjs';
import { uninstall } from '../scripts/uninstall.mjs';

let failures = 0;

function check(condition, label, extra = '') {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}${extra.length > 0 ? ` — ${extra}` : ''}`);
  }
}

function same(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label} — ${error.message}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeProfile(profileDir, pkg) {
  mkdirSync(profileDir, { recursive: true });
  const text = `${JSON.stringify(pkg, null, 2)}\n`;
  writeFileSync(join(profileDir, 'package.json'), text, 'utf8');
  return text;
}

function listBackups(profileDir) {
  return readdirSync(profileDir).filter((name) => name.startsWith('package.json.bak-'));
}

function samePath(left, right) {
  const normalize = (value) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
  return normalize(left) === normalize(right);
}

const noop = () => {};

const temp = mkdtempSync(join(tmpdir(), 'sunder-install-test-'));

try {
  // 假仓库：install 只校验 package.json.name，并把它复制到假 profile。
  const repoDir = join(temp, 'repo');
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, 'package.json'), `${JSON.stringify({ name: 'dsh-sunder', version: '1.0.1' }, null, 2)}\n`, 'utf8');
  writeFileSync(join(repoDir, 'index.js'), 'export default {};\n', 'utf8');

  const basePackage = () => ({
    name: 'dsh-profile-test',
    private: true,
    dependencies: {
      'dsh-purge': 'https://codeload.github.com/example/dsh-purge/tar.gz/abc',
      'dsh-purge-cwd-compat': 'link:D:/dsh/purge-cwd-compat',
      'some-other': '1.0.0',
    },
    dsh: {
      profile: {
        patchReload: 'live',
        bundles: ['@deepseek-ai/dsh-base', 'dsh-purge', 'dsh-purge-cwd-compat', 'billion-context'],
      },
    },
  });
  const expectedBundles = ['@deepseek-ai/dsh-base', 'billion-context', 'dsh-sunder'];
  const linkSpec = `link:${repoDir.replace(/\\/gu, '/')}`;

  // ---- 1. 首次安装 ----
  const profileDir = join(temp, 'profile-main');
  const originalPackage = basePackage();
  const originalText = writeProfile(profileDir, originalPackage);
  const manifestPath = join(profileDir, 'package.json');

  const first = install({ profileDir, repoDir, log: noop });
  check(first.ok === true, '首次安装返回 ok', first.error);
  check(first.changed === true, '首次安装报告有变更');
  check(first.restartRequired === true, '安装后提示需要重启');

  const afterFirst = readJson(manifestPath);
  same(afterFirst.dependencies['dsh-sunder'], linkSpec, '依赖写成 link:<仓库路径>');
  check(afterFirst.dependencies['dsh-purge'] !== undefined, '保留 dsh-purge 依赖（不删包）');
  check(afterFirst.dependencies['dsh-purge-cwd-compat'] !== undefined, '保留 dsh-purge-cwd-compat 依赖（不删包）');
  same(afterFirst.dsh.profile.bundles, expectedBundles, 'bundle 列表追加 dsh-sunder 并移除退休项');
  check(afterFirst.dsh.profile.patchReload === 'live', '保留 dsh.profile 其他字段');

  const entryPath = join(profileDir, 'node_modules', 'dsh-sunder');
  const entryStat = lstatSync(entryPath);
  check(entryStat.isSymbolicLink() || entryStat.isDirectory(), 'node_modules/dsh-sunder 已创建');
  if (entryStat.isSymbolicLink()) {
    check(samePath(realpathSync(entryPath), repoDir), 'junction 指向插件仓库');
  } else {
    check(readJson(join(entryPath, 'package.json')).name === 'dsh-sunder', '复制目录内容正确');
  }

  const installBackups = listBackups(profileDir);
  same(installBackups.length, 1, '安装生成一个 package.json 备份');
  check(readFileSync(join(profileDir, installBackups[0]), 'utf8') === originalText, '备份内容等于改动前的原文');
  check(readFileSync(manifestPath, 'utf8').includes('\n  "name"'), '保持两空格缩进');

  // ---- 2. 幂等：再装一次不写文件、不新增备份 ----
  const beforeSecond = readFileSync(manifestPath, 'utf8');
  const second = install({ profileDir, repoDir, log: noop });
  check(second.ok === true, '重复安装返回 ok');
  check(second.changed === false, '重复安装报告无变更');
  check(second.backupPath === undefined, '重复安装不产生新备份');
  same(listBackups(profileDir).length, 1, '重复安装备份数量不变');
  check(readFileSync(manifestPath, 'utf8') === beforeSecond, '重复安装不改写 package.json');

  // ---- 3. dry-run：只规划，不落盘 ----
  const dryProfile = join(temp, 'profile-dry');
  const dryText = writeProfile(dryProfile, basePackage());
  const dry = install({ profileDir: dryProfile, repoDir, dryRun: true, log: noop });
  check(dry.ok === true && dry.dryRun === true, 'dry-run 返回 ok');
  check(dry.changed === true, 'dry-run 报告将产生的变更');
  check(!existsSync(join(dryProfile, 'node_modules', 'dsh-sunder')), 'dry-run 不创建 node_modules 条目');
  check(readFileSync(join(dryProfile, 'package.json'), 'utf8') === dryText, 'dry-run 不改写 package.json');
  same(listBackups(dryProfile).length, 0, 'dry-run 不产生备份');

  // ---- 4. 目标被别的包占用：拒绝覆盖 ----
  const foreignProfile = join(temp, 'profile-foreign');
  const foreignText = writeProfile(foreignProfile, basePackage());
  const foreignEntry = join(foreignProfile, 'node_modules', 'dsh-sunder');
  mkdirSync(foreignEntry, { recursive: true });
  writeFileSync(join(foreignEntry, 'package.json'), `${JSON.stringify({ name: 'other-package' })}\n`, 'utf8');

  const blocked = install({ profileDir: foreignProfile, repoDir, log: noop });
  check(blocked.ok === false, '占用时安装失败而不是覆盖');
  check(typeof blocked.error === 'string' && blocked.error.includes('不是本插件'), '占用错误说明原因');
  check(readFileSync(join(foreignProfile, 'package.json'), 'utf8') === foreignText, '占用时不改写 profile');
  same(listBackups(foreignProfile).length, 0, '占用时不产生备份');

  // ---- 5. 链接失败回退复制，卸载时删复制目录但保留仓库 ----
  const copyProfile = join(temp, 'profile-copy');
  writeProfile(copyProfile, basePackage());
  const copied = install({
    profileDir: copyProfile,
    repoDir,
    symlinkImpl: () => {
      throw new Error('测试中禁用链接');
    },
    log: noop,
  });
  check(copied.ok === true, '链接失败时回退复制并成功', copied.error);
  same(copied.changes.packageEntry.method, 'copy', '安装结果标记为复制');
  const copyEntry = join(copyProfile, 'node_modules', 'dsh-sunder');
  check(lstatSync(copyEntry).isDirectory() && !lstatSync(copyEntry).isSymbolicLink(), '回退结果是真实目录');
  check(readJson(join(copyEntry, 'package.json')).name === 'dsh-sunder', '复制目录里是插件包');

  const removedCopy = uninstall({ profileDir: copyProfile, repoDir, log: noop });
  check(removedCopy.ok === true, '复制安装可以卸载', removedCopy.error);
  same(removedCopy.packageEntry.action, 'removed-copy', '卸载删除复制目录');
  check(!existsSync(copyEntry), '复制目录已删除');
  check(existsSync(join(repoDir, 'package.json')) && existsSync(join(repoDir, 'index.js')), '仓库文件未被删除');

  // ---- 6. 卸载主流程：删依赖、删 bundle 条目、解链，保留备份 ----
  const mainBackupsBefore = listBackups(profileDir).length;
  const uninstalled = uninstall({ profileDir, repoDir, log: noop });
  check(uninstalled.ok === true, '卸载返回 ok', uninstalled.error);
  check(uninstalled.dependencyRemoved === true, '卸载移除 dependencies.dsh-sunder');
  check(uninstalled.bundleRemoved === true, '卸载移除 bundles 里的 dsh-sunder');
  check(!existsSync(entryPath), '卸载后 node_modules/dsh-sunder 不存在');
  const afterUninstall = readJson(manifestPath);
  check(afterUninstall.dependencies !== undefined && afterUninstall.dependencies['dsh-sunder'] === undefined, 'package.json 里不再有 dsh-sunder 依赖');
  check(!afterUninstall.dsh.profile.bundles.includes('dsh-sunder'), 'bundle 列表里不再有 dsh-sunder');
  check(afterUninstall.dependencies['dsh-purge'] !== undefined, '卸载不删除其他包依赖');
  same(listBackups(profileDir).length, mainBackupsBefore + 1, '卸载又生成一个备份');
  check(existsSync(join(repoDir, 'package.json')), '卸载后仓库仍在');

  const uninstallAgain = uninstall({ profileDir, repoDir, log: noop });
  check(uninstallAgain.ok === true && uninstallAgain.changed === false, '重复卸载无变更');
  same(listBackups(profileDir).length, mainBackupsBefore + 1, '重复卸载不新增备份');

  // ---- 7. 找不到 profile：返回错误而不是抛异常 ----
  const missing = install({ profileDir: join(temp, 'no-such-profile'), repoDir, log: noop });
  check(missing.ok === false && typeof missing.error === 'string', '缺少 profile 时返回 ok:false');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`install: ${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('install: OK');
}
