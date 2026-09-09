// auth.js — the GitHub sign-in gate.
//
// Runs before the board boots. Three possible outcomes:
//
//   configured + valid session  -> boot the app
//   configured + no session     -> lock screen with "Sign in with GitHub"
//   not configured              -> setup screen (or an open board on localhost)
//
// Flow: the app redirects to GitHub, GitHub redirects back here with ?code,
// and the Worker trades that code for a token. GitHub OAuth Apps support
// neither PKCE nor CORS on the token endpoint, which is exactly why the Worker
// exists; `state` is therefore the CSRF defence and is checked here.
//
// Honest scope note, repeated in the README: on a static host this gate
// protects the DATA and the API token, not the HTML. The page source is
// public either way. What it genuinely prevents is anyone else obtaining a
// token or reaching your Gist.

import { AUTH, isConfigured, isLocalHost } from './auth-config.js';

const STORE_KEY = 'readerHelper.auth.v1';
const STATE_KEY = 'readerHelper.oauth.state';
const RETURN_KEY = 'readerHelper.oauth.return';
const DEV_KEY = 'readerHelper.auth.devBypass';

let session = null;

// ------------------------------------------------------------------ session

export function getSession() {
  if (session) return session;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    session = raw ? JSON.parse(raw) : null;
  } catch {
    session = null;
  }
  return session;
}

function saveSession(next) {
  session = next;
  try {
    if (next) localStorage.setItem(STORE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORE_KEY);
  } catch (err) {
    console.warn('could not persist the session', err);
  }
}

export function isSignedIn() {
  return Boolean(getSession()?.token);
}

export function currentLogin() {
  return getSession()?.login || null;
}

/**
 * The GitHub token for API calls. The session token is used when the user has
 * not pasted a PAT of their own; an explicit PAT always wins, so anyone who
 * prefers a narrowly scoped token can still use one.
 */
export function githubToken(settings = {}) {
  return settings.githubToken || getSession()?.token || '';
}

/** Merge the session token into a settings object for the Gist client. */
export function withGithubToken(settings = {}) {
  return { ...settings, githubToken: githubToken(settings) };
}

export function hasGistScope() {
  const scope = getSession()?.scope || '';
  return scope.split(/[,\s]+/).includes('gist');
}

// -------------------------------------------------------------------- login

function randomState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The exact URL registered as the OAuth App callback — no query, no hash. */
function redirectUri() {
  return `${location.origin}${location.pathname}`;
}

export function startLogin() {
  if (!isConfigured()) return;
  const state = randomState();
  try {
    sessionStorage.setItem(STATE_KEY, state);
    // Come back to whatever the user was looking at.
    sessionStorage.setItem(RETURN_KEY, location.hash || '');
  } catch {
    /* private mode: the state check below will simply fail closed */
  }
  const params = new URLSearchParams({
    client_id: AUTH.clientId,
    redirect_uri: redirectUri(),
    state,
    allow_signup: 'false',
  });
  if (AUTH.scope) params.set('scope', AUTH.scope);
  location.assign(`https://github.com/login/oauth/authorize?${params}`);
}

export async function signOut({ revoke = true } = {}) {
  const current = getSession();
  saveSession(null);
  try {
    localStorage.removeItem(DEV_KEY);
  } catch { /* ignore */ }
  if (revoke && current?.token && isConfigured()) {
    try {
      await fetch(`${AUTH.workerUrl.replace(/\/$/, '')}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: current.token }),
      });
    } catch (err) {
      console.warn('token revoke failed', err);
    }
  }
  location.replace(redirectUri());
}

// ----------------------------------------------------------------- callback

function hasCallbackParams() {
  const q = new URLSearchParams(location.search);
  return q.has('code') || q.has('error');
}

/** Strip OAuth params so a refresh does not replay a spent code. */
function clearCallbackParams() {
  const hash = location.hash || '';
  history.replaceState(null, '', `${redirectUri()}${hash}`);
}

async function handleCallback() {
  const q = new URLSearchParams(location.search);

  if (q.get('error')) {
    clearCallbackParams();
    return {
      ok: false,
      reason: q.get('error') === 'access_denied' ? 'cancelled' : 'error',
      message: q.get('error_description') || q.get('error'),
    };
  }

  const code = q.get('code');
  const returned = q.get('state');
  let expected = null;
  try {
    expected = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
  } catch { /* ignore */ }

  if (!expected || returned !== expected) {
    clearCallbackParams();
    return {
      ok: false,
      reason: 'state',
      message: 'The sign-in could not be verified (state mismatch). Please try again.',
    };
  }

  let payload;
  try {
    const res = await fetch(`${AUTH.workerUrl.replace(/\/$/, '')}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri() }),
    });
    payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      clearCallbackParams();
      return {
        ok: false,
        reason: payload.error === 'not_allowed' ? 'refused' : 'exchange',
        message: payload.message || `The sign-in service returned ${res.status}.`,
        login: payload.login,
      };
    }
  } catch (err) {
    clearCallbackParams();
    return { ok: false, reason: 'network', message: `Could not reach the sign-in service. ${err.message}` };
  }

  saveSession({
    token: payload.token,
    login: payload.login,
    name: payload.name,
    avatarUrl: payload.avatarUrl,
    scope: payload.scope || '',
    signedInAt: new Date().toISOString(),
  });

  let hash = '';
  try {
    hash = sessionStorage.getItem(RETURN_KEY) || '';
    sessionStorage.removeItem(RETURN_KEY);
  } catch { /* ignore */ }
  history.replaceState(null, '', `${redirectUri()}${hash}`);
  return { ok: true };
}

