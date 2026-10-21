#!/usr/bin/env node
/**
 * dsh-sunder 一键安装脚本。
 *
 * 用法：
 *   node scripts/install.mjs [--profile <DSH profile 目录>] [--dry-run]
 *   node scripts/install.mjs --uninstall [--profile <目录>] [--dry-run]
 *
 * 默认 profile：$DSH_HOME/profiles/desktop（$DSH_HOME 默认 ~/.dsh）。
 *
 * 安装做三件事：
 *   1. 在 <profile>/node_modules/dsh-sunder 建 junction 指向本仓库；没有创建
 *      链接的权限（或平台不支持）时自动回退成复制目录；
 *   2. 在 <profile>/package.json 的 dependencies 写入
 *      "dsh-sunder": "link:<仓库路径>"；
 *   3. 把 "dsh-sunder" 追加到 dsh.profile.bundles，同时移除
 *      dsh-purge / dsh-purge-cwd-compat 两个 bundle 条目（只删条目，不删包）。
 *
 * 修改 package.json 之前必定先写 package.json.bak-<时间戳>；没有任何变化时
 * 不写文件、不产生新备份，因此可以反复执行。安装完成后需要重启一次 DSH，
 * bundle 列表才会被重新读取。
 *
 * 本脚本只操作显式传入的 profile；测试请用 os.tmpdir() 里的假 profile。
 */

import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDshHome } from '../lib/state.js';

/** 仓库根目录（scripts/ 的上一级）。 */
export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 本插件在 profile 里的包名。 */
export const PACKAGE_NAME = 'dsh-sunder';

/** 需要从 bundle 列表里退休、但保留安装的旧插件。 */
export const RETIRED_BUNDLES = Object.freeze(['dsh-purge', 'dsh-purge-cwd-compat']);

/** 是否作为命令行入口直接运行。 */
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  const current = fileURLToPath(moduleUrl);
  const normalize = (value) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
  return normalize(entry) === normalize(current);
}

/** 默认 profile 目录：$DSH_HOME/profiles/desktop。 */
export function defaultProfileDir(env = process.env) {
  return join(resolveDshHome(env), 'profiles', 'desktop');
}

/** 解析命令行参数。未知参数记入 errors，交给 main 统一报错。 */
export function parseArgs(argv = []) {
  const options = { profileDir: undefined, repoDir: undefined, dryRun: false, uninstall: false, help: false, errors: [] };
  const takeValue = (index, flag) => {
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      options.errors.push(`${flag} 需要一个目录参数`);
      return undefined;
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile' || arg === '-p') {
      const value = takeValue(index, arg);
      if (value !== undefined) {
        options.profileDir = value;
        index += 1;
      }
    } else if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length);
      if (value.length === 0) options.errors.push('--profile 需要一个目录参数');
      else options.profileDir = value;
    } else if (arg === '--repo') {
      const value = takeValue(index, arg);
      if (value !== undefined) {
        options.repoDir = value;
        index += 1;
      }
    } else if (arg.startsWith('--repo=')) {
      const value = arg.slice('--repo='.length);
      if (value.length === 0) options.errors.push('--repo 需要一个目录参数');
      else options.repoDir = value;
    } else if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
    } else if (arg === '--uninstall' || arg === '-u') {
      options.uninstall = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      options.errors.push(`未知参数：${arg}`);
    }
  }
  return options;
}

