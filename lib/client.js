/**
 * dsh-sunder 客户端半（浏览器端）。
 *
 * 注册协议（由 DSH 的 client-modules 注入 window.__ModuleLoader__ 后调用）：
 *   window.__ModuleLoader__.load({ id, factory })
 *   factory(require) 返回模块导出，其中 apply / inject 构成一个 cordis 客户端插件。
 *
 * 纯 JS + React.createElement，不用 JSX、不用打包器；require 只解析模块图里已有的模块（react）。
 *
 * ── 数据来源与限制（重要，改代码前先读） ────────────────────────────────
 * 安装的客户端插件拿到的是真实的 cordis ctx，**没有** host.call / harness.handle
 * （那两个只在动态 cordis-client-runner 插件里有）。可用的 host 桥只有 remote 服务：
 *
 *   1) remote.pluginManager.listBundles()
 *      → 每个 bundle 一行，含 name / version / availability / enabled / installed / rows。
 *        这是**版本号**的来源（listPlugins / pluginInventory 都不带版本）。
 *   2) remote.pluginInventory.list()
 *      → entries: [{ entryId, moduleName, enabled, fiberPhase, meta? }]
 *        这是**运行时挂载状态**的来源（enabled + fiberPhase=active/failed/...）。
 *   3) remote.settings.describe()
 *      → namespaces: [{ ns, schema, value, ... }]，只有声明了 Config schema 的插件才会出现。
 *        本插件的 host 半（index.js）没有 `export const Config`，也没有 remote 贡献，
 *        所以 language / preset / guard 这些**配置值读不到**——卡片里显示"未知"并注明原因。
 *
 * 因此本文件的数据分两层：
 *   - 桥接层：版本、启用状态、挂载阶段（上面 1、2）。
 *   - 客户端自查：公告（直接拉 announcements.json，按 minVersion/maxVersion 过滤）
 *     与最新版本（api.github.com releases/latest）。这两项在卡片上标注"客户端检查"，
 *     与 host 侧 sunder_status 的口径可能不同（host 的已读记录在 %DSH_HOME%/sunder/state.json，
 *     浏览器读不到，所以客户端另用 localStorage 记录已读）。
 *
 * 任何探测失败都只降级显示，绝不阻断启动：注册全部包 try/catch，未知 slot/API 只 console.warn。
 */

