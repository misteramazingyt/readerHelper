#!/usr/bin/env node
// test-net.mjs — request deadlines.
//
// `fetch` has no timeout of its own, so a stalled connection leaves a promise
// that never settles. That is not a slow app, it is a stuck one: it left a
// progress spinner on screen that only a page reload could clear. These tests
// pin down that every request gives up, and that a real timeout is
// distinguishable from a caller cancelling on purpose.

import { fetchWithTimeout, deadline, TIMEOUTS } from '../js/net.js';

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(c, what) { if (!c) throw new Error(what || 'expected true'); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const realFetch = globalThis.fetch;

// Node unrefs the timer behind AbortSignal.timeout, so with nothing else
// pending the process exits before the deadline fires and the awaits are
// reported as unsettled. A browser has no such problem; this just holds the
// event loop open for the duration of the run.
const keepAlive = setInterval(() => {}, 1000);

/** A fetch that never answers — the failure mode being defended against. */
function stallForever() {
  globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = init.signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError';
      reject(err);
    }, { once: true });
  });
}

await check('a stalled request gives up instead of hanging forever', async () => {
  stallForever();
  const started = Date.now();
  let thrown = null;
  try {
    await fetchWithTimeout('https://example.test/slow', { timeoutMs: 150 });
  } catch (err) {
    thrown = err;
  }
  ok(thrown, 'it threw rather than hanging');
  eq(thrown.name, 'TimeoutError', 'named as a timeout');
  eq(thrown.timedOut, true, 'flagged');
  ok(Date.now() - started < 2000, 'and gave up promptly');
});

await check('the message says which host went quiet, and for how long', async () => {
  stallForever();
  try {
    await fetchWithTimeout('https://goodreads.example/book/1', { timeoutMs: 120 });
    throw new Error('should have timed out');
  } catch (err) {
    ok(err.message.includes('goodreads.example'), `names the host (got ${err.message})`);
    ok(/\d+s/.test(err.message), 'and the deadline');
  }
});

await check('a caller cancelling stays an AbortError, not a timeout', async () => {
  // Callers ignore AbortError on purpose — a superseded keystroke is not a
  // fault, and must not be reported to the user as one.
  stallForever();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  try {
    await fetchWithTimeout('https://example.test/x', { timeoutMs: 10_000, signal: controller.signal });
    throw new Error('should have aborted');
  } catch (err) {
    eq(err.name, 'AbortError', 'stays an abort');
    ok(!err.timedOut, 'not flagged as a timeout');
  }
});

await check('a request that answers in time is untouched', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hi: true }) });
  const res = await fetchWithTimeout('https://example.test/fast', { timeoutMs: 5000 });
  eq(res.status, 200, 'passed through');
  eq(await res.json(), { hi: true }, 'body intact');
});

await check('the deadline signal combines with the caller signal', () => {
  const controller = new AbortController();
  const combined = deadline(10_000, controller.signal);
  ok(!combined.aborted, 'live to begin with');
  controller.abort();
  ok(combined.aborted, 'the caller can still cancel');
});

await check('an already-aborted caller signal aborts immediately', () => {
  const controller = new AbortController();
  controller.abort();
  ok(deadline(10_000, controller.signal).aborted, 'aborted from the start');
});

await check('the timeouts are sane and ordered', () => {
  ok(TIMEOUTS.quick < TIMEOUTS.normal, 'a lookup is shorter than a page fetch');
  ok(TIMEOUTS.normal < TIMEOUTS.long, 'a page fetch is shorter than a library read');
  ok(TIMEOUTS.quick >= 5000, 'but not so short that a slow service fails spuriously');
});

globalThis.fetch = realFetch;
clearInterval(keepAlive);

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ ${passed} network deadline tests passed.`);