/** 打印用法。 */
export function usage() {
  return [
    'dsh-sunder 安装脚本',
    '',
    '用法：',
    '  node scripts/install.mjs [--profile <DSH profile 目录>] [--dry-run]',
    '  node scripts/install.mjs --uninstall [--profile <目录>] [--dry-run]',
    '',
    '选项：',
    '  -p, --profile <目录>  目标 DSH profile（默认 $DSH_HOME/profiles/desktop）',
    '      --repo <目录>     插件仓库目录（默认本脚本所在仓库）',
    '  -n, --dry-run         只打印将要做的修改，不写任何文件',
    '  -u, --uninstall       转交 scripts/uninstall.mjs 做安全回滚',
    '  -h, --help            显示本帮助',
  ].join('\n');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function lstatSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function realpathSafe(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalize = (value) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
  return normalize(left) === normalize(right);
}

/** 生成 .bak-YYYYMMDD-HHmmss 形式的时间戳；同一秒内多次备份自动加序号。 */
function timestamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 备份文件，返回备份路径；不移动原文件。 */
export function backupFile(path, date = new Date()) {
  const stamp = timestamp(date);
  let candidate = `${path}.bak-${stamp}`;
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = `${path}.bak-${stamp}-${suffix}`;
    suffix += 1;
  }
  copyFileSync(path, candidate);
  return candidate;
}

/** 按原文件的缩进 / 换行风格重新序列化 JSON。 */
export function serializeLike(original, data) {
  const match = original.match(/\n([ \t]+)"/u);
  const indent = match === null ? 2 : match[1];
  let body = JSON.stringify(data, null, indent);
  if (original.includes('\r\n')) body = body.replace(/\n/gu, '\r\n');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  return original.endsWith('\n') ? `${body}${eol}` : body;
}

function parseManifest(path) {
  const raw = readFileSync(path, 'utf8');
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  const parsed = JSON.parse(text);
  if (!isPlainObject(parsed)) throw new Error('package.json 顶层不是对象');
  return { raw, text, bom, parsed };
}

/** 读取目录里的 package.json.name（读不到返回 undefined）。 */
function readPackageName(directory) {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return typeof parsed?.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/** 计算新的 bundle 列表：保留原顺序，去掉退休条目，确保 dsh-sunder 恰好在末尾出现一次。 */
export function planBundles(entries) {
  const kept = [];
  const removed = [];
  let added = false;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === PACKAGE_NAME) {
      if (!kept.includes(PACKAGE_NAME)) kept.push(PACKAGE_NAME);
      continue;
    }
    if (RETIRED_BUNDLES.includes(entry)) {
      if (!removed.includes(entry)) removed.push(entry);
      continue;
    }
    kept.push(entry);
  }
  if (!kept.includes(PACKAGE_NAME)) {
    kept.push(PACKAGE_NAME);
    added = true;
  }
  return { bundles: kept, added, removed };
}

/** 创建链接；失败则复制目录。返回 method=junction|copy。 */
function linkOrCopy(repoDir, entryPath, symlinkImpl, log) {
  mkdirSync(dirname(entryPath), { recursive: true });
  try {
    symlinkImpl(repoDir, entryPath);
    return { method: 'junction', warning: undefined };
  } catch (error) {
    const reason = errorText(error);
    log(`  junction 创建失败（${reason}），回退为复制目录。`);
    try {
      rmSync(entryPath, { recursive: true, force: true });
    } catch {
      /* 目标可能只创建了一半，继续尝试复制 */
    }
    cpSync(repoDir, entryPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (source) => !/(?:^|[\\/])(?:\.git|node_modules)(?:[\\/]|$)/u.test(source),
    });
    return { method: 'copy', warning: reason };
  }
}

function unlinkEntry(path) {
  try {
    unlinkSync(path);
  } catch {
    // Windows 的 directory junction 在个别 Node 版本上要用 rmdir 删除。
    rmdirSync(path);
  }
}

