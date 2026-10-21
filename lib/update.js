/**
 * Update checking for Sunder.
 *
 * The canonical release feed is the GitHub Releases API of the repository that
 * ships this package. `checkForUpdate()` reports the newest published release,
 * whether it is newer than the running version, and the release page URL. The
 * result is cached in the state file so a normal session costs at most one
 * request per `updateIntervalHours`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

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

// ===========================================================================
// 自更新：下载发布源码包并安全写入安装目录
// ===========================================================================

/** 默认的 API 请求超时（毫秒）。 */
const DEFAULT_UPDATE_TIMEOUT_MS = 20_000;
/** 源码包下载允许的最长超时（毫秒）。 */
const MAX_ARCHIVE_TIMEOUT_MS = 120_000;
/** 安装目录里的包清单必须声明这个名字，才允许写入。 */
const INSTALL_PACKAGE_NAME = 'dsh-sunder';

/** 把任意异常转成可读文本，避免把异常对象直接塞进返回值。 */
function errorText(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) return error.message;
  return String(error);
}

/** 判断是否为普通对象（排除 null 与数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 统一调用 fetchJsonImpl：兼容 dsh-sunder 自己的 { ok, data } 包装，
 * 也兼容测试里直接返回数据的 stub。任何异常都转成 { ok:false }。
 */
