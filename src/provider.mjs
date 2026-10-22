/**
 * OpenAI-compatible `/v1/chat/completions` client.
 *
 * Only the Node standard library is used (`fetch`, `AbortController`), and the
 * provider key is never interpolated into an error message or a log line.
 */

import { excerpt } from './log.mjs';
import { providerError, providerTimeout, rateLimited } from './errors.mjs';

const RETRY_BACKOFF_MS = 500;

/**
 * Mark an error as worth exactly one retry: network failures, HTTP 429 and
 * HTTP 5xx. A malformed body or a rejected credential is not retryable.
 */
function retryable(error) {
  error.retryable = true;
  return error;
}

/**
 * Resolve whatever the operator configured into a full chat-completions URL.
 *
 * Accepts, and normalises to the same result:
 *   - `api.example.com`                        (bare domain -> https)
 *   - `https://api.example.com`                (origin)
 *   - `https://api.example.com/`               (origin + trailing slash)
 *   - `https://api.example.com/v1`             (/v1 base)
 *   - `https://api.example.com/v1/chat/completions` (full URL, kept as-is)
 *   - `http://127.0.0.1:11434/v1/`             (local model, /v1 base)
 *   - `https://api.example.com/openai`         (deployment prefix)
 *
 * @param {string} input
 * @returns {string} absolute URL
 */
export function normaliseEndpoint(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') throw providerError('NEOSOLVER_PROVIDER_URL is empty.');

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw providerError(`NEOSOLVER_PROVIDER_URL is not a usable URL or domain: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw providerError(`NEOSOLVER_PROVIDER_URL must be http(s), got "${url.protocol}"`);
  }

  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions') || path.endsWith('/v1/chat/completions')) {
    // Already a full completions endpoint — keep it.
  } else if (path.endsWith('/v1')) {
    path += '/chat/completions';
  } else {
    path += '/v1/chat/completions';
  }

  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Pull the assistant text out of an OpenAI-compatible chat-completion body. */
export function extractContent(body) {
  const choice = body?.choices?.[0];
  let content = choice?.message?.content ?? choice?.text;
  if (Array.isArray(content)) {
    content = content
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('');
  }
  if (typeof content !== 'string') return null;
  return content;
}

/**
 * Call the provider once, returning the decoded chat-completion body.
 * @returns {Promise<{content: string, usage: object|null, model: string|null, response: object}>}
 */
async function attemptOnce({ config, model, messages, fetchImpl, logger, attempt, reasoningEffort }) {
  const url = config.providerUrlResolved;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);

  const effort = reasoningEffort ?? config?.reasoningEffort;
  logger.debug('provider call', { attempt, url, model, ...(effort ? { reasoningEffort: effort } : {}) });

  const payload = { model, messages, stream: false };
  if (effort) {
    payload.reasoning_effort = effort;
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.providerKey}`,
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw retryable(
        providerTimeout(
          `provider did not answer within NEOSOLVER_TIMEOUT_MS (${config.timeoutMs} ms) at ${url}`,
          error,
        ),
      );
    }
    throw retryable(
      providerError(
        `could not reach the provider at ${url}: ${excerpt(error?.message ?? String(error), 200)}`,
        error,
      ),
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => '');

  if (!response.ok) {
    const detail = excerpt(text, 300);
    if (response.status === 429) {
      throw retryable(
        rateLimited(`provider rate-limited the request (HTTP 429) at ${url}${detail ? `: ${detail}` : ''}`),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw providerError(
        `provider rejected the credentials (HTTP ${response.status}) at ${url}. Check NEOSOLVER_PROVIDER_KEY.${detail ? ` Provider said: ${detail}` : ''}`,
      );
    }
    const error = providerError(
      `provider returned HTTP ${response.status} at ${url}${detail ? `: ${detail}` : ''}`,
    );
    throw response.status >= 500 ? retryable(error) : error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw providerError(
      `provider returned a non-JSON response (content-type: ${response.headers.get('content-type') ?? 'unknown'}) at ${url}: ${excerpt(text, 300)}`,
    );
  }

  const content = extractContent(parsed);
  if (content === null) {
    throw providerError(
      `provider response at ${url} contained no assistant message; body began: ${excerpt(text, 200)}`,
    );
  }

  return { content, usage: parsed?.usage ?? null, model: parsed?.model ?? null, response: parsed };
}

/**
 * Call the provider, retrying exactly once on a transient failure
 * (network error, HTTP 429, or HTTP 5xx) with a short backoff.
 */
export async function callChatCompletion({
  config,
  model,
  messages,
  fetchImpl = globalThis.fetch,
  logger,
  backoffMs = RETRY_BACKOFF_MS,
  reasoningEffort,
}) {
  if (typeof fetchImpl !== 'function') {
    throw providerError('no fetch implementation available (Node >= 20 required)');
  }

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await attemptOnce({ config, model, messages, fetchImpl, logger, attempt, reasoningEffort });
    } catch (error) {
      lastError = error;
      if (error?.retryable !== true || attempt === 2) throw error;
      logger.warn(`provider call failed (${error.code}); retrying once in ${backoffMs} ms`, {
        attempt,
        detail: error.message,
      });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}