/** 规划 / 执行 node_modules/dsh-sunder 这一项。 */
function planPackageEntry({ profileDir, repoDir, dryRun, symlinkImpl, log }) {
  const entryPath = join(profileDir, 'node_modules', PACKAGE_NAME);
  const current = lstatSafe(entryPath);
  if (current === undefined) {
    if (dryRun) return { changed: true, action: 'created', method: 'planned', target: entryPath };
    const created = linkOrCopy(repoDir, entryPath, symlinkImpl, log);
    return { changed: true, action: created.method === 'copy' ? 'copied' : 'linked', method: created.method, target: entryPath, warning: created.warning };
  }
  if (current.isSymbolicLink()) {
    const target = realpathSafe(entryPath);
    if (target !== undefined && samePath(target, repoDir)) {
      return { changed: false, action: 'linked', method: 'junction', target: entryPath };
    }
    if (dryRun) return { changed: true, action: 'relinked', method: 'planned', target: entryPath };
    unlinkEntry(entryPath);
    const created = linkOrCopy(repoDir, entryPath, symlinkImpl, log);
    return { changed: true, action: 'relinked', method: created.method, target: entryPath };
  }
  if (current.isDirectory()) {
    const name = readPackageName(entryPath);
    if (name === PACKAGE_NAME) {
      return { changed: false, action: 'copied', method: 'copy', target: entryPath };
    }
    return {
      changed: false,
      action: 'blocked',
      method: 'none',
      target: entryPath,
      error: `node_modules/${PACKAGE_NAME} 已存在且不是本插件（package.json.name=${name ?? '(缺失)'}），未覆盖`,
    };
  }
  return {
    changed: false,
    action: 'blocked',
    method: 'none',
    target: entryPath,
    error: `node_modules/${PACKAGE_NAME} 已存在且不是目录或链接，未覆盖`,
  };
}

/** 安装主流程；任何异常都转成 { ok:false, error }，不向外抛。 */
export function install(options = {}) {
  const log = typeof options.log === 'function' ? options.log : console.log;
  try {
    return installUnsafe({ ...options, log });
  } catch (error) {
    return { ok: false, error: errorText(error), profileDir: options.profileDir, repoDir: options.repoDir };
  }
}