async function safeFetchJson(impl, url, options) {
  if (typeof impl !== 'function') return { ok: false, error: 'fetch-json-unavailable' };
  try {
    const result = await impl(url, options);
    if (isPlainObject(result) && typeof result.ok === 'boolean') {
      if (result.ok === true) return { ok: true, data: result.data };
      return { ok: false, error: typeof result.error === 'string' ? result.error : 'request-failed' };
    }
    if (result === undefined || result === null) return { ok: false, error: 'empty-response' };
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/** 读取安装目录里的包清单；目录不存在或清单损坏都如实报告。 */
function readInstalledManifest(dir) {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) return { exists: false };
  try {
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return {
      exists: true,
      name: typeof pkg?.name === 'string' ? pkg.name : undefined,
      version: typeof pkg?.version === 'string' ? pkg.version : undefined,
    };
  } catch (error) {
    return { exists: true, error: errorText(error) };
  }
}

/**
 * 取 GitHub 令牌：优先 `gh auth token`，其次 GH_TOKEN / GITHUB_TOKEN。
 * 拿不到就用匿名请求；这里永不抛异常。
 */
function resolveGhToken() {
  try {
    const output = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const token = output.trim();
    if (token.length > 0) return token;
  } catch {
    // gh 未安装、未登录或超时，继续看环境变量
  }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** 组装 GitHub API 请求头。 */
function apiHeaders(token, extra = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-sunder-updater',
    'x-github-api-version': '2022-11-28',
    ...extra,
  };
  if (typeof token === 'string' && token.length > 0) headers.authorization = `Bearer ${token}`;
  return headers;
}

/**
 * 查询最新发布版本：先 /releases/latest，失败或没有 tag 时回退 /tags。
 * 只走 api.github.com，不碰 github.com / codeload。
 */
async function resolveLatestRelease({ repo, fetchJsonImpl, token, timeoutMs, log }) {
  const releasesUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  const release = await safeFetchJson(fetchJsonImpl, releasesUrl, { timeoutMs, headers: apiHeaders(token) });
  let releaseHasNoTag = false;
  if (release.ok) {
    const data = isPlainObject(release.data) ? release.data : {};
    const tag = typeof data.tag_name === 'string' && data.tag_name.length > 0
      ? data.tag_name
      : (typeof data.name === 'string' && data.name.length > 0 ? data.name : undefined);
    if (tag !== undefined) {
      return {
        ok: true,
        version: tag.replace(/^v/u, ''),
        tag,
        payload: data,
        url: typeof data.html_url === 'string' ? data.html_url : releasesUrl,
      };
    }
    releaseHasNoTag = true;
    log('最新发布没有 tag_name，回退查询 tags');
  } else {
    log(`查询最新发布失败（${release.error}），回退查询 tags`);
  }
  const tagsUrl = `https://api.github.com/repos/${repo}/tags`;
  const tags = await safeFetchJson(fetchJsonImpl, tagsUrl, { timeoutMs, headers: apiHeaders(token) });
  if (tags.ok && Array.isArray(tags.data)) {
    const entry = tags.data.find((item) => typeof item?.name === 'string' && item.name.length > 0);
    if (entry !== undefined) {
      return {
        ok: true,
        version: entry.name.replace(/^v/u, ''),
        tag: entry.name,
        payload: {},
        url: tagsUrl,
      };
    }
  }
  if (releaseHasNoTag) return { ok: false, error: 'release-has-no-tag', url: releasesUrl };
  return { ok: false, error: 'download-unavailable', url: releasesUrl };
}

/** 根据文件头识别压缩格式，避免相信扩展名。 */
function sniffArchive(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return 'tar.gz';
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip';
  if (buffer.length >= 262 && buffer.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  return 'unknown';
}

/**
 * 通过 api.github.com 下载源码包。
 * 依次尝试 release 里的 tarball_url / zipball_url 和手工拼接的 API 地址；
 * fetch 跟随 302 后若 codeload 被重置，会继续尝试下一个候选。
 */
async function downloadArchive({ repo, tag, payload, fetchImpl, token, timeoutMs, tempRoot, log }) {
  const candidates = [];
  for (const key of ['tarball_url', 'zipball_url']) {
    const url = payload?.[key];
    if (typeof url === 'string' && url.startsWith('https://api.github.com/')) candidates.push(url);
  }
  candidates.push(`https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(tag)}`);
  candidates.push(`https://api.github.com/repos/${repo}/zipball/${encodeURIComponent(tag)}`);
  const urls = [...new Set(candidates)];
  let lastUrl = urls[0] ?? `https://api.github.com/repos/${repo}`;
  const timeout = Math.min(Math.max(timeoutMs * 4, 30_000), MAX_ARCHIVE_TIMEOUT_MS);
  for (const [index, url] of urls.entries()) {
    lastUrl = url;
    if (typeof fetchImpl !== 'function') break;
    try {
      log(`尝试下载源码包：${url}`);
      const init = {
        headers: apiHeaders(token, { accept: 'application/octet-stream' }),
        redirect: 'follow',
      };
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        init.signal = AbortSignal.timeout(timeout);
      }
      const response = await fetchImpl(url, init);
      if (!response || response.ok !== true) {
        log(`下载失败：HTTP ${response?.status ?? '无响应'}`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        log('下载失败：响应内容为空');
        continue;
      }
      const kind = sniffArchive(buffer);
      const suffix = kind === 'zip' ? 'zip' : (kind === 'tar' ? 'tar' : 'tar.gz');
      const archivePath = join(tempRoot, `source-${index}.${suffix}`);
      writeFileSync(archivePath, buffer);
      return { ok: true, path: archivePath, kind, url, bytes: buffer.length };
    } catch (error) {
      log(`下载失败：${errorText(error)}`);
    }
  }
  return { ok: false, error: 'download-unavailable', url: lastUrl };
}

/** 同步执行外部命令，返回 { ok } 或 { ok:false, error }。 */
function runCommand(command, args, timeout) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return { ok: false, error: errorText(result.error) };
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    return {
      ok: false,
      error: detail.length > 0 ? detail.slice(0, 400) : `退出码 ${String(result.status)}`,
    };
  }
  return { ok: true };
}

