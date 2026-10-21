/**
 * Integration smoke test against a REAL DeepSeek Harness runtime.
 *
 * Boots the installed `@deepseek-ai/dsh-system-prompt` service (the same code
 * the desktop app runs), applies the Sunder bundle with a stub `tools` service,
 * and asserts:
 *
 *   1. the three sunder sections are registered and rendered
 *   2. the rendered prompt carries the identity claim, rules, and footer
 *   3. the guard survives a competing `complete: true` section
 *   4. repeated assemblies do not nest the guard (no proxy blow-up)
 *   5. the tools are registered against the real tool-service contract
 *   6. sunder_notice exposes action=refresh and sunder_status reports
 *      announce_limit (schema + non-networked execution path only)
 *
 * Run: node test/smoke.mjs
 * Env: DSH_RUNTIME_DIR (default D:/DSHPC/resources/app/dsh)
 *      DSH_PROFILE_VERSION (optional; only used in the summary line)
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNTIME = (process.env.DSH_RUNTIME_DIR ?? 'D:/DSHPC/resources/app/dsh').replaceAll('\\', '/');
const anchor = `${RUNTIME}/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js`;

if (!existsSync(anchor)) {
  console.log(`smoke: skipped (no DSH runtime at ${RUNTIME}; set DSH_RUNTIME_DIR to run it)`);
  process.exit(0);
}

const runtimeFile = (rel) => pathToFileURL(`${RUNTIME}/${rel}`).href;
const { Context, Service } = await import(runtimeFile('node_modules/@deepseek-ai/cordis/lib/index.js'));
const promptModule = await import(runtimeFile('node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'));
const SystemPrompt = promptModule.default ?? promptModule.SystemPrompt ?? promptModule;
const { renderPrompt } = promptModule;
const sunder = await import('../index.js');

let failures = 0;
const check = (condition, label, extra) => {
  if (condition) {
    console.log(`ok   ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${label}${extra === undefined ? '' : ` — ${extra}`}`);
};
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools');
    this.registered = [];
  }
  register(definition) {
    this.registered.push(definition);
    return () => {};
  }
}

const stateHome = mkdtempSync(join(tmpdir(), 'sunder-smoke-'));
process.env.DSH_HOME = stateHome;

const ctx = new Context();
ctx.plugin(SystemPrompt, {
  includeHarnessIdentity: false,
  includeRuntimeContext: true,
  personaPrefix: 'You are a coding agent powered by the {{model}} model.',
  personaSuffix: 'Your working directory is {{cwd}}.',
});
ctx.plugin(FakeTools);
await settle();

// Provide the two variables the deployment personas reference, so the host
// renderer does not throw before Sunder can be exercised.
ctx.systemPrompt.variable('model', () => 'smoke-model');
ctx.systemPrompt.variable('cwd', () => process.cwd());

sunder.apply(ctx, { language: 'zh', announcements: false, updateCheck: false });
await settle(120);

const prompt = ctx.systemPrompt;
check(prompt !== undefined, 'system-prompt service resolves through ctx');

let assembled;
try {
  assembled = await prompt.assemble({ agent: { session: { id: 'smoke' }, options: {} } });
} catch (error) {
  check(false, 'assemble succeeds', error.message);
}
if (assembled !== undefined) {
  const names = assembled.sections.map((section) => section.name);
  check(names.includes('sunder:identity'), 'identity section is registered');
  check(names.includes('sunder:rules'), 'rules section is registered');
  check(names.includes('sunder:footer'), 'footer section is registered');
  check(!names.includes('harness:identity'), 'bundle patch turns the harness identity off');
  check(names.indexOf('sunder:identity') === 0, 'identity is the first section', names.join(', '));
  check(names.at(-1) === 'sunder:footer', 'footer is the last section', names.at(-1));

  const rendered = renderPrompt(assembled);
  check(rendered.includes('Sunder 模式'), 'rendered prompt carries the zh identity claim');
  check(rendered.includes('Sunder 运行规则'), 'rendered prompt carries the rules');
  check(rendered.includes('[Sunder'), 'rendered prompt carries the footer');
  check(rendered.includes(`[sunder ${sunder.VERSION}]`), 'footer carries the version');
  check(!rendered.includes('{{'), 'rendered prompt has no unresolved variables');
  check(rendered.length > 600, 'rendered prompt is substantial', `${rendered.length} chars`);
}

// A competing complete section replaces every section after the waterfall; the
// guard must take the whole prompt back. Letting a rival authority sit next to
// our rules would leave two answers to the same question in one prompt.
const rival = {
  name: 'smoke-rival',
  inject: ['systemPrompt'],
  apply(context) {
    context.systemPrompt.section({
      name: 'rival:complete',
      order: 200000,
      text: 'RIVAL COMPLETE ONLY',
      complete: true,
    });
  },
};
ctx.plugin(rival);
await settle();

let guarded;
try {
  guarded = await prompt.assemble({ agent: { session: { id: 'smoke' }, options: {} } });
} catch (error) {
  check(false, 'guarded assemble succeeds', error.message);
}
if (guarded !== undefined) {
  const text = renderPrompt(guarded);
  check(!text.includes('RIVAL COMPLETE ONLY'), 'a foreign complete section is replaced, not merged', `sections=${guarded.sections.map((s) => s.name).join(',')} | ${text.slice(0, 120)}`);
  check(text.includes('Sunder 模式'), 'guard reclaims the identity claim after a complete section');
  check(text.includes('[Sunder'), 'guard re-attaches the footer after a complete section');
}

// Repeated reads/installations must not nest wrappers; 50 assemblies would
// overflow the stack with the naive assignment approach.
let repeated = true;
for (let index = 0; index < 50; index += 1) {
  try {
    const assembly = await prompt.assemble({ agent: { session: { id: 'smoke' }, options: {} } });
    if (!renderPrompt(assembly).includes('Sunder 模式')) repeated = false;
  } catch {
    repeated = false;
    break;
  }
}
check(repeated, 'fifty repeated assemblies stay stable');
check(prompt.assemble !== undefined, 'assemble stays readable through the accessor');

const tools = ctx.get('tools')?.registered ?? [];
const names = tools.map((tool) => tool.name);
check(tools.length === 5, 'exactly five tools registered', names.join(', '));
for (const name of ['sunder_status', 'sunder_notice', 'sunder_update', 'sunder_config', 'sunder_prompt']) {
  check(names.includes(name), `${name} registered`);
}
const updateTool = tools.find((tool) => tool.name === 'sunder_update');
check(
  Array.isArray(updateTool?.parameters?.properties?.action?.enum)
  && updateTool.parameters.properties.action.enum.includes('apply'),
  'sunder_update exposes action=check|apply',
);
const promptTool = tools.find((tool) => tool.name === 'sunder_prompt');
check(
  Array.isArray(promptTool?.parameters?.properties?.preset?.enum),
  'sunder_prompt exposes the preset parameter',
);
check(tools.every((tool) => typeof tool.execute === 'function'), 'every tool exposes execute');
check(tools.every((tool) => tool.output && typeof tool.output.render === 'function'), 'every tool exposes output.render');
check(tools.every((tool) => tool.parameters && tool.parameters.type === 'object'), 'every tool exposes an object parameter schema');

// ---------------------------------------------------------------------------
// 1.2.0: sunder_notice gained action=refresh; sunder_status gained announce_limit.
// No network is touched below: this smoke run applies the bundle with
// announcements:false, so refreshAnnouncements() returns before any fetch.
// ---------------------------------------------------------------------------
const noticeTool = tools.find((tool) => tool.name === 'sunder_notice');
const noticeEnum = noticeTool?.parameters?.properties?.action?.enum;
check(
  Array.isArray(noticeEnum) && noticeEnum.includes('refresh'),
  "sunder_notice exposes action=...|refresh",
  Array.isArray(noticeEnum) ? noticeEnum.join('|') : String(noticeEnum),
);
check(
  ['list', 'ack', 'ack-all'].every((action) => Array.isArray(noticeEnum) && noticeEnum.includes(action)),
  'sunder_notice keeps action=list|ack|ack-all',
  Array.isArray(noticeEnum) ? noticeEnum.join('|') : String(noticeEnum),
);
check(
  typeof noticeTool?.description === 'string' && /refresh/i.test(noticeTool.description),
  'sunder_notice description documents refresh',
  String(noticeTool?.description),
);

if (noticeTool !== undefined && typeof noticeTool.execute === 'function') {
  const refreshed = await noticeTool.execute({ action: 'refresh' });
  const refreshedLines = String(refreshed?.text ?? '').split('\n');
  check(refreshedLines[0] === 'refreshed', 'sunder_notice action=refresh starts with refreshed', refreshedLines.join('|'));
  check(refreshedLines.includes('unread=0'), 'sunder_notice action=refresh reports unread=<n>', refreshedLines.join('|'));
  check(refreshedLines.includes('source=none'), 'sunder_notice action=refresh reports source=<...>', refreshedLines.join('|'));
  check(
    refreshedLines.every((line) => line.startsWith('feed_error=') === false),
    'sunder_notice action=refresh omits feed_error when nothing failed',
    refreshedLines.join('|'),
  );
  const listed = await noticeTool.execute({ action: 'list' });
  check(String(listed?.text) === 'no unread announcements', 'sunder_notice action=list keeps its 1.1.0 text', String(listed?.text));
}

const statusTool = tools.find((tool) => tool.name === 'sunder_status');
if (statusTool !== undefined && typeof statusTool.execute === 'function') {
  const statusLines = String((await statusTool.execute({}))?.text ?? '').split('\n');
  check(statusLines.includes('announce_limit=3'), 'sunder_status reports announce_limit=3', statusLines.join('|'));
  check(statusLines.some((line) => line.startsWith('feed=')), 'sunder_status keeps the feed= line', statusLines.join('|'));
  check(statusLines.includes('feed_error=none'), 'sunder_status keeps the feed_error= line', statusLines.join('|'));
}

ctx.dispose?.();
rmSync(stateHome, { recursive: true, force: true });

console.log(failures === 0 ? '\nsmoke: OK' : `\nsmoke: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
