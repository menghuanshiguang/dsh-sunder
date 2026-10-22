/**
 * dsh-sunder — an open-source, user-authorized answer mode for DeepSeek Harness.
 *
 * The bundle contributes three pinned prompt sections (identity claim, operating
 * rules, closing directive), two runtime-context contributors (unread
 * announcements and release notices), three tools, and a small assembly guard
 * that keeps the sections attached even when another plugin replaces the whole
 * prompt with a `complete` section.
 *
 * It never touches project files, never calls a model of its own, and every
 * network request is optional, cached, and failure-tolerant.
 *
 * @module dsh-sunder
 */

import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_FEED, fetchAnnouncements, renderAnnouncements, selectAnnouncements } from './lib/announcements.js';
import { registerSunderBridge } from './lib/bridge.js';
import { buildPrompt, ruleCard } from './lib/prompt.js';
import { ackAnnouncement, loadState, markSeen, saveState, statePath } from './lib/state.js';
import { applyUpdate, checkForUpdate, DEFAULT_REPO } from './lib/update.js';

const require = createRequire(import.meta.url);
const manifest = require('./package.json');

/**
 * The directory holding this very checkout — the directory `applyUpdate()`
 * writes into. When the bundle is installed, `import.meta.url` points at the
 * installed copy, so an applied update always targets the running install and
 * never some other checkout on disk.
 */
const CHECKOUT_DIR = dirname(fileURLToPath(import.meta.url));

/** Version reported to prompt sections, tools, and update checks. */
export const VERSION = manifest.version;

/** Plugin name as declared by the manifest and the bundle patch. */
export const name = 'dsh-sunder';

/** The prompt registry is the only service this bundle requires. */
export const inject = ['systemPrompt'];

/** Process-wide idempotence key for the assemble guard accessor. */
const GUARD = Symbol.for('dsh-sunder.assembleGuard');

/** Section placement, pinned around the host's own placement table. */
const SECTION_TABLE = [
  { name: 'sunder:identity', order: -100000 },
  { name: 'sunder:rules', order: 10150 },
  { name: 'sunder:footer', order: 10300 },
];

/** Per-apply mutable state shared by contexts, tools, and the guard. */
const runtime = {
  updateNotice: undefined,
  unread: [],
  feedSource: undefined,
  feedError: undefined,
};

const DEFAULTS = {
  enabled: true,
  language: 'auto',
  preset: 'full',
  thinkHeader: true,
  fakeHistory: true,
  extraPrompt: '',
  announcements: true,
  announceLimit: 3,
  feedUrl: DEFAULT_FEED,
  feedMirrors: [],
  builtinMirrors: true,
  bundledAnnouncements: true,
  updateCheck: true,
  updateIntervalHours: 6,
  repo: DEFAULT_REPO,
  tools: true,
  guard: true,
  debug: false,
};

/** Resolve `auto` from the host locale, then clamp to a supported pack. */
function resolveLanguage(setting) {
  const requested = String(setting ?? 'auto').toLowerCase();
  if (requested === 'zh' || requested === 'en') return requested;
  const locale = String(Intl.DateTimeFormat().resolvedOptions().locale ?? '').toLowerCase();
  return locale.startsWith('zh') ? 'zh' : 'en';
}

/** Rebuild the rendered sections so the assembly guard can re-attach them. */
function renderedSections(prompt) {
  return [
    { ...SECTION_TABLE[0], text: prompt.identity, interpolate: false },
    { ...SECTION_TABLE[1], text: prompt.rules, interpolate: false },
    { ...SECTION_TABLE[2], text: prompt.footer, interpolate: false },
  ];
}

/** Set once when a foreign `complete` takeover is reversed, so the warning is not repeated every assembly. */
let takeoverWarned = false;

/** Section names this plugin owns; anything else in a one-section assembly is a takeover. */
const SUNDER_SECTION_NAMES = new Set(['sunder:identity', 'sunder:rules', 'sunder:footer']);

/**
 * Return the assembly with every sunder section present exactly once.
 *
 * Also reverses a foreign `complete` takeover: the registry restores a lone
 * `complete` section as the entire prompt, and a global override that let
 * another plugin's text sit next to its own rules would be two authorities in
 * one prompt. Replacing it is the point of the guard, not a side effect.
 */
