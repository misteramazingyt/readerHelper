#!/usr/bin/env node
// test-sync.mjs — cross-device sync: the merge, and the pull-merge-push loop.
//
// Two halves:
//
//   merge()   pure, so tested directly. This is where work gets lost if the
//             rules are wrong, so the cases are about *both* machines' edits
//             surviving, and about a delete neither resurrecting itself nor
//             eating a newer edit.
//
//   syncNow() driven against a fake Gist server stubbed at fetch. "The other
//             computer" is simulated by writing a state document straight into
//             that server, which is exactly what it would look like in reality.

import { mergeStates, addTombstone, pruneTombstones, reconcileOrder, fingerprintState } from '../js/merge.js';

// --------------------------------------------------------------- scaffolding

// The sync engine narrates what it does, which is useful in a browser console
// and noise here.
console.info = () => {};
console.warn = () => {};

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(c, what) { if (!c) throw new Error(what || 'expected true'); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// Timestamps must be recent: tombstones older than the 90-day TTL are pruned,
// so a fixture dated months ago would test the pruning, not the merge.
const ORIGIN = Date.now() - 3600_000;              // an hour ago
const T = (n) => new Date(ORIGIN + n * 1000).toISOString();
const later = (ms = 5000) => new Date(Date.now() + ms).toISOString();

function board({ projects = [], groups = [], items = [], placements = [], deleted = {}, order = null } = {}) {
  const state = {
    version: 1,
    projects: {}, groups: {}, items: {}, placements: {},
    projectOrder: order || projects.map((p) => p.id),
    deleted,
    ui: { activeProjectId: projects[0]?.id || null, projectSort: { mode: 'custom', dir: 'asc' } },
    meta: {},
  };
  for (const p of projects) state.projects[p.id] = { groupOrder: [], modifiedAt: T(0), ...p };
  for (const g of groups) state.groups[g.id] = { placementOrder: [], modifiedAt: T(0), ...g };
  for (const i of items) state.items[i.id] = { modifiedAt: T(0), title: i.id, ...i };
  for (const pl of placements) state.placements[pl.id] = pl;
  for (const g of Object.values(state.groups)) {
    const prj = state.projects[g.projectId];
    if (prj && !prj.groupOrder.includes(g.id)) prj.groupOrder.push(g.id);
  }
  for (const pl of Object.values(state.placements)) {
    const g = state.groups[pl.groupId];
    if (g && !g.placementOrder.includes(pl.id)) g.placementOrder.push(pl.id);
  }
  return state;
}

const BASE = () => board({
  projects: [{ id: 'P1', name: 'Reading' }],
  groups: [{ id: 'G1', projectId: 'P1', name: 'To read' }],
  items: [{ id: 'I1', title: 'Shared Book' }],
  placements: [{ id: 'X1', itemId: 'I1', groupId: 'G1' }],
});

// ================================================================== merging

await check('an edit on each machine survives the merge', () => {
  const local = BASE();
  const remote = BASE();
  local.items.I1 = { ...local.items.I1, currentPage: 100, modifiedAt: T(10) };
  remote.groups.G1 = { ...remote.groups.G1, name: 'Renamed elsewhere', modifiedAt: T(20) };

  const { state } = mergeStates(local, remote);
  eq(state.items.I1.currentPage, 100, 'this machine kept its reading progress');
  eq(state.groups.G1.name, 'Renamed elsewhere', 'and took the other machine rename');
});

await check('the newer edit of the same record wins', () => {
  const local = BASE();
  const remote = BASE();
  local.items.I1 = { ...local.items.I1, title: 'Older', modifiedAt: T(5) };
  remote.items.I1 = { ...remote.items.I1, title: 'Newer', modifiedAt: T(9) };
  eq(mergeStates(local, remote).state.items.I1.title, 'Newer', 'remote newer');

  local.items.I1.modifiedAt = T(30);
  local.items.I1.title = 'Newest';
  eq(mergeStates(local, remote).state.items.I1.title, 'Newest', 'local newer');
});

await check('a book added on the other machine arrives here', () => {
  const local = BASE();
  const remote = BASE();
  remote.items.I2 = { id: 'I2', title: 'Added There', modifiedAt: T(10) };
  remote.placements.X2 = { id: 'X2', itemId: 'I2', groupId: 'G1' };
  remote.groups.G1.placementOrder.push('X2');

  const { state, summary } = mergeStates(local, remote);
  ok(state.items.I2, 'the book is here');
  ok(state.groups.G1.placementOrder.includes('X2'), 'and on the board');
  eq(summary.added, 1, 'counted as added');
});

await check('a book added here is not wiped by the other copy', () => {
  const local = BASE();
  const remote = BASE();
  local.items.I3 = { id: 'I3', title: 'Added Here', modifiedAt: T(10) };
  local.placements.X3 = { id: 'X3', itemId: 'I3', groupId: 'G1' };
  local.groups.G1.placementOrder.push('X3');

  const { state } = mergeStates(local, remote);
  ok(state.items.I3, 'still here');
  ok(state.groups.G1.placementOrder.includes('X3'), 'still on the board');
});

await check('a whole project added on one side survives', () => {
  const local = BASE();
  const remote = BASE();
  remote.projects.P2 = { id: 'P2', name: 'Side reading', groupOrder: ['G2'], modifiedAt: T(10) };
  remote.groups.G2 = { id: 'G2', projectId: 'P2', name: 'Fun', placementOrder: [], modifiedAt: T(10) };
  remote.projectOrder = ['P1', 'P2'];

  const { state } = mergeStates(local, remote);
  eq(state.projects.P2.name, 'Side reading', 'project came across');
  ok(state.projectOrder.includes('P2'), 'and is in the sidebar order');
  eq(state.projects.P2.groupOrder, ['G2'], 'with its group');
});

// -------------------------------------------------------------- tombstones

await check('a delete on the other machine removes it here', () => {
  const local = BASE();
  const remote = BASE();
  delete remote.items.I1;
  delete remote.placements.X1;
  remote.groups.G1.placementOrder = [];
  addTombstone(remote, 'item', 'I1', later());
  addTombstone(remote, 'placement', 'X1', later());

  const { state, summary } = mergeStates(local, remote);
  ok(!state.items.I1, 'the book is gone');
  ok(!state.placements.X1, 'and so is its card');
  eq(summary.deleted, 1, 'counted');
});

await check('a deleted book does not come back from the other copy', () => {
  // The classic failure: A deletes, B still has it, B pushes, the book returns.
  const local = BASE();
  delete local.items.I1;
  delete local.placements.X1;
  local.groups.G1.placementOrder = [];
  addTombstone(local, 'item', 'I1', later());
  addTombstone(local, 'placement', 'X1', later());

  const remote = BASE();   // still has it, untouched since T(0)
  const { state } = mergeStates(local, remote);
  ok(!state.items.I1, 'stays deleted');
  ok(!state.placements.X1, 'card stays gone');
});

await check('an edit newer than the delete wins, and the book is restored', () => {
  const local = BASE();
  addTombstone(local, 'item', 'I1', later(1000));
  delete local.items.I1;

  const remote = BASE();
  remote.items.I1 = { ...remote.items.I1, title: 'Edited after the delete', modifiedAt: later(9000) };

  const { state, summary } = mergeStates(local, remote);
  ok(state.items.I1, 'restored');
  eq(state.items.I1.title, 'Edited after the delete', 'with the newer content');
  eq(summary.resurrected, 1, 'counted as a resurrection');
});

await check('old tombstones are pruned so they cannot pile up forever', () => {
  const now = Date.UTC(2026, 5, 1);
  const kept = { 'item:new': { type: 'item', id: 'new', at: new Date(now - 1000).toISOString() } };
  const old = { 'item:old': { type: 'item', id: 'old', at: new Date(now - 200 * 864e5).toISOString() } };
  const out = pruneTombstones({ ...kept, ...old }, { now });
  eq(Object.keys(out), ['item:new'], 'only the recent one survives');
});

// ------------------------------------------------------------------ orders

await check('orders are rebuilt against what actually exists', () => {
  eq(reconcileOrder(['a', 'b', 'c'], ['a', 'c']), ['a', 'c'], 'drops the missing');
  eq(reconcileOrder(['a'], ['a', 'b']), ['a', 'b'], 'appends the new');
  eq(reconcileOrder(['a', 'a', 'b'], ['a', 'b']), ['a', 'b'], 'de-duplicates');
  eq(reconcileOrder([], ['x']), ['x'], 'from empty');
});

await check('a card reordered on one machine keeps a coherent order', () => {
  const local = BASE();
  const remote = BASE();
  for (const s of [local, remote]) {
    s.items.I2 = { id: 'I2', title: 'Second', modifiedAt: T(0) };
    s.placements.X2 = { id: 'X2', itemId: 'I2', groupId: 'G1' };
    s.groups.G1.placementOrder = ['X1', 'X2'];
  }
  remote.groups.G1 = { ...remote.groups.G1, placementOrder: ['X2', 'X1'], modifiedAt: T(30) };

  const { state } = mergeStates(local, remote);
  eq(state.groups.G1.placementOrder, ['X2', 'X1'], 'the newer order wins');
});

await check('a placement whose book or group is gone is dropped', () => {
  const local = BASE();
  local.placements.ORPHAN = { id: 'ORPHAN', itemId: 'NOPE', groupId: 'G1' };
  local.placements.HOMELESS = { id: 'HOMELESS', itemId: 'I1', groupId: 'NOPE' };
  const { state } = mergeStates(local, BASE());
  ok(!state.placements.ORPHAN, 'no dangling item reference');
  ok(!state.placements.HOMELESS, 'no dangling group reference');
});

await check('the active project is local, and recovers if it was deleted', () => {
  const local = BASE();
  const remote = BASE();
  remote.ui = { activeProjectId: 'P_OTHER' };
  eq(mergeStates(local, remote).state.ui.activeProjectId, 'P1', 'this machine keeps its own view');

  const gone = BASE();
  gone.ui.activeProjectId = 'P_DELETED';
  eq(mergeStates(gone, BASE()).state.ui.activeProjectId, 'P1', 'falls back to a real project');
});

await check('portable settings travel, and the newer set wins', () => {
  const local = BASE();
  const remote = BASE();
  local.settings = { zoteroProjectsRoot: '01 Projects', theme: 'dark', settingsModifiedAt: T(5) };
  remote.settings = { zoteroProjectsRoot: 'Research', theme: 'light', settingsModifiedAt: T(50) };
  eq(mergeStates(local, remote).state.settings.zoteroProjectsRoot, 'Research', 'newer set adopted');
  eq(mergeStates(remote, local).state.settings.theme, 'light', 'regardless of which side is local');
});

await check('the fingerprint notices real change and ignores noise', () => {
  const a = BASE();
  const b = BASE();
  eq(fingerprintState(a), fingerprintState(b), 'identical boards match');
  b.meta = { savedAt: 'whenever' };
  eq(fingerprintState(a), fingerprintState(b), 'metadata alone is not a change');
  b.items.I1 = { ...b.items.I1, modifiedAt: T(99) };
  ok(fingerprintState(a) !== fingerprintState(b), 'an edit is a change');
});

// ============================================================ the sync loop

let server;
function resetServer({ gists = [] } = {}) {
  server = { gists: new Map(), calls: [], nextId: 1 };
  for (const g of gists) server.gists.set(g.id, g);
}

function gistDoc(id, state) {
  return {
    id,
    description: 'readerHelper board state (private)',
    updated_at: new Date().toISOString(),
    files: { 'readerhelper-state.json': { content: JSON.stringify(state), truncated: false } },
  };
}

globalThis.localStorage = (() => {
  let m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    __reset: () => { m = new Map(); },
  };
})();

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method || 'GET';
  server.calls.push({ method, path: u.pathname + u.search });
  const json = (body, status = 200) => ({
    ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
  });

  if (u.pathname === '/user') return json({ login: 'misteramazingyt' });
  if (u.pathname === '/gists' && method === 'GET') {
    return json([...server.gists.values()]);
  }
  if (u.pathname === '/gists' && method === 'POST') {
    const id = `NEW${server.nextId++}`;
    const state = JSON.parse(JSON.parse(init.body).files['readerhelper-state.json'].content);
    server.gists.set(id, gistDoc(id, state));
    return json({ id });
  }
  const m = u.pathname.match(/^\/gists\/([\w]+)$/);
  if (m) {
    const g = server.gists.get(m[1]);
    if (!g) return json({ message: 'Not Found' }, 404);
    if (method === 'GET') return json(g);
    if (method === 'PATCH') {
      const state = JSON.parse(JSON.parse(init.body).files['readerhelper-state.json'].content);
      server.gists.set(m[1], gistDoc(m[1], state));
      return json(server.gists.get(m[1]));
    }
  }
  throw new Error(`unexpected request: ${method} ${u.pathname}`);
};

