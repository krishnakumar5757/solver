/**
 * HTTP surface.
 *
 *   GET  /healthz            liveness, no auth
 *   GET  /                   plain-text usage, no auth
 *   POST /solve              solve, token in a header
 *   PUT  /solve              same (curl -T sends PUT)
 *   POST|PUT /s/<token>      same with the token as a path segment (shortest form)
 *   POST|PUT /               no-token form, only usable with NEOSOLVER_ALLOW_ANON=1
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { resolveModel } from './config.mjs';
import { solve } from './solve.mjs';
import { FORMATS, CONTENT_TYPES, renderShell, renderJson, renderTar, renderErrorShell, usageText } from './render.mjs';
import { createLogger } from './log.mjs';
import {
  NeoError,
  isNeoError,
  badRequest,
  unauthorized,
  notFound,
  methodNotAllowed,
  payloadTooLarge,
  serviceUnavailable,
} from './errors.mjs';

const ANON_WARNING =
  'NEOSOLVER_ALLOW_ANON=1 — client authentication is DISABLED. ' +
  'Anyone who can reach this port can spend your provider credits. ' +
  'Only safe behind a reverse proxy that enforces its own access control.';

/** Host header we are willing to echo back (no spaces, no CRLF, no garbage). */
const HOST_HEADER = /^[A-Za-z0-9.\-_]+(?::\d+)?$/;

/**
 * Derive the public base URL from the request, so `GET /` prints a copy-pasteable
 * one-liner for the domain the client actually used. No domain is hardcoded.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 * @param {import('node:http').Server} server
 */