function ensureSunderSections(assembly, sections) {
  if (!assembly || !Array.isArray(assembly.sections)) return assembly;
  if (assembly.sections.length === 1 && !SUNDER_SECTION_NAMES.has(assembly.sections[0]?.name)) {
    const displaced = String(assembly.sections[0]?.name ?? 'unnamed');
    if (!takeoverWarned) {
      takeoverWarned = true;
      console.warn(`[dsh-sunder] "${displaced}" replaced the whole system prompt with a complete section; sunder reclaimed it.`);
    }
    return { ...assembly, sections: [...sections] };
  }
  const present = new Set(assembly.sections.map((section) => section?.name));
  const missing = sections.filter((section) => !present.has(section.name));
  if (missing.length === 0) return assembly;
  return {
    ...assembly,
    sections: [...assembly.sections, ...missing].sort(
      (left, right) => (left.order ?? 0) - (right.order ?? 0) || String(left.name).localeCompare(String(right.name)),
    ),
  };
}

// ---------------------------------------------------------------------------
// Self-update: `sunder_update` action=apply.
//
// `applyUpdate()` (lib/update.js) validates the package name and then overwrites
// files in place; it keeps no rollback copy of its own and never throws. The
// helpers below add the one thing it lacks — a best-effort snapshot of the
// current checkout, reported as `backup=` — and turn its result into the
// English-keyed, localized text the other tools already speak.
// ---------------------------------------------------------------------------

/** Directory names a checkout snapshot never copies. */
const SNAPSHOT_SKIP = new Set(['.git', 'node_modules']);

/**
 * Copy the installed package into `destination` before an in-place update, so
 * `action=apply` can name a directory a user can restore from. A failure is
 * reported by omitting `dir`; the caller refuses to update without one unless the
 * operator explicitly passes `force`.
 *
 * @param {string} source checkout directory
 * @param {string} destination snapshot directory
 * @returns {{ dir?: string, files: number }}
 */
function snapshotCheckout(source, destination) {
  try {
    mkdirSync(destination, { recursive: true });
    let files = 0;
    const walk = (current, prefix) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (SNAPSHOT_SKIP.has(entry.name)) continue;
        const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const from = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(from, relativePath);
        } else if (entry.isFile()) {
          const to = join(destination, ...relativePath.split('/'));
          mkdirSync(dirname(to), { recursive: true });
          copyFileSync(from, to);
          files += 1;
        }
      }
    };
    walk(source, '');
    return { dir: destination, files };
  } catch {
    return { files: 0 };
  }
}

/** Whether an `applyUpdate()` result actually replaced files on disk. */
function didApply(result) {
  return result?.ok === true
    && typeof result?.method === 'string'
    && result.method !== 'up-to-date'
    && Array.isArray(result.files)
    && result.files.length > 0;
}

/** Localized one-liners for every `action=apply` outcome. */
const APPLY_NOTES = {
  applied: {
    zh: '新文件已写入安装目录，重启 DSH 后生效。',
    en: 'Files were replaced; restart DSH to load the new version.',
  },
  current: {
    zh: '已是最新版本，没有改写任何文件。',
    en: 'Already up to date; no files were changed.',
  },
  failed: {
    zh: '更新没有完成，现有安装保持原样',
    en: 'The update did not complete; the existing install was left untouched',
  },
};

/** Localized explanation for the error codes `applyUpdate()` returns. */
const APPLY_ERROR_NOTES = {
  'invalid-repo': { zh: '配置里的 repo 不是 owner/name。', en: 'the configured repo is not owner/name' },
  'snapshot-failed': {
    zh: '备份快照没能写出来，已拒绝更新（applyUpdate 自己不保留回滚副本）。确认目标目录可写后重试，或显式传 force=true 跳过备份。',
    en: 'the backup snapshot could not be written, so the update was refused (applyUpdate keeps no rollback copy of its own). Fix write access to the install directory, or pass force=true to skip the backup explicitly.',
  },
  'invalid-dir': { zh: '安装目录不可用。', en: 'the install directory is not usable' },
  'invalid-install': { zh: '安装目录里的 package.json 无法解析。', en: 'the installed package.json could not be parsed' },
  'not-a-sunder-install': { zh: '目标目录属于别的插件，拒绝写入。', en: 'the target directory belongs to another package' },
  'release-has-no-tag': { zh: '最新发布没有版本标签。', en: 'the latest release carries no tag' },
  'download-unavailable': {
    zh: '下载被网络或代理挡住（api.github.com / codeload 不可达）。',
    en: 'downloads are blocked by the network or a proxy (api.github.com / codeload unreachable)',
  },
  'extract-failed': { zh: '源码包解压失败。', en: 'the downloaded archive could not be extracted' },
  'package-name-mismatch': {
    zh: '下载内容不是 dsh-sunder，已拒绝落盘。',
    en: 'the download is not the dsh-sunder package; nothing was written',
  },
  'tree-unavailable': { zh: 'contents API 兜底取不到仓库树。', en: 'the contents-API fallback could not read the repository tree' },
  'tree-truncated': { zh: '仓库树被截断，兜底不可用。', en: 'the repository tree was truncated' },
  'empty-tree': { zh: '仓库树为空，兜底不可用。', en: 'the repository tree was empty' },
  'incomplete-download': { zh: 'contents API 兜底下载不完整。', en: 'the contents-API fallback could not finish' },
};