/** Confirm the stored token still works and still belongs to an allowed user. */
async function revalidate() {
  const current = getSession();
  if (!current?.token) return { ok: false, reason: 'none' };
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${current.token}`, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 401) {
      saveSession(null);
      return { ok: false, reason: 'expired', message: 'Your session has expired. Please sign in again.' };
    }
    if (!res.ok) {
      // A network hiccup or rate limit should not throw you out.
      console.warn(`session revalidation returned ${res.status}; keeping the session`);
      return { ok: true, stale: true };
    }
    const user = await res.json();
    const allowed = AUTH.allowedLogins.map((s) => s.toLowerCase());
    if (allowed.length && !allowed.includes(String(user.login).toLowerCase())) {
      saveSession(null);
      return { ok: false, reason: 'refused', message: `${user.login} is not permitted to use this instance.`, login: user.login };
    }
    if (user.login !== current.login) saveSession({ ...current, login: user.login });
    return { ok: true };
  } catch (err) {
    console.warn('session revalidation failed; keeping the session', err);
    return { ok: true, stale: true };
  }
}

// --------------------------------------------------------------------- gate

/**
 * Resolve to true when the app may boot. Renders the lock screen and resolves
 * false otherwise.
 */
export async function gate() {
  // Unconfigured build.
  if (!isConfigured()) {
    if (isLocalHost() || !AUTH.lockWhenUnconfigured || devBypassActive()) return true;
    renderLock({ mode: 'setup' });
    return false;
  }

  if (hasCallbackParams()) {
    renderLock({ mode: 'working', message: 'Completing sign-in…' });
    const result = await handleCallback();
    if (!result.ok) {
      renderLock({ mode: 'error', reason: result.reason, message: result.message, login: result.login });
      return false;
    }
    return true;
  }

  if (!isSignedIn()) {
    renderLock({ mode: 'signin' });
    return false;
  }

  if (AUTH.revalidateOnLoad) {
    const check = await revalidate();
    if (!check.ok) {
      renderLock({ mode: 'error', reason: check.reason, message: check.message, login: check.login });
      return false;
    }
  }
  return true;
}

function devBypassActive() {
  try {
    return localStorage.getItem(DEV_KEY) === '1';
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- lock screen

function renderLock({ mode, message, reason, login }) {
  const app = document.getElementById('app');
  if (app) app.hidden = true;
  document.getElementById('selection-bar')?.setAttribute('hidden', '');

  let host = document.getElementById('lock-root');
  if (!host) {
    host = document.createElement('div');
    host.id = 'lock-root';
    document.body.appendChild(host);
  }
  host.className = 'lock';
  host.replaceChildren();

  const card = node('div', 'lock__card');
  card.append(node('div', 'lock__mark', '📖'));
  card.append(node('h1', 'lock__title', 'readerHelper'));

  if (mode === 'working') {
    card.append(node('p', 'lock__text', message || 'Working…'));
    const spin = node('div', 'spinner lock__spinner');
    card.append(spin);
    host.append(card);
    return;
  }

  if (mode === 'setup') {
    card.append(node('p', 'lock__lede', 'Sign-in is not configured yet, so this instance is closed.'));
    const steps = node('ol', 'lock__steps');
    for (const step of [
      'Create a GitHub OAuth App with this page as the Authorization callback URL.',
      'Deploy worker/ to Cloudflare and set GITHUB_CLIENT_SECRET.',
      'Put the client ID and worker URL into js/auth-config.js and push.',
    ]) steps.append(node('li', null, step));
    card.append(steps);

    const link = node('a', 'lock__link', 'Setup instructions in the README →');
    link.href = 'https://github.com/misteramazingyt/readerHelper#locking-the-site';
    link.rel = 'noopener noreferrer';
    link.target = '_blank';
    card.append(link);

    card.append(node('p', 'lock__note', `Callback URL for step 1: ${redirectUri()}`));
    host.append(card);
    return;
  }

  if (mode === 'error') {
    const title = {
      refused: 'Not permitted',
      expired: 'Session expired',
      cancelled: 'Sign-in cancelled',
      state: 'Sign-in could not be verified',
    }[reason] || 'Sign-in failed';
    card.append(node('p', 'lock__lede lock__lede--error', title));
    card.append(node('p', 'lock__text', message || 'Something went wrong.'));
    if (reason === 'refused' && login) {
      card.append(node('p', 'lock__note', `Signed in as ${login}. Sign out of GitHub, or use the permitted account.`));
    }
  } else {
    card.append(node('p', 'lock__lede', 'Sign in with GitHub to open your board.'));
  }

  const button = node('button', 'lock__button', 'Sign in with GitHub');
  button.type = 'button';
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = 'Redirecting…';
    startLogin();
  });
  card.append(button);

  if (AUTH.scope) {
    card.append(node('p', 'lock__note', `Requests the "${AUTH.scope}" scope so the same session can mirror your board to a private Gist.`));
  }

  card.append(node('p', 'lock__note lock__note--quiet',
    'Your board lives in this browser and in your own private Gist — never on the server.'));

  host.append(card);
  setTimeout(() => button.focus(), 40);
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

export { isConfigured, redirectUri };
