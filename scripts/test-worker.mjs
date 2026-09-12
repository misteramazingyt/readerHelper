#!/usr/bin/env node
// test-worker.mjs — the auth worker, which is the part that actually locks.
//
// The Worker is a standard fetch handler, so it can be called directly here
// with Node's built-in Request/Response. GitHub is stubbed at global fetch,
// which lets us assert the things that matter and cannot be checked by reading
// the code: that a stranger never receives a token, that their token is
// revoked on the way out, that the client secret never reaches a response,
// and that another site cannot borrow the worker as a free OAuth backend.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worker = (await import(pathToFileURL(join(root, 'worker', 'src', 'worker.js')).href)).default;

const ENV = {
  GITHUB_CLIENT_ID: 'Ov23liTESTCLIENTID00',
  GITHUB_CLIENT_SECRET: 'supersecret-never-leak',
  ALLOWED_LOGINS: 'misteramazingyt',
  ALLOWED_ORIGINS: 'https://misteramazingyt.github.io,http://localhost:8000',
};

const APP_ORIGIN = 'https://misteramazingyt.github.io';

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(c, what) { if (!c) throw new Error(what || 'expected true'); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

/** Stand in for GitHub. Returns the calls it received. */
function stubGitHub({ tokenResponse, user, tokenStatus = 200 }) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });

    if (url.includes('login/oauth/access_token')) {
      return new Response(JSON.stringify(tokenResponse), { status: tokenStatus, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === 'https://api.github.com/user') {
      if (!user) return new Response('nope', { status: 401 });
      return new Response(JSON.stringify(user), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/applications/') && url.endsWith('/token')) {
      return new Response(null, { status: 204 });
    }
    return new Response('unexpected', { status: 500 });
  };
  return calls;
}

const post = (path, body, origin = APP_ORIGIN) =>
  worker.fetch(
    new Request(`https://auth.example.workers.dev${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    }),
    ENV,
    { waitUntil: (p) => p },
  );

// ---------------------------------------------------------------- the happy path

await check('an allowed user receives a token', async () => {
  stubGitHub({
    tokenResponse: { access_token: 'gho_good', scope: 'gist', token_type: 'bearer' },
    user: { login: 'misteramazingyt', name: 'Shae', avatar_url: 'https://a/1', id: 7 },
  });
  const res = await post('/exchange', { code: 'abc', redirect_uri: `${APP_ORIGIN}/readerHelper/` });
  eq(res.status, 200, 'status');
  const body = await res.json();
  eq(body.token, 'gho_good', 'token returned');
  eq(body.login, 'misteramazingyt', 'login');
  eq(body.scope, 'gist', 'scope');
  eq(res.headers.get('Access-Control-Allow-Origin'), APP_ORIGIN, 'CORS echoes the app origin');
  eq(res.headers.get('Cache-Control'), 'no-store', 'never cached');
});

await check('the client secret goes to GitHub and nowhere else', async () => {
  const calls = stubGitHub({
    tokenResponse: { access_token: 'gho_good', scope: 'gist' },
    user: { login: 'misteramazingyt' },
  });
  const res = await post('/exchange', { code: 'abc' });
  const text = await res.text();
  ok(!text.includes(ENV.GITHUB_CLIENT_SECRET), 'secret absent from the response body');
  ok(![...res.headers.values()].some((v) => v.includes(ENV.GITHUB_CLIENT_SECRET)), 'absent from headers');
  const tokenCall = calls.find((c) => c.url.includes('access_token'));
  ok(String(tokenCall.body).includes(ENV.GITHUB_CLIENT_SECRET), 'but it did reach GitHub');
});

// -------------------------------------------------------------------- allowlist

await check('a stranger is refused a token', async () => {
  stubGitHub({
    tokenResponse: { access_token: 'gho_stranger', scope: 'gist' },
    user: { login: 'random-person', id: 99 },
  });
  const res = await post('/exchange', { code: 'abc' });
  eq(res.status, 403, 'forbidden');
  const body = await res.json();
  eq(body.error, 'not_allowed', 'error code');
  ok(!body.token, 'no token handed over');
  ok(body.message.includes('random-person'), 'names the account');
});

await check('a refused stranger has their token revoked', async () => {
  const calls = stubGitHub({
    tokenResponse: { access_token: 'gho_stranger', scope: 'gist' },
    user: { login: 'random-person' },
  });
  await post('/exchange', { code: 'abc' });
  const revoke = calls.find((c) => c.url.includes('/applications/') && c.method === 'DELETE');
  ok(revoke, 'revocation requested');
  ok(String(revoke.body).includes('gho_stranger'), 'revokes the token just issued');
  ok(String(revoke.headers.Authorization || '').startsWith('Basic '), 'uses client basic auth');
});

await check('the allowlist ignores case', async () => {
  stubGitHub({
    tokenResponse: { access_token: 'gho_good', scope: 'gist' },
    user: { login: 'MisterAmazingYT' },
  });
  const res = await post('/exchange', { code: 'abc' });
  eq(res.status, 200, 'allowed regardless of case');
});

await check('an empty allowlist lets any GitHub user in', async () => {
  stubGitHub({ tokenResponse: { access_token: 't' }, user: { login: 'anyone' } });
  const res = await worker.fetch(
    new Request('https://auth.example.workers.dev/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      body: JSON.stringify({ code: 'abc' }),
    }),
    { ...ENV, ALLOWED_LOGINS: '' },
    { waitUntil: () => {} },
  );
  eq(res.status, 200, 'allowed');
});

// ----------------------------------------------------------------------- CORS

await check('another site cannot borrow the worker', async () => {
  stubGitHub({ tokenResponse: { access_token: 't' }, user: { login: 'misteramazingyt' } });
  const res = await post('/exchange', { code: 'abc' }, 'https://evil.example.com');
  eq(res.status, 403, 'forbidden');
  eq((await res.json()).error, 'origin_not_allowed', 'error code');
  eq(res.headers.get('Access-Control-Allow-Origin'), null, 'no CORS grant to that origin');
});

await check('localhost is allowed for development', async () => {
  stubGitHub({ tokenResponse: { access_token: 't', scope: 'gist' }, user: { login: 'misteramazingyt' } });
  const res = await post('/exchange', { code: 'abc' }, 'http://localhost:8000');
  eq(res.status, 200, 'allowed');
  eq(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000', 'CORS echoed');
});

await check('the preflight answers with the caller origin, never a wildcard', async () => {
  const res = await worker.fetch(
    new Request('https://auth.example.workers.dev/exchange', { method: 'OPTIONS', headers: { Origin: APP_ORIGIN } }),
    ENV, { waitUntil: () => {} },
  );
  eq(res.status, 204, 'no content');
  eq(res.headers.get('Access-Control-Allow-Origin'), APP_ORIGIN, 'echoed');
  ok(res.headers.get('Vary')?.includes('Origin'), 'varies on Origin so caches stay honest');
});

await check('a disallowed preflight is not granted CORS', async () => {
  const res = await worker.fetch(
    new Request('https://auth.example.workers.dev/exchange', { method: 'OPTIONS', headers: { Origin: 'https://evil.example.com' } }),
    ENV, { waitUntil: () => {} },
  );
  eq(res.headers.get('Access-Control-Allow-Origin'), null, 'no grant');
});

// ------------------------------------------------------------------- failures

await check('a spent or forged code is reported clearly', async () => {
  stubGitHub({ tokenResponse: { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } });
  const res = await post('/exchange', { code: 'stale' });
  eq(res.status, 400, 'bad request');
  const body = await res.json();
  eq(body.error, 'bad_verification_code', 'error code passed through');
  ok(body.message.includes('expired'), 'explains itself');
});

await check('a request with no code is rejected before contacting GitHub', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}'); };
  const res = await post('/exchange', {});
  eq(res.status, 400, 'bad request');
  eq(called, false, 'GitHub not contacted');
});

await check('a token GitHub will not identify is not handed back', async () => {
  stubGitHub({ tokenResponse: { access_token: 'gho_x' }, user: null });
  const res = await post('/exchange', { code: 'abc' });
  eq(res.status, 502, 'bad gateway');
  ok(!(await res.text()).includes('gho_x'), 'token withheld');
});

await check('an unconfigured worker says so rather than failing oddly', async () => {
  const res = await worker.fetch(
    new Request('https://auth.example.workers.dev/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      body: JSON.stringify({ code: 'abc' }),
    }),
    { ...ENV, GITHUB_CLIENT_SECRET: '' },
    { waitUntil: () => {} },
  );
  eq(res.status, 500, 'server error');
  eq((await res.json()).error, 'not_configured', 'named clearly');
});

// ------------------------------------------------------------------ scholar

// caches.default does not exist outside the Workers runtime.
const cacheStore = new Map();
globalThis.caches = {
  default: {
    match: async (req) => cacheStore.get(String(req.url)) || undefined,
    put: async (req, res) => { cacheStore.set(String(req.url), res); },
  },
};

await check('scholar search is off unless a SerpAPI key is set', async () => {
  const res = await worker.fetch(
    new Request('https://auth.example.workers.dev/scholar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      body: JSON.stringify({ q: 'anything at all' }),
    }),
    ENV, { waitUntil: () => {} },
  );
  eq(res.status, 501, 'not implemented');
  const body = await res.json();
  eq(body.error, 'not_configured', 'says so plainly');
  ok(body.message.includes('SERPAPI_KEY'), 'names what to set');
});

await check('scholar results are reshaped from SerpAPI', async () => {
  cacheStore.clear();
  let called = '';
  globalThis.fetch = async (url) => {
    called = String(url);
    return new Response(JSON.stringify({
      organic_results: [{
        title: 'Attention is all you need',
        link: 'https://example.org/attention',
        snippet: 'The dominant sequence transduction models…',
        publication_info: { summary: 'A Vaswani, N Shazeer, N Parmar - Advances in neural information, 2017 - proceedings.com' },
        inline_links: { cited_by: { total: 100000 } },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const res = await worker.fetch(
    new Request('https://auth.example.workers.dev/scholar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      body: JSON.stringify({ q: 'attention is all you need' }),
    }),
    { ...ENV, SERPAPI_KEY: 'serp-secret' }, { waitUntil: (p) => p },
  );
  eq(res.status, 200, 'ok');
  const body = await res.json();
  eq(body.results.length, 1, 'one result');
  eq(body.results[0].title, 'Attention is all you need', 'title');
  eq(body.results[0].authors, ['A Vaswani', 'N Shazeer', 'N Parmar'], 'authors parsed from the summary line');
  eq(body.results[0].year, 2017, 'year parsed');
  eq(body.results[0].citedBy, 100000, 'citation count kept');
  ok(called.includes('engine=google_scholar'), 'asked Scholar');
});

await check('the SerpAPI key is never returned to the caller', async () => {
  cacheStore.clear();
  globalThis.fetch = async () => new Response(JSON.stringify({ organic_results: [] }), { status: 200 });
  const res = await worker.fetch(
    new Request('https://auth.example.workers.dev/scholar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      body: JSON.stringify({ q: 'a query' }),
    }),
    { ...ENV, SERPAPI_KEY: 'serp-secret' }, { waitUntil: (p) => p },
  );
  ok(!(await res.text()).includes('serp-secret'), 'no key in the response');
});

await check('a repeated scholar search is served from cache, not re-billed', async () => {
  cacheStore.clear();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ organic_results: [{ title: 'X', publication_info: { summary: 'A B - J, 2001 - x' } }] }), { status: 200 });
  };
  const env = { ...ENV, SERPAPI_KEY: 'k' };
  const send = () => worker.fetch(
    new Request('https://auth.example.workers.dev/scholar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      body: JSON.stringify({ q: 'same query' }),
    }),
    env, { waitUntil: (p) => p },
  );
  await send();
  const second = await send();
  eq(calls, 1, 'SerpAPI hit only once — the free tier is 100 a month');
  eq((await second.json()).cached, true, 'second answer marked as cached');
});

await check('a too-short scholar query is rejected before it costs anything', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const res = await worker.fetch(
    new Request('https://auth.example.workers.dev/scholar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      body: JSON.stringify({ q: 'ab' }),
    }),
    { ...ENV, SERPAPI_KEY: 'k' }, { waitUntil: () => {} },
  );
  eq(res.status, 400, 'bad request');
  eq(calls, 0, 'no search performed');
});

// -------------------------------------------------------------- goodreads

const grPost = (body) => worker.fetch(
  new Request('https://auth.example.workers.dev/goodreads', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
    body: JSON.stringify(body),
  }),
  ENV, { waitUntil: (p) => p },
);

await check('a goodreads shelf is proxied with CORS added', async () => {
  cacheStore.clear();
  let called = '';
  globalThis.fetch = async (url) => {
    called = String(url);
    return new Response('<rss><channel><item><title>A</title></item></channel></rss>', { status: 200 });
  };
  const res = await grPost({ userId: '12345678', shelf: 'read', page: 1 });
  eq(res.status, 200, 'ok');
  eq(res.headers.get('Access-Control-Allow-Origin'), APP_ORIGIN, 'CORS added — the whole point');
  const body = await res.json();
  eq(body.count, 1, 'counted the items');
  ok(called.startsWith('https://www.goodreads.com/review/list_rss/12345678'), `built the URL itself (got ${called})`);
  ok(called.includes('shelf=read'), 'with the shelf');
});

await check('the proxy will not fetch a URL the caller supplies', async () => {
  // Forwarding a caller-supplied URL would make this an open proxy for
  // anything reachable from Cloudflare's network.
  cacheStore.clear();
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('', { status: 200 }); };

  for (const evil of [
    'http://169.254.169.254/latest/meta-data/',
    '../../admin',
    '12345678/../../x',
    'not-a-number',
    '',
  ]) {
    const res = await grPost({ userId: evil, shelf: 'read' });
    eq(res.status, 400, `refused ${JSON.stringify(evil)}`);
  }
  eq(called, false, 'nothing was fetched');
});

await check('a shelf name that is not a shelf name is refused', async () => {
  cacheStore.clear();
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('', { status: 200 }); };
  const res = await grPost({ userId: '1', shelf: '../../../etc/passwd' });
  eq(res.status, 400, 'refused');
  eq(called, false, 'no request made');
});

await check('a private profile is explained rather than reported as success', async () => {
  cacheStore.clear();
  globalThis.fetch = async () => new Response('<rss><channel></channel></rss>', { status: 200 });
  const body = await (await grPost({ userId: '1', shelf: 'read' })).json();
  eq(body.count, 0, 'no books');
  ok(body.warning?.includes('public'), `says why (got ${body.warning})`);
});

await check('a repeated shelf request is served from cache', async () => {
  cacheStore.clear();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('<rss><channel><item><title>A</title></item></channel></rss>', { status: 200 });
  };
  await grPost({ userId: '1', shelf: 'read', page: 1 });
  const second = await grPost({ userId: '1', shelf: 'read', page: 1 });
  eq(calls, 1, 'Goodreads hit once');
  eq((await second.json()).cached, true, 'second answer came from cache');
});

await check('the page number is clamped rather than trusted', async () => {
  cacheStore.clear();
  let called = '';
  globalThis.fetch = async (url) => {
    called = String(url);
    return new Response('<rss><channel><item></item></channel></rss>', { status: 200 });
  };
  await grPost({ userId: '1', shelf: 'read', page: 99999 });
  ok(called.includes('page=50'), `clamped to 50 (got ${called})`);
  cacheStore.clear();
  await grPost({ userId: '1', shelf: 'read', page: -3 });
  ok(called.includes('page=1'), 'a negative page becomes 1');
});

// -------------------------------------------------------------------- health

await check('health reports configuration without revealing it', async () => {
  const res = await worker.fetch(
    new Request('https://auth.example.workers.dev/health', { headers: { Origin: APP_ORIGIN } }),
    ENV, { waitUntil: () => {} },
  );
  eq(res.status, 200, 'ok');
  const text = await res.text();
  ok(!text.includes(ENV.GITHUB_CLIENT_SECRET), 'no secret');
  ok(!text.includes(ENV.GITHUB_CLIENT_ID), 'no client id either');
  const body = JSON.parse(text);
  eq(body.configured, true, 'reports configured');
  eq(body.allowedLogins, 1, 'reports allowlist size only');
});

await check('an unknown route is a plain 404', async () => {
  const res = await worker.fetch(
    new Request('https://auth.example.workers.dev/anything', { headers: { Origin: APP_ORIGIN } }),
    ENV, { waitUntil: () => {} },
  );
  eq(res.status, 404, 'not found');
});

// ------------------------------------------------------------------- report

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ ${passed} auth worker tests passed.`);
