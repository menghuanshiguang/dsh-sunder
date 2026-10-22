/**
 * Host-side HTTP bridge for the dsh-sunder client half.
 *
 * Why a route instead of the `remote` RPC: the settings panel lives in the web
 * GUI, and a third-party bundle cannot add remote namespaces to the host
 * `remote` service. What it *can* do is register a same-origin route on
 * `webServer` and let the client `fetch()` it — the pattern used by other
 * bundles in this profile (e.g. `dsh-ego-browser\lib\index.js:2032`).
 *
 * Contract (stable; the client half is written against it):
 *
 *   GET  /sunder/api/status  -> 200 { ok: true, value: Status }
 *   POST /sunder/api/ack     <- { id?: string, all?: true }
 *                            -> 200 { ok: true, value: { acked: number, status: Status } }
 *   POST /sunder/api/refresh -> 200 { ok: true, value: Status }
 *   errors                   -> { ok: false, error: { code, message } }
 *
 * `Status` is built by the caller (`index.js`) so this module stays free of
 * plugin state. Every handler is injected, which keeps `test/bridge.mjs`
 * offline and lets the route be tested without a real HTTP server.
 *
 * @module dsh-sunder/bridge
 */

/** Route prefix owned by this plugin. */
export const BRIDGE_PREFIX = '/sunder/api';

/** Maximum accepted request body (bytes) — the ack payload is tiny. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Read and parse a small JSON request body.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<unknown>}
 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('bad-json'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Same-origin guard: a browser sends `Origin` on cross-origin and on
 * state-changing same-origin requests, so compare it with `Host` when present.
 * Requests without `Origin` (same-origin GET, non-browser callers) pass.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isSameOrigin(req) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = req.headers?.host;
  return typeof host === 'string' && originHost === host;
}

/**
 * Create the request handler for the `/sunder/api` prefix.
 * @param {{status: () => object, ack?: (payload: any) => object, refresh?: () => Promise<object>}} handlers
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createBridgeHandler(handlers = {}) {
  return async function sunderBridgeHandler(req, res) {
    try {
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const suffix = pathname.startsWith(`${BRIDGE_PREFIX}/`) ? pathname.slice(BRIDGE_PREFIX.length + 1) : undefined;
      if (suffix === undefined || suffix === '' || suffix.includes('/')) {
        sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route: ${pathname}` } });
        return;
      }
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: { code: 'origin-not-allowed', message: 'same-origin requests only' } });
        return;
      }

      const method = String(req.method ?? 'GET').toUpperCase();
      if (suffix === 'status') {
        if (method !== 'GET') {
          sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'GET only' } });
          return;
        }
        sendJson(res, 200, { ok: true, value: handlers.status?.() ?? {} });
        return;
      }

      if (suffix === 'ack') {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } });
          return;
        }
        let payload;
        try {
          payload = await readJsonBody(req);
        } catch (error) {
          const code = String(error?.message ?? error);
          sendJson(res, code === 'body-too-large' ? 413 : 400, {
            ok: false,
            error: { code: code === 'body-too-large' ? 'body-too-large' : 'bad-json', message: 'invalid JSON body' },
          });
          return;
        }
        sendJson(res, 200, { ok: true, value: handlers.ack?.(payload) ?? { acked: 0 } });
        return;
      }

      if (suffix === 'refresh') {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } });
          return;
        }
        // Drain the (usually empty) body so the socket can be reused.
        await readJsonBody(req).catch(() => undefined);
        sendJson(res, 200, { ok: true, value: (await handlers.refresh?.()) ?? {} });
        return;
      }

      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method: ${suffix}` } });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: { code: 'internal', message: String(error?.message ?? error) },
      });
    }
  };
}

/**
 * Register the bridge on the host web server as soon as that service is ready.
 *
 * `ctx.inject(['webServer'], …)` is used instead of a one-shot `ctx.get` because
 * the web server may mount after this bundle (and may be absent entirely in
 * headless profiles — then nothing is registered and the client falls back).
 *
 * @param {object} ctx cordis host context
 * @param {object} handlers see {@link createBridgeHandler}
 * @param {{log?: (...args: any[]) => void}} [options] injectable logger (tests silence it)
 * @returns {{registered: boolean, dispose: () => void}} best-effort handle
 */
export function registerSunderBridge(ctx, handlers, options = {}) {
  const log = typeof options.log === 'function' ? options.log : console.warn;
  const handler = createBridgeHandler(handlers);
  let disposeRoute;
  const install = (webServer) => {
    if (!webServer || typeof webServer.register !== 'function') return undefined;
    try {
      const result = webServer.register({ kind: 'prefix', path: BRIDGE_PREFIX, handler });
      disposeRoute = typeof result === 'function' ? result : undefined;
      return disposeRoute;
    } catch (error) {
      log('[dsh-sunder] could not register the host bridge:', error?.message ?? error);
      return undefined;
    }
  };

  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['webServer'], (serviceCtx) => install(serviceCtx?.webServer));
    } catch (error) {
      log('[dsh-sunder] host bridge inject failed:', error?.message ?? error);
    }
  } else {
    let webServer;
    try {
      webServer = ctx?.get?.('webServer');
    } catch {
      webServer = undefined;
    }
    install(webServer);
  }

  return {
    get registered() {
      return typeof disposeRoute === 'function';
    },
    dispose() {
      try {
        disposeRoute?.();
      } catch {
        /* already disposed */
      }
      disposeRoute = undefined;
    },
  };
}
