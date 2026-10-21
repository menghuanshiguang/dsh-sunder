#!/usr/bin/env node
/**
 * dsh-sunder 卸载脚本：安全回滚 scripts/install.mjs 做过的三件事。
 *
 * 用法：
 *   node scripts/uninstall.mjs [--profile <DSH profile 目录>] [--dry-run]
 *
 * 卸载动作：
 *   1. 从 <profile>/package.json 的 dependencies 里删掉 "dsh-sunder"；
 *   2. 从 dsh.profile.bundles 里删掉 "dsh-sunder"；
 *   3. 删掉 <profile>/node_modules/dsh-sunder（junction 只解链，复制目录才删本
 *      目录内容）。
 *
 * 安全边界：
 *   - 永远不删除插件仓库本身，只操作 profile；
 *   - 修改 package.json 前先写 package.json.bak-<时间戳>，备份一律保留；
 *   - node_modules/dsh-sunder 若是别的包（package.json.name 不匹配），跳过并提示；
 *   - 没有任何变化时不写文件、不产生新备份，可反复执行。
 *
 * 卸载后需要重启一次 DSH，bundle 列表才会被重新读取。
 */

import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultProfileDir, PACKAGE_NAME, ROOT } from './install.mjs';

/** 是否作为命令行入口直接运行。 */
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  const current = fileURLToPath(moduleUrl);
  const normalize = (value) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
  return normalize(entry) === normalize(current);
}

/** 解析命令行参数。未知参数记入 errors，交给 main 统一报错。 */
export function parseArgs(argv = []) {
  const options = { profileDir: undefined, repoDir: undefined, dryRun: false, help: false, errors: [] };
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
    'dsh-sunder 卸载脚本',
    '',
    '用法：',
    '  node scripts/uninstall.mjs [--profile <DSH profile 目录>] [--dry-run]',
    '',
    '选项：',
    '  -p, --profile <目录>  目标 DSH profile（默认 $DSH_HOME/profiles/desktop）',
    '      --repo <目录>     插件仓库目录（仅用于安全检查，默认本脚本所在仓库）',
    '  -n, --dry-run         只打印将要做的修改，不写任何文件',
    '  -h, --help            显示本帮助',
  ].join('\n');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function timestamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 备份文件，返回备份路径；备份一律保留。 */
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
  return { raw, bom, parsed };
}