/**
 * Render an `applyUpdate()` result as English keys plus localized prose.
 * Never throws: a malformed result degrades to `applied=no` with its raw reason.
 *
 * @param {object} input
 * @param {{ ok: boolean, [key: string]: unknown } | undefined} input.result
 * @param {'zh' | 'en'} input.language
 * @param {string} input.installed running version, used when the result carries none
 * @param {string} input.target directory the update writes into
 * @param {string} [input.backup] snapshot directory, when one was kept
 * @returns {{ applied: boolean, text: string }}
 */
function renderApplyReport({ result, language, installed, target, backup }) {
  const ok = result?.ok === true;
  const applied = didApply(result);
  const method = typeof result?.method === 'string' && result.method.length > 0 ? result.method : 'none';
  const version = typeof result?.version === 'string' && result.version.length > 0 ? result.version : undefined;
  const previous = typeof result?.previous === 'string' && result.previous.length > 0 ? result.previous : installed;
  const error = ok ? undefined : String(result?.error ?? 'unknown-error');
  const explain = error === undefined ? undefined : (APPLY_ERROR_NOTES[error] ?? { zh: '未知错误码。', en: 'unrecognized error code' });
  const note = error === undefined
    ? (applied ? APPLY_NOTES.applied[language] : APPLY_NOTES.current[language])
    : `${APPLY_NOTES.failed[language]} — ${explain[language]}`;

  const lines = [
    'action=apply',
    `applied=${applied ? 'yes' : 'no'}`,
    `from=${previous}`,
    `to=${version ?? (ok ? previous : 'none')}`,
    `target=${target}`,
    `method=${method}`,
  ];
  if (applied) lines.push(`files=${result.files.length}`);
  if (typeof backup === 'string' && backup.length > 0) lines.push(`backup=${backup}`);
  if (error !== undefined) {
    lines.push(`error=${error}`);
    const detail = result?.detail ?? result?.actual;
    if (typeof detail === 'string' && detail.length > 0) lines.push(`detail=${detail}`);
  }
  lines.push(`restart=${applied ? 'required' : 'not-needed'}`);
  lines.push(`note=${note}`);
  return { applied, text: lines.join('\n') };
}

/**
 * Register the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {Partial<typeof DEFAULTS>} [rawConfig] bundle config
 */
