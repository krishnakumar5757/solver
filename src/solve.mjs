/**
 * Orchestration: request -> prompt -> provider -> parsed + sanitised files.
 *
 * A model can fail in two different ways:
 *
 *   1. the provider call itself fails (timeout, rate limit, 5xx, network), or
 *   2. the model answers with something that cannot be turned into files.
 *
 * Both are worth exactly ONE attempt with the configured fallback model, because
 * a different model frequently succeeds where one format-fumbles. A credential
 * or permission failure is NOT retried on the fallback: that is an operator
 * problem, and silently spending a second model would hide it.
 */

import { buildMessages } from './prompt.mjs';
import { callChatCompletion } from './provider.mjs';
import { parseReply } from './parse.mjs';
import { collectFiles } from './paths.mjs';
import { unprocessableReply } from './errors.mjs';
import { excerpt } from './log.mjs';

const STRATEGY_NAMES = [
  'filename-annotated fence',
  'direct JSON',
  '```json fenced block',
  'first {...} substring',
  'single code block + target hint',
];

/**
 * How much of an unparseable reply to include in the error/log line. A few
 * thousand characters are usually enough to spot the offending byte, while
 * still bounding what can be written to a log or returned to a client.
 */
const REPLY_EXCERPT_MAX = 4000;

/**
 * Codes that mean "this model did not give us a usable answer", as opposed to
 * "the provider rejected us". Only these justify spending a second model.
 */
const FALLBACK_CODES = new Set(['unprocessable_reply', 'empty_solution']);

/**
 * Whether a failure is worth one attempt on the fallback model.
 *
 * Transient provider failures arrive marked `retryable` (the provider layer
 * retries them once itself). Unusable answers carry a code from
 * {@link FALLBACK_CODES}. A 401/403 from the provider is neither, so it
 * propagates: a bad key must not quietly consume a second model.
 *
 * Path-safety failures (`unsafe_path`, `duplicate_path`) are deliberately NOT
 * fallback-worthy: the model produced something hostile or ambiguous, and
 * retrying with another model would hide that rather than fix it.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function worthFallingBack(error) {
  if (!error || typeof error !== 'object') return false;
  if (FALLBACK_CODES.has(error.code)) return true;
  return error.retryable === true;
}

/**
 * One full generate-attempt: call the provider, parse the reply, sanitise the
 * resulting files. Throws on any failure so the caller can decide to fall back.
 *
 * @param {{model: string, messages: Array<object>, targets: string[], config: object, fetchImpl?: Function, logger: object, testFileBytes: number}} request
 */
async function attempt({ model, messages, targets, config, fetchImpl, logger, testFileBytes, reasoningEffort }) {
  logger.debug('calling provider', { model, testFileBytes, ...(reasoningEffort ? { reasoningEffort } : {}) });
  const completion = await callChatCompletion({ config, model, messages, fetchImpl, logger, reasoningEffort });

  const parsed = parseReply(completion.content, { targets });
  if (!parsed) {
    throw unprocessableReply(
      `the model reply did not contain a usable {"files": {...}} object (tried: ${STRATEGY_NAMES.join(', ')}). ` +
        `Reply excerpt: ${excerpt(completion.content, REPLY_EXCERPT_MAX)}`,
    );
  }

  const files = collectFiles(parsed.files, {
    maxFiles: config.maxFiles,
    maxTotalBytes: config.maxTotalBytes,
  });

  logger.debug('parsed model reply', { model, strategy: parsed.strategy, files: files.length });

  return {
    files,
    notes: parsed.notes ?? '',
    usage: completion.usage,
    model: completion.model ?? model,
    strategy: parsed.strategy,
  };
}

/**
 * @param {{testFile: string, targets?: string[], model?: string, reasoningEffort?: string|null, config: object, fetchImpl?: Function, logger: object}} request
 * @returns {Promise<{files: Array<{path: string, content: string}>, notes: string, usage: object|null, model: string|null, strategy: number, fellBack: boolean, attempts: string[]}>}
 */
export async function solve({ testFile, targets = [], model, reasoningEffort, config, fetchImpl, logger }) {
  const messages = buildMessages({ testFile, targets });
  const primary = model ?? config.model;
  const fallback = config.fallbackModel ?? '';
  const canFallBack = fallback !== '' && fallback !== primary;
  const testFileBytes = Buffer.byteLength(testFile, 'utf8');

  try {
    const result = await attempt({ model: primary, messages, targets, config, fetchImpl, logger, testFileBytes, reasoningEffort });
    return { ...result, fellBack: false, attempts: [primary] };
  } catch (primaryError) {
    if (!canFallBack || !worthFallingBack(primaryError)) throw primaryError;

    logger.warn('primary model did not produce a usable answer; trying the fallback', {
      primary,
      fallback,
      code: primaryError.code,
      detail: primaryError.message,
    });

    const result = await attempt({ model: fallback, messages, targets, config, fetchImpl, logger, testFileBytes, reasoningEffort });
    return { ...result, fellBack: true, attempts: [primary, fallback] };
  }
}

export { STRATEGY_NAMES };
