/**
 * Offline guard test: the assembly guard against a minimal fake registry.
 *
 * `test/smoke.mjs` needs a real DSH runtime, so on a machine without one the
 * guard had no coverage at all. This test reproduces the one host behaviour the
 * guard exists for — a `complete` section replacing every provider section —
 * with a ~40-line stand-in, and asserts the takeover is reversed.
 *
 * Run: node test/guard.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'sunder-guard-'));
process.env.DSH_HOME = home;

const sunder = await import('../index.js');

/** Capture warnings: the takeover notice is asserted to fire exactly once. */
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => {
  warnings.push(args.join(' '));
};

/** Minimal stand-in for @deepseek-ai/dsh-system-prompt. */
function createCtx() {
  const sections = [];
  const contexts = [];
  const prompt = {
    section(definition) {
      sections.push({ ...definition });
      return () => {};
    },
    context(definition) {
      contexts.push({ ...definition });
      return () => {};
    },
    // The real registry restores a lone `complete` section as the whole prompt
    // after the cooperative waterfall has run.
    async assemble() {
      const complete = sections.filter((section) => section.complete === true);
      const effective = complete.length === 0 ? [...sections] : [complete.at(-1)];
      const text = (value) => (typeof value === 'function' ? value({}) : value);
      return {
        sections: effective.map((section) => ({
          name: section.name,
          text: text(section.text),
          interpolate: section.interpolate,
        })),
        contexts: contexts.map((entry) => ({ name: entry.name, text: text(entry.text) })),
        tools: [],
        variables: {},
      };
    },
  };
  const listeners = new Map();
  const ctx = {
    systemPrompt: prompt,
    // cordis hands each service to a nested inject callback; mirror that shape
    // so the plugin can declare `tools` / `webServer` without reading them off
    // this fake context directly (`ctx.tools` is what throws in a real host).
    inject(names, callback) {
      if (!Array.isArray(names) || typeof callback !== 'function') return;
      if (names.includes('tools')) callback({ tools: { register: () => () => {} } });
      else if (names.includes('webServer')) callback({ webServer: undefined });
    },
    on(name, handler) {
      listeners.set(name, handler);
      return () => {};
    },
    effect(run) {
      if (typeof run === 'function') run();
      return () => {};
    },
  };
  return { ctx, sections, contexts, prompt, listeners };
}