export function requestBaseUrl(req, config, server) {
  const rawHost = req.headers['x-forwarded-host'] ?? req.headers.host;
  const host = typeof rawHost === 'string' ? rawHost.split(',')[0].trim() : '';

  let proto = 'http';
  const rawProto = req.headers['x-forwarded-proto'];
  if (typeof rawProto === 'string') {
    const candidate = rawProto.split(',')[0].trim().toLowerCase();
    if (candidate === 'http' || candidate === 'https') proto = candidate;
  }

  if (host !== '' && HOST_HEADER.test(host)) return `${proto}://${host}`;

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const fallbackHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${fallbackHost}:${port}`;
}

/**
 * Constant-time token comparison. Never throws, even for non-ASCII input or
 * wildly different lengths.
 * @param {string|null} provided
 * @param {string|null} expected
 */
export function checkToken(provided, expected) {
  if (expected === null || expected === undefined) return true; // anon mode
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Burn comparable work so the failure path is not obviously faster.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function headerToken(req) {
  const direct = req.headers['x-token'];
  if (typeof direct === 'string' && direct !== '') return direct;
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1];
  }
  return null;
}

function splitUrl(rawUrl) {
  const url = rawUrl ?? '/';
  const mark = url.indexOf('?');
  const pathname = mark === -1 ? url : url.slice(0, mark);
  return { pathname, query: new URLSearchParams(mark === -1 ? '' : url.slice(mark + 1)) };
}

/** Upper bound on caller-supplied target hints, so a prompt cannot grow without limit. */
const TARGETS_MAX = 64;

/**
 * Collect the caller's target hints from the repeatable `?target=` query
 * parameter AND the comma-separated `X-Targets` header.
 *
 * The header exists because the default client is a shell pipeline:
 *
 *   curl 'https://host/s/neo?target=a&target=b' -T file | sh
 *
 * Those `&` characters are shell operators. If the URL is unquoted, has lost
 * its quotes in a copy/paste, or picked up typographic quotes, the shell splits
 * the command: the request quietly becomes a GET with no `-T`, and the caller
 * sees a confusing failure instead of their files. `X-Targets: a,b` carries the
 * same information with no character the shell treats specially.
 *
 * Query values are taken first, then header values; duplicates are dropped and
 * the list is capped at {@link TARGETS_MAX}. An empty or whitespace-only
 * entry is ignored in both sources.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {URLSearchParams} query
 * @returns {string[]}
 */
function readTargets(req, query) {
  const raw = query.getAll('target');
  const header = req.headers['x-targets'];
  if (typeof header === 'string') raw.push(...header.split(','));
  else if (Array.isArray(header)) for (const part of header) raw.push(...part.split(','));

  const seen = new Set();
  const targets = [];
  for (const value of raw) {
    const trimmed = String(value).trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    targets.push(trimmed);
    if (targets.length >= TARGETS_MAX) break;
  }
  return targets;
}

function decodePathToken(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw badRequest('the token in the URL path is not valid percent-encoding');
  }
}

/** Read the raw request body, enforcing the size cap. */
function readBody(req, maxBytes) {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Drain so the client can still read our 413 instead of hitting EPIPE.
      req.resume();
      reject(
        payloadTooLarge(
          `request body is ${declared} bytes, which exceeds NEOSOLVER_MAX_BODY (${maxBytes} bytes)`,
        ),
      );
      return;
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        finish(
          reject,
          payloadTooLarge(
            `request body exceeds NEOSOLVER_MAX_BODY (${maxBytes} bytes); stop after ${maxBytes} bytes`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolveBody, Buffer.concat(chunks)));
    req.on('aborted', () => finish(reject, badRequest('the client aborted the request')));
    req.on('error', (error) => finish(reject, badRequest(`could not read the request body: ${error.message}`)));
  });
}

function send(res, status, contentType, body, extraHeaders = null) {
  if (res.writableEnded) return;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const headers = {
    'content-type': contentType,
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(payload);
}

function sendJson(res, status, value, extraHeaders = null) {
  send(res, status, 'application/json', `${JSON.stringify(value)}\n`, extraHeaders);
}

/**
 * Opening bytes of a streamed `sh` response.
 *
 * A reverse proxy in front of this service (Cloudflare) aborts an origin that
 * has sent nothing for ~100 s. A solve can take longer than that under provider
 * congestion, so the shell response is streamed: the shebang and this comment go
 * out immediately, and the rest of the script follows when the model answers.
 * `sh` reads a script as it arrives, so the client simply waits — and sees that
 * something is happening instead of a blank cursor.
 *
 * The comment is deliberately STATIC (no timestamp, no elapsed time) so the same
 * input still produces a byte-identical response.
 */
const SHELL_STREAM_PREFIX =
  '#!/bin/sh\n# NeoSolver: solving — this script streams as it is produced.\n';

/**
 * How often to emit a keep-alive comment while the model works, and the comment
 * itself.
 *
 * Sending the first byte early defeats a proxy's "origin did not respond" timer,
 * but a proxy also drops a response whose body then goes silent. The solve can
 * take minutes under provider congestion, so bytes are kept flowing. The line is
 * a shell comment, so it is inert wherever it lands in the script.
 */
const SHELL_HEARTBEAT = '# NeoSolver: still solving…\n';

/** Write one keep-alive comment into an in-progress shell stream. */
function writeShellHeartbeat(res) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(SHELL_HEARTBEAT);
  } catch {
    /* the client is gone; the caller will notice on the next write */
  }
}

/**
 * Begin a streamed shell response. Returns false when the client is already gone,
 * so the caller can bail out without doing the work.
 */
function startShellStream(res) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.writeHead(200, {
      'content-type': CONTENT_TYPES.sh,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.write(SHELL_STREAM_PREFIX);
    return true;
  } catch {
    return false;
  }
}

/**
 * Append the remainder of a rendered script and close the stream.
 *
 * The script's own `#!/bin/sh` line is dropped because the prefix already sent it.
 * The status code can no longer change once the stream began, so a failure is
 * delivered as a script that prints the error and exits non-zero.
 */
function finishShellStream(res, script) {
  const firstBreak = script.indexOf('\n');
  const body = script.startsWith('#!') && firstBreak !== -1 ? script.slice(firstBreak + 1) : script;
  if (!res.writableEnded && !res.destroyed) {
    try {
      res.write(body);
    } catch {
      /* the client went away mid-stream; nothing left to do */
    }
  }
  try {
    if (!res.writableEnded) res.end();
  } catch {
    /* ignore */
  }
}

/**
 * Whether a FAILED request must be answered with a POSIX shell script rather
 * than JSON.
 *
 * `sh` is the default response format, so an error is rendered as a shell
 * script by default — the client is piping the body into `sh`. Requests that
 * explicitly ask for `?format=json` or `?format=tar` keep the JSON error body,
 * and so do the non-solve routes (`/healthz`, `GET /`, unknown endpoints).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 */
function wantsShellErrorBody(req, config) {
  const { pathname, query } = splitUrl(req.url);
  const method = (req.method ?? 'GET').toUpperCase();

  // Non-solve routes keep their current JSON error bodies.
  if (pathname === '/healthz' || pathname === '/favicon.ico') return false;
  if (pathname === '/' && method === 'GET') return false;

  const solveSurface = pathname === '/' || pathname === '/solve' || pathname.startsWith('/s/');
  if (!solveSurface) {
    // In anon mode every POST/PUT path is accepted as a solve target; anything
    // else is a genuinely unknown endpoint and keeps the JSON error.
    if (!(config.allowAnon && (method === 'POST' || method === 'PUT'))) return false;
  }

  const format = (query.get('format') ?? 'sh').trim().toLowerCase();
  return format !== 'json' && format !== 'tar';
}

/**
 * Bounded FIFO concurrency limiter.
 *
 * The server is single-threaded and holds no shared mutable state, so concurrent
 * solves are already correct — what needs bounding is the BURST. Every in-flight
 * solve holds an upstream socket and up to `timeoutMs` of work, so an unbounded
 * flood turns into provider 429s and memory pressure. Requests beyond
 * `maxConcurrency` wait in FIFO order; beyond `queueLimit` they are refused with
 * 503 + Retry-After so the caller learns to retry instead of hanging.
 *
 * `acquire()` resolves to a release function. Release is idempotent — a double
 * release cannot inflate capacity — and the caller must run it in a `finally` so
 * a success, an error, and a client disconnect all return the slot exactly once.
 * A leak here would permanently shrink capacity.
 *
 * @param {{maxConcurrency: number, queueLimit: number}} options
 */
function createLimiter({ maxConcurrency, queueLimit }) {
  let active = 0;
  const waiting = [];

  function grant() {
    active += 1;
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      active -= 1;
      const next = waiting.shift();
      if (next) {
        active += 1;
        next();
      }
    };
  }

  function acquire() {
    if (active < maxConcurrency) return Promise.resolve(grant());
    if (waiting.length >= queueLimit) {
      return Promise.reject(
        serviceUnavailable(
          `the server is at capacity (${active} running, ${waiting.length} queued); retry shortly`,
        ),
      );
    }
    return new Promise((resolve) => {
      waiting.push(function next() {
        resolve(grant());
      });
    });
  }

  return {
    acquire,
    stats: () => ({ active, waiting: waiting.length }),
  };
}

