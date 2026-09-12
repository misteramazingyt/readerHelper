#!/usr/bin/env node
// test-ingest.mjs — Zotero import shape, against a stubbed Zotero API.
//
// Verifies the rule the spec cares about: a collection becomes a project and
// its subcollections become groups; re-syncing is additive and never clobbers
// reading progress.

import { emptyState } from '../js/model.js';
import { buildPlan, applyPlan, linkedCollectionKeys, UNSORTED } from '../js/ingest.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; })
    .catch((err) => failures.push(`${name}: ${err.message}`));
}

function eq(a, b, what = '') {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${what} expected ${y}, got ${x}`);
}
function ok(c, what) { if (!c) throw new Error(what || 'expected true'); }

// ------------------------------------------------------------- stub Zotero

const COLLECTIONS = [
  { key: 'ROOT', name: 'Dissertation', parentCollection: null },
  { key: 'SUB1', name: 'Chapter 1 — Method', parentCollection: 'ROOT' },
  { key: 'SUB2', name: 'Chapter 2 — Cases', parentCollection: 'ROOT' },
  { key: 'OTHER', name: 'Unrelated', parentCollection: null },
];

let ITEMS = {
  ROOT: [row('TOP1', 'A Loose Item', 1)],
  SUB1: [row('M1', 'Method Matters', 1), row('M2', 'On Cases', 1)],
  SUB2: [row('C1', 'The Case Book', 1)],
};

function row(key, title, version) {
  return { key, version, data: { key, itemType: 'book', title, creators: [{ creatorType: 'author', firstName: 'A', lastName: 'Writer' }], date: '2001', numPages: '200' } };
}

// Counts every call, so a test can assert the import does not go back to the
// network once per book.
const calls = { tree: 0, children: 0, fields: 0 };

const zotStub = {
  async fetchCollections() { return COLLECTIONS; },
  async fetchCollectionItems(_cfg, key) { return ITEMS[key] || []; },
  async fetchItemChildren() { calls.children += 1; return []; },
  async fetchCollectionTree(_cfg, key) {
    calls.tree += 1;
    const rows = ITEMS[key] || [];
    // A PDF attachment hanging off the first item, as a real library would have.
    const childrenByParent = new Map();
    if (rows.length) {
      childrenByParent.set(rows[0].key, [
        { key: 'ATT1', data: { itemType: 'attachment', contentType: 'application/pdf', linkMode: 'imported_file', path: 'storage:x.pdf', parentItem: rows[0].key } },
      ]);
    }
    return { tops: rows, childrenByParent };
  },
  async toItemFields(_cfg, r, opts = {}) {
    calls.fields += 1;
    // Mirror the real signature: with attachments supplied, make no request.
    if (!opts.attachments) await zotStub.fetchItemChildren();
    return {
      title: r.data.title,
      authors: ['A Writer'],
      year: 2001,
      zoteroKey: r.key,
      zoteroVersion: r.version,
      totalPages: 200,
      itemType: 'book',
      pdfAttachmentKey: (opts.attachments || [])[0]?.key || null,
    };
  },
};

const cfg = { zoteroApiKey: 'k', zoteroUserId: '1' };

// -------------------------------------------------------------------- tests

await check('an import costs one request per collection, not one per book', async () => {
  // The N+1 this replaces: asking each book for its children meant three
  // hundred serial round trips on a real library, which looked like a hang.
  ITEMS.SUB1 = Array.from({ length: 40 }, (_, i) => row(`M${i}`, `Book ${i}`, 1));
  calls.tree = 0; calls.children = 0;

  const plan = await buildPlan(cfg, zotStub, 'ROOT');
  const books = plan.groups.reduce((n, g) => n + g.items.length, 0);

  ok(books >= 40, `fetched the books (${books})`);
  eq(calls.children, 0, 'no per-book request');
  eq(calls.tree, 1 + COLLECTIONS.filter((c) => c.parentCollection === 'ROOT').length,
    'one tree fetch for the root and one per subcollection');

  ITEMS.SUB1 = [row('M1', 'Method Matters', 1), row('M2', 'On Cases', 1)];
});

await check('attachments come from the bulk fetch, not a second call', async () => {
  calls.children = 0;
  const plan = await buildPlan(cfg, zotStub, 'ROOT');
  const withPdf = plan.groups.flatMap((g) => g.items).filter((i) => i.pdfAttachmentKey);
  ok(withPdf.length > 0, 'PDFs were still found');
  eq(calls.children, 0, 'and without asking per item');
});

const state = emptyState();

await check('a collection becomes a project, subcollections become groups', async () => {
  const plan = await buildPlan(cfg, zotStub, 'ROOT');
  const report = applyPlan(state, plan);

  const project = state.projects[report.projectId];
  eq(project.name, 'Dissertation', 'project name');
  eq(project.zoteroCollectionKey, 'ROOT', 'linked key');

  const groupNames = project.groupOrder.map((id) => state.groups[id].name);
  eq(groupNames, [UNSORTED, 'Chapter 1 — Method', 'Chapter 2 — Cases'], 'group names');
  eq(report.added, 4, 'books imported');
});

await check('loose top-level items go to an Unsorted group', () => {
  const project = Object.values(state.projects)[0];
  const unsorted = project.groupOrder.map((id) => state.groups[id]).find((g) => g.name === UNSORTED);
  ok(unsorted, 'Unsorted exists');
  eq(unsorted.placementOrder.length, 1, 'holds the loose item');
  eq(unsorted.zoteroCollectionKey, null, 'not claiming the parent key');
});

await check('subcollection groups keep their own collection key', () => {
  const g = Object.values(state.groups).find((x) => x.name === 'Chapter 1 — Method');
  eq(g.zoteroCollectionKey, 'SUB1', 'linked key');
  eq(g.placementOrder.length, 2, 'two books');
});

await check('re-syncing unchanged data adds nothing', async () => {
  const before = Object.keys(state.items).length;
  const plan = await buildPlan(cfg, zotStub, 'ROOT');
  const report = applyPlan(state, plan);
  eq(report.added, 0, 'no new books');
  eq(Object.keys(state.items).length, before, 'item count stable');
  eq(report.unchanged, 4, 'all unchanged');
});

await check('a new book in Zotero appears on the next sync', async () => {
  ITEMS.SUB2 = [...ITEMS.SUB2, row('C2', 'A Late Addition', 1)];
  const plan = await buildPlan(cfg, zotStub, 'ROOT');
  const report = applyPlan(state, plan);
  eq(report.added, 1, 'one new book');
  const g = Object.values(state.groups).find((x) => x.name === 'Chapter 2 — Cases');
  eq(g.placementOrder.length, 2, 'group grew');
});

await check('a new subcollection appears as a new group', async () => {
  COLLECTIONS.push({ key: 'SUB3', name: 'Chapter 3 — Coda', parentCollection: 'ROOT' });
  ITEMS.SUB3 = [row('X1', 'Coda Reading', 1)];
  const plan = await buildPlan(cfg, zotStub, 'ROOT');
  const report = applyPlan(state, plan);
  const project = state.projects[report.projectId];
  ok(project.groupOrder.map((id) => state.groups[id].name).includes('Chapter 3 — Coda'), 'new group added');
  eq(report.added, 1, 'its book came too');
});

await check('sync never overwrites reading progress', async () => {
  const item = Object.values(state.items).find((i) => i.zoteroKey === 'M1');
  item.currentPage = 88;
  item.notes = 'Important for ch. 1';
  item.tag = 'Digest';
  // Zotero-side edit bumps the version and retitles the work.
  ITEMS.SUB1 = [row('M1', 'Method Matters, 2nd ed.', 2), ITEMS.SUB1[1]];

  const plan = await buildPlan(cfg, zotStub, 'ROOT');
  const report = applyPlan(state, plan);

  const after = Object.values(state.items).find((i) => i.zoteroKey === 'M1');
  eq(after.title, 'Method Matters, 2nd ed.', 'title refreshed');
  eq(after.currentPage, 88, 'page kept');
  eq(after.notes, 'Important for ch. 1', 'notes kept');
  eq(after.tag, 'Digest', 'reading mode kept');
  eq(report.updated, 1, 'one refreshed');
});

await check('a hand-entered page count outranks the Zotero value', async () => {
  const item = Object.values(state.items).find((i) => i.zoteroKey === 'C1');
  item.totalPages = 999;
  ITEMS.SUB2 = [row('C1', 'The Case Book', 5), ITEMS.SUB2[1]];
  const plan = await buildPlan(cfg, zotStub, 'ROOT');
  applyPlan(state, plan);
  eq(Object.values(state.items).find((i) => i.zoteroKey === 'C1').totalPages, 999, 'kept 999');
});

await check('renaming the collection in Zotero renames the project', async () => {
  COLLECTIONS[0] = { ...COLLECTIONS[0], name: 'The Dissertation' };
  const plan = await buildPlan(cfg, zotStub, 'ROOT');
  const report = applyPlan(state, plan);
  eq(state.projects[report.projectId].name, 'The Dissertation', 'renamed');
});

await check('importing a second collection makes a second project', async () => {
  ITEMS.OTHER = [row('O1', 'Something Else', 1)];
  const plan = await buildPlan(cfg, zotStub, 'OTHER');
  const report = applyPlan(state, plan);
  eq(Object.keys(state.projects).length, 2, 'two projects');
  eq(state.projects[report.projectId].name, 'Unrelated', 'name');
  eq(linkedCollectionKeys(state).sort(), ['OTHER', 'ROOT'], 'both linked');
});

await check('a collection with no subcollections uses one group named after it', () => {
  const project = Object.values(state.projects).find((p) => p.zoteroCollectionKey === 'OTHER');
  const names = project.groupOrder.map((id) => state.groups[id].name);
  eq(names, ['Unrelated'], 'single group');
  const g = state.groups[project.groupOrder[0]];
  eq(g.zoteroCollectionKey, 'OTHER', 'group claims the key');
});

await check('a missing collection raises rather than corrupting state', async () => {
  let threw = false;
  try {
    await buildPlan(cfg, zotStub, 'DOES_NOT_EXIST');
  } catch {
    threw = true;
  }
  ok(threw, 'buildPlan rejected');
});

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ ${passed} ingest tests passed.`);