const store = await import('../js/store.js');
const boardsync = await import('../js/boardsync.js');

function reset({ local = null, settings = {} } = {}) {
  store.replaceState(local || board({}), 'test reset');
  store.saveSettings({
    githubToken: 'gho_test',
    gistSyncEnabled: true,
    gistId: '',
    syncDefaultsApplied: true,
    ...settings,
  });
}

const remoteState = (id) => JSON.parse(server.gists.get(id).files['readerhelper-state.json'].content);
const patches = () => server.calls.filter((c) => c.method === 'PATCH');
const creates = () => server.calls.filter((c) => c.method === 'POST' && c.path === '/gists');

await check('a new computer finds the existing board instead of starting its own', async () => {
  // The bug this replaces: with no gistId, the first save created a SECOND
  // gist and the two machines drifted apart without a word.
  resetServer({ gists: [gistDoc('EXISTING', BASE())] });
  reset({ local: board({}) });          // a fresh machine, empty board

  await boardsync.syncNow({ reason: 'test' });

  eq(creates().length, 0, 'no second gist created');
  eq(store.getSettings().gistId, 'EXISTING', 'adopted the one already there');
  const s = store.getState();
  eq(s.projects.P1?.name, 'Reading', 'the board arrived');
  eq(s.items.I1?.title, 'Shared Book', 'with its books');
});

