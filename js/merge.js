// merge.js — reconcile two copies of the board.
//
// The board is edited on more than one machine, so "whose copy wins?" has to be
// answered per record, not per file. Replacing the whole state with whichever
// copy was saved last throws away everything done on the other machine since
// they diverged — add a book on the laptop, rename a group on the desktop, and
// one of those is simply gone.
//
// So: every project, group and item carries `modifiedAt`, and the newer edit
// wins for that record alone. Deletions leave a tombstone, because otherwise
// "absent here, present there" is ambiguous — it could be an addition on one
// side or a deletion on the other, and guessing wrong either resurrects deleted
// books forever or deletes new ones.
//
// This is last-write-wins at record granularity, not a CRDT. Two people editing
// the *same field* of the *same book* at the same moment still lose one edit.
// For one person moving between their own machines, that is the right trade.

const TOMBSTONE_TTL_DAYS = 90;
const BUCKETS = ['projects', 'groups', 'items'];

/** Settings that are the same everywhere, and so travel with the board. */
export const PORTABLE_SETTINGS = [
  'zoteroUserId',
  'zoteroReadTag',
  'zoteroProjectsRoot',
  'promptMarkReadAt',
  'theme',
  'bibFormat',
];

/**
 * Settings deliberately left behind on each machine:
 *   every API key and token   — secrets, and the blast radius stays local
 *   zoteroDataDir, linkedBase — filesystem paths differ per computer
 *   localPdfHandler           — depends on whether the handler is installed here
 *   gistId, gistSyncEnabled   — discovered per machine
 */

export function tombstoneKey(type, id) {
  return `${type}:${id}`;
}

/** Record a deletion so other machines learn about it. */
export function addTombstone(state, type, id, at = new Date().toISOString()) {
  if (!state.deleted) state.deleted = {};
  state.deleted[tombstoneKey(type, id)] = { type, id, at };
}

export function isTombstoned(deleted, type, id) {
  return Boolean(deleted?.[tombstoneKey(type, id)]);
}

/** Drop tombstones old enough that every device has certainly seen them. */
export function pruneTombstones(deleted, { ttlDays = TOMBSTONE_TTL_DAYS, now = Date.now() } = {}) {
  const cutoff = now - ttlDays * 24 * 60 * 60 * 1000;
  const out = {};
  for (const [key, t] of Object.entries(deleted || {})) {
    if (new Date(t.at).getTime() >= cutoff) out[key] = t;
  }
  return out;
}

