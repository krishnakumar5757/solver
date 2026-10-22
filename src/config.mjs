/**
 * Environment-only configuration with fail-fast validation.
 *
 * A long-running service does not have a "working directory", so every knob
 * comes from the environment — never from a config file on disk.
 */

import { readFileSync } from 'node:fs';

import { normaliseEndpoint } from './provider.mjs';
import { badRequest } from './errors.mjs';

export const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 8787,
  maxBody: 1024 * 1024, // 1 MiB
  timeoutMs: 120_000, // 2 minutes
  logLevel: 'info',
  maxFiles: 64,
  maxTotalBytes: 4 * 1024 * 1024, // 4 MiB
  maxConcurrency: 8,
  queueLimit: 32, // 0 = refuse immediately instead of queueing
  heartbeatMs: 15_000, // keep-alive comment while a streamed solve runs; 0 disables
  logFile: '', // empty = stderr only
  logMaxBytes: 5 * 1024 * 1024, // rotate to <file>.1 past this; 0 disables
  testCommand: 'npm test',
  reasoningEffort: '', // e.g. 'low', 'medium', 'high' for reasoning models
});

/** Required variable names, in the order they are reported to the operator. */
export const REQUIRED_VARS = [
  'NEOSOLVER_TOKEN',
  'NEOSOLVER_PROVIDER_URL',
  'NEOSOLVER_PROVIDER_KEY',
  'NEOSOLVER_MODEL',
];

/** Thrown when required environment variables are absent. Names every one. */
export class ConfigError extends Error {
  /** @param {string[]} missing */
  constructor(missing) {
    const lines = ['NeoSolver cannot start: missing required environment variable(s):'];
    for (const name of missing) lines.push(`  - ${name}`);
    lines.push('');
    if (missing.includes('NEOSOLVER_TOKEN')) {
      lines.push('NEOSOLVER_TOKEN is a short token you pick yourself (e.g. NEOSOLVER_TOKEN=myteam7).');
      lines.push('Set it, or set NEOSOLVER_ALLOW_ANON=1 to disable client auth entirely.');
    } else {
      lines.push('Set the variables above (see neosolver.env.example) and retry.');
    }
    super(lines.join('\n'));
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

/** Thrown when a variable is present but unusable. */
export class ConfigValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigValueError';
  }
}

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

const isTrue = (value) => value === '1' || value === 'true';

/**
 * Resolve the provider key without ever echoing it.
 *
 *   1. NEOSOLVER_PROVIDER_KEY
 *   2. NEOSOLVER_PROVIDER_KEY_FILE (a file containing the raw key)
 *
 * @returns {{key: string, source: string}|null} null when nothing was found
 */
export function resolveProviderKey(env) {
  if (nonEmpty(env.NEOSOLVER_PROVIDER_KEY)) {
    return { key: env.NEOSOLVER_PROVIDER_KEY, source: 'NEOSOLVER_PROVIDER_KEY' };
  }

  if (nonEmpty(env.NEOSOLVER_PROVIDER_KEY_FILE)) {
    const file = env.NEOSOLVER_PROVIDER_KEY_FILE.trim();
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      throw new ConfigValueError(
        `NeoSolver cannot start: could not read NEOSOLVER_PROVIDER_KEY_FILE "${file}": ${error.message}.`,
      );
    }
    if (raw.trim() === '') {
      throw new ConfigValueError(
        `NeoSolver cannot start: NEOSOLVER_PROVIDER_KEY_FILE "${file}" is empty.`,
      );
    }
    return { key: raw.trim(), source: `NEOSOLVER_PROVIDER_KEY_FILE (${file})` };
  }

  return null;
}

function intFrom(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigValueError(
      `NeoSolver cannot start: ${name} must be an integer between ${min} and ${max}, got "${raw}".`,
    );
  }
  return parsed;
}

/**
 * Parse and validate the environment.
 * @param {Record<string, string|undefined>} [env]
 * @returns {Readonly<ReturnType<typeof shapeConfig>>}
 */