await check('a gist is created only when the account genuinely has none', async () => {
  resetServer({ gists: [] });
  reset({ local: BASE() });
  await boardsync.syncNow({ reason: 'test' });
  eq(creates().length, 1, 'one created');
  ok(store.getSettings().gistId.startsWith('NEW'), 'and remembered');
});

await check('work done on each computer ends up on both', async () => {
  resetServer({ gists: [gistDoc('G', BASE())] });
  reset({ local: BASE(), settings: { gistId: 'G' } });

  // This machine adds a book.
  const s = store.getState();
  store.addItem('G1', { title: 'Added On This Machine' });

  // Meanwhile the other machine renames the group and adds its own book.
  // The other machine's edits happen after this machine's, so they are newer.
  const theirs = BASE();
  theirs.groups.G1 = { ...theirs.groups.G1, name: 'Renamed Over There', modifiedAt: later() };
  theirs.items.OTHER = { id: 'OTHER', title: 'Added Over There', modifiedAt: later() };
  theirs.placements.XO = { id: 'XO', itemId: 'OTHER', groupId: 'G1' };
  theirs.groups.G1.placementOrder = ['X1', 'XO'];
  server.gists.set('G', gistDoc('G', theirs));

  await boardsync.syncNow({ reason: 'test' });

  const after = store.getState();
  const titles = Object.values(after.items).map((i) => i.title).sort();
  ok(titles.includes('Added On This Machine'), `kept this machine's book (got ${titles})`);
  ok(titles.includes('Added Over There'), 'took the other machine book');
  eq(after.groups.G1.name, 'Renamed Over There', 'and the rename');

  // And the merged result went back up, so the other machine will see it too.
  const uploaded = remoteState('G');
  const remoteTitles = Object.values(uploaded.items).map((i) => i.title).sort();
  ok(remoteTitles.includes('Added On This Machine'), 'uploaded this machine work');
  ok(remoteTitles.includes('Added Over There'), 'and kept theirs');
});