(function registerSunderClient() {
  'use strict';

  if (typeof window === 'undefined') return;

  const loader = window.__ModuleLoader__;
  if (!loader || typeof loader.load !== 'function') {
    // 没有模块加载器说明不是在 DSH web 里跑（例如被 node 直接 import），静默退出即可。
    return;
  }

  loader.load({
    id: 'dsh-sunder',
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      // ---------------------------------------------------------------------
      // 0. React：模块图里的 React；取不到就用空实现兜底，保证插件仍然能被加载。
      // ---------------------------------------------------------------------
      let React;
      try {
        React = require('react');
      } catch (error) {
        React = null;
        console.warn('[dsh-sunder] 无法从模块图加载 react，界面降级为空渲染：', messageOf(error));
      }

      const h = React && typeof React.createElement === 'function'
        ? React.createElement
        : function emptyElement() { return null; };

      const useState = React && typeof React.useState === 'function'
        ? React.useState
        : function noState(initial) { return [typeof initial === 'function' ? initial() : initial, function noop() {}]; };
      const useEffect = React && typeof React.useEffect === 'function' ? React.useEffect : function noEffect() {};
      const useMemo = React && typeof React.useMemo === 'function' ? React.useMemo : function noMemo(factory) { return factory(); };
      const useCallback = React && typeof React.useCallback === 'function' ? React.useCallback : function noCallback(fn) { return fn; };

      // ---------------------------------------------------------------------
      // 1. 常量
      // ---------------------------------------------------------------------
      const PACKAGE_NAME = 'dsh-sunder';
      const REPO = 'menghuanshiguang/dsh-sunder';
      const REPO_URL = 'https://github.com/' + REPO;
      const RELEASES_URL = REPO_URL + '/releases';
      const RELEASE_API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
      // 与 host 侧 lib/announcements.js 的 FEED_URLS 对齐：canonical + 镜像。
      const FEED_URLS = [
        'https://raw.githubusercontent.com/' + REPO + '/main/announcements.json',
        'https://ghproxy.net/https://raw.githubusercontent.com/' + REPO + '/main/announcements.json',
      ];

      const KEY_ACKED = 'dsh-sunder.acked';
      const KEY_DISMISSED = 'dsh-sunder.dismissed';
      const KEY_CACHE = 'dsh-sunder.cache';

      const FEED_TTL_MS = 30 * 60 * 1000;
      const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
      const FETCH_TIMEOUT_MS = 8000;
      // 与宿主 announceLimit 默认值对齐（index.js DEFAULTS.announceLimit = 3）。
      const ANNOUNCE_LIMIT = 3;

      // ---------------------------------------------------------------------
      // 2. 小工具
      // ---------------------------------------------------------------------
      function messageOf(error) {
        if (error === undefined || error === null) return '未知错误';
        if (typeof error === 'string') return error;
        return error.message || String(error);
      }

      function safeStorage() {
        try {
          return typeof globalThis.localStorage === 'object' && globalThis.localStorage !== null
            ? globalThis.localStorage
            : null;
        } catch (error) {
          return null;
        }
      }

      function readJson(key, fallback) {
        const storage = safeStorage();
        if (!storage) return fallback;
        try {
          const raw = storage.getItem(key);
          if (raw === null || raw === undefined || raw === '') return fallback;
          const parsed = JSON.parse(raw);
          return parsed === null || parsed === undefined ? fallback : parsed;
        } catch (error) {
          return fallback;
        }
      }

      function writeJson(key, value) {
        const storage = safeStorage();
        if (!storage) return;
        try {
          storage.setItem(key, JSON.stringify(value));
        } catch (error) {
          // 隐私模式/配额满：忽略，界面照常工作。
        }
      }

      /** 读取一组 id：兼容 `["a","b"]` 与 `{ ids: [...], at }` 两种形状。 */
      function readIdSet(key) {
        const raw = readJson(key, []);
        const ids = Array.isArray(raw) ? raw : Array.isArray(raw.ids) ? raw.ids : [];
        return new Set(ids.filter((id) => typeof id === 'string' && id !== ''));
      }

      function writeIdSet(key, set) {
        const ids = [...set].sort();
        writeJson(key, { ids, at: new Date().toISOString() });
      }

      /** 轻量 semver 比较，够用于公告 minVersion/maxVersion 与"有没有新版本"。 */
      function parseVersion(value) {
        if (typeof value !== 'string') return undefined;
        const text = value.trim().replace(/^v/i, '');
        const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text);
        if (!match) return undefined;
        return {
          major: Number(match[1]),
          minor: Number(match[2]),
          patch: Number(match[3]),
          prerelease: match[4] ? match[4].split('.') : [],
        };
      }

      function compareVersions(left, right) {
        const a = parseVersion(left);
        const b = parseVersion(right);
        if (!a || !b) return 0;
        const head = [['major'], ['minor'], ['patch']];
        for (const [field] of head) {
          if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
        }
        if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
        if (a.prerelease.length === 0) return 1;
        if (b.prerelease.length === 0) return -1;
        const length = Math.max(a.prerelease.length, b.prerelease.length);
        for (let index = 0; index < length; index += 1) {
          const leftPart = a.prerelease[index];
          const rightPart = b.prerelease[index];
          if (leftPart === undefined) return -1;
          if (rightPart === undefined) return 1;
          const leftNumeric = /^\d+$/.test(leftPart);
          const rightNumeric = /^\d+$/.test(rightPart);
          if (leftNumeric && rightNumeric) {
            const delta = Number(leftPart) - Number(rightPart);
            if (delta !== 0) return delta < 0 ? -1 : 1;
          } else if (leftNumeric !== rightNumeric) {
            return leftNumeric ? -1 : 1;
          } else if (leftPart !== rightPart) {
            return leftPart < rightPart ? -1 : 1;
          }
        }
        return 0;
      }

      function isNewer(candidate, current) {
        if (typeof candidate !== 'string' || typeof current !== 'string') return false;
        return compareVersions(candidate, current) > 0;
      }

      async function fetchJson(url) {
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
        let timer;
        if (controller) {
          timer = setTimeout(() => {
            try { controller.abort(); } catch (error) { /* 忽略 */ }
          }, FETCH_TIMEOUT_MS);
        }
        try {
          const response = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: controller ? controller.signal : undefined,
          });
          if (!response || !response.ok) {
            throw new Error('HTTP ' + (response ? response.status : '?'));
          }
          return await response.json();
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }

      // ---------------------------------------------------------------------
      // 3. 文案（跟随界面语言：优先 locale 服务，其次 navigator.language）
      // ---------------------------------------------------------------------
      const TEXT = {
        zh: {
          title: 'Sunder',
          subtitle: '系统提示词分区 · 公告 · 版本自检',
          version: '版本',
          status: '状态',
          language: '语言',
          preset: '预设',
          guard: 'guard',
          unread: '未读公告',
          update: '最近更新检查',
          latest: '最新版本',
          repo: '仓库',
          releases: 'Release 页',
          refresh: '刷新',
          markRead: '全部标记已读',
          unknown: '未知',
          checking: '检查中…',
          notChecked: '尚未检查',
          noBridge: '未连上 host 桥，以下为静态信息',
          unreadClientNote: '客户端口径（浏览器 localStorage 记录已读）',
          configLimit: 'host 侧未暴露配置（index.js 无 Config/remote），配置值读不到',
          updateNote: '客户端直接查 GitHub',
          bannerTitle: 'Sunder 有新公告',
          bannerMore: (count) => `共 ${count} 条未读`,
          dismiss: '关闭',
          enabled: '已启用',
          disabled: '已停用',
          phase: '挂载',
          yes: '开启',
          no: '关闭',
          newVersion: '有新版本',
          upToDate: '已是最新',
          error: '失败',
        },
        en: {
          title: 'Sunder',
          subtitle: 'system-prompt sections · announcements · version check',
          version: 'Version',
          status: 'Status',
          language: 'Language',
          preset: 'Preset',
          guard: 'Guard',
          unread: 'Unread',
          update: 'Last update check',
          latest: 'Latest',
          repo: 'Repository',
          releases: 'Releases',
          refresh: 'Refresh',
          markRead: 'Mark all read',
          unknown: 'unknown',
          checking: 'checking…',
          notChecked: 'not checked yet',
          noBridge: 'no host bridge — showing static data',
          unreadClientNote: 'client-side count (read ids kept in localStorage)',
          configLimit: 'host does not expose config (no Config/remote in index.js)',
          updateNote: 'queried from the client',
          bannerTitle: 'Sunder has new announcements',
          bannerMore: (count) => `${count} unread`,
          dismiss: 'Dismiss',
          enabled: 'enabled',
          disabled: 'disabled',
          phase: 'phase',
          yes: 'on',
          no: 'off',
          newVersion: 'update available',
          upToDate: 'up to date',
          error: 'failed',
        },
      };

      function detectLanguage(ctx) {
        let locale;
        try {
          const service = typeof ctx?.get === 'function' ? ctx.get('locale') : undefined;
          const snapshot = service && typeof service.getSnapshot === 'function' ? service.getSnapshot() : undefined;
          if (typeof snapshot === 'string') locale = snapshot;
          else if (snapshot && typeof snapshot.locale === 'string') locale = snapshot.locale;
        } catch (error) {
          locale = undefined;
        }
        if (!locale) {
          try {
            locale = globalThis.navigator && typeof globalThis.navigator.language === 'string'
              ? globalThis.navigator.language
              : '';
          } catch (error) {
            locale = '';
          }
        }
        return typeof locale === 'string' && /^zh/i.test(locale) ? 'zh' : 'en';
      }

      // ---------------------------------------------------------------------
      // 4. 公告：拉取 + 过滤（与 host 侧 selectAnnouncements 行为对齐的客户端子集）
      // ---------------------------------------------------------------------
      function pickLocaleText(value, lang) {
        if (typeof value === 'string') return value;
        if (!value || typeof value !== 'object') return '';
        const preferred = value[lang];
        if (typeof preferred === 'string' && preferred.trim() !== '') return preferred;
        const other = lang === 'zh' ? value.en : value.zh;
        return typeof other === 'string' ? other : '';
      }

      function normalizeAnnouncement(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
        if (typeof raw.id !== 'string' || raw.id === '') return undefined;
        if (typeof raw.body !== 'string' && (typeof raw.body !== 'object' || raw.body === null)) return undefined;
        const level = raw.level === 'warn' || raw.level === 'critical' ? raw.level : 'info';
        return {
          id: raw.id,
          level,
          date: typeof raw.date === 'string' ? raw.date : '',
          title: raw.title === undefined ? undefined : raw.title,
          body: raw.body,
          link: typeof raw.link === 'string' ? raw.link : undefined,
          minVersion: typeof raw.minVersion === 'string' ? raw.minVersion : undefined,
          maxVersion: typeof raw.maxVersion === 'string' ? raw.maxVersion : undefined,
        };
      }

      function decodeFeed(payload) {
        let value = payload;
        if (typeof value === 'string') {
          try { value = JSON.parse(value); } catch (error) { return []; }
        }
        // GitHub contents API：{ content: base64 }
        if (value && typeof value === 'object' && typeof value.content === 'string' && !Array.isArray(value.content)) {
          try {
            const decoded = typeof atob === 'function' ? atob(value.content.replace(/\s/g, '')) : '';
            if (decoded !== '') value = JSON.parse(decoded);
          } catch (error) {
            return [];
          }
        }
        if (Array.isArray(value)) return value;
        if (value && Array.isArray(value.announcements)) return value.announcements;
        return [];
      }

      function selectAnnouncements(entries, options) {
        const currentVersion = options.currentVersion;
        const acked = options.acked || new Set();
        const selected = [];
        const seen = new Set();
        for (const raw of entries) {
          const item = normalizeAnnouncement(raw);
          if (!item) continue;
          if (seen.has(item.id)) continue;
          if (typeof currentVersion === 'string') {
            if (item.minVersion && compareVersions(currentVersion, item.minVersion) < 0) continue;
            if (item.maxVersion && compareVersions(currentVersion, item.maxVersion) > 0) continue;
          }
          seen.add(item.id);
          selected.push({ ...item, acknowledged: acked.has(item.id) });
        }
        selected.sort((left, right) => {
          const byDate = String(right.date).localeCompare(String(left.date));
          if (byDate !== 0) return byDate;
          const rank = { critical: 0, warn: 1, info: 2 };
          return rank[left.level] - rank[right.level];
        });
        return selected.slice(0, options.limit || ANNOUNCE_LIMIT);
      }

      async function loadFeed(force) {
        const cache = readJson(KEY_CACHE, {});
        const cached = cache.feed;
        if (!force && cached && typeof cached.at === 'string') {
          const age = Date.now() - Date.parse(cached.at);
          if (Number.isFinite(age) && age >= 0 && age < FEED_TTL_MS && Array.isArray(cached.raw)) {
            return { raw: cached.raw, fetchedAt: cached.at, fromCache: true };
          }
        }
        let lastError = '所有公告源都失败';
        for (const url of FEED_URLS) {
          try {
            const payload = await fetchJson(url);
            const raw = decodeFeed(payload).filter((item) => normalizeAnnouncement(item) !== undefined);
            const fetchedAt = new Date().toISOString();
            const next = { ...readJson(KEY_CACHE, {}), feed: { at: fetchedAt, raw } };
            writeJson(KEY_CACHE, next);
            return { raw, fetchedAt, fromCache: false };
          } catch (error) {
            lastError = messageOf(error);
          }
        }
        throw new Error(lastError);
      }

      async function loadUpdate(force) {
        const cache = readJson(KEY_CACHE, {});
        const cached = cache.update;
        if (!force && cached && typeof cached.checkedAt === 'string') {
          const age = Date.now() - Date.parse(cached.checkedAt);
          if (Number.isFinite(age) && age >= 0 && age < UPDATE_TTL_MS) return cached;
        }
        try {
          const payload = await fetchJson(RELEASE_API);
          const value = {
            checkedAt: new Date().toISOString(),
            latest: typeof payload?.tag_name === 'string' ? payload.tag_name.replace(/^v/i, '') : undefined,
            url: typeof payload?.html_url === 'string' ? payload.html_url : undefined,
          };
          writeJson(KEY_CACHE, { ...readJson(KEY_CACHE, {}), update: value });
          return value;
        } catch (error) {
          const value = { checkedAt: new Date().toISOString(), error: messageOf(error) };
          writeJson(KEY_CACHE, { ...readJson(KEY_CACHE, {}), update: value });
          return value;
        }
      }

      // ---------------------------------------------------------------------
      // 5. host 桥探测（remote 服务；缺服务时全部降级）
      // ---------------------------------------------------------------------
      function getService(ctx, name) {
        if (!ctx || typeof ctx.get !== 'function') return undefined;
        try {
          return ctx.get(name);
        } catch (error) {
          return undefined;
        }
      }

      /** remote 命名空间：先按点号全名取服务，再退回 remote 服务上的属性。 */
      function getRemoteNamespace(ctx, name) {
        const direct = getService(ctx, 'remote.' + name);
        if (direct) return direct;
        const remote = getService(ctx, 'remote');
        if (!remote) return undefined;
        try {
          const nested = remote[name];
          if (nested) return nested;
        } catch (error) {
          /* 未声明的服务属性访问会抛，忽略 */
        }
        return undefined;
      }

      /** 解开 {ok,value} / {ok:false,error} 信封。 */
      function unwrap(result) {
        if (!result || typeof result !== 'object') throw new Error('remote 返回非对象');
        if (result.ok !== true) {
          const error = result.error || {};
          throw new Error(error.message || error.code || 'remote 调用失败');
        }
        return result.value;
      }

      async function probeBundle(ctx) {
        const namespace = getRemoteNamespace(ctx, 'pluginManager');
        if (!namespace || typeof namespace.listBundles !== 'function') {
          return { available: false };
        }
        const rows = unwrap(await namespace.listBundles());
        const list = Array.isArray(rows) ? rows : [];
        const row = list.find((item) => item && item.name === PACKAGE_NAME);
        if (!row) return { available: true, found: false };
        return {
          available: true,
          found: true,
          version: typeof row.version === 'string' ? row.version : null,
          availability: typeof row.availability === 'string' ? row.availability : null,
          enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
          installed: typeof row.installed === 'boolean' ? row.installed : null,
        };
      }

      async function probeInventory(ctx) {
        const namespace = getRemoteNamespace(ctx, 'pluginInventory');
        if (!namespace || typeof namespace.list !== 'function') {
          return { available: false };
        }
        const value = unwrap(await namespace.list());
        const entries = value && Array.isArray(value.entries) ? value.entries : [];
        const row = entries.find((item) => item && (item.moduleName === PACKAGE_NAME
          || (item.meta && typeof item.meta === 'object' && typeof item.meta.title === 'string' && /sunder/i.test(item.meta.title))));
        if (!row) return { available: true, found: false };
        return {
          available: true,
          found: true,
          enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
          fiberPhase: typeof row.fiberPhase === 'string' ? row.fiberPhase : null,
        };
      }

      /**
       * settings.describe 只包含声明了 Config schema 的插件。
       * 本插件 host 半没有 Config，所以这里通常拿不到东西——保留探测是为了 host 侧将来补齐后自动生效。
       */
      async function probeSettings(ctx) {
        const namespace = getRemoteNamespace(ctx, 'settings');
        if (!namespace || typeof namespace.describe !== 'function') {
          return { available: false };
        }
        const value = unwrap(await namespace.describe());
        const namespaces = value && Array.isArray(value.namespaces) ? value.namespaces : [];
        const row = namespaces.find((item) => item && typeof item.ns === 'string' && /sunder/i.test(item.ns));
        if (!row) return { available: true, found: false };
        const config = row.value && typeof row.value === 'object' ? row.value : {};
        return {
          available: true,
          found: true,
          language: typeof config.language === 'string' ? config.language : null,
          preset: typeof config.preset === 'string' ? config.preset : null,
          guard: typeof config.guard === 'boolean' ? config.guard : null,
        };
      }

      // ---------------------------------------------------------------------
      // 6. 共享 store（卡片与横幅共用一次探测结果）
      // ---------------------------------------------------------------------
      const INITIAL_STATE = {
        lang: 'en',
        busy: false,
        probeAt: null,
        bridge: { available: false },
        version: null,
        availability: null,
        enabled: null,
        fiberPhase: null,
        installed: null,
        language: null,
        preset: null,
        guard: null,
        announcements: [],
        unread: null,
        feedError: null,
        update: null,
        warned: null,
      };

      let state = INITIAL_STATE;
      const listeners = new Set();
      let ctxRef = null;

      function getSnapshot() {
        return state;
      }

      function subscribe(listener) {
        if (typeof listener !== 'function') return function noop() {};
        listeners.add(listener);
        return function unsubscribe() {
          listeners.delete(listener);
        };
      }

      function patch(partial) {
        state = { ...state, ...partial };
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            console.warn('[dsh-sunder] 订阅回调异常：', messageOf(error));
          }
        }
      }

      function useStore() {
        const [snapshot, setSnapshot] = useState(getSnapshot);
        useEffect(() => subscribe(() => setSnapshot(getSnapshot())), []);
        return snapshot;
      }

      // ---------------------------------------------------------------------
      // 7. 刷新流程：每一步单独 try/catch，任何一步失败都不影响其余内容
      // ---------------------------------------------------------------------
      let refreshInFlight = null;

      function refresh(ctx, options) {
        const force = Boolean(options && options.force);
        if (refreshInFlight) return refreshInFlight;
        if (ctx) ctxRef = ctx;
        const target = ctxRef;
        patch({ busy: true });
        refreshInFlight = (async () => {
          const partial = { lang: detectLanguage(target) };
          const warnings = [];

          try {
            const bundle = await probeBundle(target);
            partial.bridge = { available: Boolean(bundle.available) };
            if (bundle.found) {
              partial.version = bundle.version ?? null;
              partial.availability = bundle.availability ?? null;
              partial.enabled = bundle.enabled ?? null;
              partial.installed = bundle.installed ?? null;
            }
          } catch (error) {
            warnings.push('pluginManager: ' + messageOf(error));
          }

          try {
            const inventory = await probeInventory(target);
            if (inventory.found) {
              partial.enabled = inventory.enabled ?? partial.enabled ?? null;
              partial.fiberPhase = inventory.fiberPhase ?? null;
            }
          } catch (error) {
            warnings.push('pluginInventory: ' + messageOf(error));
          }

          try {
            const settings = await probeSettings(target);
            if (settings.found) {
              partial.language = settings.language ?? null;
              partial.preset = settings.preset ?? null;
              partial.guard = settings.guard ?? null;
            }
          } catch (error) {
            // settings.describe 常驻失败是预期行为（本插件没有 Config），不当作告警。
          }

          try {
            const feed = await loadFeed(force);
            const acked = readIdSet(KEY_ACKED);
            const selected = selectAnnouncements(feed.raw, {
              currentVersion: partial.version ?? state.version,
              acked,
              limit: ANNOUNCE_LIMIT,
            });
            partial.announcements = selected;
            partial.unread = selected.filter((item) => !item.acknowledged).length;
            partial.feedAt = feed.fetchedAt;
            partial.feedError = null;
          } catch (error) {
            partial.announcements = state.announcements;
            partial.feedError = messageOf(error);
          }

          try {
            partial.update = await loadUpdate(force);
          } catch (error) {
            partial.update = { checkedAt: new Date().toISOString(), error: messageOf(error) };
          }

          partial.busy = false;
          partial.probeAt = new Date().toISOString();
          partial.warned = warnings.length > 0 ? warnings.join('；') : null;
          patch(partial);
          return getSnapshot();
        })()
          .catch((error) => {
            patch({ busy: false, warned: messageOf(error) });
            return getSnapshot();
          })
          .finally(() => {
            refreshInFlight = null;
          });
        return refreshInFlight;
      }

      // ---------------------------------------------------------------------
      // 8. 界面小件
      // ---------------------------------------------------------------------
      const styles = {
        card: {
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
          padding: '4px 2px 8px',
          color: 'var(--dsh-text-primary, inherit)',
          font: 'inherit',
        },
        header: { display: 'flex', flexDirection: 'column', gap: '4px' },
        heading: { margin: 0, fontSize: '15px', fontWeight: 600 },
        hint: { margin: 0, fontSize: '12px', opacity: 0.7 },
        rows: {
          display: 'grid',
          gridTemplateColumns: 'minmax(96px, max-content) 1fr',
          rowGap: '8px',
          columnGap: '16px',
          alignItems: 'baseline',
          fontSize: '13px',
        },
        key: { opacity: 0.65 },
        value: { wordBreak: 'break-word' },
        actions: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
        button: {
          padding: '4px 10px',
          borderRadius: '6px',
          border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: '12px',
          cursor: 'pointer',
        },
        link: { color: 'var(--dsh-link, #3b82f6)', textDecoration: 'none' },
        warn: { fontSize: '12px', color: 'var(--dsh-warning, #b45309)' },
        banner: {
          position: 'fixed',
          right: '16px',
          bottom: '16px',
          zIndex: 60,
          maxWidth: '360px',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '10px',
          padding: '10px 12px',
          borderRadius: '10px',
          border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
          background: 'var(--dsh-surface, rgba(24,24,27,0.94))',
          color: 'var(--dsh-text-primary, #f4f4f5)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
          fontSize: '12.5px',
          lineHeight: '1.5',
          // 层本身是 click-through 的，条目要自己把指针事件要回来。
          pointerEvents: 'auto',
        },
        bannerBody: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 auto' },
        bannerTitle: { fontWeight: 600 },
        close: {
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: '14px',
          lineHeight: '1',
          padding: '2px 4px',
          opacity: 0.65,
        },
      };

      function Row(props) {
        return h(
          'div',
          { style: styles.key },
          props.label,
          h('div', { style: { ...styles.value, gridColumn: '2' } }, props.children),
        );
      }

      function ValueRow(props) {
        return [
          h('div', { key: 'k', style: styles.key }, props.label),
          h('div', { key: 'v', style: styles.value }, props.children),
        ];
      }

      function ExternalLink(props) {
        return h(
          'a',
          { href: props.href, target: '_blank', rel: 'noreferrer noopener', style: styles.link },
          props.text,
        );
      }

      function formatTime(iso) {
        if (typeof iso !== 'string' || iso === '') return '';
        const time = Date.parse(iso);
        if (!Number.isFinite(time)) return iso;
        try {
          return new Date(time).toLocaleString();
        } catch (error) {
          return iso;
        }
      }

      function announcementText(item, lang) {
        if (!item) return '';
        const title = pickLocaleText(item.title, lang);
        const body = pickLocaleText(item.body, lang);
        return title || body || item.id;
      }

      function SunderSection() {
        const snapshot = useStore();
        const lang = snapshot.lang;
        const t = TEXT[lang] || TEXT.en;
        const onRefresh = useCallback(() => {
          void refresh(ctxRef, { force: true });
        }, []);
        const onMarkRead = useCallback(() => {
          const acked = readIdSet(KEY_ACKED);
          for (const item of snapshot.announcements) acked.add(item.id);
          writeIdSet(KEY_ACKED, acked);
          const dismissed = readIdSet(KEY_DISMISSED);
          for (const item of snapshot.announcements) dismissed.add(item.id);
          writeIdSet(KEY_DISMISSED, dismissed);
          patch({
            announcements: snapshot.announcements.map((item) => ({ ...item, acknowledged: true })),
            unread: 0,
          });
        }, [snapshot.announcements]);

        const version = snapshot.version;
        const statusText = snapshot.enabled === null && snapshot.fiberPhase === null
          ? t.unknown
          : [
            snapshot.enabled === null ? '' : snapshot.enabled ? t.enabled : t.disabled,
            snapshot.fiberPhase ? t.phase + '=' + snapshot.fiberPhase : '',
          ].filter(Boolean).join(' · ');

        const update = snapshot.update;
        let updateText;
        if (!update) updateText = snapshot.busy ? t.checking : t.notChecked;
        else if (update.error) updateText = t.error + '：' + update.error;
        else updateText = formatTime(update.checkedAt);

        const latest = update && update.latest ? update.latest : null;
        const newer = latest && version ? isNewer(latest, version) : false;

        const rows = [
          ValueRow({ key: 'version', label: t.version, children: version ? 'v' + version : t.unknown }),
          ValueRow({ key: 'status', label: t.status, children: statusText }),
          ValueRow({
            key: 'language',
            label: t.language,
            children: snapshot.language ? snapshot.language : t.unknown,
          }),
          ValueRow({
            key: 'guard',
            label: t.guard,
            children: snapshot.guard === null ? t.unknown : snapshot.guard ? t.yes : t.no,
          }),
          ValueRow({
            key: 'unread',
            label: t.unread,
            children: snapshot.unread === null
              ? t.unknown
              : String(snapshot.unread) + (snapshot.unread > 0 ? ' · ' + t.unreadClientNote : ''),
          }),
          ValueRow({
            key: 'update',
            label: t.update,
            children: updateText + (latest ? ' · ' + t.latest + ' v' + latest : ''),
          }),
          ValueRow({
            key: 'latest',
            label: t.latest,
            children: latest
              ? [
                'v' + latest,
                newer ? ' · ' + t.newVersion : ' · ' + t.upToDate,
                h('span', { key: 'note', style: { opacity: 0.6 } }, '（' + t.updateNote + '）'),
              ]
              : t.unknown,
          }),
          ValueRow({
            key: 'repo',
            label: t.repo,
            children: h(ExternalLink, { href: REPO_URL, text: REPO }),
          }),
          ValueRow({
            key: 'releases',
            label: t.releases,
            children: h(ExternalLink, { href: RELEASES_URL, text: RELEASES_URL.replace('https://', '') }),
          }),
        ];

        const notices = snapshot.announcements.slice(0, 3).map((item) => h(
          'li',
          { key: item.id, style: { marginBottom: '4px' } },
          h('strong', {}, announcementText(item, lang)),
          item.link ? h('span', {}, ' · ', h(ExternalLink, { href: item.link, text: 'link' })) : null,
          item.acknowledged ? h('span', { style: { opacity: 0.6 } }, '（已读）') : null,
        ));

        return h(
          'div',
          { style: styles.card, 'data-dsh-sunder': 'settings' },
          h(
            'div',
            { style: styles.header },
            h('h3', { style: styles.heading }, t.title),
            h('p', { style: styles.hint }, t.subtitle),
            snapshot.bridge.available ? null : h('p', { style: styles.warn }, t.noBridge),
            snapshot.guard === null ? h('p', { style: styles.hint }, t.configLimit) : null,
          ),
          h('div', { style: styles.rows }, rows),
          notices.length > 0 ? h('div', {}, h('div', { style: styles.hint }, t.unread), h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, notices)) : null,
          h(
            'div',
            { style: styles.actions },
            h('button', { type: 'button', style: styles.button, onClick: onRefresh, disabled: snapshot.busy }, t.refresh),
            snapshot.unread && snapshot.unread > 0
              ? h('button', { type: 'button', style: styles.button, onClick: onMarkRead }, t.markRead)
              : null,
          ),
          snapshot.feedError ? h('p', { style: styles.warn }, '公告源：' + snapshot.feedError) : null,
          snapshot.warned ? h('p', { style: styles.warn }, 'host 桥：' + snapshot.warned) : null,
        );
      }

      function SunderBanner() {
        const snapshot = useStore();
        const lang = snapshot.lang;
        const t = TEXT[lang] || TEXT.en;
        const [dismissedIds, setDismissedIds] = useState(() => readIdSet(KEY_DISMISSED));
        useEffect(() => {
          setDismissedIds(readIdSet(KEY_DISMISSED));
        }, [snapshot.announcements]);

        const unread = snapshot.announcements.filter((item) => !item.acknowledged);
        if (unread.length === 0) return null;
        if (unread.every((item) => dismissedIds.has(item.id))) return null;

        const top = unread[0];
        const onDismiss = function onDismiss() {
          const next = readIdSet(KEY_DISMISSED);
          for (const item of unread) next.add(item.id);
          writeIdSet(KEY_DISMISSED, next);
          setDismissedIds(next);
        };

        return h(
          'div',
          { style: styles.banner, role: 'status', 'data-dsh-sunder': 'banner' },
          h(
            'div',
            { style: styles.bannerBody },
            h('span', { style: styles.bannerTitle }, t.bannerTitle),
            h('span', {}, announcementText(top, lang)),
            unread.length > 1 ? h('span', { style: { opacity: 0.7 } }, t.bannerMore(unread.length)) : null,
            top.link ? h(ExternalLink, { href: top.link, text: 'link' }) : null,
          ),
          h(
            'button',
            { type: 'button', style: styles.close, onClick: onDismiss, title: t.dismiss, 'aria-label': t.dismiss },
            '×',
          ),
        );
      }

      // ---------------------------------------------------------------------
      // 9. 注册（全部 try/catch；未知 slot/API 只 warn）
      // ---------------------------------------------------------------------
      /** 合法的 slot 名白名单：只用于本地防护与测试断言，未知名字仍会尝试注册并 warn。 */
      const KNOWN_SLOTS = new Set([
        'settings.section',
        'shell.overlay',
        'shell.quota-notice',
        'workspace.toast',
        'workspace.toast.content',
        'plugins.item',
        'settings.plugins.tab',
      ]);

      function registerSlot(ctx, options, Component) {
        const slot = options.name;
        if (!KNOWN_SLOTS.has(slot)) {
          console.warn('[dsh-sunder] 未在已知目录里的 slot：' + slot + '（继续尝试注册）');
        }
        try {
          const slots = ctx && ctx.slots;
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
            console.warn('[dsh-sunder] 当前 ctx 没有 slots 服务，跳过 ' + slot);
            return undefined;
          }
          return slots.inject(slot, () => slots.register(options, Component));
        } catch (error) {
          console.warn('[dsh-sunder] 注册 ' + slot + ' 失败：' + messageOf(error));
          return undefined;
        }
      }

      const inject = ['slots'];

      function apply(ctx) {
        try {
          ctxRef = ctx;
        } catch (error) {
          /* 忽略 */
        }

        // 设置页分区：id 用 sunder，order 60 排在内置分区（account -10 / general 0 / models 10 /
        // plugins 15 / agent-presets 20）之后。
        registerSlot(ctx, { name: 'settings.section', id: 'sunder', order: 60, label: () => 'Sunder' }, SunderSection);

        // 未读公告横幅：shell.overlay 是 root 级浮动层，层本身 click-through，条目自己开 pointer-events。
        registerSlot(ctx, { name: 'shell.overlay', id: 'sunder-notice', order: 100 }, SunderBanner);

        // 数据探测放到注册之后，异步进行，失败不影响已注册的界面。
        try {
          const pending = refresh(ctx);
          if (pending && typeof pending.catch === 'function') {
            pending.catch((error) => {
              console.warn('[dsh-sunder] 数据刷新失败：', messageOf(error));
            });
          }
        } catch (error) {
          console.warn('[dsh-sunder] 数据刷新启动失败：', messageOf(error));
        }
      }

      exports.apply = apply;
      exports.inject = inject;
      // 方便测试/调试：不参与 cordis 生命周期。
      exports.__internals = {
        refresh,
        getSnapshot,
        subscribe,
        selectAnnouncements,
        compareVersions,
        ANNOUNCE_LIMIT,
        PACKAGE_NAME,
        KNOWN_SLOTS,
      };
      return module.exports;
    },
  });
})();
