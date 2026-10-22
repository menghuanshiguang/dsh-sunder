/**
 * Offline tests for lib/bridge.js — the host-side HTTP bridge.
 *
 * No real HTTP server: requests are Readable streams with `url`/`method`/
 * `headers` attached, responses are tiny recorders. This is exactly the shape
 * `webServer.register({kind:'prefix'})` hands to a handler.
 */
import { Readable } from 'node:stream';

const {
  BRIDGE_PREFIX,
  createBridgeHandler,
  registerSunderBridge,
  sendJson,
  readJsonBody,
  isSameOrigin,
} = await import('../lib/bridge.js');

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function makeReq({ url = '/sunder/api/status', method = 'GET', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')]);
  req.url = url;
  req.method = method;
  req.headers = headers;
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(payload) {
      this.body = payload;
    },
  };
  res.json = () => JSON.parse(res.body);
  return res;
}

const status = {
  version: '1.3.1',
  language: 'zh',
  preset: 'full',
  guard: true,
  unread: 2,
  announcements: [{ id: 'a', acknowledged: false }],
  feed: { url: 'https://example.test/feed.json', source: 'bundled', error: null },
  update: { latest: '1.3.1', newer: false, checkedAt: '2026-10-22T00:00:00Z' },
};
const handlers = {
  status: () => status,
  ack: (payload) => {
    handlers.lastAck = payload;
    return { acked: payload?.all === true ? 2 : 1, status };
  },
  refresh: async () => ({ ...status, refreshed: true }),
};

const handler = createBridgeHandler(handlers);

// 1. GET status ------------------------------------------------------------------
{
  const res = makeRes();
  await handler(makeReq(), res);
  const body = res.json();
  check(res.statusCode === 200, 'GET status returns 200');
  check(res.headers['content-type'].startsWith('application/json'), 'content-type is JSON');
  check(body.ok === true && body.value.version === '1.3.1', 'status envelope carries the snapshot', JSON.stringify(body.value?.version));
  check(body.value.feed.source === 'bundled', 'feed source is forwarded');
}

// 2. POST ack with an id ----------------------------------------------------------
{
  const res = makeRes();
  await handler(makeReq({ url: '/sunder/api/ack', method: 'POST', body: '{"id":"a"}', headers: { 'content-type': 'application/json' } }), res);
  const body = res.json();
  check(res.statusCode === 200 && body.ok === true, 'POST ack returns 200');
  check(body.value.acked === 1, 'ack returns the acked count');
  check(handlers.lastAck?.id === 'a', 'ack handler receives the parsed body');
  check(body.value.status.unread === 2, 'ack returns the refreshed status');
}

// 3. POST ack with all -----------------------------------------------------------
{
  const res = makeRes();
  await handler(makeReq({ url: '/sunder/api/ack', method: 'POST', body: '{"all":true}' }), res);
  check(res.json().value.acked === 2, 'ack all is forwarded');
}

// 4. POST refresh ----------------------------------------------------------------
{
  const res = makeRes();
  await handler(makeReq({ url: '/sunder/api/refresh', method: 'POST', body: '' }), res);
  const body = res.json();
  check(res.statusCode === 200 && body.value.refreshed === true, 'refresh awaits the handler and returns the new status');
}

// 5. method + route errors -------------------------------------------------------
{
  const res = makeRes();
  await handler(makeReq({ url: '/sunder/api/status', method: 'POST', body: '{}' }), res);
  check(res.statusCode === 405, 'status rejects POST', String(res.statusCode));

  const unknown = makeRes();
  await handler(makeReq({ url: '/sunder/api/nope' }), unknown);
  check(unknown.statusCode === 404, 'unknown method returns 404');

  const outside = makeRes();
  await handler(makeReq({ url: '/other/api/status' }), outside);
  check(outside.statusCode === 404, 'paths outside the prefix return 404');

  const nested = makeRes();
  await handler(makeReq({ url: '/sunder/api/a/b' }), nested);
  check(nested.statusCode === 404, 'nested paths return 404');
}