/**
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 * @param {{fetchImpl?: Function, logger?: object}} [deps]
 * @returns {import('node:http').Server}
 */
export function createServer(config, { fetchImpl = globalThis.fetch, logger } = {}) {
  const log =
    logger ??
    createLogger({ level: config.logLevel, secrets: [config.providerKey] });

  const limiter = createLimiter({
    maxConcurrency: config.maxConcurrency,
    queueLimit: config.queueLimit,
  });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      respondWithError(req, res, error, log);
    });
  });

  server.on('clientError', (error, socket) => {
    log.warn('malformed HTTP request from client', { detail: error.message });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n');
    else socket.destroy();
  });

  async function handle(req, res) {
    const method = (req.method ?? 'GET').toUpperCase();
    const { pathname, query } = splitUrl(req.url);

    res.on('close', () => {
      if (!res.writableEnded) log.warn('client disconnected before the response completed', { pathname });
    });

    if (pathname === '/healthz') {
      if (method !== 'GET') throw methodNotAllowed(`${method} /healthz is not supported; use GET`);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/favicon.ico') throw notFound('no such endpoint: GET /favicon.ico');

    if (pathname === '/' && method === 'GET') {
      send(
        res,
        200,
        'text/plain; charset=utf-8',
        usageText({ allowAnon: config.allowAnon, baseUrl: requestBaseUrl(req, config, server) }),
      );
      return;
    }

    // The solve surface is `/`, `/solve` and `/s/<token>`. In anon mode there is
    // no token to carry in the path, and curl appends the local file name to a
    // URL with no file part (`-T tests.js https://host` becomes `PUT /tests.js`),
    // so every other POST/PUT path is accepted too.
    const knownSolvePath =
      pathname === '/' || pathname === '/solve' || pathname.startsWith('/s/');
    if (!knownSolvePath && !config.allowAnon) {
      throw notFound(
        `no such endpoint: ${method} ${pathname}. POST/PUT the test file to /solve, ` +
          `to /s/<token>, or to / with an X-Token header.`,
      );
    }
    if (method !== 'POST' && method !== 'PUT') {
      throw methodNotAllowed(`${method} ${pathname} is not supported; use POST or PUT`);
    }

    if (config.allowAnon) log.warn(`anonymous request (${ANON_WARNING})`, { path: pathname, method });

    // --- auth -------------------------------------------------------------
    const viaPath = pathname.startsWith('/s/');
    let presented;
    if (viaPath) {
      // curl appends the local file name when the URL ends in a slash, so take
      // the FIRST segment after /s/ as the token and ignore anything after it
      // (`/s/neo`, `/s/neo/`, `/s/neo/tests.js` all use the token `neo`).
      const firstSegment = pathname.slice(3).split('/')[0];
      presented = decodePathToken(firstSegment);
    } else {
      presented = headerToken(req);
    }
    if (!checkToken(presented, config.token)) {
      log.warn('rejected request with a bad or missing token', {
        path: pathname,
        via: viaPath ? 'path' : 'header',
      });
      throw unauthorized(
        viaPath
          ? 'the token in the URL path does not match NEOSOLVER_TOKEN'
          : 'missing or invalid token: send X-Token or Authorization: Bearer',
      );
    }

    // --- body -------------------------------------------------------------
    const body = await readBody(req, config.maxBody);
    if (body.length === 0) {
      throw badRequest('no test file supplied: send the raw test file as the request body');
    }
    let testFile = body.toString('utf8');
    if (testFile.charCodeAt(0) === 0xfeff) testFile = testFile.slice(1);

    // --- negotiation ------------------------------------------------------
    const format = (query.get('format') ?? 'sh').trim().toLowerCase();
    if (!FORMATS.includes(format)) {
      throw badRequest(`unknown format "${query.get('format')}"; expected one of ${FORMATS.join(', ')}`);
    }

    const model = resolveModel(config, query.get('model') || null);
    const reasoningEffort =
      query.get('reasoning') ?? query.get('reasoning_effort') ?? (config.reasoningEffort || null);
    const targets = readTargets(req, query);

    let testCommand = config.testCommand;
    if (query.has('test')) {
      const value = query.get('test') ?? '';
      testCommand = value.trim() === '' || value.trim().toLowerCase() === 'none' ? null : value;
    }

    // --- work -------------------------------------------------------------
    // Bounded concurrency: wait for a slot, then hold it for exactly the work.
    // The release is idempotent and `finally` runs it on success, error, and
    // client disconnect alike, so a slot can never leak.
    const queuedAt = Date.now();
    const release = await limiter.acquire();
    const queuedMs = Date.now() - queuedAt;
    try {
      // A client that vanished while queued must not hold a slot for a full
      // timeout; bail out and let `finally` return it.
      //
      // NOTE: do NOT test `req.destroyed` here — a fully-consumed request stream
      // reports destroyed=true, which would skip the response for every normal
      // request. Only a gone client matters, and that shows up on the socket or
      // on the response.
      if (res.writableEnded || res.destroyed || req.socket?.destroyed) return;

      const startedAt = Date.now();
      // `sh` is the default format and the one a proxy can time out on, so it is
      // streamed from the first byte. `tar` and `json` need correct bytes and a
      // length, so they stay buffered (and keep their exact status codes).
      const streaming = format === 'sh';
      if (streaming && !startShellStream(res)) return;

      // Keep bytes flowing until the answer is ready. Sending the prefix only
      // defeats the "origin did not respond" timer; a silent body can still be
      // dropped, so a shell comment is written periodically until we finish.
      let heartbeat = null;
      if (streaming && config.heartbeatMs > 0) {
        heartbeat = setInterval(() => writeShellHeartbeat(res), config.heartbeatMs);
        if (typeof heartbeat.unref === 'function') heartbeat.unref();
      }
      const stopHeartbeat = () => {
        if (heartbeat === null) return;
        clearInterval(heartbeat);
        heartbeat = null;
      };

      let solution;
      try {
        solution = await solve({ testFile, targets, model, reasoningEffort, config, fetchImpl, logger: log });
      } catch (error) {
        if (!streaming) throw error;
        stopHeartbeat();
        // The response has already begun, so the status cannot change. Finish the
        // stream with a script that prints the failure and exits non-zero; the
        // message still names the real status.
        const neo = isNeoError(error) ? error : new NeoError('internal_error', 500, 'internal error');
        if (!isNeoError(error)) log.error('unhandled error', { detail: error?.stack ?? String(error) });
        else log.warn('request failed', { code: neo.code, status: neo.status, detail: neo.message });
        finishShellStream(
          res,
          renderErrorShell({
            code: neo.code,
            status: neo.status,
            message: log.redact(neo.message),
          }),
        );
        return;
      }

      stopHeartbeat();

      // Include the actual filenames: a bare count is useless when debugging an
      // incomplete answer. Bounded so the line cannot grow without limit.
      const names = solution.files.map((file) => file.path);
      const namesField =
        names.length > 64 ? `${names.slice(0, 64).join(',')},+${names.length - 64} more` : names.join(',');
      log.info('solved', {
        format,
        model: solution.model ?? model,
        fellBack: solution.fellBack ? 'yes' : 'no',
        reasoningEffort: reasoningEffort ?? '(none)',
        files: solution.files.length,
        names: namesField,
        strategy: solution.strategy,
        ms: Date.now() - startedAt,
        queuedMs,
        testCommand: testCommand ?? '(skipped)',
      });

      if (streaming) {
        finishShellStream(res, renderShell(solution.files, { testCommand }));
        return;
      }
      if (format === 'tar') {
        send(res, 200, CONTENT_TYPES.tar, renderTar(solution.files));
        return;
      }
      send(res, 200, CONTENT_TYPES.json, renderJson(solution));
    } finally {
      release();
    }
  }

  function respondWithError(req, res, error, logger) {
    if (res.writableEnded) {
      logger.warn('error after the response was already sent', { detail: error?.message });
      return;
    }
    const neo = isNeoError(error) ? error : new NeoError('internal_error', 500, 'internal error');
    if (!isNeoError(error)) {
      logger.error('unhandled error', { detail: error?.stack ?? String(error) });
    } else {
      logger.warn('request failed', { code: neo.code, status: neo.status, detail: neo.message });
    }
    // Belt and braces: no secret may ever leave the process in a message.
    const wire = neo.toWire();
    wire.error.message = logger.redact(wire.error.message);
    // A 503 means "come back later" — tell the caller how long to wait.
    const extraHeaders = neo.status === 503 ? { 'retry-after': '5' } : null;
    // The default client pipeline is `curl ... | sh`, so a JSON error body is
    // piped into the shell and prints `error: command not found`. Render a
    // readable shell script instead when the negotiated format is `sh` (the
    // default). The HTTP status stays exactly as before.
    if (wantsShellErrorBody(req, config)) {
      send(
        res,
        neo.status,
        CONTENT_TYPES.sh,
        renderErrorShell({ code: neo.code, status: neo.status, message: wire.error.message }),
        extraHeaders,
      );
      return;
    }
    sendJson(res, neo.status, wire, extraHeaders);
  }

  server.neosolverLogger = log;
  return server;
}
