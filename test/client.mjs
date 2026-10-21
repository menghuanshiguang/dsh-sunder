/**
 * dsh-sunder 客户端半（lib/client.js）的离线契约测试。
 *
 * client.js 是浏览器脚本（IIFE），协议：
 *   window.__ModuleLoader__.load({ id: 'dsh-sunder', factory(require) => module.exports })
 * 本测试在 node:vm 里伪造 window / localStorage / navigator / React / fetch，真执行源码，验证：
 *   1. 没有模块加载器时静默退出；
 *   2. 加载器收到正确的 id 与 factory；
 *   3. 模块导出 apply（函数）与 inject（cordis 依赖数组，恰好 ['slots']）；
 *   4. apply 通过 ctx.slots.inject + register 注册设置页分区与公告横幅；
 *   5. 没有 slots 服务 / 桥探测抛错时 apply 与 refresh 都只降级不抛；
 *   6. 两个槽位组件拿到最小 props 也能渲染不抛（空 store 也不炸）；
 *   7. 桥接数据：pluginManager.listBundles 的版本、pluginInventory 的挂载态、公告未读数；
 *   8. 横幅关闭把 id 写进 localStorage 的 dsh-sunder.dismissed，且已关闭时不再渲染；
 *   9. 纯函数：版本比较、公告筛选（版本区间 / 已读 / 排序 / 条数上限）。
 *
 * Run: node test/client.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

let passed = 0;
let failed = 0;
const ok = (message) => {
  passed += 1;
  console.log(`ok   ${message}`);
};
const bad = (message, error) => {
  failed += 1;
  console.log(`FAIL ${message}`);
  if (error !== undefined) console.log(`     ${error?.message ?? error}`);
};
const test = (message, fn) => {
  try {
    fn();
    ok(message);
  } catch (error) {
    bad(message, error);
  }
};
const testAsync = async (message, fn) => {
  try {
    await fn();
    ok(message);
  } catch (error) {
    bad(message, error);
  }
};

// 任何被漏掉的 Promise 拒绝都算失败：客户端代码不允许把异步错误抛到全局。
const unhandled = [];
process.on('unhandledRejection', (error) => {
  unhandled.push(error);
});

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------
/** 最小 React 替身：createElement 返回普通对象，组件可以被直接调用渲染。 */
const makeReact = () => ({
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useRef: (initial) => ({ current: initial }),
});

/** 内存版 localStorage。 */
const makeStorage = (seed = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
    __dump: () => Object.fromEntries(map),
  };
};

const safeTimeout = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  if (typeof timer?.unref === 'function') timer.unref();
  return timer;
};

const DEFAULT_FEED = {
  announcements: [
    {
      id: 'a1',
      level: 'warn',
      date: '2026-10-21',
      title: { zh: '新公告', en: 'New announcement' },
      body: { zh: '客户端测试内容', en: 'client test body' },
      link: 'https://github.com/menghuanshiguang/dsh-sunder/releases',
    },
    {
      id: 'a0',
      level: 'info',
      date: '2026-09-01',
      title: { zh: '旧公告', en: 'Old announcement' },
      body: { zh: '旧内容', en: 'old body' },
      maxVersion: '0.9.0',
    },
  ],
};