/** 用 Windows 自带的 PowerShell 解压 zip（tar 不可用时的兜底）。 */
function expandWithPowerShell(archivePath, extractDir) {
  const quote = (value) => `'${value.replace(/'/gu, "''")}'`;
  const script = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(extractDir)} -Force`;
  const candidates = [];
  if (typeof process.env.SystemRoot === 'string' && process.env.SystemRoot.length > 0) {
    candidates.push(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  }
  candidates.push('powershell.exe', 'pwsh');
  let lastError = 'PowerShell 不可用';
  for (const executable of [...new Set(candidates)]) {
    const result = runCommand(
      executable,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      MAX_ARCHIVE_TIMEOUT_MS,
    );
    if (result.ok) return result;
    lastError = result.error;
  }
  return { ok: false, error: lastError };
}

/** 清空目录内容但保留目录本身。 */
function cleanDirectory(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * 解压源码包：优先用 tar（Windows 自带 bsdtar、Linux/macOS 自带 tar），
 * zip 再兜底 PowerShell Expand-Archive 或 unzip。
 */
function extractArchive(archivePath, extractDir, log) {
  const kind = sniffArchive(readFileSync(archivePath));
  const tarArgs = kind === 'tar.gz'
    ? ['-xzf', archivePath, '-C', extractDir]
    : ['-xf', archivePath, '-C', extractDir];
  const attempts = [{ method: 'tar', run: () => runCommand('tar', tarArgs, MAX_ARCHIVE_TIMEOUT_MS) }];
  if (kind === 'zip' || kind === 'unknown') {
    if (process.platform === 'win32') {
      attempts.push({ method: 'powershell-expand-archive', run: () => expandWithPowerShell(archivePath, extractDir) });
    } else {
      attempts.push({ method: 'unzip', run: () => runCommand('unzip', ['-o', archivePath, '-d', extractDir], MAX_ARCHIVE_TIMEOUT_MS) });
    }
  }
  mkdirSync(extractDir, { recursive: true });
  let lastError = '没有可用的解压方式';
  for (const attempt of attempts) {
    cleanDirectory(extractDir);
    const result = attempt.run();
    if (result.ok) return { ok: true, method: attempt.method };
    lastError = result.error;
    log(`解压失败（${attempt.method}）：${result.error}`);
  }
  return { ok: false, error: lastError };
}

/** 只允许仓库内的相对路径，挡住绝对路径与 .. 穿越。 */
function isSafeRepoPath(path) {
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.includes('\\')) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * 逐层查找 package.json 且 name === "dsh-sunder" 的根目录。
 * 先检查给定目录，再按广度优先下探最多 4 层。
 */
function findPackageRoot(root) {
  const queue = [{ dir: root, depth: 0 }];
  const seen = [];
  while (queue.length > 0) {
    const current = queue.shift();
    const manifestPath = join(current.dir, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const name = typeof pkg?.name === 'string' ? pkg.name : undefined;
        if (name === INSTALL_PACKAGE_NAME) {
          return { ok: true, root: current.dir, version: typeof pkg.version === 'string' ? pkg.version : undefined };
        }
        seen.push({ name, dir: current.dir });
      } catch (error) {
        seen.push({ name: undefined, dir: current.dir, error: errorText(error) });
      }
    }
    if (current.depth >= 4) continue;
    let entries = [];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return { ok: false, actualName: seen[0]?.name, candidates: seen };
}

/** 递归收集文件相对路径，跳过 .git 与 node_modules。 */
function collectFiles(root, base = root, output = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, base, output);
    } else if (entry.isFile()) {
      output.push(relative(base, full).split(sep).join('/'));
    }
  }
  return output;
}

/** 把校验通过的源码目录覆盖写入安装目录，返回写入的文件列表。 */
function applySourceFiles(sourceRoot, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const targetBase = resolve(targetDir);
  const prefix = `${targetBase}${sep}`;
  const files = collectFiles(sourceRoot).sort();
  const written = [];
  for (const file of files) {
    const segments = file.split('/');
    const destination = resolve(targetBase, ...segments);
    if (destination !== targetBase && !destination.startsWith(prefix)) continue;
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(sourceRoot, ...segments), destination);
    written.push(file);
  }
  return written;
}

/**
 * 源码包下载全部失败时的兜底：用 GitHub contents API 逐文件取出仓库快照。
 * 只访问 api.github.com，适合 codeload 被网络策略重置的环境。
 */
async function materializeViaContentsApi({ repo, tag, version, fetchJsonImpl, token, timeoutMs, destDir, log }) {
  const refs = [...new Set([tag, version, `v${version}`].filter((ref) => typeof ref === 'string' && ref.length > 0))];
  let tree;
  for (const ref of refs) {
    const url = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const result = await safeFetchJson(fetchJsonImpl, url, { timeoutMs, headers: apiHeaders(token) });
    if (result.ok && isPlainObject(result.data) && Array.isArray(result.data.tree)) {
      tree = result.data;
      break;
    }
    log(`读取仓库树失败（${ref}）：${result.error ?? '响应格式不对'}`);
  }
  if (tree === undefined) return { ok: false, error: 'tree-unavailable' };
  if (tree.truncated === true) return { ok: false, error: 'tree-truncated' };
  const blobs = tree.tree.filter((entry) => entry?.type === 'blob'
    && typeof entry.path === 'string'
    && typeof entry.sha === 'string'
    && isSafeRepoPath(entry.path));
  if (blobs.length === 0) return { ok: false, error: 'empty-tree' };
  mkdirSync(destDir, { recursive: true });
  const failures = [];
  const concurrency = 4;
  for (let index = 0; index < blobs.length; index += concurrency) {
    const chunk = blobs.slice(index, index + concurrency);
    await Promise.all(chunk.map(async (entry) => {
      try {
        const url = `https://api.github.com/repos/${repo}/git/blobs/${entry.sha}`;
        const result = await safeFetchJson(fetchJsonImpl, url, { timeoutMs, headers: apiHeaders(token) });
        if (!result.ok || !isPlainObject(result.data) || typeof result.data.content !== 'string') {
          failures.push(entry.path);
          return;
        }
        const buffer = Buffer.from(result.data.content.replace(/\s+/gu, ''), 'base64');
        const destination = join(destDir, ...entry.path.split('/'));
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, buffer);
      } catch (error) {
        log(`写入临时文件失败（${entry.path}）：${errorText(error)}`);
        failures.push(entry.path);
      }
    }));
  }
  if (failures.length > 0) return { ok: false, error: 'incomplete-download', detail: failures.slice(0, 5) };
  return { ok: true, files: blobs.length };
}

