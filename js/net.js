// net.js — timeouts for every outbound request.
//
// `fetch` has no timeout of its own. A stalled connection therefore leaves a
// promise that never settles, and anything waiting on it waits forever — which
// is how a "Fetching 1/1 from Goodreads…" spinner ends up needing a page
// refresh to clear. Every request in this app goes out with a deadline.

/** How long each kind of call may reasonably take before it is a fault. */
export const TIMEOUTS = {
  quick: 15_000,    // a single metadata lookup
  normal: 30_000,   // a page fetch through the worker
  long: 60_000,     // a paginated library read
};

/**
 * A signal that aborts after `ms`, also aborting if the caller's own signal
 * does. `AbortSignal.any` is recent enough to be worth a fallback.
 */
export function deadline(ms, signal = null) {
  const timer = AbortSignal.timeout(ms);
  if (!signal) return timer;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timer]);

  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal.aborted || timer.aborted) stop();
  signal.addEventListener('abort', stop, { once: true });
  timer.addEventListener('abort', stop, { once: true });
  return controller.signal;
}

/**
 * fetch with a deadline, and an error that says the request timed out rather
 * than the generic "The user aborted a request".
 */
export async function fetchWithTimeout(url, { timeoutMs = TIMEOUTS.normal, signal, ...init } = {}) {
  try {
    return await fetch(url, { ...init, signal: deadline(timeoutMs, signal) });
  } catch (err) {
    // A caller-initiated abort must stay an AbortError so callers can ignore it;
    // only a genuine timeout is reported as one.
    if (err.name === 'TimeoutError' || (err.name === 'AbortError' && !signal?.aborted)) {
      const host = safeHost(url);
      const timeout = new Error(`${host} did not respond within ${Math.round(timeoutMs / 1000)}s.`);
      timeout.name = 'TimeoutError';
      timeout.timedOut = true;
      throw timeout;
    }
    throw err;
  }
}

function safeHost(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return 'The server';
  }
}
