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
  const ctx = {
    systemPrompt: prompt,
    on() {
      return () => {};
    },
    effect(run) {
      if (typeof run === 'function') run();
      return () => {};
    },
  };
  return { ctx, sections, contexts, prompt };
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

const { ctx, sections, contexts, prompt } = createCtx();

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
