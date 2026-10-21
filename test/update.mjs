#!/usr/bin/env node
/**
 * lib/update.js 里 applyUpdate 的离线测试。
 *
 * 不访问网络：release 查询、源码包下载、contents API 全部用 stub 注入。
 * 覆盖：参数校验、网络不可达、已是最新、manifest 损坏、写前包名校验、
 * contents API 成功落盘、tar 源码包成功与包名不匹配、永不抛异常。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyUpdate } from '../lib/update.js';

const REPO = 'menghuanshiguang/dsh-sunder';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
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

/** 包一层，applyUpdate 万一把异常抛出来也记成失败而不是中断整个测试。 */
async function run(options) {
  try {
    return await applyUpdate(options);
  } catch (error) {
    return { threw: true, error: error instanceof Error ? error.message : String(error) };
  }
}

function packageText(pkg) {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function writePackage(dir, pkg) {
  mkdirSync(dir, { recursive: true });
  const text = packageText(pkg);
  writeFileSync(join(dir, 'package.json'), text, 'utf8');
  return text;
}

function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function jsonResponse(data) {
  return { ok: true, data };
}

/** 模拟下载源码包成功的响应。 */
function bufferResponse(buffer) {
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

/** 所有请求都失败，模拟断网 / codeload 被重置。 */
async function offlineFetch() {
  throw new Error('测试环境不联网');
}

/** 依次匹配 URL 的 fetchJson stub；没匹配到就抛错，方便发现意外请求。 */
function routedFetchJson(routes) {
  return async (url) => {
    for (const [matcher, response] of routes) {
      if (typeof matcher === 'string' ? url === matcher : matcher.test(url)) return response;
    }
    throw new Error(`意外请求：${url}`);
  };
}

const noToken = () => undefined;
const noop = () => {};

/** 用系统 tar 打一个源码包；没有 tar 时返回 false，相关用例自动跳过。 */
function makeTar(sourceDir, archivePath) {
  const result = spawnSync('tar', ['-cf', archivePath, '-C', sourceDir, '.'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 && existsSync(archivePath);
}

const temp = mkdtempSync(join(tmpdir(), 'sunder-update-test-'));

try {
  // ---- 1. 参数校验：不抛异常，也不访问网络 ----
  const nullResult = await run(null);
  check(nullResult.threw !== true && nullResult.ok === false && nullResult.error === 'invalid-dir', '传 null 时返回 invalid-dir');
  const emptyResult = await run({});
  check(emptyResult.ok === false && emptyResult.error === 'invalid-dir', '缺 dir 时返回 invalid-dir');
  const badRepo = await run({ dir: temp, repo: 'not-a-repo', fetchJsonImpl: routedFetchJson([]), ghTokenImpl: noToken });
  check(badRepo.ok === false && badRepo.error === 'invalid-repo', '非法 repo 时返回 invalid-repo');

  // ---- 2. 安装目录里是别的包：直接拒绝，不发请求 ----
  const foreignDir = join(temp, 'target-foreign');
  const foreignText = writePackage(foreignDir, { name: 'some-other-plugin', version: '0.1.0' });
  let foreignRequests = 0;
  const foreign = await run({
    dir: foreignDir,
    currentVersion: '1.0.0',
    fetchJsonImpl: async () => {
      foreignRequests += 1;
      throw new Error('不应该发请求');
    },
    fetchImpl: offlineFetch,
    ghTokenImpl: noToken,
  });
  check(foreign.ok === false && foreign.error === 'not-a-sunder-install', '目标目录是别的包时拒绝更新');
  same(foreignRequests, 0, '拒绝时不访问网络');
  check(readFileSync(join(foreignDir, 'package.json'), 'utf8') === foreignText, '拒绝时不改写目标 package.json');

  // ---- 3. 网络不可达：返回 download-unavailable 与 url ----
  const emptyTarget = join(temp, 'target-empty');
  const unavailable = await run({
    dir: emptyTarget,
    currentVersion: '1.0.0',
    fetchJsonImpl: async () => {
      throw new Error('模拟断网');
    },
    fetchImpl: offlineFetch,
    ghTokenImpl: noToken,
  });
  check(unavailable.ok === false, '断网时返回 ok:false');
  check(unavailable.error === 'download-unavailable', '断网错误码是 download-unavailable', String(unavailable.error));
  check(typeof unavailable.url === 'string' && unavailable.url.startsWith('https://api.github.com/'), '断网时带 api.github.com url');
  check(!existsSync(emptyTarget), '失败时不会创建目标目录');

  // ---- 4. 已是最新：不下载、不写盘 ----
  const latestDir = join(temp, 'target-latest');
  const latestText = writePackage(latestDir, { name: 'dsh-sunder', version: '1.0.1' });
  let downloadCount = 0;
  const latest = await run({
    dir: latestDir,
    currentVersion: '1.0.1',
    fetchJsonImpl: routedFetchJson([[RELEASES_URL, jsonResponse({ tag_name: 'v1.0.1', html_url: 'https://github.com/x/y/releases/tag/v1.0.1' })]]),
    fetchImpl: async () => {
      downloadCount += 1;
      throw new Error('不应该下载');
    },
    ghTokenImpl: noToken,
  });
  check(latest.ok === true && latest.method === 'up-to-date', '相同版本返回 up-to-date');
  same(latest.previous, '1.0.1', 'up-to-date 返回当前版本');
  same(latest.files, [], 'up-to-date 不写文件');
  same(downloadCount, 0, 'up-to-date 不下载源码包');
  check(readFileSync(join(latestDir, 'package.json'), 'utf8') === latestText, 'up-to-date 不改写 package.json');

  // ---- 5. 损坏的 package.json：返回 invalid-install，不动文件 ----
  const brokenDir = join(temp, 'target-broken');
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, 'package.json'), '{"name": "dsh-sunder",', 'utf8');
  const broken = await run({
    dir: brokenDir,
    fetchJsonImpl: async () => {
      throw new Error('不应该发请求');
    },
    fetchImpl: offlineFetch,
    ghTokenImpl: noToken,
  });
  check(broken.ok === false && broken.error === 'invalid-install', 'manifest 损坏时返回 invalid-install');

  // ---- 6. 源码包（contents API 回退）包名不匹配：写前拦截 ----
  const mismatchDir = join(temp, 'target-mismatch');
  const mismatchText = writePackage(mismatchDir, { name: 'dsh-sunder', version: '1.0.0' });
  const treeUrl = `https://api.github.com/repos/${REPO}/git/trees/v2.0.0?recursive=1`;
  const mismatchFetchJson = routedFetchJson([
    [RELEASES_URL, jsonResponse({ tag_name: 'v2.0.0', html_url: 'https://github.com/x/y/releases/tag/v2.0.0' })],
    [treeUrl, jsonResponse({
      tree: [
        { path: 'package.json', type: 'blob', sha: 'pkg-evil' },
        { path: 'lib/evil.js', type: 'blob', sha: 'js-evil' },
      ],
    })],
    [/\/git\/blobs\/pkg-evil$/u, jsonResponse({ content: base64(packageText({ name: 'evil-package', version: '2.0.0' })) })],
    [/\/git\/blobs\/js-evil$/u, jsonResponse({ content: base64('// 不应该被写入\n') })],
  ]);
  const mismatch = await run({
    dir: mismatchDir,
    currentVersion: '1.0.0',
    fetchJsonImpl: mismatchFetchJson,
    fetchImpl: offlineFetch,
    ghTokenImpl: noToken,
    log: noop,
  });
  check(mismatch.ok === false, 'contents 回退包名错误时返回 ok:false');
  check(mismatch.error === 'package-name-mismatch', '包名错误返回 package-name-mismatch', String(mismatch.error));
  same(mismatch.actual, 'evil-package', '错误结果带上实际包名');
  check(readFileSync(join(mismatchDir, 'package.json'), 'utf8') === mismatchText, '包名错误时目标 package.json 未被改写');
  check(!existsSync(join(mismatchDir, 'lib', 'evil.js')), '包名错误时其他文件也没有落盘');
  check(!existsSync(join(mismatchDir, 'lib')), '包名错误时没有创建 lib 目录');

  // ---- 7. contents API 回退成功：校验通过后写入 ----
  const successDir = join(temp, 'target-success');
  writePackage(successDir, { name: 'dsh-sunder', version: '1.0.0' });
  writeFileSync(join(successDir, 'old-marker.txt'), '旧文件\n', 'utf8');
  const successTree = `https://api.github.com/repos/${REPO}/git/trees/v2.0.0?recursive=1`;
  const successFetchJson = routedFetchJson([
    [RELEASES_URL, jsonResponse({ tag_name: 'v2.0.0', html_url: 'https://github.com/x/y/releases/tag/v2.0.0' })],
    [successTree, jsonResponse({
      tree: [
        { path: 'package.json', type: 'blob', sha: 'pkg-ok' },
        { path: 'lib/update.js', type: 'blob', sha: 'lib-ok' },
        { path: 'README.md', type: 'blob', sha: 'readme-ok' },
      ],
    })],
    [/\/git\/blobs\/pkg-ok$/u, jsonResponse({ content: base64(packageText({ name: 'dsh-sunder', version: '2.0.0' })) })],
    [/\/git\/blobs\/lib-ok$/u, jsonResponse({ content: base64('export const version = "2.0.0";\n') })],
    [/\/git\/blobs\/readme-ok$/u, jsonResponse({ content: base64('# dsh-sunder 2.0.0\n') })],
  ]);
  const success = await run({
    dir: successDir,
    currentVersion: '1.0.0',
    fetchJsonImpl: successFetchJson,
    fetchImpl: offlineFetch,
    ghTokenImpl: noToken,
    log: noop,
  });
  check(success.ok === true, 'contents 回退成功返回 ok', success.error);
  same(success.previous, '1.0.0', '成功结果带上 previous');
  same(success.version, '2.0.0', '成功结果带上 version');
  same(success.method, 'contents-api', '成功结果标记 method=contents-api');
  same(success.files, ['README.md', 'lib/update.js', 'package.json'], '成功结果列出写入的文件');
  same(JSON.parse(readFileSync(join(successDir, 'package.json'), 'utf8')), { name: 'dsh-sunder', version: '2.0.0' }, '目标 package.json 已更新');
  check(readFileSync(join(successDir, 'lib', 'update.js'), 'utf8').includes('2.0.0'), '目标 lib/update.js 已更新');
  check(existsSync(join(successDir, 'old-marker.txt')), '只覆盖不清空旧文件');

  // ---- 8. tar 源码包：成功路径与包名不匹配路径 ----
  const tarAvailable = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
  if (!tarAvailable) {
    console.log('skip 未找到 tar，跳过源码包解压用例');
  } else {
    const goodSource = join(temp, 'archive-good');
    writePackage(goodSource, { name: 'dsh-sunder', version: '3.0.0' });
    mkdirSync(join(goodSource, 'lib'), { recursive: true });
    writeFileSync(join(goodSource, 'lib', 'a.js'), 'export const a = 1;\n', 'utf8');
    const goodArchive = join(temp, 'good.tar');
    check(makeTar(goodSource, goodArchive), '测试用 tar 源码包创建成功');

    if (existsSync(goodArchive)) {
      const goodBuffer = readFileSync(goodArchive);
      const goodTarUrl = `https://api.github.com/repos/${REPO}/tarball/v3.0.0`;
      const archiveDir = join(temp, 'target-archive');
      writePackage(archiveDir, { name: 'dsh-sunder', version: '2.0.0' });
      const archived = await run({
        dir: archiveDir,
        currentVersion: '2.0.0',
        fetchJsonImpl: routedFetchJson([[RELEASES_URL, jsonResponse({ tag_name: 'v3.0.0', tarball_url: goodTarUrl })]]),
        fetchImpl: async (url) => {
          if (url === goodTarUrl) return bufferResponse(goodBuffer);
          throw new Error(`意外下载：${url}`);
        },
        ghTokenImpl: noToken,
        log: noop,
      });
      check(archived.ok === true, 'tar 源码包更新成功', archived.error);
      same(archived.version, '3.0.0', 'tar 更新到最新版本');
      same(archived.method, 'tar', 'tar 路径 method=tar');
      check(archived.files.includes('package.json') && archived.files.includes('lib/a.js'), 'tar 路径写入文件清单');
      same(JSON.parse(readFileSync(join(archiveDir, 'package.json'), 'utf8')).version, '3.0.0', 'tar 路径目标版本已更新');
      check(readFileSync(join(archiveDir, 'lib', 'a.js'), 'utf8').includes('export const a'), 'tar 路径源码已落盘');
    }

    const evilSource = join(temp, 'archive-evil');
    writePackage(evilSource, { name: 'evil-package', version: '4.0.0' });
    writeFileSync(join(evilSource, 'evil.js'), 'console.log("evil");\n', 'utf8');
    const evilArchive = join(temp, 'evil.tar');
    check(makeTar(evilSource, evilArchive), '测试用错误包名 tar 创建成功');

    if (existsSync(evilArchive)) {
      const evilBuffer = readFileSync(evilArchive);
      const evilTarUrl = `https://api.github.com/repos/${REPO}/tarball/v4.0.0`;
      const evilDir = join(temp, 'target-archive-evil');
      const evilText = writePackage(evilDir, { name: 'dsh-sunder', version: '3.0.0' });
      const rejected = await run({
        dir: evilDir,
        currentVersion: '3.0.0',
        fetchJsonImpl: routedFetchJson([[RELEASES_URL, jsonResponse({ tag_name: 'v4.0.0', tarball_url: evilTarUrl })]]),
        fetchImpl: async (url) => {
          if (url === evilTarUrl) return bufferResponse(evilBuffer);
          throw new Error(`意外下载：${url}`);
        },
        ghTokenImpl: noToken,
        log: noop,
      });
      check(rejected.ok === false && rejected.error === 'package-name-mismatch', 'tar 包名错误时拒绝写入');
      same(rejected.actual, 'evil-package', 'tar 包名错误时报告实际包名');
      check(readFileSync(join(evilDir, 'package.json'), 'utf8') === evilText, 'tar 包名错误时目标未被改写');
      check(!existsSync(join(evilDir, 'evil.js')), 'tar 包名错误时恶意文件未落盘');
    }
  }

  // ---- 9. 任何异常都不外抛 ----
  const throwing = await run({
    dir: join(temp, 'target-throw'),
    fetchJsonImpl: () => {
      throw new Error('同步异常');
    },
    fetchImpl: offlineFetch,
    ghTokenImpl: () => {
      throw new Error('令牌异常');
    },
    log: noop,
  });
  check(throwing.threw !== true, '内部异常没有穿透 applyUpdate');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`update: ${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('update: OK');
}
