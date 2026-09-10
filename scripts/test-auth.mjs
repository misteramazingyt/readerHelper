#!/usr/bin/env node
// test-auth.mjs — the GitHub sign-in gate.
//
// Each scenario gets a fresh jsdom (so location.hostname can vary) and a fresh
// import of auth.js (so its cached session resets). The Worker is stubbed at
// fetch, which lets us exercise the paths that matter and would otherwise need
// a live OAuth round trip: state mismatch, a refused login, an expired token.
//
// Requires jsdom:  npm install --no-save jsdom

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('· jsdom not installed — skipping auth tests.');
  process.exit(0);
}

const html = readFileSync(join(root, 'index.html'), 'utf8')
  .replace(/<script type="module"[\s\S]*?<\/script>/g, '');

const define = (o, n, v) => Object.defineProperty(o, n, { value: v, writable: true, configurable: true });
const AUTH_URL = pathToFileURL(join(root, 'js', 'auth.js')).href;
const CONFIG_URL = pathToFileURL(join(root, 'js', 'auth-config.js')).href;

// Several scenarios deliberately exercise the "keep the session" branches,
// which log by design. Silence that so a passing run is quiet.
console.warn = () => {};

let scenarioCount = 0;

/**
 * Build a world: fresh DOM at `url`, seeded storage, a stubbed fetch, and a
 * freshly imported auth module configured as `config` describes.
 */