await check('a delete made on the other computer is honoured here', async () => {
  resetServer({ gists: [gistDoc('G', BASE())] });
  reset({ local: BASE(), settings: { gistId: 'G' } });

  const theirs = BASE();
  delete theirs.items.I1;
  delete theirs.placements.X1;
  theirs.groups.G1.placementOrder = [];
  addTombstone(theirs, 'item', 'I1', new Date().toISOString());
  addTombstone(theirs, 'placement', 'X1', new Date().toISOString());
  server.gists.set('G', gistDoc('G', theirs));

  await boardsync.syncNow({ reason: 'test' });
  ok(!store.getState().items.I1, 'the book is gone here too');
});

await check('a delete made here is not undone by the other copy', async () => {
  resetServer({ gists: [gistDoc('G', BASE())] });
  reset({ local: BASE(), settings: { gistId: 'G' } });

  const placementId = Object.keys(store.getState().placements)[0];
  store.removePlacement(placementId);
  ok(!store.getState().items.I1, 'deleted locally');

  await boardsync.syncNow({ reason: 'test' });
  ok(!store.getState().items.I1, 'still deleted after syncing with a copy that still had it');
  ok(!remoteState('G').items.I1, 'and the deletion was published');
});

await check('nothing is uploaded when nothing changed', async () => {
  resetServer({ gists: [gistDoc('G', BASE())] });
  reset({ local: BASE(), settings: { gistId: 'G' } });
  await boardsync.syncNow({ reason: 'first' });
  const before = patches().length;
  await boardsync.syncNow({ reason: 'second' });
  eq(patches().length, before, 'the second sync wrote nothing');
});

await check('a gist that has been deleted is recovered from, not duplicated blindly', async () => {
  resetServer({ gists: [gistDoc('REAL', BASE())] });
  reset({ local: board({}), settings: { gistId: 'GONE' } });

  await boardsync.syncNow({ reason: 'test' });
  // The stale id is dropped; the next pass discovers the real one.
  await boardsync.syncNow({ reason: 'test' });

  eq(store.getSettings().gistId, 'REAL', 'found the surviving gist');
  eq(creates().length, 0, 'did not create a replacement');
});

await check('sync does nothing without a token', async () => {
  resetServer({ gists: [] });
  reset({ local: BASE(), settings: { githubToken: '' } });
  const res = await boardsync.syncNow({ reason: 'test' });
  eq(res.skipped, 'disabled', 'skipped');
  eq(server.calls.length, 0, 'no requests');
});

await check('sync can still be switched off deliberately', async () => {
  resetServer({ gists: [] });
  reset({ local: BASE(), settings: { gistSyncEnabled: false } });
  eq(boardsync.syncEnabled(), false, 'disabled');
  eq((await boardsync.syncNow({ reason: 'test' })).skipped, 'disabled', 'and does nothing');
});

// ------------------------------------------------------------------- report

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ ${passed} sync tests passed.`);
