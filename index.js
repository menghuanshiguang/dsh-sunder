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

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { DEFAULT_FEED, fetchAnnouncements, renderAnnouncements, selectAnnouncements } from './lib/announcements.js';
import { buildPrompt } from './lib/prompt.js';
import { ackAnnouncement, loadState, markSeen, saveState, statePath } from './lib/state.js';
import { checkForUpdate, DEFAULT_REPO } from './lib/update.js';

const require = createRequire(import.meta.url);
const manifest = require('./package.json');

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
  { name: 'sunder:rules', order: 9600 },
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
  extraPrompt: '',
  announcements: true,
  announceLimit: 3,
  feedUrl: DEFAULT_FEED,
  feedMirrors: [],
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

/** Return the assembly with every sunder section present exactly once. */
function ensureSunderSections(assembly, sections) {
  if (!assembly || !Array.isArray(assembly.sections)) return assembly;
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
  // rules 9600 (before deliverable/harness-source sections), footer 10300
  // (last, after the deployment persona suffix).
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
    text: () => renderAnnouncements(runtime.unread, language),
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

  // A waterfall listener still covers assemblies created without the guard.
  try {
    ctx.on('system-prompt/assemble', async (...args) => {
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
  const guardTimer = setInterval(() => {
    installGuard();
  }, 4000);
  guardTimer.unref?.();
  ctx.effect(() => () => {
    clearInterval(guardTimer);
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
  // Tools. Optional: headless profiles can run without the tools service.
  // -------------------------------------------------------------------------
  if (config.tools !== false && ctx.tools) {
    const output = {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    };

    ctx.tools.register({
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
            `language=${language} sections=on guard=${config.guard === false ? 'off' : 'on'}`,
            `announcements=${config.announcements === false ? 'off' : `on (unread ${runtime.unread.length})`} update_check=${config.updateCheck === false ? 'off' : 'on'}`,
            `placements=${sections.map((section) => `${section.name}@${section.order}`).join(', ')}`,
            `update=${update}`,
            `feed=${config.feedUrl} (source=${runtime.feedSource ?? 'none'})`,
            `feed_error=${runtime.feedError ?? 'none'}`,
            `state=${stateFile}`,
            `repo=https://github.com/${config.repo}`,
          ].join('\n'),
        };
      },
    });

    ctx.tools.register({
      name: 'sunder_notice',
      description: 'List or acknowledge dsh-sunder announcements from the remote feed. Actions: list (default) | ack id | ack-all.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'ack', 'ack-all'], description: 'list shows unread announcements; ack dismisses one id; ack-all dismisses every unread one.' },
          id: { type: 'string', description: 'Announcement id for action=ack.' },
        },
      },
      output,
      async execute(args = {}) {
        const action = args?.action ?? 'list';
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

    ctx.tools.register({
      name: 'sunder_update',
      description: 'Force a dsh-sunder release check against GitHub (ignores the cache) and report the latest version, release URL, and whether an upgrade is available.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output,
      async execute() {
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
      },
    });
  }

  console.info(`[dsh-sunder] v${VERSION} active — language=${language}, prompt sections registered, guard=${config.guard === false ? 'off' : 'on'}`);
}
