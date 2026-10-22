/**
 * dsh-sunder 客户端半（浏览器端）。
 *
 * 注册协议（由 DSH 的 client-modules 注入 window.__ModuleLoader__ 后调用）：
 *   window.__ModuleLoader__.load({ id, factory })
 *   factory(require) 返回模块导出，其中 apply / inject 构成一个 cordis 客户端插件。
 *
 * 纯 JS + React.createElement，不用 JSX、不用打包器；require 只解析模块图里已有的模块（react）。
 *
 * ── 数据来源（重要，改代码前先读） ─────────────────────────────────────
 * 安装的客户端插件拿到的是真实的 cordis ctx，**没有** host.call / harness.handle
 * （那两个只在动态 cordis-client-runner 插件里有）。可用的数据通道有两层：
 *
 *   A) host 同源 HTTP 路由（首选）——host 半注册在 webServer 上的只读 JSON 接口，
 *      与 GUI 同源，不需要鉴权头，cookie 自带：
 *        GET  /sunder/api/status   → { ok:true, value: STATUS }
 *        POST /sunder/api/ack      body {id} | {all:true} → { ok:true, value:{acked,status} }
 *        POST /sunder/api/refresh  → { ok:true, value: STATUS }（host 重新拉 feed / 查 release）
 *      错误信封：{ ok:false, error:{ code, message } }，状态码 400/403/404/405/500。
 *      路由不存在（404）或网络失败时**不报错**，静默降级到 B —— 这条路径是旧版本
 *      host（没有路由）或 headless profile（没有 webServer）时的正常情况。
 *
 *   B) 降级路径（旧行为，保持原样）：
 *      1) remote.pluginManager.listBundles() → 版本号（listPlugins 不带版本）。
 *      2) remote.pluginInventory.list()     → enabled + fiberPhase 挂载态。
 *      3) remote.settings.describe()        → 只有声明 Config schema 的插件才出现（通常没有）。
 *      4) 客户端直连 raw.githubusercontent / ghproxy 拉 announcements.json，
 *         直连 api.github.com 查 releases/latest。这条路径容易被限流（HTTP 429）。
 *
 * 因此本文件的数据分两层：HTTP 桥能给出全部字段（version / status / language / preset /
 * guard / thinkHeader / fakeHistory / announcements / feed / update / ...），给不出时才退回
 * remote 探测 + 客户端直连；桥可用时一律以 host 为准，也不再请求 api.github.com。
 * 已读/关闭记录优先交给 host（%DSH_HOME%/sunder/state.json），降级时仍写 localStorage。
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

      // host 同源 HTTP 路由（host 半注册到 webServer，见 index.js / lib/bridge.js）。
      // URL 都是站内绝对路径：同源、自带 cookie，不要拼 origin。
      const API_BASE = '/sunder/api';
      const REFRESH_ROUTES = {
        status: API_BASE + '/status',
        ack: API_BASE + '/ack',
        refresh: API_BASE + '/refresh',
      };

      const KEY_ACKED = 'dsh-sunder.acked';
      const KEY_DISMISSED = 'dsh-sunder.dismissed';
      const KEY_CACHE = 'dsh-sunder.cache';

      const FEED_TTL_MS = 30 * 60 * 1000;
      const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
      // host 路由要快：4s 内没响应就认为路由不可用，立刻走降级路径（测试可改 TIMEOUTS 加速）。
      const TIMEOUTS = { host: 4000, api: 4000, feed: 8000 };
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

      /** 长消息截断（feed.error / warned 这类可能很长的文本，界面上只显示一截）。 */
      function truncate(text, max) {
        const value = typeof text === 'string' ? text.trim() : messageOf(text);
        if (max <= 0) return '';
        if (value.length <= max) return value;
        return value.slice(0, max - 1) + '…';
      }

      function pickString(value) {
        return typeof value === 'string' && value.trim() !== '' ? value : null;
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

      /** 跨域 JSON 拉取（降级路径用：raw.githubusercontent / ghproxy / api.github.com）。 */
      async function fetchJson(url) {
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
        let timer;
        if (controller) {
          timer = setTimeout(() => {
            try { controller.abort(); } catch (error) { /* 忽略 */ }
          }, TIMEOUTS.feed);
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

      /**
       * 同源 HTTP 路由请求：永远 resolve，从不 throw。
       * 返回 { ok, status, code, error, value }。
       */
      async function requestJson(url, options) {
        const opts = options || {};
        const method = typeof opts.method === 'string' ? opts.method : 'GET';
        const body = typeof opts.body === 'string' ? opts.body : undefined;
        const timeout = typeof opts.timeout === 'number' ? opts.timeout : TIMEOUTS.api;
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
        let timer;
        if (controller && timeout > 0) {
          timer = setTimeout(() => {
            try { controller.abort(); } catch (error) { /* 忽略 */ }
          }, timeout);
        }
        try {
          const headers = { accept: 'application/json' };
          if (body !== undefined) headers['content-type'] = 'application/json';
          const response = await fetch(url, {
            method,
            cache: 'no-store',
            credentials: 'same-origin',
            headers,
            body,
            signal: controller ? controller.signal : undefined,
          });
          const statusCode = response && typeof response.status === 'number' ? response.status : 0;
          let payload;
          try {
            payload = response && typeof response.json === 'function' ? await response.json() : undefined;
          } catch (error) {
            payload = undefined;
          }
          const envelope = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
          if (!response || response.ok !== true || !envelope || envelope.ok !== true) {
            const rawError = envelope && envelope.error && typeof envelope.error === 'object' ? envelope.error : null;
            const message = rawError && typeof rawError.message === 'string' ? rawError.message : '';
            const code = rawError && typeof rawError.code === 'string' ? rawError.code : '';
            return {
              ok: false,
              status: statusCode,
              code,
              error: message !== '' ? message : statusCode > 0 ? 'HTTP ' + statusCode : '路由不可用',
            };
          }
          return { ok: true, status: statusCode, code: '', error: '', value: envelope.value };
        } catch (error) {
          // 网络失败 / 超时 abort / CORS：都按"路由不可用"处理，交给降级路径。
          return { ok: false, status: 0, code: '', error: messageOf(error) };
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }

      function postJson(url, payload, timeout) {
        return requestJson(url, {
          method: 'POST',
          body: payload === undefined ? undefined : JSON.stringify(payload),
          timeout: typeof timeout === 'number' ? timeout : TIMEOUTS.api,
        });
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
          thinkHeader: '提示头',
          fakeHistory: '伪历史',
          unread: '未读公告',
          update: '最近更新检查',
          latest: '最新版本',
          feedSource: '公告源',
          repo: '仓库',
          releases: 'Release 页',
          refresh: '刷新',
          markRead: '全部标记已读',
          unknown: '未知',
          checking: '检查中…',
          notChecked: '尚未检查',
          bridgeHttp: 'host 桥（HTTP）已连接',
          noBridge: '未连上 host 桥，以下为静态信息',
          unreadClientNote: '客户端口径（浏览器 localStorage 记录已读）',
          configLimit: 'host 侧未暴露配置（index.js 无 Config/remote），配置值读不到',
          updateNote: '客户端直接查 GitHub',
          updateNoteHost: '宿主侧检查',
          feedLabel: '公告源：',
          feedErrorLabel: '公告源错误：',
          hostErrorLabel: 'HTTP 路由：',
          ackLocalNote: 'host 路由不可用，已读/关闭记录只写在本机 localStorage',
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
          thinkHeader: 'Think header',
          fakeHistory: 'Fake history',
          unread: 'Unread',
          update: 'Last update check',
          latest: 'Latest',
          feedSource: 'Feed',
          repo: 'Repository',
          releases: 'Releases',
          refresh: 'Refresh',
          markRead: 'Mark all read',
          unknown: 'unknown',
          checking: 'checking…',
          notChecked: 'not checked yet',
          bridgeHttp: 'host bridge (HTTP) connected',
          noBridge: 'no host bridge — showing static data',
          unreadClientNote: 'client-side count (read ids kept in localStorage)',
          configLimit: 'host does not expose config (no Config/remote in index.js)',
          updateNote: 'queried from the client',
          updateNoteHost: 'checked by the host',
          feedLabel: 'Feed: ',
          feedErrorLabel: 'Feed error: ',
          hostErrorLabel: 'HTTP route: ',
          ackLocalNote: 'host route unavailable — read/dismiss state kept in localStorage only',
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
            return {
              raw: cached.raw,
              fetchedAt: cached.at,
              fromCache: true,
              url: typeof cached.url === 'string' ? cached.url : null,
            };
          }
        }
        let lastError = '所有公告源都失败';
        for (const url of FEED_URLS) {
          try {
            const payload = await fetchJson(url);
            const raw = decodeFeed(payload).filter((item) => normalizeAnnouncement(item) !== undefined);
            const fetchedAt = new Date().toISOString();
            const next = { ...readJson(KEY_CACHE, {}), feed: { at: fetchedAt, raw, url } };
            writeJson(KEY_CACHE, next);
            return { raw, fetchedAt, fromCache: false, url };
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
      // 5. host 桥探测（remote 服务；缺服务时全部降级）——降级路径专用
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
      // 5b. host 同源 HTTP 路由（首选数据源）
      // ---------------------------------------------------------------------
      function hostBridgeUp() {
        return Boolean(state.bridge && state.bridge.available === true && state.bridge.kind === 'http');
      }

      /** GET /sunder/api/status。永不 throw：失败就是 { ok:false, error }。 */
      async function fetchHostStatus() {
        const result = await requestJson(REFRESH_ROUTES.status, {
          timeout: TIMEOUTS.host,
          method: 'GET',
        });
        if (!result.ok) return { ok: false, error: result.error, status: result.status };
        return { ok: true, status: result.value && typeof result.value === 'object' && !Array.isArray(result.value) ? result.value : {} };
      }

      /**
       * host 的公告已经是"已筛选/已限流/已标已读"的结果：
       * title/body 由 host 本地化好，这里只做结构归一，不再按 minVersion 过滤、也不再截断。
       */
      function normalizeHostAnnouncements(raw) {
        const list = Array.isArray(raw) ? raw : [];
        const seen = new Set();
        const out = [];
        for (const item of list) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const id = typeof item.id === 'string' ? item.id : '';
          if (id === '' || seen.has(id)) continue;
          seen.add(id);
          out.push({
            id,
            level: item.level === 'warn' || item.level === 'critical' ? item.level : 'info',
            date: typeof item.date === 'string' ? item.date : '',
            title: item.title,
            body: item.body,
            link: typeof item.link === 'string' && item.link !== '' ? item.link : undefined,
            acknowledged: item.acknowledged === true,
            seen: item.seen === true,
          });
        }
        return out;
      }

      function normalizeHostUpdate(raw, fallback) {
        const previous = fallback === undefined ? null : fallback;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return previous;
        return {
          latest: typeof raw.latest === 'string' ? raw.latest.replace(/^v/i, '') : undefined,
          url: typeof raw.url === 'string' ? raw.url : undefined,
          newer: typeof raw.newer === 'boolean' ? raw.newer : undefined,
          checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : new Date().toISOString(),
          error: pickString(raw.error) ? truncate(raw.error, 200) : undefined,
        };
      }

      /** 把 host STATUS 映射成 store 的 patch。未知/缺字段一律落到 null（界面显示"未知"）。 */
      function mergeHostStatus(status) {
        const value = status && typeof status === 'object' && !Array.isArray(status) ? status : {};
        const feed = value.feed && typeof value.feed === 'object' && !Array.isArray(value.feed) ? value.feed : null;
        const announcements = normalizeHostAnnouncements(value.announcements);
        const unread = typeof value.unread === 'number' && Number.isFinite(value.unread)
          ? value.unread
          : announcements.filter((item) => !item.acknowledged).length;
        const feedSource = feed ? pickString(feed.source) || pickString(feed.url) : null;
        const feedError = feed ? pickString(feed.error) : null;
        return {
          bridge: { available: true, kind: 'http' },
          hostError: null,
          version: typeof value.version === 'string' ? value.version.replace(/^v/i, '') : null,
          enabled: typeof value.enabled === 'boolean' ? value.enabled : null,
          active: typeof value.active === 'boolean' ? value.active : null,
          language: typeof value.language === 'string' ? value.language : null,
          preset: typeof value.preset === 'string' ? value.preset : null,
          guard: typeof value.guard === 'boolean' ? value.guard : null,
          thinkHeader: value.thinkHeader === undefined ? null : value.thinkHeader,
          fakeHistory: value.fakeHistory === undefined ? null : value.fakeHistory,
          tools: typeof value.tools === 'boolean' ? value.tools : null,
          announceLimit: typeof value.announceLimit === 'number' && Number.isFinite(value.announceLimit)
            ? value.announceLimit
            : null,
          announcements,
          unread,
          feedSource: feedSource === null ? null : truncate(feedSource, 160),
          feedError: feedError === null ? null : truncate(feedError, 200),
          update: normalizeHostUpdate(value.update, state.update),
          updateSource: 'host',
          repo: pickString(value.repo),
          statePath: pickString(value.statePath),
          node: pickString(value.node),
        };
      }

      /** mergeHostStatus 的容错包装：坏数据绝不能炸掉 refresh/ack。 */
      function mergeHostStatusSafe(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        try {
          return mergeHostStatus(value);
        } catch (error) {
          return {};
        }
      }

      function normalizeAckBody(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
        if (payload.all === true) return { all: true };
        if (typeof payload.id === 'string' && payload.id !== '') return { id: payload.id };
        return null;
      }

      /**
       * 本地降级：写 localStorage（dsh-sunder.acked / dsh-sunder.dismissed）。
       * mode='dismiss'（横幅关闭）只写 dismissed；mode='read'（全部标记已读）两个都写。
       */
      function applyAckLocal(body, mode, ids) {
        const list = Array.isArray(ids) ? ids : [];
        const targets = body.all === true ? list.slice() : list.filter((id) => id === body.id);
        const set = new Set(targets);
        if (set.size === 0 && body.all !== true && typeof body.id === 'string') set.add(body.id);
        try {
          const dismissed = readIdSet(KEY_DISMISSED);
          for (const id of set) dismissed.add(id);
          writeIdSet(KEY_DISMISSED, dismissed);
          if (mode === 'dismiss') return { count: set.size, mode };
          const acked = readIdSet(KEY_ACKED);
          for (const id of set) acked.add(id);
          writeIdSet(KEY_ACKED, acked);
          const acknowledged = state.announcements.map((item) => (set.has(item.id)
            ? { ...item, acknowledged: true }
            : item));
          patch({ announcements: acknowledged, unread: acknowledged.filter((item) => !item.acknowledged).length });
          return { count: set.size, mode };
        } catch (error) {
          return { count: 0, mode, error: messageOf(error) };
        }
      }

      /**
       * ack 动作：卡片"全部标记已读"与横幅"关闭"共用。
       * payload: { id } | { all: true }；options.mode: 'read'（默认）| 'dismiss'；options.ids 覆盖目标列表。
       * 优先 POST /sunder/api/ack 并合并返回的 status；路由不可用时退回 localStorage。
       * 永不 reject。
       */
      async function ack(payload, options) {
        try {
          const body = normalizeAckBody(payload);
          if (!body) return { ok: false, mode: 'invalid', error: 'ack 需要 id 或 all:true' };
          const opts = options || {};
          const mode = opts.mode === 'dismiss' ? 'dismiss' : 'read';
          const ids = Array.isArray(opts.ids)
            ? opts.ids.filter((id) => typeof id === 'string' && id !== '')
            : state.announcements.map((item) => (item && item.id)).filter((id) => typeof id === 'string' && id !== '');
          if (hostBridgeUp()) {
            const result = await postJson(REFRESH_ROUTES.ack, body);
            if (result.ok) {
              const value = result.value && typeof result.value === 'object' && !Array.isArray(result.value)
                ? result.value
                : {};
              const merged = mergeHostStatusSafe(value.status);
              merged.ackMode = 'http';
              merged.ackError = null;
              merged.ackedCount = typeof value.acked === 'number' && Number.isFinite(value.acked) ? value.acked : null;
              patch(merged);
              return { ok: true, mode: 'http', acked: merged.ackedCount };
            }
            const local = applyAckLocal(body, mode, ids);
            patch({ ackMode: 'local', ackError: truncate(result.error, 160) });
            return { ok: false, mode: 'local', error: result.error, acked: local.count };
          }
          const local = applyAckLocal(body, mode, ids);
          patch({ ackMode: 'local', ackError: null });
          return { ok: true, mode: 'local', acked: local.count };
        } catch (error) {
          return { ok: false, mode: 'error', error: messageOf(error) };
        }
      }

      // ---------------------------------------------------------------------
      // 6. 共享 store（卡片与横幅共用一次探测结果）
      // ---------------------------------------------------------------------
      const INITIAL_STATE = {
        lang: 'en',
        busy: false,
        probeAt: null,
        // kind: undefined（未知）/ 'http'（host 路由）/ 'remote'（remote 服务降级）/ 'none'
        bridge: { available: false },
        hostError: null,
        version: null,
        availability: null,
        enabled: null,
        active: null,
        fiberPhase: null,
        installed: null,
        language: null,
        preset: null,
        guard: null,
        thinkHeader: null,
        fakeHistory: null,
        tools: null,
        announceLimit: null,
        announcements: [],
        unread: null,
        feedSource: null,
        feedError: null,
        update: null,
        updateSource: null,
        repo: null,
        statePath: null,
        node: null,
        ackMode: null,
        ackError: null,
        ackedCount: null,
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
      // 7. 刷新流程：host HTTP 路由优先；不可用时逐步降级，每一步单独 try/catch
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

          // 1) 首选：host 同源 HTTP 路由一次拿到全部字段。
          const host = await fetchHostStatus();
          if (host.ok) {
            Object.assign(partial, mergeHostStatusSafe(host.status));
            partial.bridge = { available: true, kind: 'http' };
            partial.warned = null;
            partial.busy = false;
            partial.probeAt = new Date().toISOString();
            patch(partial);
            return getSnapshot();
          }
          // 路由不可用（旧 host / 无 host / 网络失败）：记下原因，走既有降级路径。
          partial.hostError = truncate(host.error, 160);

          try {
            const bundle = await probeBundle(target);
            partial.bridge = { available: Boolean(bundle.available), kind: bundle.available ? 'remote' : 'none' };
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
            partial.feedSource = feed.url ? truncate(feed.url, 160) : null;
            partial.feedError = null;
          } catch (error) {
            partial.announcements = state.announcements;
            partial.feedError = truncate(messageOf(error), 200);
          }

          try {
            partial.update = await loadUpdate(force);
          } catch (error) {
            partial.update = { checkedAt: new Date().toISOString(), error: messageOf(error) };
          }
          partial.updateSource = 'client';

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

      /**
       * "刷新"按钮：HTTP 桥在线时让 host 重新拉 feed / 查 release 并合并返回的 status；
       * 否则退回本地 refresh（内部会先再试一次 status，再走 remote + GitHub）。
       * 永不 reject。
       */
      let refreshHostInFlight = null;

      function refreshHost() {
        if (refreshHostInFlight) return refreshHostInFlight;
        refreshHostInFlight = (async () => {
          if (hostBridgeUp()) {
            patch({ busy: true });
            const result = await postJson(REFRESH_ROUTES.refresh);
            if (result.ok) {
              const merged = mergeHostStatusSafe(result.value);
              merged.busy = false;
              merged.probeAt = new Date().toISOString();
              merged.lang = detectLanguage(ctxRef);
              merged.warned = null;
              patch(merged);
              return getSnapshot();
            }
            patch({ busy: false, hostError: truncate(result.error, 160) });
          }
          const fallback = refresh(ctxRef, { force: true });
          return typeof fallback?.then === 'function' ? await fallback : getSnapshot();
        })()
          .catch((error) => {
            patch({ busy: false, warned: messageOf(error) });
            return getSnapshot();
          })
          .finally(() => {
            refreshHostInFlight = null;
          });
        return refreshHostInFlight;
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
        const hostUp = Boolean(snapshot.bridge && snapshot.bridge.kind === 'http');
        // 组件的 onClick 直接返回 Promise，测试可以 await 到刷新完成。
        const onRefresh = useCallback(() => refreshHost(), []);
        const onMarkRead = useCallback(() => ack({ all: true }, { mode: 'read' }), [snapshot.announcements]);

        const version = snapshot.version;
        // host 给的是 active/enabled 两个布尔；remote 降级路径给 enabled + fiberPhase。
        const enabledValue = snapshot.enabled !== null ? snapshot.enabled : snapshot.active;
        const statusText = enabledValue === null && snapshot.fiberPhase === null
          ? t.unknown
          : [
            enabledValue === null ? '' : enabledValue ? t.enabled : t.disabled,
            snapshot.fiberPhase ? t.phase + '=' + snapshot.fiberPhase : '',
          ].filter(Boolean).join(' · ');

        const update = snapshot.update;
        let updateText;
        if (!update) updateText = snapshot.busy ? t.checking : t.notChecked;
        else if (update.error) updateText = t.error + '：' + update.error;
        else updateText = formatTime(update.checkedAt);

        const latest = update && update.latest ? update.latest : null;
        const newer = update && typeof update.newer === 'boolean'
          ? update.newer
          : latest && version ? isNewer(latest, version) : false;

        const repoSlug = typeof snapshot.repo === 'string' && snapshot.repo !== '' ? snapshot.repo : REPO;
        const repoUrl = 'https://github.com/' + repoSlug;
        const releasesUrl = repoUrl + '/releases';

        const rows = [
          ValueRow({ key: 'version', label: t.version, children: version ? 'v' + version : t.unknown }),
          ValueRow({ key: 'status', label: t.status, children: statusText }),
          ValueRow({
            key: 'language',
            label: t.language,
            children: snapshot.language ? snapshot.language : t.unknown,
          }),
          ValueRow({
            key: 'preset',
            label: t.preset,
            children: snapshot.preset ? snapshot.preset : t.unknown,
          }),
          ValueRow({
            key: 'guard',
            label: t.guard,
            children: snapshot.guard === null ? t.unknown : snapshot.guard ? t.yes : t.no,
          }),
          snapshot.thinkHeader === null ? null : ValueRow({
            key: 'thinkHeader',
            label: t.thinkHeader,
            children: snapshot.thinkHeader === false ? t.no : String(snapshot.thinkHeader),
          }),
          snapshot.fakeHistory === null ? null : ValueRow({
            key: 'fakeHistory',
            label: t.fakeHistory,
            children: snapshot.fakeHistory === false ? t.no : String(snapshot.fakeHistory),
          }),
          ValueRow({
            key: 'unread',
            label: t.unread,
            children: snapshot.unread === null
              ? t.unknown
              : String(snapshot.unread) + (snapshot.unread > 0 && !hostUp ? ' · ' + t.unreadClientNote : ''),
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
                h('span', { key: 'note', style: { opacity: 0.6 } }, '（' + (hostUp ? t.updateNoteHost : t.updateNote) + '）'),
              ]
              : t.unknown,
          }),
          snapshot.feedSource ? ValueRow({
            key: 'feed',
            label: t.feedSource,
            children: snapshot.feedSource,
          }) : null,
          ValueRow({
            key: 'repo',
            label: t.repo,
            children: h(ExternalLink, { href: repoUrl, text: repoSlug }),
          }),
          ValueRow({
            key: 'releases',
            label: t.releases,
            children: h(ExternalLink, { href: releasesUrl, text: releasesUrl.replace('https://', '') }),
          }),
        ].filter(Boolean);

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
            h('p', { style: hostUp ? styles.hint : styles.warn }, hostUp ? t.bridgeHttp : t.noBridge),
            !hostUp && snapshot.guard === null ? h('p', { style: styles.hint }, t.configLimit) : null,
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
          snapshot.feedSource ? h('p', { style: styles.hint }, t.feedLabel + snapshot.feedSource) : null,
          snapshot.feedError ? h('p', { style: styles.warn }, t.feedErrorLabel + snapshot.feedError) : null,
          snapshot.ackMode === 'local' ? h('p', { style: styles.hint }, t.ackLocalNote) : null,
          !hostUp && snapshot.hostError && !snapshot.bridge.available
            ? h('p', { style: styles.hint }, t.hostErrorLabel + snapshot.hostError)
            : null,
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
          // 本地关闭记录先落盘（关闭不该因为 host 挂掉而失效）。
          const next = readIdSet(KEY_DISMISSED);
          for (const item of unread) next.add(item.id);
          writeIdSet(KEY_DISMISSED, next);
          setDismissedIds(next);
          // 有 host 路由时同步到 host（合并返回的 status，横幅随之消失）。
          return ack({ all: true }, { mode: 'dismiss', ids: unread.map((item) => item.id) });
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
        refreshHost,
        fetchHostStatus,
        ack,
        mergeHostStatus,
        hostBridgeUp,
        getSnapshot,
        subscribe,
        selectAnnouncements,
        compareVersions,
        truncate,
        ANNOUNCE_LIMIT,
        PACKAGE_NAME,
        KNOWN_SLOTS,
        REFRESH_ROUTES,
        TIMEOUTS,
      };
      return module.exports;
    },
  });
})();
