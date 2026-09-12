// gist.js — board state mirrored to a private GitHub Gist.
//
// localStorage stays the working copy; the Gist is the shared truth that makes
// cross-device use and the nightly GitHub Action possible. The token is a
// fine-grained PAT with Gist read/write only, kept in localStorage and never
// committed — the Action uses a repo Secret instead.

const GH = 'https://api.github.com';
export const STATE_FILENAME = 'readerhelper-state.json';

export class GistError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GistError';
    this.status = status;
  }
}

async function gh(cfg, path, { method = 'GET', body } = {}) {
  if (!cfg?.githubToken) throw new GistError('No GitHub token configured.', 0);
  const res = await fetch(`${GH}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cfg.githubToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new GistError('GitHub rejected the token.', 401);
  if (res.status === 404) throw new GistError('Gist not found (check the ID and token scope).', 404);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GistError(`GitHub ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  return res.json();
}

export async function verifyToken(cfg) {
  const user = await gh(cfg, '/user');
  return { login: user.login };
}

/** A marker in the description so our gist is recognisable among many. */
export const GIST_MARKER = 'readerHelper board state';

/**
 * Find the board's gist in the account, without being told its id.
 *
 * This is what makes a second computer work. Previously a fresh machine had no
 * `gistId`, so the first save created a *new* gist and the two devices drifted
 * apart in silence. Now the id is discovered from the account itself, and a
 * gist is only created when there genuinely is not one.
 */
export async function findStateGist(cfg) {
  let page = 1;
  let best = null;
  while (page <= 5) {
    const gists = await gh(cfg, `/gists?per_page=100&page=${page}`);
    if (!Array.isArray(gists) || !gists.length) break;
    for (const g of gists) {
      if (!g.files?.[STATE_FILENAME]) continue;
      // Prefer the most recently updated, in case an old one lingers.
      if (!best || new Date(g.updated_at) > new Date(best.updated_at)) best = g;
    }
    if (gists.length < 100) break;
    page += 1;
  }
  return best ? { id: best.id, updatedAt: best.updated_at, description: best.description } : null;
}

/**
 * Resolve the gist to sync with: the configured one, else one found in the
 * account, else a new one. Returns the id and how it was arrived at.
 */
export async function resolveGist(cfg, stateForCreate) {
  if (cfg.gistId) {
    try {
      await gh(cfg, `/gists/${cfg.gistId}`);
      return { gistId: cfg.gistId, source: 'configured' };
    } catch (err) {
      // A stale id (deleted gist, or a token that cannot see it) must not
      // silently become "create a new one" without saying so.
      if (err.status !== 404) throw err;
      console.warn(`configured gist ${cfg.gistId} is gone; looking for another`);
    }
  }
  const found = await findStateGist(cfg);
  if (found) return { gistId: found.id, source: 'discovered' };
  const id = await createGist(cfg, stateForCreate);
  return { gistId: id, source: 'created' };
}

export async function createGist(cfg, state) {
  const gist = await gh(cfg, '/gists', {
    method: 'POST',
    body: {
      description: `${GIST_MARKER} (private)`,
      public: false,
      files: { [STATE_FILENAME]: { content: serialise(state) } },
    },
  });
  return gist.id;
}

export async function pushState(cfg, state) {
  if (!cfg.gistId) {
    // Discovery first: creating unconditionally is how a second machine ends
    // up with a gist of its own.
    const { gistId, source } = await resolveGist(cfg, state);
    if (source !== 'created') {
      await gh(cfg, `/gists/${gistId}`, {
        method: 'PATCH',
        body: { files: { [STATE_FILENAME]: { content: serialise(state) } } },
      });
    }
    return { gistId, created: source === 'created', source, pushedAt: new Date().toISOString() };
  }
  const res = await gh(cfg, `/gists/${cfg.gistId}`, {
    method: 'PATCH',
    body: { files: { [STATE_FILENAME]: { content: serialise(state) } } },
  });
  return {
    gistId: cfg.gistId,
    created: false,
    source: 'configured',
    pushedAt: new Date().toISOString(),
    updatedAt: res?.updated_at || null,
  };
}

export async function pullState(cfg) {
  if (!cfg.gistId) throw new GistError('No Gist ID configured.', 0);
  const gist = await gh(cfg, `/gists/${cfg.gistId}`);
  const file = gist.files?.[STATE_FILENAME];
  if (!file) throw new GistError(`Gist has no ${STATE_FILENAME}.`, 404);
  // Files over 1MB come back truncated with a raw_url to fetch in full.
  const content = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  return {
    state: JSON.parse(content),
    updatedAt: gist.updated_at,
  };
}

function serialise(state) {
  return JSON.stringify({ ...state, meta: { ...state.meta, savedAt: new Date().toISOString() } }, null, 2);
}

/**
 * Decide what to do when local and remote both have state.
 *
 * There is no field-level merge here on purpose: silently interleaving two
 * divergent boards produces a board neither device meant. Instead we detect
 * divergence and hand the caller a decision.
 */
export function compareStates(local, remote) {
  const lTime = latestTimestamp(local);
  const rTime = latestTimestamp(remote);
  const lCount = countRecords(local);
  const rCount = countRecords(remote);
  if (!rCount) return { verdict: 'push', reason: 'Remote is empty.' };
  if (!lCount) return { verdict: 'pull', reason: 'Local is empty.' };
  if (lTime === rTime) return { verdict: 'in-sync', reason: 'Timestamps match.' };
  if (lTime > rTime) return { verdict: 'push', reason: `Local is newer (${lTime} > ${rTime}).` };
  return { verdict: 'pull', reason: `Remote is newer (${rTime} > ${lTime}).` };
}

function latestTimestamp(state) {
  let latest = '';
  const scan = (rec) => {
    if (rec?.modifiedAt && rec.modifiedAt > latest) latest = rec.modifiedAt;
  };
  for (const bucket of ['projects', 'groups', 'items']) {
    for (const rec of Object.values(state?.[bucket] || {})) scan(rec);
  }
  return latest;
}

function countRecords(state) {
  return (
    Object.keys(state?.projects || {}).length +
    Object.keys(state?.groups || {}).length +
    Object.keys(state?.items || {}).length
  );
}