function installUnsafe({ profileDir, repoDir, dryRun = false, symlinkImpl = (target, path) => symlinkSync(target, path, 'junction'), log }) {
  const targetProfile = resolve(profileDir ?? defaultProfileDir());
  const targetRepo = resolve(repoDir ?? ROOT);
  const manifestPath = join(targetProfile, 'package.json');
  const repoManifest = join(targetRepo, 'package.json');

  if (!existsSync(manifestPath)) {
    return { ok: false, error: `找不到 profile 的 package.json：${manifestPath}（可用 --profile 指定）`, profileDir: targetProfile, repoDir: targetRepo };
  }
  if (!existsSync(repoManifest)) {
    return { ok: false, error: `仓库目录缺少 package.json：${targetRepo}`, profileDir: targetProfile, repoDir: targetRepo };
  }
  const repoPackage = JSON.parse(readFileSync(repoManifest, 'utf8'));
  if (repoPackage?.name !== PACKAGE_NAME) {
    return { ok: false, error: `仓库 package.json.name=${repoPackage?.name ?? '(缺失)'}，不是 ${PACKAGE_NAME}`, profileDir: targetProfile, repoDir: targetRepo };
  }

  const manifest = parseManifest(manifestPath);
  const pkg = manifest.parsed;
  const before = cloneJson(pkg);

  if (pkg.dependencies !== undefined && !isPlainObject(pkg.dependencies)) {
    return { ok: false, error: 'profile package.json 的 dependencies 不是对象，未做修改', profileDir: targetProfile, repoDir: targetRepo };
  }
  if (pkg.dependencies === undefined) pkg.dependencies = {};
  if (pkg.dsh !== undefined && !isPlainObject(pkg.dsh)) {
    return { ok: false, error: 'profile package.json 的 dsh 字段不是对象，未做修改', profileDir: targetProfile, repoDir: targetRepo };
  }
  if (pkg.dsh === undefined) pkg.dsh = {};
  if (pkg.dsh.profile !== undefined && !isPlainObject(pkg.dsh.profile)) {
    return { ok: false, error: 'profile package.json 的 dsh.profile 字段不是对象，未做修改', profileDir: targetProfile, repoDir: targetRepo };
  }
  if (pkg.dsh.profile === undefined) pkg.dsh.profile = {};

  const linkSpec = `link:${targetRepo.replace(/\\/gu, '/')}`;
  const previousSpec = pkg.dependencies[PACKAGE_NAME];
  pkg.dependencies[PACKAGE_NAME] = linkSpec;

  const originalBundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  const planned = planBundles(originalBundles);
  pkg.dsh.profile.bundles = planned.bundles;

  const packageChanged = JSON.stringify(pkg) !== JSON.stringify(before);
  const entry = planPackageEntry({ profileDir: targetProfile, repoDir: targetRepo, dryRun, symlinkImpl, log });
  if (entry.action === 'blocked') {
    return { ok: false, error: entry.error, profileDir: targetProfile, repoDir: targetRepo, packageEntry: entry };
  }

  let backupPath;
  if (packageChanged && !dryRun) {
    backupPath = backupFile(manifestPath);
    const text = serializeLike(manifest.raw, pkg);
    writeFileSync(manifestPath, manifest.bom ? `\ufeff${text}` : text, 'utf8');
  }

  const dependencyChanged = previousSpec !== linkSpec;
  const bundlesChanged = JSON.stringify(originalBundles) !== JSON.stringify(planned.bundles);

  log(`[${PACKAGE_NAME}] 目标 profile：${targetProfile}`);
  log(`[${PACKAGE_NAME}] 插件仓库：${targetRepo}`);
  log(`  依赖 dsh-sunder：${dependencyChanged ? (previousSpec === undefined ? `新增 ${linkSpec}` : `更新 ${previousSpec} -> ${linkSpec}`) : `已是最新（${linkSpec}）`}`);
  if (bundlesChanged) {
    const parts = [];
    if (planned.added) parts.push('追加 dsh-sunder');
    if (planned.removed.length > 0) parts.push(`移除 ${planned.removed.join('、')}（包本体保留，不删除）`);
    if (parts.length === 0) parts.push('把 dsh-sunder 调整到末尾');
    log(`  dsh.profile.bundles：${parts.join('；')}`);
  } else {
    log('  dsh.profile.bundles：已包含 dsh-sunder，无需修改');
  }
  const actionText = {
    created: '创建',
    linked: '已存在',
    copied: '已存在',
    relinked: '重建',
    blocked: '被占用',
  }[entry.action] ?? entry.action;
  const methodText = entry.method === 'copy' ? '复制' : entry.method;
  log(`  node_modules/dsh-sunder：${actionText}${entry.method === 'planned' ? '（dry-run 计划）' : `（${methodText}）`}`);
  if (backupPath !== undefined) log(`  package.json 备份：${backupPath}`);
  if (dryRun) log('（dry-run）未写入任何文件。');
  else log('安装完成。');
  log('需重启一次 DSH，新的 bundle 列表才会被加载。');

  return {
    ok: true,
    dryRun,
    profileDir: targetProfile,
    repoDir: targetRepo,
    linkSpec,
    changed: packageChanged || entry.changed,
    packageChanged,
    backupPath,
    restartRequired: true,
    changes: {
      dependency: { previous: previousSpec ?? null, next: linkSpec, changed: dependencyChanged },
      bundles: { previous: originalBundles, next: planned.bundles, added: planned.added, removed: planned.removed, changed: bundlesChanged },
      packageEntry: entry,
    },
  };
}

/** 命令行入口；返回进程退出码。 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.errors.length > 0) {
    for (const message of options.errors) console.error(`[${PACKAGE_NAME}] ${message}`);
    console.error(usage());
    return 2;
  }
  if (options.uninstall) {
    const { uninstall } = await import('./uninstall.mjs');
    const result = uninstall({ profileDir: options.profileDir, repoDir: options.repoDir, dryRun: options.dryRun });
    if (result.ok !== true) {
      console.error(`[${PACKAGE_NAME}] 卸载失败：${result.error}`);
      return 1;
    }
    return 0;
  }
  const result = install({ profileDir: options.profileDir, repoDir: options.repoDir, dryRun: options.dryRun });
  if (result.ok !== true) {
    console.error(`[${PACKAGE_NAME}] 安装失败：${result.error}`);
    return 1;
  }
  return 0;
}

if (isMain(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