const makeFetch = (routes = {}) => {
  const calls = [];
  const fetchStub = async (url) => {
    calls.push(String(url));
    const handler = routes[String(url)];
    if (typeof handler === 'function') return handler(url);
    if (handler === undefined) {
      if (String(url).includes('releases/latest')) {
        return { ok: true, status: 200, json: async () => ({ tag_name: 'v1.2.0', html_url: 'https://github.com/menghuanshiguang/dsh-sunder/releases/tag/v1.2.0' }) };
      }
      if (String(url).includes('announcements.json')) {
        return { ok: true, status: 200, json: async () => DEFAULT_FEED };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return handler;
  };
  fetchStub.calls = calls;
  return fetchStub;
};

/**
 * 造一个跑着 client.js 的 vm 环境。
 * @returns {{exports: object, spec: object, windowObject: object, storage: object, warnings: string[], context: object}}
 */
const loadModule = (options = {}) => {
  const windowObject = {};
  const warnings = [];
  const storage = options.storage ?? makeStorage();
  const sandbox = {
    window: windowObject,
    console: {
      warn: (...args) => warnings.push(args.map((item) => String(item)).join(' ')),
      error: () => {},
      info: () => {},
      log: () => {},
    },
    fetch: options.fetch ?? makeFetch(),
    AbortController: globalThis.AbortController,
    setTimeout: safeTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    JSON,
    Date,
    Promise,
    localStorage: storage,
    navigator: options.navigator ?? { language: 'zh-CN' },
  };
  const context = createContext(sandbox);
  sandbox.globalThis = sandbox;
  if (options.loader !== false) {
    runInContext('window.__ModuleLoader__ = { load(s) { window.__loaded = s; } };', context);
  }
  runInContext(source, context, { filename: 'lib/client.js' });
  const spec = windowObject.__loaded;
  const exports = spec ? spec.factory((name) => {
    if (name === 'react') return makeReact();
    throw new Error(`模块图里没有 ${name}`);
  }) : undefined;
  return { exports, spec, windowObject, storage, warnings, context, sandbox };
};

/** 遍历 React 替身产出的元素树，收集文本。 */
const textOf = (node) => {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') return textOf(node.children);
  return '';
};

/** 深度优先找第一个匹配的节点。 */
const findNode = (node, predicate) => {
  if (!node || typeof node !== 'object') return undefined;
  if (!Array.isArray(node) && predicate(node)) return node;
  const children = Array.isArray(node) ? node : node.children;
  if (!Array.isArray(children)) return undefined;
  for (const child of children) {
    const hit = findNode(child, predicate);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// 1. 没有 __ModuleLoader__ 时静默退出
// ---------------------------------------------------------------------------
test('没有模块加载器时静默退出', () => {
  const { windowObject } = loadModule({ loader: false });
  assert.equal(windowObject.__loaded, undefined);
  assert.equal(Object.keys(windowObject).length, 0);
});

// ---------------------------------------------------------------------------
// 2. 协议：load({ id, factory })
// ---------------------------------------------------------------------------
const base = loadModule();
const spec = base.spec;
const moduleExports = base.exports;

test('加载器收到一次 load 调用', () => {
  assert.ok(spec, 'window.__ModuleLoader__.load 没有被调用');
});

test('load 的 id 是 dsh-sunder', () => {
  assert.equal(spec.id, 'dsh-sunder');
});

test('load 的 factory 是函数', () => {
  assert.equal(typeof spec.factory, 'function');
});

// ---------------------------------------------------------------------------
// 3. 模块导出（cordis 客户端插件）
// ---------------------------------------------------------------------------
test('导出 apply 是函数', () => {
  assert.equal(typeof moduleExports.apply, 'function');
});

test("导出 inject 是依赖数组 ['slots']", () => {
  // 约定与 @deepseek-ai/dsh-client-ui-brand-official 等一致：inject 是 cordis 依赖名数组，
  // 不是函数——真正的注册动作在 apply(ctx) 里。
  assert.ok(Array.isArray(moduleExports.inject), 'inject 应当是数组');
  assert.deepEqual([...moduleExports.inject], ['slots']);
  assert.ok(moduleExports.inject.every((item) => typeof item === 'string'));
});

test('__internals 暴露纯函数与常量', () => {
  const internals = moduleExports.__internals ?? {};
  for (const key of ['refresh', 'getSnapshot', 'subscribe', 'selectAnnouncements', 'compareVersions', 'PACKAGE_NAME', 'KNOWN_SLOTS']) {
    assert.ok(internals[key] !== undefined, `__internals.${key} 缺失`);
  }
  assert.equal(internals.PACKAGE_NAME, 'dsh-sunder');
  assert.ok(internals.KNOWN_SLOTS.has('settings.section'));
  assert.ok(internals.KNOWN_SLOTS.has('shell.overlay'));
});

test('没有 require 到 react 之外的模块', () => {
  // factory 只允许 require('react')；这里用一个会记录名字的 require 重新跑一次 factory。
  const requested = [];
  const probe = loadModule();
  const exports = probe.spec.factory((name) => {
    requested.push(name);
    if (name === 'react') return makeReact();
    throw new Error(`模块图里没有 ${name}`);
  });
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(requested, ['react']);
});

// ---------------------------------------------------------------------------
// 4. apply：注册两个槽位
// ---------------------------------------------------------------------------
const buildSlotsCtx = () => {
  const injected = [];
  const registered = [];
  const ctx = {
    slots: {
      inject(name, callback) {
        injected.push(name);
        return callback();
      },
      register(options, Component) {
        registered.push({ options, Component });
        return { dispose() {} };
      },
    },
  };
  return { ctx, injected, registered };
};

const first = buildSlotsCtx();
test('apply 不抛错', () => {
  assert.doesNotThrow(() => moduleExports.apply(first.ctx));
});

test('apply 注入了 settings.section 与 shell.overlay', () => {
  assert.deepEqual(first.injected, ['settings.section', 'shell.overlay']);
});

test('设置页分区 id=sunder、order=60、带 label', () => {
  const entry = first.registered.find((item) => item.options.name === 'settings.section');
  assert.ok(entry, 'settings.section 未注册');
  assert.equal(entry.options.id, 'sunder');
  assert.equal(entry.options.order, 60);
  assert.equal(typeof entry.options.label, 'function');
  assert.equal(entry.options.label(), 'Sunder');
  assert.equal(typeof entry.Component, 'function');
});

test('公告横幅 id=sunder-notice、order=100', () => {
  const entry = first.registered.find((item) => item.options.name === 'shell.overlay');
  assert.ok(entry, 'shell.overlay 未注册');
  assert.equal(entry.options.id, 'sunder-notice');
  assert.equal(entry.options.order, 100);
  assert.equal(typeof entry.Component, 'function');
});

test('注册的槽位名都在已知目录内且没有告警', () => {
  const { KNOWN_SLOTS } = moduleExports.__internals;
  for (const name of first.injected) {
    assert.ok(KNOWN_SLOTS.has(name), `未收录的槽位：${name}`);
  }
  assert.deepEqual(base.warnings, [], `不应有 console.warn：${base.warnings.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// 5. 鲁棒性：缺服务、桥抛错、重复 apply
// ---------------------------------------------------------------------------
test('没有 slots 服务的 ctx 不抛错', () => {
  assert.doesNotThrow(() => moduleExports.apply({}));
  assert.doesNotThrow(() => moduleExports.apply({ slots: {} }));
  assert.doesNotThrow(() => moduleExports.apply(undefined));
});

test('重复 apply 不会抛错', () => {
  const repeat = buildSlotsCtx();
  assert.doesNotThrow(() => moduleExports.apply(repeat.ctx));
  assert.doesNotThrow(() => moduleExports.apply(repeat.ctx));
  assert.equal(repeat.injected.length, 4, '两次 apply 各自注册一次（去重由 cordis fiber 负责）');
});

test('ctx.get 抛错时只降级', () => {
  const hostile = buildSlotsCtx();
  hostile.ctx.get = () => {
    throw new Error('undeclared service');
  };
  assert.doesNotThrow(() => moduleExports.apply(hostile.ctx));
});

test('slots.inject 抛错时只 warn，不阻断后续槽位', () => {
  const warnings = [];
  let second = false;
  const ctx = {
    slots: {
      inject(name) {
        if (name === 'settings.section') throw new Error('unknown slot');
        second = true;
        return () => {};
      },
      register: () => ({ dispose() {} }),
    },
  };
  const script = moduleExports.apply;
  assert.doesNotThrow(() => script(ctx));
  assert.equal(second, true, '第二个槽位仍然被注入');
});

// ---------------------------------------------------------------------------
// 6. 数据层：remote 桥 + 公告 + 更新检查
// ---------------------------------------------------------------------------
const remoteCtx = (overrides = {}) => {
  const namespaces = {
    'remote.pluginManager': {
      listBundles: async () => ({
        ok: true,
        value: [
          { name: 'other-plugin', version: '0.0.1', availability: 'profile', enabled: false },
          {
            name: 'dsh-sunder',
            version: '1.0.1',
            availability: 'installation',
            enabled: true,
            installed: true,
          },
        ],
      }),
    },
    'remote.pluginInventory': {
      list: async () => ({
        ok: true,
        value: { entries: [{ entryId: 'sunder', moduleName: 'dsh-sunder', enabled: true, fiberPhase: 'active' }] },
      }),
    },
    ...overrides,
  };
  const { ctx, injected, registered } = buildSlotsCtx();
  ctx.get = (name) => namespaces[name];
  return { ctx, injected, registered, namespaces };
};

await testAsync('refresh 从 remote 桥读到版本与挂载状态', async () => {
  const fetchStub = makeFetch();
  const mod = loadModule({ fetch: fetchStub });
  const bridge = remoteCtx();
  mod.exports.apply(bridge.ctx);
  await mod.exports.__internals.refresh(bridge.ctx, { force: true });
  const snapshot = mod.exports.__internals.getSnapshot();
  assert.equal(snapshot.version, '1.0.1', '版本应来自 pluginManager.listBundles');
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.fiberPhase, 'active');
  assert.equal(snapshot.bridge.available, true);
  assert.equal(snapshot.busy, false);
  assert.ok(fetchStub.calls.some((url) => url.includes('announcements.json')), '应拉取公告源');
  assert.ok(fetchStub.calls.some((url) => url.includes('releases/latest')), '应检查最新 release');
  assert.equal(snapshot.update.latest, '1.2.0');
});

await testAsync('未读数按版本区间与已读集合计算', async () => {
  const mod = loadModule({});
  const bridge = remoteCtx();
  mod.exports.apply(bridge.ctx);
  await mod.exports.__internals.refresh(bridge.ctx, { force: true });
  const snapshot = mod.exports.__internals.getSnapshot();
  // a1 在版本区间内且未读；a0 的 maxVersion=0.9.0 被过滤掉。
  assert.equal(snapshot.announcements.length, 1, `期望 1 条，实际 ${snapshot.announcements.length}`);
  assert.equal(snapshot.announcements[0].id, 'a1');
  assert.equal(snapshot.unread, 1);
});

await testAsync('全部标记已读后未读归零', async () => {
  const storage = makeStorage({ 'dsh-sunder.acked': JSON.stringify({ ids: ['a1'], at: '2026-10-21T00:00:00.000Z' }) });
  const mod = loadModule({ storage });
  const bridge = remoteCtx();
  mod.exports.apply(bridge.ctx);
  await mod.exports.__internals.refresh(bridge.ctx, { force: true });
  const snapshot = mod.exports.__internals.getSnapshot();
  assert.equal(snapshot.unread, 0);
  assert.equal(snapshot.announcements[0].acknowledged, true);
});

await testAsync('fetch 失败时 refresh 只降级不抛', async () => {
  const failing = async () => {
    throw new Error('offline');
  };
  const mod = loadModule({ fetch: failing });
  mod.exports.apply({});
  let error;
  try {
    await mod.exports.__internals.refresh(null, { force: true });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error, undefined);
  const snapshot = mod.exports.__internals.getSnapshot();
  assert.equal(snapshot.busy, false);
  assert.ok(typeof snapshot.feedError === 'string' && snapshot.feedError.includes('offline'), `feedError=${snapshot.feedError}`);
  assert.ok(snapshot.update && typeof snapshot.update.error === 'string');
});

await testAsync('remote 信封 ok=false 时只记告警', async () => {
  const mod = loadModule({});
  const bridge = remoteCtx({
    'remote.pluginManager': {
      listBundles: async () => ({ ok: false, error: { code: 'denied', message: 'not permitted' } }),
    },
  });
  mod.exports.apply(bridge.ctx);
  await mod.exports.__internals.refresh(bridge.ctx, { force: true });
  const snapshot = mod.exports.__internals.getSnapshot();
  assert.equal(snapshot.version, null);
  assert.ok(typeof snapshot.warned === 'string' && snapshot.warned.includes('not permitted'), `warned=${snapshot.warned}`);
});

// ---------------------------------------------------------------------------
// 7. 渲染：组件拿到最小 props 不抛
// ---------------------------------------------------------------------------
test('设置页组件用空 store 渲染不抛', () => {
  const mod = loadModule({});
  const slots = buildSlotsCtx();
  mod.exports.apply(slots.ctx);
  const component = slots.registered.find((item) => item.options.name === 'settings.section').Component;
  assert.ok(component, '缺少 settings.section 组件');
  let tree;
  assert.doesNotThrow(() => {
    tree = component({});
  });
  const text = textOf(tree);
  assert.ok(text.includes('Sunder'), `渲染结果里没有标题：${text.slice(0, 120)}`);
  // 没有桥时应显示未知与降级提示。
  assert.ok(/未知|unknown/.test(text), '缺少"未知"降级文案');
  assert.ok(/未连上 host 桥|no host bridge/.test(text), '缺少"未连上 host 桥"提示');
});

test('横幅在 store 为空时返回 null', () => {
  const mod = loadModule({});
  const slots = buildSlotsCtx();
  mod.exports.apply(slots.ctx);
  const Component = slots.registered.find((item) => item.options.name === 'shell.overlay').Component;
  let tree;
  assert.doesNotThrow(() => {
    tree = Component({});
  });
  assert.equal(tree, null, '没有未读公告时横幅应为 null');
});

await testAsync('有未读公告时横幅渲染并能关闭（写 localStorage）', async () => {
  const storage = makeStorage();
  const mod = loadModule({ storage });
  const bridge = remoteCtx();
  mod.exports.apply(bridge.ctx);
  await mod.exports.__internals.refresh(bridge.ctx, { force: true });

  const banner = bridge.registered.find((item) => item.options.name === 'shell.overlay').Component;
  let tree;
  assert.doesNotThrow(() => {
    tree = banner({});
  });
  assert.ok(tree, '有未读公告时横幅不应为 null');
  const text = textOf(tree);
  assert.ok(text.includes('新公告'), `横幅里没有公告标题：${text.slice(0, 120)}`);

  const dismiss = findNode(tree, (node) => node.props && typeof node.props.onClick === 'function' && node.props['aria-label']);
  assert.ok(dismiss, '找不到关闭按钮');
  assert.doesNotThrow(() => dismiss.props.onClick());
  const raw = storage.getItem('dsh-sunder.dismissed');
  assert.ok(raw, '关闭后应写入 dsh-sunder.dismissed');
  const saved = JSON.parse(raw);
  assert.deepEqual(saved.ids, ['a1']);
});

await testAsync('已关闭的公告不再渲染横幅', async () => {
  const storage = makeStorage({ 'dsh-sunder.dismissed': JSON.stringify({ ids: ['a1'], at: '2026-10-21T00:00:00.000Z' }) });
  const mod = loadModule({ storage });
  const bridge = remoteCtx();
  mod.exports.apply(bridge.ctx);
  await mod.exports.__internals.refresh(bridge.ctx, { force: true });
  const banner = bridge.registered.find((item) => item.options.name === 'shell.overlay').Component;
  assert.equal(banner({}), null);
});

await testAsync('设置页组件在有数据时显示版本与新版本提示', async () => {
  const mod = loadModule({});
  const bridge = remoteCtx();
  mod.exports.apply(bridge.ctx);
  await mod.exports.__internals.refresh(bridge.ctx, { force: true });
  const section = bridge.registered.find((item) => item.options.name === 'settings.section').Component;
  const text = textOf(section({}));
  assert.ok(text.includes('1.0.1'), `缺少版本号：${text.slice(0, 200)}`);
  assert.ok(text.includes('1.2.0'), `缺少最新版本：${text.slice(0, 200)}`);
  assert.ok(/有新版本|update available/.test(text), '缺少"有新版本"提示');
  assert.ok(text.includes('已启用') || text.includes('enabled'), '缺少启用状态');
  assert.ok(text.includes('active'), '缺少挂载阶段');
});

// ---------------------------------------------------------------------------
// 8. 纯函数：版本与公告
// ---------------------------------------------------------------------------
const internals = moduleExports.__internals;

test('compareVersions 可比较版本', () => {
  assert.equal(typeof internals.compareVersions, 'function');
  assert.ok(internals.compareVersions('1.1.0', '1.0.1') > 0);
  assert.equal(internals.compareVersions('1.0.1', '1.0.1'), 0);
  assert.ok(internals.compareVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(internals.compareVersions('v2.0.0', '1.9.9') > 0);
});

test('selectAnnouncements 过滤版本区间、去重、排序并截断', () => {
  const entries = [
    { id: 'b', level: 'info', date: '2026-10-02', title: 'b', body: 'b' },
    { id: 'a', level: 'critical', date: '2026-10-02', title: 'a', body: 'a' },
    { id: 'old', level: 'info', date: '2026-10-03', title: 'old', body: 'old', maxVersion: '0.9.0' },
    { id: 'future', level: 'info', date: '2026-10-04', title: 'future', body: 'future', minVersion: '2.0.0' },
    { id: 'a', level: 'info', date: '2026-10-01', title: 'dup', body: 'dup' },
    { title: 'no id', body: 'x' },
    { id: 'nobody' },
  ];
  const selected = internals.selectAnnouncements(entries, { currentVersion: '1.0.1', acked: new Set(['b']), limit: 5 });
  // vm 里返回的数组与宿主的 Array 不同源，spread 一次转成宿主数组再比较。
  assert.deepEqual([...selected.map((item) => item.id)], ['a', 'b']);
  assert.equal(selected[0].level, 'critical', 'critical 在同日应排前');
  assert.equal(selected[1].acknowledged, true);
  const limited = internals.selectAnnouncements(entries, { currentVersion: '1.0.1', acked: new Set(), limit: 1 });
  assert.equal(limited.length, 1);
});

test('selectAnnouncements 在版本未知时不做区间过滤', () => {
  const entries = [
    { id: 'x', level: 'info', date: '2026-10-01', title: 'x', body: 'x', minVersion: '9.0.0' },
  ];
  const selected = internals.selectAnnouncements(entries, { currentVersion: null, acked: new Set(), limit: 5 });
  assert.equal(selected.length, 1);
});

test('subscribe/getSnapshot 成对可用', () => {
  let calls = 0;
  const unsubscribe = internals.subscribe(() => {
    calls += 1;
  });
  assert.equal(typeof unsubscribe, 'function');
  const snapshot = internals.getSnapshot();
  assert.equal(typeof snapshot, 'object');
  assert.ok('version' in snapshot);
  unsubscribe();
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
await new Promise((resolve) => setImmediate(resolve));

test('没有未处理的 Promise 拒绝', () => {
  assert.equal(unhandled.length, 0, unhandled.map((error) => error?.message ?? error).join(' | '));
});

console.log(`\nclient: ${failed === 0 ? 'OK' : `${failed} FAILURE(S)`} (${passed} passed)`);
process.exitCode = failed === 0 ? 0 : 1;
