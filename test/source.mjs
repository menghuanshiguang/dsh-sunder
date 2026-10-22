/**
 * Regression test for the V4 message-source admission rule.
 *
 * Session rows in format V4 accept only a "producer-owned source kind":
 * `source.kind` must be a non-empty string that is not the retired `"plugin"`
 * wrapper. Plugins that wrote `{ kind: "plugin", plugin: "..." }` made every
 * turn fail on write/restore with
 *
 *   format v4 message requires a producer-owned source kind
 *
 * This test feeds both the retired wrapper and the kind this bundle actually
 * stamps (`PRODUCER_KIND`) to the host's own `assertV4RowAdmission`, so the
 * rule is checked against the runtime instead of a copy of it.
 *
 * Run: node test/source.mjs
 * Env: DSH_RUNTIME_DIR (default D:/DSHPC/resources/app/dsh)
 */

import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'sunder-source-'));
process.env.DSH_HOME = home;

const runtimeDir = (process.env.DSH_RUNTIME_DIR ?? 'D:/DSHPC/resources/app/dsh').replaceAll('\\', '/');
const formatEntry = `${runtimeDir}/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js`;

const results = [];
function check(ok, label, detail = '') {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

function message(source, id = 'm1') {
  return { id, role: 'user', content: [{ type: 'text', text: 'hello' }], source };
}

function row(type, data) {
  return { type, seq: 1, time: Date.now(), data };
}

let sunder;
try {
  sunder = await import('../index.js');
} catch (error) {
  console.log(`skip: cannot load the bundle (${error.message})`);
  process.exit(0);
}

check(sunder.PRODUCER_KIND === 'dsh-sunder', 'bundle advertises a producer-owned kind', String(sunder.PRODUCER_KIND));
check(sunder.PRODUCER_KIND !== 'plugin', 'the advertised kind is not the retired wrapper', String(sunder.PRODUCER_KIND));

if (!existsSync(formatEntry)) {
  console.log(`skip: no DSH runtime at ${formatEntry}`);
  console.log('source: SKIPPED (no runtime)');
  process.exit(0);
}

const { assertV4RowAdmission } = await import(pathToFileURL(formatEntry).href);

/** The retired wrapper must be rejected, with the exact user-visible message. */
let retiredError;
try {
  assertV4RowAdmission(row('user/message', message({ kind: 'plugin', plugin: 'dsh-sunder' })));
} catch (error) {
  retiredError = error;
}
check(
  retiredError !== undefined && /producer-owned source kind/u.test(retiredError.message),
  'the retired {kind:"plugin"} wrapper is rejected',
  retiredError?.message?.slice(0, 120),
);

/** The producer-owned kind must pass. */
let admitted;
try {
  assertV4RowAdmission(row('user/message', message({ kind: sunder.PRODUCER_KIND })));
  admitted = true;
} catch (error) {
  admitted = false;
  check(false, 'producer-owned kind is admitted for user/message', error.message);
}
if (admitted) check(true, 'producer-owned kind is admitted for user/message');

/** Assistant messages are admitted through the same rule. */
let assistantError;
try {
  assertV4RowAdmission(row('assistant/message', { message: { role: 'assistant', content: [], source: { kind: 'plugin', plugin: 'dsh-sunder' } } }));
} catch (error) {
  assistantError = error;
}
check(assistantError !== undefined, 'an assistant message with the retired wrapper is rejected', assistantError?.message?.slice(0, 100));

/** Inbox splices validate the messages they insert. */
const insertedBad = {
  type: 'agent/inbox/spliced',
  seq: 2,
  time: Date.now(),
  data: { target: 'next-turn', start: 0, inserted: [message({ kind: 'plugin', plugin: 'dsh-sunder' }, 'm2')] },
};
let splicedError;
try {
  assertV4RowAdmission(insertedBad);
} catch (error) {
  splicedError = error;
}
check(splicedError !== undefined, 'a spliced inbox message with the retired wrapper is rejected', splicedError?.message?.slice(0, 100));

const insertedGood = {
  type: 'agent/inbox/spliced',
  seq: 3,
  time: Date.now(),
  data: { target: 'next-turn', start: 0, inserted: [message({ kind: sunder.PRODUCER_KIND }, 'm3')] },
};
let splicedOk = true;
try {
  assertV4RowAdmission(insertedGood);
} catch (error) {
  splicedOk = false;
  check(false, 'a spliced inbox message with the producer kind is admitted', error.message);
}
if (splicedOk) check(true, 'a spliced inbox message with the producer kind is admitted');

rmSync(home, { recursive: true, force: true });

if (results.some((entry) => !entry.ok)) {
  console.log('\nsource: FAILED');
  process.exit(1);
}
console.log('\nsource: OK');