async function world({ url = 'https://misteramazingyt.github.io/readerHelper/', config = {}, stored = null, fetchImpl } = {}) {
  scenarioCount += 1;
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = dom;

  const local = new Map();
  const session = new Map();
  if (stored) local.set('readerHelper.auth.v1', JSON.stringify(stored));

  define(window, 'localStorage', {
    getItem: (k) => (local.has(k) ? local.get(k) : null),
    setItem: (k, v) => local.set(k, String(v)),
    removeItem: (k) => local.delete(k),
  });
  define(window, 'sessionStorage', {
    getItem: (k) => (session.has(k) ? session.get(k) : null),
    setItem: (k, v) => session.set(k, String(v)),
    removeItem: (k) => session.delete(k),
  });
  define(window, 'crypto', {
    getRandomValues: (arr) => { for (let i = 0; i < arr.length; i += 1) arr[i] = (i * 7 + 3) % 256; return arr; },
    randomUUID: () => 'uuid',
  });

  const calls = [];
  define(window, 'fetch', async (input, init) => {
    calls.push({ url: String(input), init });
    if (fetchImpl) return fetchImpl(String(input), init);
    throw new Error('unexpected fetch');
  });

  // jsdom refuses real navigation and its Location.assign is non-configurable,
  // so stand in a plain object with the same shape and record the attempts.
  const navigations = [];
  const parsed = new URL(url);
  const location = {
    href: parsed.href,
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
    assign: (to) => navigations.push(String(to)),
    replace: (to) => navigations.push(String(to)),
  };
  // history.replaceState is how auth.js strips the spent ?code, so it has to
  // move the stand-in location too or that behaviour cannot be observed.
  const history = {
    replaceState: (_s, _t, to) => {
      const next = new URL(String(to), location.origin);
      location.href = next.href;
      location.pathname = next.pathname;
      location.search = next.search;
      location.hash = next.hash;
    },
  };

  for (const k of ['window', 'document', 'navigator', 'localStorage',
    'sessionStorage', 'crypto', 'fetch', 'CustomEvent', 'Event', 'MouseEvent', 'HTMLElement', 'Element', 'Node']) {
    if (window[k] !== undefined) define(globalThis, k, window[k]);
  }
  define(globalThis, 'location', location);
  define(globalThis, 'history', history);

  // A fresh copy of auth.js so its module-level session cache is empty.
  const authMod = await import(`${AUTH_URL}?s=${scenarioCount}`);
  const cfgMod = await import(CONFIG_URL);
  Object.assign(cfgMod.AUTH, {
    clientId: '', workerUrl: '', scope: 'gist',
    allowedLogins: ['misteramazingyt'], lockWhenUnconfigured: true, revalidateOnLoad: true,
    ...config,
  });

  return { window, auth: authMod, AUTH: cfgMod.AUTH, calls, navigations, local, session, location };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// --------------------------------------------------------------------- tests

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(c, what) { if (!c) throw new Error(what || 'expected true'); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const lockText = (w) => w.document.getElementById('lock-root')?.textContent || '';

// --- unconfigured

await check('an unconfigured build stays closed on a public host', async () => {
  const w = await world();
  const allowed = await w.auth.gate();
  eq(allowed, false, 'gate refused');
  ok(w.window.document.getElementById('lock-root'), 'lock screen rendered');
  ok(lockText(w.window).includes('not configured'), `explains why (got: ${lockText(w.window).slice(0, 80)})`);
  ok(w.window.document.getElementById('app').hidden, 'the board stays hidden');
});

await check('the setup screen names the callback URL to register', async () => {
  const w = await world();
  await w.auth.gate();
  ok(lockText(w.window).includes('https://misteramazingyt.github.io/readerHelper/'),
    'callback URL shown');
});

await check('an unconfigured build still opens on localhost', async () => {
  const w = await world({ url: 'http://localhost:8000/' });
  eq(await w.auth.gate(), true, 'gate allowed');
  ok(!w.window.document.getElementById('lock-root'), 'no lock screen');
});

await check('lockWhenUnconfigured:false deliberately opens an instance', async () => {
  const w = await world({ config: { lockWhenUnconfigured: false } });
  eq(await w.auth.gate(), true, 'gate allowed');
});

await check('the dev bypass opens an unconfigured instance', async () => {
  const w = await world();
  w.local.set('readerHelper.auth.devBypass', '1');
  eq(await w.auth.gate(), true, 'gate allowed');
});

await check('the dev bypass does NOT survive once OAuth is configured', async () => {
  const w = await world({
    config: { clientId: 'Ov23liTESTCLIENTID00', workerUrl: 'https://auth.example.workers.dev' },
  });
  w.local.set('readerHelper.auth.devBypass', '1');
  eq(await w.auth.gate(), false, 'still gated');
  ok(w.window.document.querySelector('.lock__button'), 'sign-in still required');
});

// --- configured, signed out

const CONFIGURED = { clientId: 'Ov23liTESTCLIENTID00', workerUrl: 'https://auth.example.workers.dev' };

await check('a configured build asks you to sign in', async () => {
  const w = await world({ config: CONFIGURED });
  eq(await w.auth.gate(), false, 'gate refused');
  const btn = w.window.document.querySelector('.lock__button');
  ok(btn, 'sign-in button rendered');
  eq(btn.textContent, 'Sign in with GitHub', 'button label');
  ok(w.window.document.getElementById('app').hidden, 'board hidden');
});

await check('signing in redirects to GitHub with the right parameters', async () => {
  const w = await world({ config: CONFIGURED });
  await w.auth.gate();
  w.window.document.querySelector('.lock__button')
    .dispatchEvent(new w.window.MouseEvent('click', { bubbles: true }));

  eq(w.navigations.length, 1, 'one navigation');
  const url = new URL(w.navigations[0]);
  eq(url.origin + url.pathname, 'https://github.com/login/oauth/authorize', 'authorize endpoint');
  eq(url.searchParams.get('client_id'), 'Ov23liTESTCLIENTID00', 'client id');
  eq(url.searchParams.get('redirect_uri'), 'https://misteramazingyt.github.io/readerHelper/', 'redirect uri');
  eq(url.searchParams.get('scope'), 'gist', 'scope');
  ok(url.searchParams.get('state'), 'state present');
  eq(w.session.get('readerHelper.oauth.state'), url.searchParams.get('state'), 'state stored for the return trip');
});

await check('the client secret never appears in the redirect', async () => {
  const w = await world({ config: CONFIGURED });
  await w.auth.gate();
  w.window.document.querySelector('.lock__button').dispatchEvent(new w.window.MouseEvent('click', { bubbles: true }));
  ok(!/secret/i.test(w.navigations[0]), 'no secret in the URL');
});

// --- callback handling

await check('a successful callback stores the session and opens the board', async () => {
  const w = await world({
    url: 'https://misteramazingyt.github.io/readerHelper/?code=abc123&state=STATE',
    config: CONFIGURED,
    fetchImpl: async (url) => {
      ok(url.endsWith('/exchange'), `posts to the worker (got ${url})`);
      return jsonResponse(200, {
        token: 'gho_realtoken', login: 'misteramazingyt', name: 'Shae',
        avatarUrl: 'https://avatars.example/1', scope: 'gist',
      });
    },
  });
  w.session.set('readerHelper.oauth.state', 'STATE');

  eq(await w.auth.gate(), true, 'gate allowed');
  eq(w.auth.currentLogin(), 'misteramazingyt', 'login recorded');
  eq(w.auth.isSignedIn(), true, 'signed in');
  ok(w.local.get('readerHelper.auth.v1').includes('gho_realtoken'), 'token persisted');
});

await check('the spent code is stripped from the address bar', async () => {
  const w = await world({
    url: 'https://misteramazingyt.github.io/readerHelper/?code=abc123&state=STATE',
    config: CONFIGURED,
    fetchImpl: async () => jsonResponse(200, { token: 't', login: 'misteramazingyt', scope: 'gist' }),
  });
  w.session.set('readerHelper.oauth.state', 'STATE');
  await w.auth.gate();
  eq(w.location.search, '', 'query cleared');
});

await check('a state mismatch is refused without contacting the worker', async () => {
  const w = await world({
    url: 'https://misteramazingyt.github.io/readerHelper/?code=abc123&state=FORGED',
    config: CONFIGURED,
    fetchImpl: async () => { throw new Error('should not be called'); },
  });
  w.session.set('readerHelper.oauth.state', 'REAL');

  eq(await w.auth.gate(), false, 'gate refused');
  eq(w.calls.length, 0, 'no exchange attempted');
  ok(lockText(w.window).includes('could not be verified'), 'explains the CSRF refusal');
});

await check('a callback with no stored state is refused', async () => {
  const w = await world({
    url: 'https://misteramazingyt.github.io/readerHelper/?code=abc&state=X',
    config: CONFIGURED,
    fetchImpl: async () => { throw new Error('should not be called'); },
  });
  eq(await w.auth.gate(), false, 'refused');
  eq(w.calls.length, 0, 'no exchange attempted');
});

await check('a login the worker refuses shows who was rejected', async () => {
  const w = await world({
    url: 'https://misteramazingyt.github.io/readerHelper/?code=abc&state=STATE',
    config: CONFIGURED,
    fetchImpl: async () => jsonResponse(403, {
      error: 'not_allowed', message: 'Signed in as stranger, who is not permitted to use this instance.', login: 'stranger',
    }),
  });
  w.session.set('readerHelper.oauth.state', 'STATE');

  eq(await w.auth.gate(), false, 'gate refused');
  eq(w.auth.isSignedIn(), false, 'no session stored');
  const text = lockText(w.window);
  ok(text.includes('Not permitted'), 'headline');
  ok(text.includes('stranger'), 'names the account');
});

await check('cancelling at GitHub is reported gently', async () => {
  const w = await world({
    url: 'https://misteramazingyt.github.io/readerHelper/?error=access_denied&error_description=The+user+denied',
    config: CONFIGURED,
  });
  eq(await w.auth.gate(), false, 'refused');
  ok(lockText(w.window).includes('cancelled'), 'says cancelled');
  ok(w.window.document.querySelector('.lock__button'), 'offers another try');
});

await check('an unreachable worker is reported, not swallowed', async () => {
  const w = await world({
    url: 'https://misteramazingyt.github.io/readerHelper/?code=abc&state=STATE',
    config: CONFIGURED,
    fetchImpl: async () => { throw new Error('connection refused'); },
  });
  w.session.set('readerHelper.oauth.state', 'STATE');
  eq(await w.auth.gate(), false, 'refused');
  ok(lockText(w.window).includes('Could not reach'), 'explains the failure');
});

// --- existing sessions

const SESSION = { token: 'gho_x', login: 'misteramazingyt', scope: 'gist', signedInAt: '2026-01-01T00:00:00Z' };

await check('a valid stored session opens the board', async () => {
  const w = await world({
    config: CONFIGURED,
    stored: SESSION,
    fetchImpl: async () => jsonResponse(200, { login: 'misteramazingyt' }),
  });
  eq(await w.auth.gate(), true, 'gate allowed');
  eq(w.calls[0].url, 'https://api.github.com/user', 'revalidated against GitHub');
});

await check('a revoked token forces a fresh sign-in', async () => {
  const w = await world({
    config: CONFIGURED,
    stored: SESSION,
    fetchImpl: async () => jsonResponse(401, { message: 'Bad credentials' }),
  });
  eq(await w.auth.gate(), false, 'gate refused');
  eq(w.local.has('readerHelper.auth.v1'), false, 'stale session cleared');
  ok(lockText(w.window).includes('expired'), 'explains why');
});

await check('a session whose account left the allowlist is dropped', async () => {
  const w = await world({
    config: CONFIGURED,
    stored: { ...SESSION, login: 'someone-else' },
    fetchImpl: async () => jsonResponse(200, { login: 'someone-else' }),
  });
  eq(await w.auth.gate(), false, 'gate refused');
  eq(w.local.has('readerHelper.auth.v1'), false, 'session cleared');
  ok(lockText(w.window).includes('Not permitted'), 'headline');
});

await check('a rate-limited revalidation does not throw you out', async () => {
  const w = await world({
    config: CONFIGURED,
    stored: SESSION,
    fetchImpl: async () => jsonResponse(403, { message: 'rate limit exceeded' }),
  });
  eq(await w.auth.gate(), true, 'session kept');
});

await check('a network failure during revalidation does not throw you out', async () => {
  const w = await world({
    config: CONFIGURED,
    stored: SESSION,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  eq(await w.auth.gate(), true, 'session kept while offline');
});

await check('revalidateOnLoad:false trusts the stored session', async () => {
  const w = await world({
    config: { ...CONFIGURED, revalidateOnLoad: false },
    stored: SESSION,
    fetchImpl: async () => { throw new Error('should not be called'); },
  });
  eq(await w.auth.gate(), true, 'allowed');
  eq(w.calls.length, 0, 'no revalidation call');
});

// --- token plumbing

await check('the session token drives Gist sync when no PAT is pasted', async () => {
  const w = await world({ config: CONFIGURED, stored: SESSION, fetchImpl: async () => jsonResponse(200, { login: 'misteramazingyt' }) });
  await w.auth.gate();
  eq(w.auth.githubToken({}), 'gho_x', 'falls back to the session token');
  eq(w.auth.withGithubToken({ gistId: 'g1' }).githubToken, 'gho_x', 'merged into settings');
  eq(w.auth.hasGistScope(), true, 'gist scope detected');
});

await check('an explicitly pasted PAT overrides the session token', async () => {
  const w = await world({ config: CONFIGURED, stored: SESSION, fetchImpl: async () => jsonResponse(200, { login: 'misteramazingyt' }) });
  await w.auth.gate();
  eq(w.auth.githubToken({ githubToken: 'ghp_manual' }), 'ghp_manual', 'PAT wins');
});

await check('an identity-only session reports no gist scope', async () => {
  const w = await world({
    config: { ...CONFIGURED, scope: '' },
    stored: { ...SESSION, scope: '' },
    fetchImpl: async () => jsonResponse(200, { login: 'misteramazingyt' }),
  });
  await w.auth.gate();
  eq(w.auth.hasGistScope(), false, 'no gist scope');
});

await check('signing out clears the session and asks the worker to revoke', async () => {
  const w = await world({
    config: CONFIGURED,
    stored: SESSION,
    fetchImpl: async (url) => (url.endsWith('/revoke') ? jsonResponse(200, { revoked: true }) : jsonResponse(200, { login: 'misteramazingyt' })),
  });
  await w.auth.gate();
  await w.auth.signOut();
  eq(w.local.has('readerHelper.auth.v1'), false, 'session cleared');
  ok(w.calls.some((c) => c.url.endsWith('/revoke')), 'revoke requested');
  eq(w.auth.isSignedIn(), false, 'signed out');
});

// ------------------------------------------------------------------- report

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ ${passed} auth gate tests passed.`);
process.exit(0);
