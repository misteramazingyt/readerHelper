#!/usr/bin/env node
// test-store.mjs — behavioural tests for the board model.
//
// The interesting requirement is the linked duplicate: one book record, many
// placements. Editing any copy must change all of them; dragging one copy must
// move only it. These tests pin that down, plus move/copy/delete and sorting.

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const store = await import('../js/store.js');
const model = await import('../js/model.js');
const nlp = await import('../js/nlp.js');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what} expected ${e}, got ${a}`);
}

function ok(cond, what) {
  if (!cond) throw new Error(what || 'expected true');
}

// ------------------------------------------------------------------- set-up

const project = store.addProject('Dissertation');
const toRead = store.addGroup(project.id, 'To read');
const reading = store.addGroup(project.id, 'Reading now');
const second = store.addProject('Side reading');
const sideGroup = store.addGroup(second.id, 'Fun');

const { item: capital, placement: capitalP } = store.addItem(toRead.id, {
  title: 'Capital, Vol. I',
  authors: ['Karl Marx'],
  totalPages: 1152,
  totalChapters: 33,
});
const { item: ulysses } = store.addItem(toRead.id, { title: 'Ulysses', totalPages: 730 });

check('project and groups created', () => {
  const s = store.getState();
  eq(s.projects[project.id].groupOrder.length, 2, 'group count');
  eq(model.orderedGroups(s, project.id).map((g) => g.name), ['To read', 'Reading now']);
});

check('books land in their group', () => {
  const s = store.getState();
  eq(model.visiblePlacements(s, toRead.id).length, 2, 'card count');
});

// --------------------------------------------------- linked duplicate: core

const copy = store.duplicatePlacement(capitalP.id, sideGroup.id);

check('duplicate creates a second placement on the SAME item', () => {
  const s = store.getState();
  eq(s.placements[copy.id].itemId, capital.id, 'itemId');
  eq(Object.values(s.placements).filter((p) => p.itemId === capital.id).length, 2, 'placements');
  eq(Object.values(s.items).filter((i) => i.title === 'Capital, Vol. I').length, 1, 'item records');
});

check('editing the copy edits the original (bidirectional)', () => {
  store.renameItem(capital.id, 'Capital, Volume One');
  const s = store.getState();
  const viaOriginal = model.itemOfPlacement(s, capitalP.id);
  const viaCopy = model.itemOfPlacement(s, copy.id);
  eq(viaOriginal.title, 'Capital, Volume One', 'original title');
  eq(viaCopy.title, 'Capital, Volume One', 'copy title');
  ok(viaOriginal === viaCopy, 'both placements resolve to one record');
});

check('the copy sits in the other project without moving the original', () => {
  const s = store.getState();
  eq(s.placements[copy.id].groupId, sideGroup.id, 'copy group');
  eq(s.placements[capitalP.id].groupId, toRead.id, 'original group');
  ok(s.groups[sideGroup.id].placementOrder.includes(copy.id), 'copy listed in side group');
  ok(s.groups[toRead.id].placementOrder.includes(capitalP.id), 'original still listed');
});

check('dragging the copy elsewhere leaves the original alone', () => {
  store.movePlacement(copy.id, reading.id, 0);
  const s = store.getState();
  eq(s.placements[copy.id].groupId, reading.id, 'copy moved');
  eq(s.placements[capitalP.id].groupId, toRead.id, 'original unmoved');
  ok(!s.groups[sideGroup.id].placementOrder.includes(copy.id), 'removed from old group');
});

check('progress is shared across copies', () => {
  store.setCurrentPage(capital.id, 576);
  const s = store.getState();
  eq(Math.round(model.itemProgress(s.items[capital.id]) * 100), 50, 'percent');
  eq(model.itemOfPlacement(s, copy.id).currentPage, 576, 'copy sees the page');
});

check('removing one copy keeps the book alive', () => {
  store.removePlacement(copy.id);
  const s = store.getState();
  ok(s.items[capital.id], 'item survives');
  ok(s.placements[capitalP.id], 'original placement survives');
  eq(Object.values(s.placements).filter((p) => p.itemId === capital.id).length, 1, 'one placement left');
});

check('removing the last copy deletes the record', () => {
  const { item: temp, placement: tempP } = store.addItem(toRead.id, { title: 'Throwaway' });
  store.removePlacement(tempP.id);
  ok(!store.getState().items[temp.id], 'item removed with its last placement');
});

// ------------------------------------------------------------ move and copy

check('moving a group between projects rewires both sides', () => {
  store.moveGroup(reading.id, second.id);
  const s = store.getState();
  eq(s.groups[reading.id].projectId, second.id, 'group project');
  ok(!s.projects[project.id].groupOrder.includes(reading.id), 'gone from source');
  ok(s.projects[second.id].groupOrder.includes(reading.id), 'present in target');
  store.moveGroup(reading.id, project.id); // put it back
});

check('copying a group links the same books', () => {
  const copied = store.copyGroup(toRead.id, second.id);
  const s = store.getState();
  const originalItems = s.groups[toRead.id].placementOrder.map((id) => s.placements[id].itemId);
  const copiedItems = s.groups[copied.id].placementOrder.map((id) => s.placements[id].itemId);
  eq(copiedItems, originalItems, 'same item ids');
  ok(copied.id !== toRead.id, 'distinct group');
  store.deleteGroup(copied.id);
  ok(store.getState().items[capital.id], 'deleting the copied group keeps the books');
});

check('deleting a group does not delete books held elsewhere', () => {
  const s = store.getState();
  ok(s.items[ulysses.id], 'ulysses survives');
});

// ---------------------------------------------------------------- ordering

check('reordering within a group works', () => {
  const s = store.getState();
  const before = [...s.groups[toRead.id].placementOrder];
  store.reorderPlacement(before[0], 1);
  eq(store.getState().groups[toRead.id].placementOrder, [before[1], before[0]], 'swapped');
});

check('alphabetical sort ignores stored order', () => {
  store.setGroupSort(toRead.id, 'alpha', 'asc');
  const s = store.getState();
  const titles = model.visiblePlacements(s, toRead.id).map((r) => r.item.title);
  eq(titles, [...titles].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), 'alpha asc');
  store.setGroupSort(toRead.id, 'alpha', 'desc');
  const desc = model.visiblePlacements(store.getState(), toRead.id).map((r) => r.item.title);
  eq(desc, [...titles].reverse(), 'alpha desc');
  store.setGroupSort(toRead.id, 'custom', 'asc');
});

// ----------------------------------------------------------- reading + log

check('logging reading advances the page and the percentage', () => {
  store.setCurrentPage(capital.id, 0);
  const intent = nlp.parseReading('two chapters');
  const res = nlp.resolveReading(intent, store.getState().items[capital.id]);
  ok(res.ok, res.explain);
  store.logReading(capital.id, { raw: 'two chapters', ...res });
  const item = store.getState().items[capital.id];
  eq(item.currentPage, 70, 'page after 2 of 33 chapters over 1152pp');
  eq(item.readingLog.length, 1, 'log entry recorded');
});

check('reading is clamped to the book length', () => {
  store.setCurrentPage(capital.id, 99999);
  eq(store.getState().items[capital.id].currentPage, 1152, 'clamped');
  eq(model.itemProgress(store.getState().items[capital.id]), 1, 'reads as 100%');
});

check('archiving hides a book from the board but keeps it', () => {
  store.archiveItem(capital.id, true);
  const s = store.getState();
  eq(model.visiblePlacements(s, toRead.id).length, 1, 'hidden from column');
  ok(s.items[capital.id], 'record retained');
  store.archiveItem(capital.id, false);
});

// ------------------------------------------------------------------- undo

check('undo restores the previous board', () => {
  const before = store.getState().items[ulysses.id].title;
  store.renameItem(ulysses.id, 'Finnegans Wake');
  eq(store.getState().items[ulysses.id].title, 'Finnegans Wake', 'renamed');
  store.undo();
  eq(store.getState().items[ulysses.id].title, before, 'undone');
  store.redo();
  eq(store.getState().items[ulysses.id].title, 'Finnegans Wake', 'redone');
  store.undo();
});

check('project progress averages distinct books only', () => {
  store.setCurrentPage(capital.id, 576);   // 50%
  store.setCurrentPage(ulysses.id, 730);   // 100%
  const p = model.projectProgress(store.getState(), project.id);
  eq(Math.round(p * 100), 75, 'mean of 50 and 100');
});

check('a duplicate does not double-count in project progress', () => {
  const dup = store.duplicatePlacement(capitalP.id);
  const p = model.projectProgress(store.getState(), project.id);
  eq(Math.round(p * 100), 75, 'still the mean of two distinct books');
  store.removePlacement(dup.id);
});

// ---------------------------------------------------------- serialisation

check('state survives a save/load round trip', () => {
  const exported = store.exportState();
  const json = JSON.stringify(exported);
  store.replaceState(JSON.parse(json), 'round trip');
  const s = store.getState();
  eq(Object.keys(s.items).length, Object.keys(exported.items).length, 'item count');
  eq(s.projects[project.id].name, 'Dissertation', 'project name');
});

check('migration drops dangling references', () => {
  const broken = store.exportState();
  broken.placements.ghost = { id: 'ghost', itemId: 'nope', groupId: toRead.id };
  broken.groups[toRead.id].placementOrder.push('ghost');
  store.replaceState(broken, 'repair');
  const s = store.getState();
  ok(!s.placements.ghost, 'ghost placement dropped');
  ok(!s.groups[toRead.id].placementOrder.includes('ghost'), 'order cleaned');
});

// ------------------------------------------------------------------ report

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ ${passed} store tests passed.`);
