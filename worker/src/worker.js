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
    if (url.pathname === '/scholar' && request.method === 'POST') {
      return handleScholar(request, env, ctx, corsOrigin);
    }
    if (url.pathname === '/goodreads' && request.method === 'POST') {
      return handleGoodreads(request, env, ctx, corsOrigin);
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

// ------------------------------------------------------------------ scholar

/**
 * Optional Google Scholar search, proxied so the SerpAPI key stays here.
 *
 * Entirely opt-in: without SERPAPI_KEY this answers 501 and the app simply
 * carries on with its keyless sources (Crossref, OpenAlex, Google Books), which
 * cover indexed literature well. Scholar earns its place mainly for grey
 * literature and older work those miss.
 *
 * Responses are cached for a day. The free SerpAPI tier is 100 searches a
 * month, so repeating a search must not cost a second one.
 */
async function handleScholar(request, env, ctx, corsOrigin) {
  if (!env.SERPAPI_KEY) {
    return json({
      error: 'not_configured',
      message: 'Scholar search is off. Set SERPAPI_KEY on the worker to enable it.',
    }, 501, corsOrigin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400, corsOrigin);
  }
  const q = String(body.q || '').trim().slice(0, 300);
  if (q.length < 3) {
    return json({ error: 'bad_request', message: 'Query too short.' }, 400, corsOrigin);
  }

  const cacheKey = new Request(`https://scholar.cache/${encodeURIComponent(q.toLowerCase())}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    const cached = await hit.json();
    return json({ ...cached, cached: true }, 200, corsOrigin);
  }

  const params = new URLSearchParams({
    engine: 'google_scholar',
    q,
    num: '8',
    api_key: env.SERPAPI_KEY,
  });

  let data;
  try {
    const res = await fetch(`https://serpapi.com/search.json?${params}`, {
      headers: { 'User-Agent': UA },
    });
    data = await res.json();
    if (!res.ok || data.error) {
      return json({ error: 'serpapi_error', message: data.error || `SerpAPI returned ${res.status}` }, 502, corsOrigin);
    }
  } catch (err) {
    return json({ error: 'serpapi_unreachable', message: String(err) }, 502, corsOrigin);
  }

  const results = (data.organic_results || []).map(normaliseScholarRow).filter((r) => r.title);
  const payload = { results, query: q };

  // Cache the shaped result, not the raw SerpAPI response.
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' },
  })));

  return json(payload, 200, corsOrigin);
}

/**
 * Scholar has no structured metadata: everything is in a summary line like
 * "A Author, B Author - Journal Name, 2001 - publisher.com". Parse what is
 * reliably there and leave the rest null rather than guessing.
 */
function normaliseScholarRow(row) {
  const summary = row.publication_info?.summary || '';
  const [namesPart, ...restParts] = summary.split(' - ');
  const rest = restParts.join(' - ');

  const authors = (namesPart || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s.length < 60 && !/^\d/.test(s));

  const yearMatch = rest.match(/\b(1\d{3}|20\d{2})\b/);
  const container = rest.split(',')[0]?.trim() || null;

  return {
    title: (row.title || '').trim(),
    authors,
    year: yearMatch ? Number(yearMatch[1]) : null,
    url: row.link || null,
    container: container && !/^\d{4}$/.test(container) ? container : null,
    abstract: row.snippet || null,
    citedBy: row.inline_links?.cited_by?.total ?? null,
    source: 'Google Scholar',
  };
}

// ---------------------------------------------------------------- goodreads

const GOODREADS_SHELVES = /^[a-z0-9][a-z0-9 _-]{0,48}$/i;

/**
 * Proxy a Goodreads shelf RSS feed.
 *
 * Goodreads retired its API, but the per-shelf RSS feeds still work — they just
 * send no CORS headers, so a browser on the Pages origin cannot read them. This
 * adds the headers and nothing else; no key is involved, and the feed is only
 * readable at all if the profile is public.
 *
 * The URL is *built here* from a numeric id and a shelf name rather than taken
 * from the caller. Forwarding a caller-supplied URL would turn this worker into
 * an open proxy for anything reachable from Cloudflare's network.
 */
async function handleGoodreads(request, env, ctx, corsOrigin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400, corsOrigin);
  }

  const userId = String(body.userId || '').trim();
  if (!/^\d{1,12}$/.test(userId)) {
    return json({
      error: 'bad_request',
      message: 'A Goodreads numeric user id is required (the digits in your profile URL).',
    }, 400, corsOrigin);
  }
  const shelf = String(body.shelf || 'read').trim();
  if (!GOODREADS_SHELVES.test(shelf)) {
    return json({ error: 'bad_request', message: `Not a valid shelf name: ${shelf}` }, 400, corsOrigin);
  }
  const page = Math.min(Math.max(parseInt(body.page, 10) || 1, 1), 50);

  const target = `https://www.goodreads.com/review/list_rss/${userId}`
    + `?shelf=${encodeURIComponent(shelf)}&page=${page}&per_page=100`;

  const cacheKey = new Request(`https://goodreads.cache/${userId}/${encodeURIComponent(shelf)}/${page}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    const cached = await hit.json();
    return json({ ...cached, cached: true }, 200, corsOrigin);
  }

  let xml;
  try {
    const res = await fetch(target, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml' } });
    if (res.status === 404) {
      return json({
        error: 'not_found',
        message: 'Goodreads returned nothing for that id and shelf. Is the profile public?',
      }, 404, corsOrigin);
    }
    if (!res.ok) {
      return json({ error: 'goodreads_error', message: `Goodreads returned ${res.status}.` }, 502, corsOrigin);
    }
    xml = await res.text();
  } catch (err) {
    return json({ error: 'goodreads_unreachable', message: String(err) }, 502, corsOrigin);
  }

  // A private profile answers 200 with an empty feed rather than an error.
  const count = (xml.match(/<item>/g) || []).length;
  if (!count && page === 1) {
    return json({
      xml,
      count: 0,
      page,
      shelf,
      warning: 'That shelf came back empty. Goodreads only publishes RSS for public profiles.',
    }, 200, corsOrigin);
  }

  const payload = { xml, count, page, shelf };
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' },
  })));
  return json(payload, 200, corsOrigin);
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