/**
 * 应用最新版本：查询 release → 下载源码包 → 解压 → 校验包名 → 写入安装目录。
 *
 * 永不抛异常；失败时返回 { ok:false, error, ... }。
 * 只有解压结果里的 package.json.name === "dsh-sunder" 才会写 dir，
 * 因此下载到错误内容或半截文件时不会污染现有安装。
 *
 * @param {object} [options]
 * @param {string} [options.repo] GitHub 仓库，默认 DEFAULT_REPO
 * @param {string} [options.currentVersion] 当前版本（安装目录没有 package.json 时用于比较）
 * @param {string} options.dir 安装目录（必填）
 * @param {(url: string, init?: object) => Promise<{ ok:boolean, data?:unknown, error?:string }>} [options.fetchJsonImpl] 可注入的 JSON 请求实现
 * @param {number} [options.timeoutMs] API 超时（毫秒）
 * @param {boolean} [options.force] 即使版本不新也重新应用
 * @param {(url: string, init?: object) => Promise<Response>} [options.fetchImpl] 可注入的二进制下载实现
 * @param {() => string | undefined} [options.ghTokenImpl] 可注入的令牌获取实现（测试用）
 * @param {(message: string) => void} [options.log] 日志回调
 * @returns {Promise<{ ok:true, previous:string|null, version:string, method:string, files:string[] } | { ok:false, error:string, url?:string, detail?:unknown }>}
 */
