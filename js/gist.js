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

export async function createGist(cfg, state) {
  const gist = await gh(cfg, '/gists', {
    method: 'POST',
    body: {
      description: 'readerHelper board state (private)',
      public: false,
      files: { [STATE_FILENAME]: { content: serialise(state) } },
    },
  });
  return gist.id;
}

export async function pushState(cfg, state) {
  if (!cfg.gistId) {
    const id = await createGist(cfg, state);
    return { gistId: id, created: true, pushedAt: new Date().toISOString() };
  }
  await gh(cfg, `/gists/${cfg.gistId}`, {
    method: 'PATCH',
    body: { files: { [STATE_FILENAME]: { content: serialise(state) } } },
  });
  return { gistId: cfg.gistId, created: false, pushedAt: new Date().toISOString() };
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