let failures = 0;
const check = (condition, label, extra) => {
  if (condition) {
    console.log(`ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${label}${extra === undefined ? '' : ` — ${extra}`}`);
};

const { ctx, sections, contexts, prompt, listeners } = createCtx();

try {
  sunder.apply(ctx, { announcements: false, updateCheck: false, language: 'zh' });

  const names = (assembly) => assembly.sections.map((section) => section.name);

  const plain = await prompt.assemble();
  check(names(plain).join(',') === 'sunder:identity,sunder:rules,sunder:footer', 'plain assembly carries the three sections', names(plain).join(','));
  check(plain.sections.every((section) => typeof section.text === 'string' && section.text.length > 0), 'every assembly section carries text');

  // The registry registration itself: pinned orders and literal text.
  const registered = sections.map((section) => `${section.name}@${section.order}`);
  check(registered.join(',') === 'sunder:identity@-100000,sunder:rules@10150,sunder:footer@10300', 'sections keep their pinned orders', registered.join(','));

  // A rival `complete` section is restored by the registry as the sole section.
  prompt.section({ name: 'rival:complete', order: 200000, text: 'RIVAL COMPLETE ONLY', complete: true });

  const guarded = await prompt.assemble();
  check(!names(guarded).includes('rival:complete'), 'a foreign complete section is replaced, not merged', `sections=${names(guarded).join(',')}`);
  check(names(guarded).join(',') === 'sunder:identity,sunder:rules,sunder:footer', 'the guard takes the whole prompt back', names(guarded).join(','));
  check(!guarded.sections.some((section) => section.text.includes('RIVAL')), 'the rival text never reaches the model', String(guarded.sections.length));

  // Repeated assemblies must not nest wrappers (50 would overflow a naive one).
  let stable = true;
  for (let index = 0; index < 50; index += 1) {
    const again = await prompt.assemble();
    if (again.sections.length !== 3) stable = false;
  }
  check(stable, 'fifty repeated assemblies stay stable');

  // Per-turn rule card: a real user-role message admitted with the request, so
  // it lands after the runtime-context snapshot and immediately before the answer.
  const preStep = listeners.get('agent/pre-step');
  check(typeof preStep === 'function', 'pre-step listener registered');

  const claimed = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'human' } }];
  const enter = { kind: 'enter', messages: claimed };
  const firstTurn = await preStep({ agent: { id: 'a1' }, turn: 1, step: 1, messages: claimed, signal: { aborted: false } }, async () => enter);
  const card = firstTurn.messages.at(-1);
  check(firstTurn.messages.length === 2, 'rule card is appended to the admitted batch', String(firstTurn.messages.length));
  check(card?.role === 'user', 'rule card uses the user role', String(card?.role));
  check(
    card?.source?.kind === sunder.PRODUCER_KIND && !Object.hasOwn(card?.source ?? {}, 'plugin'),
    'rule card carries the producer-owned source kind',
    JSON.stringify(card?.source),
  );
  check(card?.content?.[0]?.text.includes('本轮'), 'rule card carries the zh operative clause', String(card?.content?.[0]?.text).slice(0, 40));
  check(firstTurn.messages[0] === claimed[0], 'the user request stays first and untouched');

  const again = await preStep({ agent: { id: 'a1' }, turn: 1, step: 1, messages: claimed, signal: { aborted: false } }, async () => enter);
  check(again.messages.length === 1, 'the same turn is never injected twice');

  const secondTurn = await preStep({ agent: { id: 'a1' }, turn: 2, step: 1, messages: claimed, signal: { aborted: false } }, async () => enter);
  check(secondTurn.messages.length === 2, 'the next turn gets its own card');

  // Warm-up exchange: written once per session as two real events (a user
  // question and a model-source assistant commitment), before the request.
  const appended = [];
  const session = {
    id: 'warm-session',
    append(type, data, options) {
      appended.push({ type, data, options });
      return { type, seq: appended.length - 1 };
    },
    deriveMessages() {
      return appended.map((entry) => (entry.type === 'assistant/message' ? entry.data.message : { ...entry.data, role: 'user' }));
    },
  };
  const warmAgent = { id: 'warm-1', options: { provider: 'deepseek-account', model: 'deepseek-flash' }, session };
  await preStep({ agent: warmAgent, turn: 1, step: 1, messages: claimed, signal: { aborted: false } }, async () => enter);
  check(appended.length === 2, 'warmup writes two events', String(appended.length));
  check(appended[0]?.type === 'user/message' && appended[0]?.data?.role === 'user', 'warmup question is a real user message', JSON.stringify(appended[0]?.type));
  check(appended[1]?.type === 'assistant/message' && appended[1]?.data?.message?.role === 'assistant', 'warmup commitment is a real assistant message');
  check(
    appended[1]?.data?.message?.source?.kind === 'model'
      && appended[1]?.data?.message?.source?.provider === 'deepseek-account'
      && appended[1]?.data?.message?.source?.model === 'deepseek-flash',
    'warmup commitment carries the host provider/model source',
    JSON.stringify(appended[1]?.data?.message?.source),
  );
  check(appended.every((entry) => entry.options?.surfaceOp === 'append'), 'warmup events are appended to the surface');
  check(appended.every((entry) => entry.data?.source?.warmup === true || entry.data?.message?.source?.warmup === true), 'warmup events are tagged for dedupe');
  check(appended[0]?.data?.turn === undefined && appended[0]?.data?.step === undefined, 'warmup question keeps the bare user/message data shape');
  check(Array.isArray(appended[1]?.data?.stream) && appended[1].data.stream.length === 0, 'warmup commitment carries the settlement stream array');
  check(appended[1]?.data?.usage !== undefined && typeof appended[1].data.usage.totalTokens === 'number', 'warmup commitment carries settlement usage');
  check(appended[1]?.data?.turn === 1 && appended[1]?.data?.step === 1, 'warmup commitment is stamped with the open turn/step');

  await preStep({ agent: warmAgent, turn: 2, step: 1, messages: claimed, signal: { aborted: false } }, async () => enter);
  check(appended.length === 2, 'warmup is written once per session', String(appended.length));

  const noModel = { id: 'warm-2', options: {}, session: { id: 'warm-session-2', append: () => { throw new Error('should not append'); }, deriveMessages: () => [] } };
  let noModelError;
  try {
    await preStep({ agent: noModel, turn: 1, step: 1, messages: claimed, signal: { aborted: false } }, async () => enter);
  } catch (error) {
    noModelError = error;
  }
  check(noModelError === undefined, 'warmup is skipped when the agent has no provider/model', String(noModelError));

  const toolStep = await preStep({ agent: { id: 'a1' }, turn: 3, step: 2, messages: claimed, signal: { aborted: false } }, async () => enter);
  check(toolStep.messages.length === 1, 'tool rounds inherit the card instead of restating it');

  const emptyTurn = await preStep({ agent: { id: 'a1' }, turn: 4, step: 1, messages: [], signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }));
  check(emptyTurn.messages.length === 0, 'a no-input turn is not turned into a request');

  // The waterfall re-arms the guard: a host that swapped `assemble` for a plain
  // function gets wrapped again on the next assembly, with no polling window.
  const bare = async () => ({
    sections: [{ name: 'rival:complete', text: 'RIVAL AGAIN', interpolate: true }],
    contexts: [],
    tools: [],
    variables: {},
  });
  prompt.assemble = bare;
  const waterfall = listeners.get('system-prompt/assemble');
  check(typeof waterfall === 'function', 'assemble waterfall registered');
  if (typeof waterfall === 'function') {
    await waterfall(
      { sections: [], contexts: [], tools: [], variables: {} },
      {},
      async () => bare(),
    );
    const repaired = await prompt.assemble();
    check(repaired.sections.map((section) => section.name).join(',') === 'sunder:identity,sunder:rules,sunder:footer',
      'the waterfall re-arms the guard on the current service', repaired.sections.map((section) => section.name).join(','));
  }

  // Runtime notices must survive a scoped suppression of optional context.
  const optional = contexts.filter((entry) => entry.required === true).map((entry) => entry.name);
  check(optional.includes('sunder:update') && optional.includes('sunder:announcements'), 'update and announcement contexts are required', optional.join(','));
  const takeoverWarnings = warnings.filter((line) => line.includes('complete section'));
  check(takeoverWarnings.length === 1, 'the takeover warning fires exactly once per process', String(takeoverWarnings.length));
  check(takeoverWarnings[0]?.includes('rival:complete'), 'the warning names the displaced section', takeoverWarnings[0]);
} finally {
  console.warn = realWarn;
  rmSync(home, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nguard: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nguard: OK');