export async function applyUpdate(options = {}) {
  try {
    return await applyUpdateUnsafe(options ?? {});
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function applyUpdateUnsafe(options) {
  const {
    repo = DEFAULT_REPO,
    currentVersion,
    dir,
    fetchJsonImpl = fetchJson,
    fetchImpl = (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined),
    timeoutMs = DEFAULT_UPDATE_TIMEOUT_MS,
    force = false,
    ghTokenImpl = resolveGhToken,
    log = () => {},
  } = options;

  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/u.test(repo)) {
    return { ok: false, error: 'invalid-repo' };
  }
  if (typeof dir !== 'string' || dir.trim().length === 0) {
    return { ok: false, error: 'invalid-dir' };
  }
  const targetDir = resolve(dir);
  const installed = readInstalledManifest(targetDir);
  if (installed.exists && installed.error !== undefined) {
    return { ok: false, error: 'invalid-install', detail: installed.error };
  }
  if (installed.name !== undefined && installed.name !== INSTALL_PACKAGE_NAME) {
    return { ok: false, error: 'not-a-sunder-install', actual: installed.name };
  }

  const previous = installed.version
    ?? (typeof currentVersion === 'string' && currentVersion.length > 0 ? currentVersion.replace(/^v/u, '') : undefined);
  const token = typeof ghTokenImpl === 'function' ? ghTokenImpl() : undefined;
  const release = await resolveLatestRelease({ repo, fetchJsonImpl, token, timeoutMs, log });
  if (!release.ok) return { ok: false, error: release.error, url: release.url };

  const { version, tag, payload } = release;
  const newer = force === true || previous === undefined || isNewer(version, previous);
  if (!newer) {
    log(`已是最新版本：${previous}（latest=${version}）`);
    return { ok: true, previous: previous ?? null, version, method: 'up-to-date', files: [] };
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-sunder-update-'));
  try {
    let sourceRoot;
    let method;
    let failure;
    const archive = await downloadArchive({ repo, tag, payload, fetchImpl, token, timeoutMs, tempRoot, log });
    if (archive.ok) {
      const extractDir = join(tempRoot, 'extract');
      const extracted = extractArchive(archive.path, extractDir, log);
      if (extracted.ok) {
        sourceRoot = extractDir;
        method = extracted.method;
      } else {
        failure = { error: 'extract-failed', url: archive.url, detail: extracted.error };
      }
    } else {
      failure = { error: archive.error, url: archive.url };
    }

    if (sourceRoot === undefined) {
      log('源码包不可用，尝试通过 GitHub contents API 逐文件获取');
      const materialized = await materializeViaContentsApi({
        repo,
        tag,
        version,
        fetchJsonImpl,
        token,
        timeoutMs,
        destDir: join(tempRoot, 'contents'),
        log,
      });
      if (materialized.ok) {
        sourceRoot = join(tempRoot, 'contents');
        method = 'contents-api';
      } else {
        log(`contents API 兜底也失败：${materialized.error}`);
        return {
          ok: false,
          error: failure?.error ?? 'download-unavailable',
          url: failure?.url ?? release.url,
          detail: failure?.detail ?? materialized.error,
        };
      }
    }

    // 关键安全闸门：写入目标目录之前先确认包名。
    const found = findPackageRoot(sourceRoot);
    if (!found.ok) {
      log(`源码包校验失败：package.json.name=${found.actualName ?? '(缺失)'}`);
      return {
        ok: false,
        error: 'package-name-mismatch',
        expected: INSTALL_PACKAGE_NAME,
        actual: found.actualName ?? null,
        url: release.url,
      };
    }
    if (typeof found.version === 'string' && found.version.length > 0 && found.version !== version) {
      log(`提示：源码包版本 ${found.version} 与 release ${version} 不一致，以源码包为准`);
    }

    const files = applySourceFiles(found.root, targetDir);
    log(`已应用 ${version}（${method}，${files.length} 个文件）到 ${targetDir}`);
    return { ok: true, previous: previous ?? null, version, method, files };
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响更新结果
    }
  }
}
