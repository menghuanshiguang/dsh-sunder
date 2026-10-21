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
  check(card?.source?.kind === 'plugin' && card?.source?.plugin === 'dsh-sunder', 'rule card is attributed to the plugin', JSON.stringify(card?.source));
  check(card?.content?.[0]?.text.includes('本轮'), 'rule card carries the zh operative clause', String(card?.content?.[0]?.text).slice(0, 40));
  check(firstTurn.messages[0] === claimed[0], 'the user request stays first and untouched');

  const again = await preStep({ agent: { id: 'a1' }, turn: 1, step: 1, messages: claimed, signal: { aborted: false } }, async () => enter);
  check(again.messages.length === 1, 'the same turn is never injected twice');

  const secondTurn = await preStep({ agent: { id: 'a1' }, turn: 2, step: 1, messages: claimed, signal: { aborted: false } }, async () => enter);
  check(secondTurn.messages.length === 2, 'the next turn gets its own card');

  const toolStep = await preStep({ agent: { id: 'a1' }, turn: 3, step: 2, messages: claimed, signal: { aborted: false } }, async () => enter);
  check(toolStep.messages.length === 1, 'tool rounds inherit the card instead of restating it');

  const emptyTurn = await preStep({ agent: { id: 'a1' }, turn: 4, step: 1, messages: [], signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }));
  check(emptyTurn.messages.length === 0, 'a no-input turn is not turned into a request');

  // Runtime notices must survive a scoped suppression of optional context.
  const optional = contexts.filter((entry) => entry.required === true).map((entry) => entry.name);
  check(optional.includes('sunder:update') && optional.includes('sunder:announcements'), 'update and announcement contexts are required', optional.join(','));
} finally {
  rmSync(home, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nguard: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nguard: OK');