function readPackageName(directory) {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return typeof parsed?.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
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

/** 删除 node_modules/dsh-sunder；foreign 目录只跳过，绝不动插件仓库。 */
function planEntryRemoval({ profileDir, repoDir, dryRun }) {
  const entryPath = join(profileDir, 'node_modules', PACKAGE_NAME);
  const current = lstatSafe(entryPath);
  if (current === undefined) return { changed: false, action: 'absent', target: entryPath };
  if (current.isSymbolicLink()) {
    if (dryRun) return { changed: true, action: 'would-unlink', target: entryPath };
    unlinkEntry(entryPath);
    return { changed: true, action: 'unlinked', target: entryPath };
  }
  if (current.isDirectory()) {
    const name = readPackageName(entryPath);
    if (name !== PACKAGE_NAME) {
      return {
        changed: false,
        action: 'skipped-foreign',
        target: entryPath,
        warning: `node_modules/${PACKAGE_NAME} 的 package.json.name=${name ?? '(缺失)'}，不是本插件，已跳过`,
      };
    }
    const real = realpathSafe(entryPath);
    if (real !== undefined && samePath(real, repoDir)) {
      return { changed: false, action: 'skipped-repo', target: entryPath, warning: '目标解析到插件仓库本身，拒绝递归删除' };
    }
    if (dryRun) return { changed: true, action: 'would-remove-copy', target: entryPath };
    rmSync(entryPath, { recursive: true, force: true });
    return { changed: true, action: 'removed-copy', target: entryPath };
  }
  return {
    changed: false,
    action: 'skipped-file',
    target: entryPath,
    warning: `node_modules/${PACKAGE_NAME} 不是目录或链接，已跳过`,
  };
}

/** 卸载主流程；任何异常都转成 { ok:false, error }，不向外抛。 */
export function uninstall(options = {}) {
  const log = typeof options.log === 'function' ? options.log : console.log;
  try {
    return uninstallUnsafe({ ...options, log });
  } catch (error) {
    return { ok: false, error: errorText(error), profileDir: options.profileDir, repoDir: options.repoDir };
  }
}

function uninstallUnsafe({ profileDir, repoDir, dryRun = false, log }) {
  const targetProfile = resolve(profileDir ?? defaultProfileDir());
  const targetRepo = resolve(repoDir ?? ROOT);
  const manifestPath = join(targetProfile, 'package.json');

  if (!existsSync(manifestPath)) {
    return { ok: false, error: `找不到 profile 的 package.json：${manifestPath}（可用 --profile 指定）`, profileDir: targetProfile, repoDir: targetRepo };
  }

  const manifest = parseManifest(manifestPath);
  const pkg = manifest.parsed;
  let dependencyRemoved = false;
  if (isPlainObject(pkg.dependencies) && Object.hasOwn(pkg.dependencies, PACKAGE_NAME)) {
    delete pkg.dependencies[PACKAGE_NAME];
    dependencyRemoved = true;
  }

  const originalBundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const nextBundles = originalBundles.filter((entry) => entry !== PACKAGE_NAME);
  const bundleRemoved = nextBundles.length !== originalBundles.length;
  if (bundleRemoved && isPlainObject(pkg.dsh?.profile)) {
    pkg.dsh.profile.bundles = nextBundles;
  }

  const packageChanged = dependencyRemoved || bundleRemoved;
  let backupPath;
  if (packageChanged && !dryRun) {
    backupPath = backupFile(manifestPath);
    const text = serializeLike(manifest.raw, pkg);
    writeFileSync(manifestPath, manifest.bom ? `\ufeff${text}` : text, 'utf8');
  }

  const entry = planEntryRemoval({ profileDir: targetProfile, repoDir: targetRepo, dryRun });

  log(`[${PACKAGE_NAME}] 目标 profile：${targetProfile}`);
  log(`  依赖 dsh-sunder：${dependencyRemoved ? '已移除' : '本来就不存在'}`);
  log(`  dsh.profile.bundles：${bundleRemoved ? '已移除 dsh-sunder' : '本来就不存在'}`);
  const actionText = {
    absent: '本来就不存在',
    unlinked: '已解除 junction',
    'would-unlink': '将解除 junction（dry-run）',
    'removed-copy': '已删除复制目录',
    'would-remove-copy': '将删除复制目录（dry-run）',
    'skipped-foreign': '跳过（不是本插件）',
    'skipped-repo': '跳过（指向插件仓库）',
    'skipped-file': '跳过（不是目录或链接）',
  }[entry.action] ?? entry.action;
  log(`  node_modules/dsh-sunder：${actionText}`);
  if (entry.warning !== undefined) log(`  注意：${entry.warning}`);
  if (backupPath !== undefined) log(`  package.json 备份：${backupPath}`);
  if (!packageChanged && !entry.changed) log('未发现安装痕迹，无需改动。');
  if (dryRun) log('（dry-run）未写入任何文件。');
  else log('卸载完成。');
  log(`插件仓库保持不变：${targetRepo}`);
  log('需重启一次 DSH，新的 bundle 列表才会被加载。');

  return {
    ok: true,
    dryRun,
    profileDir: targetProfile,
    repoDir: targetRepo,
    changed: packageChanged || entry.changed,
    dependencyRemoved,
    bundleRemoved,
    backupPath,
    restartRequired: true,
    packageEntry: entry,
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
  const result = uninstall({ profileDir: options.profileDir, repoDir: options.repoDir, dryRun: options.dryRun });
  if (result.ok !== true) {
    console.error(`[${PACKAGE_NAME}] 卸载失败：${result.error}`);
    return 1;
  }
  return 0;
}

if (isMain(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