export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
  if (config.enabled === false) {
    console.info('[dsh-sunder] disabled by config; no prompt sections registered');
    return;
  }

  const language = resolveLanguage(config.language);
  const prompt = buildPrompt({
    language,
    preset: config.preset,
    thinkHeader: config.thinkHeader,
    fakeHistory: config.fakeHistory,
    extraPrompt: typeof config.extraPrompt === 'string' ? config.extraPrompt.trim() : '',
    version: VERSION,
  });
  const sections = renderedSections(prompt);
  const debug = (...parts) => {
    if (config.debug) console.info('[dsh-sunder]', ...parts);
  };

  // -------------------------------------------------------------------------
  // State file ($DSH_HOME/sunder/state.json): announcement acks, update cache.
  // -------------------------------------------------------------------------
  const stateFile = statePath();
  const state = loadState(stateFile);
  let persistTimer;
  const persist = () => {
    if (persistTimer !== undefined) return;
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      saveState(state, stateFile);
    }, 500);
    persistTimer.unref?.();
  };

  // -------------------------------------------------------------------------
  // Prompt sections. Orders: identity -100000 (first section in the assembly),
  // rules 10150 (after harness-source and web-surface, before the deployment
  // persona suffix at 10200), footer 10300 (the last section in the assembly).
  // -------------------------------------------------------------------------
  for (const section of sections) ctx.systemPrompt.section({ ...section });

  // -------------------------------------------------------------------------
  // Runtime context. Empty text is dropped by the host's renderer, so both
  // contributors stay silent until they actually have something to report.
  // -------------------------------------------------------------------------
  if (state.lastUpdateCheck !== null && typeof state.lastUpdateCheck === 'object') {
    runtime.updateNotice = state.lastUpdateCheck;
  }

  ctx.systemPrompt.context({
    name: 'sunder:update',
    order: 3400,
    // required: a scoped persona with includeRuntimeContext:false must not be
    // able to silence the update notice without disabling the plugin itself.
    required: true,
    text: () => {
      const notice = runtime.updateNotice;
      if (notice === undefined || notice.error !== undefined || notice.newer !== true) return '';
      return [
        `dsh-sunder ${VERSION} is installed, ${notice.latest} is available.`,
        notice.url === undefined ? '' : `Release: ${notice.url}`,
        'Run sunder_update for details.',
      ].filter(Boolean).join('\n');
    },
  });

  ctx.systemPrompt.context({
    name: 'sunder:announcements',
    order: 3600,
    // Same reason as sunder:update: an announcement that a scope can suppress
    // is an announcement that scope chose not to deliver.
    required: true,
    text: () => renderAnnouncements(runtime.unread, language),
  });

  // -------------------------------------------------------------------------
  // Per-turn rule card. Sections are read once per assembly; this card is a real
  // user-role message admitted in the same step as the request, so it lands
  // after the runtime-context snapshot and immediately before the answer. No
  // scope, `complete` section, or compaction pass can move it or drop it.
  //
  // It is injected once per turn (first step only): tool rounds inherit the
  // conversation that already contains it.
  //
  // The user role is not a stylistic pick. Every model-visible injection channel
  // the host exposes is typed to it — `agent.inject` / `followup` / `steer` take
  // `UserMessage`, and `PreStepDecision.enter.messages` is `UserMessage[]` — so a
  // plugin has no developer- or system-role path into the message list. The card
  // is phrased as the user's own instruction because that is what the role means
  // to the model; the system-level authorization narrative stays in the identity
  // section, which is the only place that can carry it.
  //
  // TODO(host): if DSH ever exposes a developer- or system-role injection channel
  // (or lets a plugin append to the in-history system update), move this card
  // there and keep the user-role path only as the fallback.
  // -------------------------------------------------------------------------
  const injectedTurns = new Map();
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    if (payload?.step !== 1) return decision;
    // A first step with nothing claimed owns a no-step turn; adding the card
    // there would turn it into a real request. Known boundary: a system-triggered
    // first step with no user message therefore gets no card — there is no
    // request to remind the model about.
    if (decision.messages.length === 0) return decision;
    const agentId = payload?.agent?.id ?? 'default';
    if (Number.isFinite(payload?.turn)) {
      if (injectedTurns.get(agentId) === payload.turn) return decision;
      injectedTurns.set(agentId, payload.turn);
    }
    return {
      ...decision,
      messages: [
        ...decision.messages,
        {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: ruleCard(language) }],
          source: { kind: 'plugin', plugin: 'dsh-sunder' },
        },
      ],
    };
  });

  // -------------------------------------------------------------------------
  // Assembly guard. A `complete` section elsewhere replaces every section after
  // the waterfall, so re-attach ours on the way out.
  //
  // Cordis hands out a fresh service proxy on every read, so the guard is a
  // property accessor keyed by a process-wide symbol: repeated installs update
  // the slot in place instead of nesting another wrapper (which ends in a stack
  // overflow). The dispose is intentionally a no-op — cordis effect cleanup
  // also fires on scope end, session boundary, and preset switches, and
  // unbinding there would silently drop the guard mid-conversation.
  // -------------------------------------------------------------------------
  const installGuard = () => {
    if (config.guard === false) return false;
    try {
      const promptService = ctx.systemPrompt;
      if (!promptService || typeof promptService.assemble !== 'function') return false;
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(promptService, 'assemble');
      } catch {
        descriptor = undefined;
      }
      const attach = (slot) => {
        slot.sections = sections;
        return true;
      };
      if (descriptor && typeof descriptor.get === 'function' && descriptor.get[GUARD]) {
        return attach(descriptor.get[GUARD]);
      }
      if (promptService[GUARD]) return attach(promptService[GUARD]);
      let original;
      try {
        original = promptService.assemble;
      } catch {
        return false;
      }
      if (typeof original !== 'function') return false;
      if (original._sunderWrapped) {
        return original._sunderSlot ? attach(original._sunderSlot) : true;
      }
      const slot = { sections };
      const wrap = (fn) => {
        if (typeof fn !== 'function') return fn;
        if (fn._sunderWrapped) {
          if (fn._sunderSlot) fn._sunderSlot.sections = slot.sections;
          return fn;
        }
        const bound = typeof fn.bind === 'function' ? fn.bind(promptService) : fn;
        const wrapped = async function assembleWithSunder(...args) {
          let assembled;
          try {
            assembled = await bound(...args);
          } catch (error) {
            debug('inner assemble threw:', error?.message ?? error);
            return { sections: [], contexts: [], tools: [] };
          }
          try {
            return ensureSunderSections(assembled, slot.sections);
          } catch {
            return assembled;
          }
        };
        Object.defineProperty(wrapped, '_sunderWrapped', { value: true, configurable: true });
        wrapped._sunderSlot = slot;
        return wrapped;
      };
      let current = wrap(original);
      const getter = function sunderAssembleGuard() {
        return current;
      };
      Object.defineProperty(getter, GUARD, { value: slot, configurable: true });
      Object.defineProperty(promptService, 'assemble', {
        configurable: true,
        enumerable: false,
        get: getter,
        set(next) {
          current = wrap(next);
        },
      });
      return true;
    } catch {
      return false;
    }
  };

  // A waterfall listener covers assemblies created without the guard, and
  // re-arms the guard on every assembly. If the host handed out a fresh service
  // proxy since the last call, the wrapper has to land on the current one; doing
  // it here means it happens on the very path that needs it, with no polling
  // window and no interval to keep alive.
  try {
    ctx.on('system-prompt/assemble', async (...args) => {
      installGuard();
      const [assembly] = args;
      const next = args.length >= 3 && typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      let result = assembly;
      if (next !== null) {
        try {
          result = await next();
        } catch {
          result = assembly;
        }
      }
      return ensureSunderSections(result, sections);
    }, { global: true, prepend: true });
  } catch {
    /* older cordis signatures: the guard still applies */
  }

  installGuard();
  try {
    ctx.on('session/created', () => {
      installGuard();
    });
  } catch {
    /* ignore */
  }
  ctx.effect(() => () => {
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer);
      persistTimer = undefined;
      saveState(state, stateFile);
    }
  });

  // -------------------------------------------------------------------------
  // Background checks: one immediate pass, then the configured cadence.
  // -------------------------------------------------------------------------
  /**
   * The packaged feed doubles as the offline fallback: it ships with the
   * installed version, so announcements still work with no network at all.
   */
  const bundledFeed = async () => {
    try {
      return JSON.parse(await readFile(new URL('./announcements.json', import.meta.url), 'utf8'));
    } catch (error) {
      debug('bundled announcement feed unreadable:', error?.message ?? error);
      return undefined;
    }
  };

  const refreshAnnouncements = async () => {
    if (config.announcements === false) return;
    try {
      const mirrors = Array.isArray(config.feedMirrors) ? config.feedMirrors.filter((url) => typeof url === 'string') : [];
      const result = await fetchAnnouncements({
        url: config.feedUrl,
        urls: mirrors,
        builtinMirrors: config.builtinMirrors !== false,
        currentVersion: VERSION,
        limit: config.announceLimit,
        acked: state.ackedAnnouncements,
        timeoutMs: 8000,
      });
      let items;
      let source;
      if (result.ok === true) {
        items = result.items;
        source = result.source;
        runtime.feedError = undefined;
      } else {
        runtime.feedError = result.error;
        debug('announcement feed failed:', result.error, '— trying the bundled feed');
        if (config.bundledAnnouncements !== false) {
          const bundled = await bundledFeed();
          if (bundled !== undefined) {
            items = selectAnnouncements(bundled, {
              currentVersion: VERSION,
              limit: config.announceLimit,
              acked: state.ackedAnnouncements,
            });
            source = 'bundled';
          }
        }
      }
      if (items === undefined) {
        debug('announcements: no source available');
        return;
      }
      runtime.unread = items;
      runtime.feedSource = source;
      for (const item of items) markSeen(state, item.id);
      state.lastAnnouncementCheck = new Date().toISOString();
      persist();
      debug(`announcements: ${items.length} selected from ${source}`);
    } catch (error) {
      runtime.feedError = String(error?.message ?? error);
    }
  };

  const runUpdateCheck = async (force = false) => {
    if (config.updateCheck === false) return undefined;
    try {
      const result = await checkForUpdate({
        repo: config.repo,
        currentVersion: VERSION,
        state,
        intervalHours: Math.max(1, Number(config.updateIntervalHours) || 6),
        persist,
        force,
      });
      if (result !== undefined) runtime.updateNotice = result;
      debug('update check:', result?.error ?? (result?.newer === true ? `newer ${result.latest}` : 'up to date'));
      return result;
    } catch (error) {
      debug('update check threw:', error?.message ?? error);
      return undefined;
    }
  };

  void refreshAnnouncements();
  void runUpdateCheck(false);
  const checkTimer = setInterval(() => {
    void refreshAnnouncements();
    void runUpdateCheck(false);
  }, Math.max(1, Number(config.updateIntervalHours) || 6) * 3_600_000);
  checkTimer.unref?.();
  ctx.effect(() => () => clearInterval(checkTimer));

  // -------------------------------------------------------------------------
  // Host bridge: a same-origin HTTP route for the settings panel.
  //
  // A third-party bundle cannot add namespaces to the host `remote` service, so
  // the panel reads the snapshot below through `/sunder/api/*` instead. Headless
  // profiles have no webServer: the bridge simply never registers and the client
  // falls back to its degraded view.
  // -------------------------------------------------------------------------
  const ackedAnnouncements = () => new Set(state.ackedAnnouncements);

  const bridgeStatus = () => {
    const acked = ackedAnnouncements();
    const notice = runtime.updateNotice;
    const unread = runtime.unread.filter((item) => !acked.has(item.id));
    return {
      version: VERSION,
      active: true,
      enabled: true,
      language,
      preset: config.preset,
      thinkHeader: prompt.thinkHeader === null ? false : prompt.thinkHeader,
      fakeHistory: prompt.fakeHistory === null ? false : prompt.fakeHistory,
      guard: config.guard !== false,
      tools: config.tools !== false && toolCount > 0,
      announceLimit: Math.max(0, Number(config.announceLimit) || 3),
      unread: unread.length,
      announcements: runtime.unread.map((item) => ({
        id: item.id,
        level: item.level,
        date: item.date,
        title: item.title,
        body: item.body,
        link: item.link,
        acknowledged: acked.has(item.id),
      })),
      feed: {
        url: config.feedUrl,
        source: runtime.feedSource ?? null,
        error: runtime.feedError ?? null,
      },
      update: notice === undefined || notice === null
        ? null
        : {
          latest: notice.latest ?? null,
          url: notice.url ?? null,
          newer: notice.newer === true,
          checkedAt: notice.checkedAt ?? null,
          error: notice.error ?? null,
        },
      repo: config.repo,
      statePath: stateFile,
      node: process.versions.node,
    };
  };

  const bridge = registerSunderBridge(ctx, {
    status: bridgeStatus,
    ack: (payload) => {
      const ids = payload?.all === true
        ? runtime.unread.map((item) => item.id)
        : [payload?.id].filter((id) => typeof id === 'string' && id.length > 0);
      let acked = 0;
      for (const id of ids) {
        if (state.ackedAnnouncements.includes(id)) continue;
        ackAnnouncement(state, id);
        acked += 1;
      }
      if (acked > 0) persist();
      return { acked, status: bridgeStatus() };
    },
    refresh: async () => {
      // Force both checks: the panel's "刷新" is an explicit user action.
      await Promise.all([refreshAnnouncements(), runUpdateCheck(true)]);
      return bridgeStatus();
    },
  });
  ctx.effect(() => () => bridge.dispose());
  debug('host bridge registered:', bridge.registered);

  // -------------------------------------------------------------------------
  // Tools. Optional: headless profiles can run without the tools service, and
  // cordis forbids reading `ctx.tools` unless the service is declared in the
  // plugin's `inject`. The dependency is declared here (nested), so the plugin
  // still activates — prompt sections + host bridge — when no tools exist.
  // -------------------------------------------------------------------------
  let toolCount = 0;
  if (config.tools !== false) ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.tools;
    const register = (definition) => {
      tools.register(definition);
      toolCount += 1;
    };
    const output = {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    };

    register({
      name: 'sunder_status',
      description: 'Show dsh-sunder status: version, language, pinned prompt sections, unread announcements, update-check cache, state file path.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output,
      async execute() {
        const notice = runtime.updateNotice;
        const update = notice?.error !== undefined
          ? `error: ${notice.error}`
          : notice?.newer === true ? `${notice.latest} available (${notice.url})` : 'up to date';
        return {
          text: [
            `dsh-sunder ${VERSION}`,
            `language=${language} preset=${config.preset} think_header=${prompt.thinkHeader === null ? 'off' : `on (${prompt.thinkHeader})`} fake_history=${prompt.fakeHistory === null ? 'off' : 'on'} sections=on guard=${config.guard === false ? 'off' : 'on'}`,
            `announcements=${config.announcements === false ? 'off' : `on (unread ${runtime.unread.length})`} update_check=${config.updateCheck === false ? 'off' : 'on'}`,
            `placements=${sections.map((section) => `${section.name}@${section.order}`).join(', ')}`,
            `update=${update}`,
            `feed=${config.feedUrl} (source=${runtime.feedSource ?? 'none'})`,
            `feed_error=${runtime.feedError ?? 'none'}`,
            `announce_limit=${config.announceLimit ?? 3}`,
            `state=${stateFile}`,
            `repo=https://github.com/${config.repo}`,
          ].join('\n'),
        };
      },
    });

    register({
      name: 'sunder_notice',
      description: 'List, acknowledge, or refresh dsh-sunder announcements from the remote feed. Actions: list (default) | ack id | ack-all | refresh. refresh re-fetches the feed immediately instead of reusing the cached runtime state.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'ack', 'ack-all', 'refresh'], description: 'list shows unread announcements; ack dismisses one id; ack-all dismisses every unread one; refresh re-fetches the feed right now and reports unread=<n>, source=<url|bundled|none>, plus feed_error=<...> when the fetch failed.' },
          id: { type: 'string', description: 'Announcement id for action=ack.' },
        },
      },
      output,
      async execute(args = {}) {
        const action = args?.action ?? 'list';
        if (action === 'refresh') {
          // 立刻重拉 feed（走 announceLimit 与 state 里的已读集合），再用刷新后的
          // runtime 状态回报结果；feed 失败时 refreshAnnouncements 已把原因写进
          // runtime.feedError，与 sunder_status 的 feed_error= 行同源。
          await refreshAnnouncements();
          const lines = [
            'refreshed',
            `unread=${runtime.unread.length}`,
            `source=${runtime.feedSource ?? 'none'}`,
          ];
          if (runtime.feedError !== undefined && runtime.feedError !== null) {
            lines.push(`feed_error=${runtime.feedError}`);
          }
          return { text: lines.join('\n') };
        }
        if (action === 'ack' || action === 'ack-all') {
          const targets = action === 'ack-all' ? runtime.unread.map((item) => item.id) : [args?.id].filter((id) => typeof id === 'string' && id.length > 0);
          if (targets.length === 0) return { text: action === 'ack' ? 'ERROR: id is required for action=ack' : 'no unread announcements' };
          for (const id of targets) ackAnnouncement(state, id);
          persist();
          await refreshAnnouncements();
          return { text: `acknowledged ${targets.length} announcement(s); unread=${runtime.unread.length}` };
        }
        return { text: renderAnnouncements(runtime.unread, language) || 'no unread announcements' };
      },
    });

    register({
      name: 'sunder_update',
      description: 'Check for or apply a dsh-sunder release. action=check (default) forces a GitHub release check (ignoring the cache) and reports the latest version, release URL, and whether an upgrade is available. action=apply downloads the newest release, validates the package name, replaces the files in this install, and reports applied/from/to/backup — restart DSH afterwards.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['check', 'apply'],
            description: 'check (default) only reports the latest release; apply downloads it and replaces the installed files. apply refuses to run unless a backup snapshot was written first; pass force=true to skip the backup explicitly.',
          },
          force: {
            type: 'boolean',
            description: 'apply only: proceed even when the backup snapshot could not be written. Without a snapshot there is no rollback path, so this is an explicit acceptance of that risk.',
          },
        },
      },
      output,
      async execute(args = {}) {
        const action = args?.action === 'apply' ? 'apply' : 'check';
        if (action === 'check') {
          const result = await runUpdateCheck(true);
          if (result === undefined) return { text: 'update check is disabled' };
          if (result.error !== undefined) return { text: `update check failed: ${result.error}` };
          return {
            text: [
              `installed=${VERSION}`,
              `latest=${result.latest}`,
              `upgrade=${result.newer === true ? 'yes' : 'no'}`,
              result.url === undefined ? '' : `url=${result.url}`,
              result.notes === undefined ? '' : `notes=${result.notes}`,
              `checked_at=${result.checkedAt}`,
            ].filter(Boolean).join('\n'),
          };
        }

        // action=apply: snapshot the checkout, then let lib/update.js replace it.
        // An explicit apply ignores the `updateCheck` switch — that switch only
        // governs background/check requests — and never throws into the harness.
        const target = CHECKOUT_DIR;
        const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
        const snapshotPath = join(dirname(stateFile), 'backups', `${stamp}-v${VERSION}`);
        const snapshot = snapshotCheckout(target, snapshotPath);
        if (snapshot.dir === undefined && args?.force !== true) {
          // `applyUpdate()` keeps no rollback copy and never throws, so the
          // snapshot is the only way back from a half-written install. A missing
          // backup is a reason to refuse, not a best-effort detail.
          try {
            rmSync(snapshotPath, { recursive: true, force: true });
          } catch {
            /* a partial copy that cannot be removed is harmless */
          }
          return {
            text: renderApplyReport({
              result: { ok: false, error: 'snapshot-failed' },
              language,
              installed: VERSION,
              target,
            }).text,
          };
        }
        let result;
        try {
          result = await applyUpdate({
            repo: config.repo,
            currentVersion: VERSION,
            dir: target,
            log: (message) => debug('apply:', message),
          });
        } catch (error) {
          result = { ok: false, error: String(error?.message ?? error) };
        }
        let backup = snapshot.dir;
        if (didApply(result) !== true && backup !== undefined) {
          // Nothing was replaced (up to date, offline, rejected download): drop
          // the snapshot instead of leaving clutter behind.
          try {
            rmSync(backup, { recursive: true, force: true });
          } catch {
            /* an undeletable snapshot is harmless */
          }
          backup = undefined;
        }
        return { text: renderApplyReport({ result, language, installed: VERSION, target, backup }).text };
      },
    });
    register({
      name: 'sunder_config',
      description: 'Show the effective dsh-sunder configuration (language, preset, feature switches, feed sources, repo) and where the state file lives.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output,
      async execute() {
        const mirrors = Array.isArray(config.feedMirrors) ? config.feedMirrors : [];
        return {
          text: [
            `dsh-sunder ${VERSION}`,
            `enabled=${config.enabled !== false}`,
            `language=${language} (raw ${String(config.language)}) preset=${config.preset} think_header=${prompt.thinkHeader === null ? 'off' : 'on'} fake_history=${prompt.fakeHistory === null ? 'off' : 'on'}`,
            `think_header_value=${prompt.thinkHeader === null ? '(none)' : prompt.thinkHeader}`,
            `fake_history_chars=${prompt.fakeHistory === null ? 0 : prompt.fakeHistory.length}`,
            `announcements=${config.announcements !== false} limit=${config.announceLimit} bundled_fallback=${config.bundledAnnouncements !== false}`,
            // required contexts are charged to every assembly, so the running
            // cost of the announcement block has to be observable.
            `announcement_chars=${config.announcements === false ? 0 : renderAnnouncements(runtime.unread, language).length} card_chars=${prompt.card.length}`,
            `feed=${config.feedUrl}`,
            `feed_mirrors=${mirrors.length === 0 ? '(built-in only)' : mirrors.join(', ')} builtin_mirrors=${config.builtinMirrors !== false}`,
            `update_check=${config.updateCheck !== false} interval_hours=${config.updateIntervalHours} repo=https://github.com/${config.repo}`,
            `tools=${config.tools !== false} guard=${config.guard !== false} debug=${config.debug === true}`,
            `extra_prompt=${config.extraPrompt === '' ? '(none)' : `${config.extraPrompt.length} chars`}`,
            `state=${stateFile}`,
          ].join('\n'),
        };
      },
    });

    register({
      name: 'sunder_prompt',
      description: 'Preview the exact prompt sections dsh-sunder registers (identity, rules, footer) plus the per-turn rule card serialized into the message list, optionally for another language or preset. Useful for debugging what the model sees.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          language: { type: 'string', enum: ['zh', 'en'], description: 'Override the language pack for this preview.' },
          preset: { type: 'string', enum: ['full', 'concise', 'dev'], description: 'Override the preset for this preview.' },
          section: { type: 'string', enum: ['all', 'identity', 'rules', 'footer', 'card'], description: 'Which section to print (default all). `card` is the per-turn user message, not a prompt section.' },
        },
      },
      output,
      async execute(args = {}) {
        const previewLanguage = args?.language === 'zh' || args?.language === 'en' ? args.language : language;
        const previewPreset = typeof args?.preset === 'string' ? args.preset : config.preset;
        const preview = buildPrompt({
          language: previewLanguage,
          preset: previewPreset,
          thinkHeader: config.thinkHeader,
          fakeHistory: config.fakeHistory,
          extraPrompt: typeof config.extraPrompt === 'string' ? config.extraPrompt.trim() : '',
          version: VERSION,
        });
        const which = args?.section ?? 'all';
        const parts = which === 'all'
          ? [
              `## identity (order ${SECTION_TABLE[0].order})`, preview.identity, '',
              `## rules (order ${SECTION_TABLE[1].order})`, preview.rules, '',
              `## footer (order ${SECTION_TABLE[2].order})`, preview.footer, '',
              '## card (request-time user message, not a section)', preview.card,
            ]
          : [`## ${which}`, preview[which]];
        return {
          text: [
            `language=${previewLanguage} preset=${previewPreset} think_header=${preview.thinkHeader === null ? 'off' : `on (${preview.thinkHeader})`} fake_history=${preview.fakeHistory === null ? 'off' : 'on'} version=${VERSION}`,
            ...parts,
          ].join('\n'),
        };
      },
    });
  });

  console.info(`[dsh-sunder] v${VERSION} active — language=${language}, preset=${config.preset}, think_header=${prompt.thinkHeader === null ? 'off' : 'on'}, fake_history=${prompt.fakeHistory === null ? 'off' : 'on'}, prompt sections registered, guard=${config.guard === false ? 'off' : 'on'}`);
}
