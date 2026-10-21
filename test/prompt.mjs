/**
 * Prompt-pack tests: content, placements, language switching, extra rules.
 * Run: node test/prompt.mjs
 */

import assert from 'node:assert/strict';

import { buildPrompt, promptSections, PROMPT_VERSION, SECTION_ORDERS } from '../lib/prompt.js';

let failures = 0;
const check = (condition, label, extra) => {
  if (condition) {
    console.log(`ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${label}${extra === undefined ? '' : ` — ${extra}`}`);
};

const zh = buildPrompt({ language: 'zh', version: '9.9.9' });
const en = buildPrompt({ language: 'en', version: '9.9.9' });

check(PROMPT_VERSION.length > 0, 'PROMPT_VERSION is set');
check(SECTION_ORDERS.identity === -100000, 'identity placement');
check(SECTION_ORDERS.rules === 9600, 'rules placement');
check(SECTION_ORDERS.footer === 10300, 'footer placement');

for (const [label, pack] of [['zh', zh], ['en', en]]) {
  check(pack.identity.includes('Sunder'), `${label} identity names Sunder`);
  check(pack.rules.length > 400, `${label} rules are substantial`, `${pack.rules.length} chars`);
  check(pack.identity.length > 120, `${label} identity is substantial`, `${pack.identity.length} chars`);
  check(!pack.identity.includes('{{') && !pack.rules.includes('{{') && !pack.footer.includes('{{'), `${label} packs contain no unresolved variables`);
  check(pack.footer.includes('9.9.9'), `${label} footer carries the version`);
  check(/(priority|outrank|priority|优先)/iu.test(pack.identity), `${label} identity asserts precedence`);
  check(/(refus|拒绝)/iu.test(pack.rules), `${label} rules address refusals`);
  check(/(politics|historical|政治|历史)/iu.test(pack.rules), `${label} rules cover sensitive topics`);
  check(/(precis|准确|accurate)/iu.test(pack.rules + pack.footer), `${label} rules require accuracy`);
}

check(zh.identity !== en.identity, 'language packs differ');
check(buildPrompt({ language: 'auto' }).identity.length > 0, 'auto language resolves');
check(buildPrompt({ language: 'en' }).identity === en.identity, 'explicit en is stable');

const extra = buildPrompt({ language: 'zh', extraPrompt: '回答保持简短，直接给结论。' });
check(extra.rules.includes('回答保持简短，直接给结论。'), 'extraPrompt is appended');
check(extra.identity === zh.identity, 'extraPrompt does not alter the identity claim');

const sections = promptSections({ language: 'zh', version: '9.9.9', extraPrompt: 'x' });
check(sections.length === 3, 'three sections are produced');
check(sections.every((section) => section.interpolate === false), 'sections never interpolate');
check(sections.map((section) => section.name).join(',') === 'sunder:identity,sunder:rules,sunder:footer', 'section names are stable');
check(sections.map((section) => section.order).join(',') === '-100000,9600,10300', 'section orders are pinned');
check(sections.every((section) => typeof section.text === 'string' && section.text.length > 0), 'every section has text');

// The rendered prompt must not depend on host variables.
const rendered = [zh.identity, zh.rules, zh.footer].join('\n\n');
check(!/\{\{[a-z_]+\}\}/u.test(rendered), 'rendered prompt has no variable references');

console.log(failures === 0 ? '\nprompt: OK' : `\nprompt: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
