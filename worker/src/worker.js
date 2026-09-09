/**
 * readerHelper auth worker — the one piece that cannot live in the browser.
 *
 * GitHub's OAuth token endpoint sends no CORS headers and GitHub OAuth Apps do
 * not support PKCE, so the code -> token exchange has to happen server-side
 * with a client secret. This Worker is that server, and nothing more: it holds
 * the secret, performs the exchange, checks the resulting identity against an
 * allowlist, and hands the token back to the app.
 *
 * It deliberately does two things beyond a bare proxy:
 *
 *   1. It enforces the allowlist *here*, not in the app. A gate written in
 *      client-side JavaScript is advice; a gate in front of the secret is a
 *      lock. Nobody outside the allowlist ever receives a token.
 *   2. When a stranger does sign in, their freshly minted token is revoked
 *      before the 403 is returned, so a refused login leaves nothing behind.
 *
 * Routes
 *   POST /exchange   { code, redirect_uri, state } -> { token, login, ... }
 *   POST /revoke     { token }                     -> { revoked: true }
 *   GET  /health                                   -> { ok: true }
 *
 * Secrets (wrangler secret put ...)
 *   GITHUB_CLIENT_SECRET
 * Vars (wrangler.toml)
 *   GITHUB_CLIENT_ID, ALLOWED_LOGINS, ALLOWED_ORIGINS
 */

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const UA = 'readerHelper-auth-worker';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = splitList(env.ALLOWED_ORIGINS);
    const corsOrigin = pickOrigin(origin, allowedOrigins);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }

    if (url.pathname === '/health') {
      return json({
        ok: true,
        configured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        allowedLogins: splitList(env.ALLOWED_LOGINS).length,
        allowedOrigins: allowedOrigins.length,
      }, 200, corsOrigin);
    }

    // Every other route is a cross-origin POST from the app, so the browser
    // will have sent an Origin. Refuse anything we do not recognise.
    if (allowedOrigins.length && !corsOrigin) {
      return json({ error: 'origin_not_allowed', message: 'This origin may not use this worker.' }, 403, null);
    }

    if (url.pathname === '/exchange' && request.method === 'POST') {
      return handleExchange(request, env, ctx, corsOrigin);
    }
    if (url.pathname === '/revoke' && request.method === 'POST') {
      return handleRevoke(request, env, corsOrigin);
    }

    return json({ error: 'not_found' }, 404, corsOrigin);
  },
};

// ------------------------------------------------------------------ exchange

async function handleExchange(request, env, ctx, corsOrigin) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return json({ error: 'not_configured', message: 'The worker has no GitHub client id or secret set.' }, 500, corsOrigin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request', message: 'Expected a JSON body.' }, 400, corsOrigin);
  }

  const code = String(body.code || '').trim();
  if (!code) {
    return json({ error: 'bad_request', message: 'No authorization code supplied.' }, 400, corsOrigin);
  }

  // --- 1. code -> token
  let tokenPayload;
  try {
    const res = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: body.redirect_uri || undefined,
      }),
    });
    tokenPayload = await res.json();
  } catch (err) {
    return json({ error: 'github_unreachable', message: String(err) }, 502, corsOrigin);
  }

  if (tokenPayload.error) {
    // bad_verification_code means an expired or reused code — worth saying so
    // plainly, because the fix (sign in again) is different from a real fault.
    return json({
      error: tokenPayload.error,
      message: tokenPayload.error_description || 'GitHub refused the authorization code.',
    }, 400, corsOrigin);
  }

  const token = tokenPayload.access_token;
  if (!token) {
    return json({ error: 'no_token', message: 'GitHub returned no access token.' }, 502, corsOrigin);
  }

  // --- 2. token -> identity
  let user;
  try {
    const res = await fetch(GITHUB_USER_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': UA },
    });
    if (!res.ok) {
      return json({ error: 'identity_failed', message: `GitHub returned ${res.status} for the user lookup.` }, 502, corsOrigin);
    }
    user = await res.json();
  } catch (err) {
    return json({ error: 'github_unreachable', message: String(err) }, 502, corsOrigin);
  }

  // --- 3. allowlist, enforced here rather than in the app
  const allowed = splitList(env.ALLOWED_LOGINS).map((s) => s.toLowerCase());
  const login = String(user.login || '');
  if (allowed.length && !allowed.includes(login.toLowerCase())) {
    // Do not leave a usable token in a stranger's hands.
    ctx.waitUntil(revokeToken(env, token).catch(() => {}));
    return json({
      error: 'not_allowed',
      message: `Signed in as ${login}, who is not permitted to use this instance.`,
      login,
    }, 403, corsOrigin);
  }

  return json({
    token,
    scope: tokenPayload.scope || '',
    tokenType: tokenPayload.token_type || 'bearer',
    login,
    name: user.name || null,
    avatarUrl: user.avatar_url || null,
    id: user.id,
  }, 200, corsOrigin);
}

// -------------------------------------------------------------------- revoke

async function handleRevoke(request, env, corsOrigin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400, corsOrigin);
  }
  const token = String(body.token || '');
  if (!token) return json({ error: 'bad_request', message: 'No token supplied.' }, 400, corsOrigin);

  try {
    const res = await revokeToken(env, token);
    // 204 means revoked; 404 means it was already gone, which is also success.
    return json({ revoked: res.status === 204 || res.status === 404 }, 200, corsOrigin);
  } catch (err) {
    return json({ error: 'revoke_failed', message: String(err) }, 502, corsOrigin);
  }
}

/** Delete an authorization for this OAuth app. Requires HTTP Basic client auth. */
function revokeToken(env, token) {
  const basic = btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`);
  return fetch(`https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({ access_token: token }),
  });
}

// ------------------------------------------------------------------- helpers

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Echo the caller's origin only when it is on the list — never a bare "*". */
function pickOrigin(origin, allowed) {
  if (!origin) return null;
  if (!allowed.length) return origin; // unconfigured: permissive, and /health says so
  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(payload, status, corsOrigin) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(corsOrigin),
    },
  });
}