export function loadConfig(env = process.env) {
  const allowAnon = isTrue(env.NEOSOLVER_ALLOW_ANON);

  const missing = [];
  if (!allowAnon && !nonEmpty(env.NEOSOLVER_TOKEN)) missing.push('NEOSOLVER_TOKEN');
  if (!nonEmpty(env.NEOSOLVER_PROVIDER_URL)) missing.push('NEOSOLVER_PROVIDER_URL');
  const resolvedKey = resolveProviderKey(env);
  if (!resolvedKey) missing.push('NEOSOLVER_PROVIDER_KEY');
  if (!nonEmpty(env.NEOSOLVER_MODEL)) missing.push('NEOSOLVER_MODEL');
  if (missing.length > 0) throw new ConfigError(missing);

  const logLevel = nonEmpty(env.NEOSOLVER_LOG_LEVEL) ? env.NEOSOLVER_LOG_LEVEL.trim() : DEFAULTS.logLevel;
  if (!['error', 'warn', 'info', 'debug'].includes(logLevel)) {
    throw new ConfigValueError(
      `NeoSolver cannot start: NEOSOLVER_LOG_LEVEL must be one of error|warn|info|debug, got "${logLevel}".`,
    );
  }

  const allowedModels = nonEmpty(env.NEOSOLVER_ALLOWED_MODELS)
    ? env.NEOSOLVER_ALLOWED_MODELS.split(',').map((part) => part.trim()).filter(Boolean)
    : [];

  const fallbackModel = nonEmpty(env.NEOSOLVER_FALLBACK_MODEL) ? env.NEOSOLVER_FALLBACK_MODEL.trim() : '';
  if (allowedModels.length > 0 && fallbackModel !== '' && !allowedModels.includes(fallbackModel)) {
    throw new ConfigValueError(
      `NeoSolver cannot start: NEOSOLVER_FALLBACK_MODEL "${fallbackModel}" is not in NEOSOLVER_ALLOWED_MODELS (${allowedModels.join(', ')}).`,
    );
  }

  const providerUrl = env.NEOSOLVER_PROVIDER_URL.trim();

  const reasoningEffort = nonEmpty(env.NEOSOLVER_REASONING_EFFORT)
    ? env.NEOSOLVER_REASONING_EFFORT.trim()
    : (nonEmpty(env.NEOSOLVER_REASONING) ? env.NEOSOLVER_REASONING.trim() : DEFAULTS.reasoningEffort);

  return shapeConfig({
    token: nonEmpty(env.NEOSOLVER_TOKEN) ? env.NEOSOLVER_TOKEN : null,
    allowAnon,
    providerUrl,
    providerUrlResolved: normaliseEndpoint(providerUrl),
    providerKey: resolvedKey.key,
    providerKeySource: resolvedKey.source,
    model: env.NEOSOLVER_MODEL.trim(),
    fallbackModel,
    allowedModels,
    reasoningEffort,
    host: nonEmpty(env.NEOSOLVER_HOST) ? env.NEOSOLVER_HOST.trim() : DEFAULTS.host,
    port: intFrom(env, 'NEOSOLVER_PORT', DEFAULTS.port, { min: 0, max: 65535 }),
    maxBody: intFrom(env, 'NEOSOLVER_MAX_BODY', DEFAULTS.maxBody, { min: 1 }),
    maxConcurrency: intFrom(env, 'NEOSOLVER_MAX_CONCURRENCY', DEFAULTS.maxConcurrency, { min: 1 }),
    queueLimit: intFrom(env, 'NEOSOLVER_QUEUE_LIMIT', DEFAULTS.queueLimit, { min: 0 }),
    heartbeatMs: intFrom(env, 'NEOSOLVER_HEARTBEAT_MS', DEFAULTS.heartbeatMs, { min: 0 }),
    timeoutMs: intFrom(env, 'NEOSOLVER_TIMEOUT_MS', DEFAULTS.timeoutMs, { min: 1 }),
    maxFiles: intFrom(env, 'NEOSOLVER_MAX_FILES', DEFAULTS.maxFiles, { min: 1 }),
    maxTotalBytes: intFrom(env, 'NEOSOLVER_MAX_TOTAL_BYTES', DEFAULTS.maxTotalBytes, { min: 1 }),
    testCommand: nonEmpty(env.NEOSOLVER_TEST_COMMAND) ? env.NEOSOLVER_TEST_COMMAND : DEFAULTS.testCommand,
    logFile: nonEmpty(env.NEOSOLVER_LOG_FILE) ? env.NEOSOLVER_LOG_FILE.trim() : DEFAULTS.logFile,
    logMaxBytes: intFrom(env, 'NEOSOLVER_LOG_MAX_BYTES', DEFAULTS.logMaxBytes, { min: 0 }),
    logLevel,
  });
}

function shapeConfig(values) {
  return Object.freeze(values);
}

/**
 * Resolve the model for a request, enforcing NEOSOLVER_ALLOWED_MODELS when set.
 * @param {ReturnType<typeof loadConfig>} config
 * @param {string|null} requested
 */
export function resolveModel(config, requested) {
  if (!requested) return config.model;
  if (config.allowedModels.length > 0 && !config.allowedModels.includes(requested)) {
    throw badRequest(
      `model "${requested}" is not permitted; NEOSOLVER_ALLOWED_MODELS allows: ${config.allowedModels.join(', ')}`,
    );
  }
  return requested;
}

/** Redaction-safe view of the config, used by the startup banner. */
export function describeConfig(config) {
  return {
    host: config.host,
    port: config.port,
    auth: config.allowAnon ? 'ANON (no token check)' : `token set (${config.token.length} chars)`,
    providerUrl: config.providerUrlResolved,
    providerKey: config.providerKey ? 'set (redacted)' : 'MISSING',
    providerKeySource: config.providerKeySource,
    model: config.model,
    fallbackModel: config.fallbackModel || '(none)',
    allowedModels: config.allowedModels.length > 0 ? config.allowedModels.join(',') : '(any)',
    reasoningEffort: config.reasoningEffort || '(none)',
    maxBody: `${config.maxBody} bytes`,
    maxConcurrency: config.maxConcurrency,
    queueLimit: config.queueLimit,
    heartbeatMs: config.heartbeatMs,
    timeoutMs: `${config.timeoutMs} ms`,
    maxFiles: config.maxFiles,
    maxTotalBytes: `${config.maxTotalBytes} bytes`,
    testCommand: config.testCommand,
    logLevel: config.logLevel,
    logFile: config.logFile === '' ? '(stderr only)' : config.logFile,
    logMaxBytes: config.logFile === '' ? '(n/a)' : `${config.logMaxBytes} bytes`,
  };
}