// 6. same-origin guard -----------------------------------------------------------
{
  const bad = makeRes();
  await handler(
    makeReq({ url: '/sunder/api/ack', method: 'POST', body: '{}', headers: { origin: 'https://evil.test', host: '127.0.0.1:50505' } }),
    bad,
  );
  check(bad.statusCode === 403, 'cross-origin POST is rejected', String(bad.statusCode));

  const good = makeRes();
  await handler(
    makeReq({ url: '/sunder/api/ack', method: 'POST', body: '{}', headers: { origin: 'http://127.0.0.1:50505', host: '127.0.0.1:50505' } }),
    good,
  );
  check(good.statusCode === 200, 'same-origin POST is accepted', String(good.statusCode));

  check(isSameOrigin({ headers: {} }) === true, 'requests without Origin pass');
  check(isSameOrigin({ headers: { origin: 'not a url', host: 'x' } }) === false, 'invalid Origin is rejected');
}

// 7. body errors -----------------------------------------------------------------
{
  const bad = makeRes();
  await handler(makeReq({ url: '/sunder/api/ack', method: 'POST', body: '{not json' }), bad);
  check(bad.statusCode === 400 && bad.json().error.code === 'bad-json', 'malformed JSON returns 400');

  const big = makeRes();
  await handler(makeReq({ url: '/sunder/api/ack', method: 'POST', body: JSON.stringify({ id: 'x'.repeat(20000) }) }), big).catch(() => {});
  check(big.statusCode === 413, 'oversized body returns 413', String(big.statusCode));
}

// 8. handler failures ------------------------------------------------------------
{
  const boom = createBridgeHandler({ status: () => { throw new Error('boom'); } });
  const res = makeRes();
  await boom(makeReq(), res);
  check(res.statusCode === 500 && res.json().error.code === 'internal', 'handler failure returns 500');

  const optionals = createBridgeHandler({ status: () => ({ ok: 1 }) });
  const ack = makeRes();
  await optionals(makeReq({ url: '/sunder/api/ack', method: 'POST', body: '{}' }), ack);
  check(ack.statusCode === 200 && ack.json().value.acked === 0, 'missing ack handler degrades to acked=0');

  const refresh = makeRes();
  await optionals(makeReq({ url: '/sunder/api/refresh', method: 'POST', body: '' }), refresh);
  check(refresh.statusCode === 200 && typeof refresh.json().value === 'object', 'missing refresh handler degrades to {}');
}

// 9. registration on webServer ---------------------------------------------------
{
  const registered = [];
  let disposed = 0;
  const fakeCtx = {
    inject(deps, callback) {
      check(JSON.stringify(deps) === '["webServer"]', 'bridge injects webServer');
      callback({
        webServer: {
          register(options) {
            registered.push(options);
            return () => {
              disposed += 1;
            };
          },
        },
      });
    },
  };
  const bridge = registerSunderBridge(fakeCtx, handlers);
  check(registered.length === 1, 'route registered once');
  check(registered[0].kind === 'prefix', 'route kind is prefix');
  check(registered[0].path === BRIDGE_PREFIX, 'route path is the bridge prefix');
  check(typeof registered[0].handler === 'function', 'route handler is a function');
  check(bridge.registered === true, 'bridge reports registered');
  bridge.dispose();
  check(disposed === 1, 'dispose removes the route');
  check(bridge.registered === false, 'bridge reports disposed');

  const res = makeRes();
  await registered[0].handler(makeReq(), res);
  check(res.statusCode === 200, 'registered handler serves status');
}

// 10. registration without a web server ------------------------------------------
{
  const noInject = { get: () => undefined };
  const bridge = registerSunderBridge(noInject, handlers);
  check(bridge.registered === false, 'missing webServer leaves the bridge unregistered');

  const throwing = {
    inject() {
      throw new Error('no inject');
    },
  };
  const noopLog = () => {};
  const quiet = registerSunderBridge(throwing, handlers, { log: noopLog });
  check(quiet.registered === false, 'inject failure does not throw out of registration');

  const registerThrows = {
    inject(_deps, callback) {
      callback({
        webServer: {
          register() {
            throw new Error('already mounted');
          },
        },
      });
    },
  };
  const tolerant = registerSunderBridge(registerThrows, handlers, { log: noopLog });
  check(tolerant.registered === false, 'register failure does not throw out of registration');
}

// 11. helpers --------------------------------------------------------------------
{
  const res = makeRes();
  sendJson(res, 201, { ok: true });
  check(res.statusCode === 201 && res.json().ok === true, 'sendJson writes a JSON body');

  const empty = await readJsonBody(makeReq({ body: undefined }));
  check(empty === undefined, 'empty body resolves to undefined');
}

console.log(failures === 0 ? '\nbridge: OK' : `\nbridge: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