function timeOf(value) {
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Keep the ids that still exist, in the order given, then append anything that
 * exists but was not listed. Self-heals an order that drifted on one machine.
 */
export function reconcileOrder(order = [], validIds = []) {
  const valid = new Set(validIds);
  const kept = [];
  const seen = new Set();
  for (const id of order) {
    if (valid.has(id) && !seen.has(id)) {
      kept.push(id);
      seen.add(id);
    }
  }
  for (const id of validIds) {
    if (!seen.has(id)) kept.push(id);
  }
  return kept;
}

/**
 * Merge two board states.
 *
 * @param {object} local
 * @param {object} remote
 * @returns {{state: object, summary: object}}
 */
export function mergeStates(local, remote, { now = Date.now() } = {}) {
  const a = local || {};
  const b = remote || {};

  const summary = {
    fromRemote: 0,   // records the remote copy was newer for
    fromLocal: 0,    // records this machine was newer for
    added: 0,        // records only the remote had
    deleted: 0,      // records a tombstone removed
    resurrected: 0,  // edits newer than a delete, so the delete was dropped
  };

  const deleted = pruneTombstones({ ...(a.deleted || {}), ...(b.deleted || {}) }, { now });
  // When both sides tombstoned the same thing, keep the earlier moment: it is
  // when the record actually stopped being wanted.
  for (const [key, t] of Object.entries(b.deleted || {})) {
    const mine = a.deleted?.[key];
    if (mine && deleted[key] && timeOf(mine.at) < timeOf(t.at)) deleted[key] = mine;
  }

  const merged = {
    version: Math.max(a.version || 1, b.version || 1),
    projects: {},
    groups: {},
    items: {},
    placements: {},
    projectOrder: [],
    // The active project is where *this* machine is looking; it is not shared.
    ui: a.ui || b.ui || {},
    meta: mergeMeta(a.meta, b.meta),
    deleted,
    settings: mergePortableSettings(a.settings, b.settings),
  };

  for (const bucket of BUCKETS) {
    const mine = a[bucket] || {};
    const theirs = b[bucket] || {};
    for (const id of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      const type = bucket.slice(0, -1);          // projects -> project
      const l = mine[id];
      const r = theirs[id];
      const winner = pick(l, r, summary);
      if (!winner) continue;

      const grave = deleted[tombstoneKey(type, id)];
      if (grave) {
        // A delete only sticks if nothing newer happened to the record.
        if (timeOf(grave.at) >= timeOf(winner.modifiedAt)) {
          summary.deleted += 1;
          continue;
        }
        delete deleted[tombstoneKey(type, id)];
        summary.resurrected += 1;
      }
      merged[bucket][id] = winner;
      if (!l) summary.added += 1;
    }
  }

  // Placements carry no modifiedAt — they are identity, not content — so the
  // rule is simply "exists on either side and not tombstoned".
  const allPlacements = { ...(a.placements || {}), ...(b.placements || {}) };
  for (const [id, p] of Object.entries(allPlacements)) {
    if (isTombstoned(deleted, 'placement', id)) continue;
    if (!merged.items[p.itemId] || !merged.groups[p.groupId]) continue;   // dangling
    merged.placements[id] = p;
  }

  // Now that the record sets are settled, rebuild every ordering against them.
  merged.projectOrder = reconcileOrder(
    (a.projectOrder || []).length >= (b.projectOrder || []).length ? a.projectOrder : b.projectOrder,
    Object.keys(merged.projects),
  );

  for (const project of Object.values(merged.projects)) {
    const groupIds = Object.values(merged.groups)
      .filter((g) => g.projectId === project.id)
      .map((g) => g.id);
    project.groupOrder = reconcileOrder(project.groupOrder, groupIds);
  }

  for (const group of Object.values(merged.groups)) {
    const placementIds = Object.values(merged.placements)
      .filter((p) => p.groupId === group.id)
      .map((p) => p.id);
    group.placementOrder = reconcileOrder(group.placementOrder, placementIds);
  }

  // The active project may have been deleted elsewhere.
  if (!merged.projects[merged.ui?.activeProjectId]) {
    merged.ui = { ...merged.ui, activeProjectId: merged.projectOrder[0] || null };
  }

  return { state: merged, summary };
}

function pick(l, r, summary) {
  if (l && !r) return l;
  if (r && !l) return r;
  if (!l && !r) return null;
  const lt = timeOf(l.modifiedAt);
  const rt = timeOf(r.modifiedAt);
  if (rt > lt) {
    summary.fromRemote += 1;
    return r;
  }
  if (lt > rt) {
    summary.fromLocal += 1;
    return l;
  }
  return l;   // identical timestamps: same edit, or a tie nobody loses by
}

function mergeMeta(a = {}, b = {}) {
  const latest = (x, y) => (timeOf(x) >= timeOf(y) ? x : y);
  return {
    ...b,
    ...a,
    lastZoteroSync: latest(a.lastZoteroSync, b.lastZoteroSync),
    lastGistPush: latest(a.lastGistPush, b.lastGistPush),
  };
}

/** Portable settings travel; the newer `settingsModifiedAt` wins the lot. */
function mergePortableSettings(a, b) {
  if (!a && !b) return undefined;
  const mine = a || {};
  const theirs = b || {};
  const newer = timeOf(theirs.settingsModifiedAt) > timeOf(mine.settingsModifiedAt) ? theirs : mine;
  const out = {};
  for (const key of PORTABLE_SETTINGS) {
    if (newer[key] !== undefined) out[key] = newer[key];
  }
  if (newer.settingsModifiedAt) out.settingsModifiedAt = newer.settingsModifiedAt;
  return Object.keys(out).length ? out : undefined;
}

/** Has anything actually changed? Used to skip pointless uploads. */
export function statesEqual(a, b) {
  return fingerprintState(a) === fingerprintState(b);
}

/** A cheap content hash: record ids paired with their modification times. */
export function fingerprintState(state) {
  if (!state) return '';
  const parts = [];
  for (const bucket of BUCKETS) {
    const rows = Object.entries(state[bucket] || {})
      .map(([id, r]) => `${id}@${r.modifiedAt || ''}`)
      .sort();
    parts.push(`${bucket}:${rows.join(',')}`);
  }
  parts.push(`placements:${Object.keys(state.placements || {}).sort().join(',')}`);
  parts.push(`deleted:${Object.keys(state.deleted || {}).sort().join(',')}`);
  parts.push(`order:${(state.projectOrder || []).join(',')}`);
  for (const g of Object.values(state.groups || {})) {
    parts.push(`g${g.id}:${(g.placementOrder || []).join(',')}`);
  }
  for (const p of Object.values(state.projects || {})) {
    parts.push(`p${p.id}:${(p.groupOrder || []).join(',')}`);
  }
  return parts.join('|');
}

export { TOMBSTONE_TTL_DAYS };
