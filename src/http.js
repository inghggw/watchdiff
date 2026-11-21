/**
 * Fetching a body, with the retry policy a monitor actually needs.
 *
 * A single failed request must never be reported as a change or as an outage:
 * portals return intermittent 5xx and empty bodies, and the retry of the same
 * minute usually succeeds. Only 429 and 5xx (and network/timeout errors) are
 * retried — a 404 means the page is gone, which is news, not a glitch.
 */

export class HttpError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response) {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : null;
}

/**
 * @param {object} watcher validated watcher config
 * @param {object} [deps] injectable fetch/sleep for tests
 * @returns {Promise<{body: string, status: number, attempts: number, durationMs: number}>}
 */
export async function fetchBody(watcher, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleepImpl = deps.sleepImpl ?? sleep;
  const attempts = (watcher.retries ?? 0) + 1;
  const started = Date.now();
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleepImpl(lastError?.retryAfterMs ?? watcher.retryDelayMs ?? 5000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), watcher.timeoutMs);
    try {
      const response = await fetchImpl(watcher.url, {
        method: watcher.method ?? 'GET',
        headers: { 'User-Agent': 'watchdiff/0.1 (+https://github.com/)', ...watcher.headers },
        body: watcher.body === undefined ? undefined : typeof watcher.body === 'string' ? watcher.body : JSON.stringify(watcher.body),
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const error = new HttpError(`HTTP ${response.status} ${response.statusText}`.trim(), {
          status: response.status,
          retryable,
        });
        if (!retryable) throw error;
        error.retryAfterMs = retryAfterMs(response);
        lastError = error;
        continue;
      }
      const body = await response.text();
      if (!body.trim()) {
        const error = new HttpError('the response body was empty', { status: response.status, retryable: true });
        lastError = error;
        continue;
      }
      return { body, status: response.status, attempts: attempt, durationMs: Date.now() - started };
    } catch (error) {
      if (error instanceof HttpError && !error.retryable) throw error;
      lastError =
        error?.name === 'AbortError' || error?.name === 'TimeoutError'
          ? new HttpError(`timed out after ${watcher.timeoutMs} ms`, { retryable: true })
          : error instanceof HttpError
            ? error
            : new HttpError(`request failed: ${error?.message ?? String(error)}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new HttpError(`request failed after ${attempts} attempts`, { retryable: true });
}
