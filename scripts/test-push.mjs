#!/usr/bin/env node
// test-push.mjs — pushing the board back into Zotero.
//
// Rather than mocking js/zotero.js, this stubs `fetch` with a small in-memory
// Zotero server. That way the real request layer, the real pagination, the
// real PATCH-merge and the real write-unpacking are all exercised, and the
// assertions can be about the state the library ends up in — which is the
// thing that actually matters when writing to someone's library.

import * as push from '../js/zotero-push.js';
import * as zotero from '../js/zotero.js';

// ------------------------------------------------------------ fake library

let library;

function resetLibrary({ collections = [], items = [] } = {}) {
  library = {
    version: 10,
    collections: collections.map((c, i) => ({ key: c.key || `COLL${i}`, ...c })),
    items: items.map((it, i) => ({ key: it.key || `ITEM${i}`, version: 10, data: { collections: [], ...it } })),
    writes: [],
  };
}

function jsonRes(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => headers[h] ?? headers[h.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
})();

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method || 'GET';
  const path = u.pathname;
  const body = init.body ? JSON.parse(init.body) : null;
  library.writes.push({ method, path, body });

  // --- collections
  if (path.endsWith('/collections') && method === 'GET') {
    return jsonRes(
      library.collections.map((c) => ({
        key: c.key,
        version: library.version,
        data: { key: c.key, name: c.name, parentCollection: c.parentCollection || false },
      })),
      200,
      { 'Total-Results': String(library.collections.length), 'Last-Modified-Version': String(library.version) },
    );
  }
  if (path.endsWith('/collections') && method === 'POST') {
    const success = {};
    body.forEach((spec, i) => {
      const key = `NEW${library.collections.length}`;
      library.collections.push({
        key,
        name: spec.name,
        parentCollection: spec.parentCollection || null,
      });
      success[String(i)] = key;
    });
    library.version += 1;
    return jsonRes({ success, successful: {}, failed: {} });
  }

  // --- items
  if (path.endsWith('/items/top') && method === 'GET') {
    const since = u.searchParams.get('since');
    const rows = since ? library.items.filter((i) => i.version > Number(since)) : library.items;
    return jsonRes(rows, 200, {
      'Total-Results': String(rows.length),
      'Last-Modified-Version': String(library.version),
    });
  }
  if (path.endsWith('/deleted') && method === 'GET') {
    return jsonRes({ items: [], collections: [] });
  }
  if (path.endsWith('/items') && method === 'POST') {
    const success = {};
    body.forEach((data, i) => {
      const key = `MADE${library.items.length}`;
      library.items.push({ key, version: library.version + 1, data: { ...data } });
      success[String(i)] = key;
    });
    library.version += 1;
    return jsonRes({ success, successful: {}, failed: {} });
  }
  const itemMatch = path.match(/\/items\/([A-Z0-9]+)$/i);
  if (itemMatch && method === 'GET') {
    const found = library.items.find((i) => i.key === itemMatch[1]);
    if (!found) return jsonRes({}, 404);
    return jsonRes(found, 200, { 'Last-Modified-Version': String(found.version) });
  }
  if (itemMatch && method === 'PATCH') {
    const found = library.items.find((i) => i.key === itemMatch[1]);
    if (!found) return jsonRes({}, 404);
    Object.assign(found.data, body);
    found.version = library.version + 1;
    library.version += 1;
    return jsonRes({}, 204, { 'Last-Modified-Version': String(library.version) });
  }

  throw new Error(`fake Zotero got an unexpected request: ${method} ${path}`);
};

const CFG = { zoteroApiKey: 'k', zoteroUserId: '99', zoteroProjectsRoot: '01 Projects' };

// -------------------------------------------------------------------- test

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(c, what) { if (!c) throw new Error(what || 'expected true'); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const coll = (name, parent) => library.collections.find((c) => c.name === name && (c.parentCollection || null) === (parent || null));

// ============================================================ normalising

await check('identifiers normalise to a comparable form', () => {
  eq(push.normDoi('https://doi.org/10.1086/230209'), '10.1086/230209', 'doi url');
  eq(push.normDoi('10.1086/230209.'), '10.1086/230209', 'trailing stop');
  eq(push.normDoi('10.1086/ABC'), '10.1086/abc', 'case folded');
  eq(push.normIsbn('978-0-8040-1166-2'), '9780804011662', 'isbn hyphens');
  eq(push.normUrl('HTTPS://www.Example.com/x/#frag'), 'example.com/x', 'url');
  eq(push.normTitle('The Órder of  Things!'), 'order of things', 'title, accent and article dropped');
  eq(push.surnameOf('Michel Foucault'), 'foucault', 'surname');
  eq(push.surnameOf('Foucault, Michel'), 'foucault', 'inverted surname');
});

// ============================================================ matching

const INDEX = {
  entries: [
    { key: 'A', title: 'order of things', doi: '', isbns: ['9780804011662'], url: '', year: '1966', surname: 'foucault', collections: ['C1'] },
    { key: 'B', title: 'professional quest for truth', doi: '10.1086/230209', isbns: [], url: '', year: '1993', surname: 'pickering', collections: [] },
    { key: 'C', title: 'some web thing', doi: '', isbns: [], url: 'example.com/x', year: '', surname: '', collections: [] },
    { key: 'D', title: 'common title', doi: '', isbns: [], url: '', year: '1990', surname: 'alpha', collections: [] },
    { key: 'E', title: 'common title', doi: '', isbns: [], url: '', year: '2020', surname: 'beta', collections: [] },
  ],
};

await check('an identifier match is found before anything else', () => {
  eq(push.findMatch(INDEX, { doi: 'https://doi.org/10.1086/230209' })?.key, 'B', 'by DOI');
  eq(push.findMatch(INDEX, { isbn: '978-0-8040-1166-2' })?.key, 'A', 'by ISBN');
  eq(push.findMatch(INDEX, { url: 'https://www.example.com/x/' })?.key, 'C', 'by URL');
  eq(push.findMatch(INDEX, { doi: '10.1086/230209' }).reason, 'same DOI', 'reason given');
});

await check('an already-linked item matches on its key', () => {
  eq(push.findMatch(INDEX, { zoteroKey: 'A', title: 'anything else' })?.key, 'A', 'by key');
  eq(push.findMatch(INDEX, { zoteroKey: 'A' }).reason, 'already linked', 'reason');
});

await check('a title match needs an author or year to agree', () => {
  eq(push.findMatch(INDEX, { title: 'The Order of Things', authors: ['Michel Foucault'] })?.key, 'A', 'title + author');
  eq(push.findMatch(INDEX, { title: 'The Order of Things', year: 1966 })?.key, 'A', 'title + year');
});

await check('a title shared by two works does not match blindly', () => {
  // Both D and E are "common title"; with no author or year there is nothing
  // to choose between them, and guessing would merge two different books.
  eq(push.findMatch(INDEX, { title: 'Common Title' }), null, 'ambiguous title refused');
  eq(push.findMatch(INDEX, { title: 'Common Title', year: 1990 })?.key, 'D', 'year disambiguates');
  eq(push.findMatch(INDEX, { title: 'Common Title', authors: ['Zoe Beta'] })?.key, 'E', 'author disambiguates');
});

await check('a book that is genuinely new matches nothing', () => {
  eq(push.findMatch(INDEX, { title: 'Something Entirely New', year: 2024, authors: ['A B'] }), null, 'no match');
  eq(push.findMatch(INDEX, { doi: '10.9999/nope' }), null, 'unknown doi');
});

// ============================================================ collections

await check('an existing collection is reused, not duplicated', async () => {
  resetLibrary({
    collections: [
      { key: 'ROOT', name: '01 Projects', parentCollection: null },
      { key: 'PRJ', name: 'Dissertation', parentCollection: 'ROOT' },
    ],
  });
  const res = await push.ensureCollectionPath(CFG, {
    rootName: '01 Projects', projectName: 'Dissertation', groupName: 'Chapter 1',
  });
  eq(res.root.key, 'ROOT', 'root reused');
  eq(res.project.key, 'PRJ', 'project reused');
  eq(res.created.length, 1, 'only the group was created');
  eq(res.created[0].name, 'Chapter 1', 'which one');
  eq(library.collections.filter((c) => c.name === 'Dissertation').length, 1, 'no second Dissertation');
});

await check('collection names are matched case-insensitively', async () => {
  resetLibrary({
    collections: [
      { key: 'ROOT', name: '01 Projects', parentCollection: null },
      { key: 'PRJ', name: 'DISSERTATION', parentCollection: 'ROOT' },
    ],
  });
  const res = await push.ensureCollectionPath(CFG, {
    rootName: '01 projects', projectName: 'dissertation', groupName: null,
  });
  eq(res.root.key, 'ROOT', 'root matched despite case');
  eq(res.project.key, 'PRJ', 'project matched despite case');
  eq(res.created.length, 0, 'nothing created');
});

await check('the same name under a different parent is not confused', async () => {
  resetLibrary({
    collections: [
      { key: 'ROOT', name: '01 Projects', parentCollection: null },
      { key: 'ELSE', name: 'Archive', parentCollection: null },
      { key: 'DECOY', name: 'Chapter 1', parentCollection: 'ELSE' },
      { key: 'PRJ', name: 'Dissertation', parentCollection: 'ROOT' },
    ],
  });
  const res = await push.ensureCollectionPath(CFG, {
    rootName: '01 Projects', projectName: 'Dissertation', groupName: 'Chapter 1',
  });
  ok(res.group.key !== 'DECOY', 'did not reuse the unrelated Chapter 1');
  eq(res.group.parentCollection, 'PRJ', 'created under the project');
});

await check('a missing root collection is created rather than failing', async () => {
  resetLibrary({ collections: [] });
  const res = await push.ensureCollectionPath(CFG, {
    rootName: '01 Projects', projectName: 'New Project', groupName: 'Group A',
  });
  eq(res.created.map((c) => c.name), ['01 Projects', 'New Project', 'Group A'], 'whole path created');
  eq(coll('01 Projects', null).key, res.root.key, 'root at top level');
});

// ============================================================ push

const BOOK = { id: 'b1', title: 'The Order of Things', authors: ['Michel Foucault'], year: 1966, isbn: '9780804011662', itemType: 'book', totalPages: 422, publisher: 'Gallimard' };
const ARTICLE = { id: 'b2', title: 'The Professional Quest for Truth', authors: ['Andrew Pickering'], year: 1993, doi: '10.1086/230209', itemType: 'journalArticle', container: 'AJS', volume: '99', pages: '559-561' };
const NEWBOOK = { id: 'b3', title: 'A Brand New Book', authors: ['Jane Doe'], year: 2024, itemType: 'book' };

function entries(items, projectName = 'Dissertation', groupName = 'Chapter 1') {
  return items.map((item) => ({ item, projectName, groupName }));
}

await check('a book not in the library is created in the right collection', async () => {
  resetLibrary({ collections: [{ key: 'ROOT', name: '01 Projects', parentCollection: null }] });
  push.clearIndexCache();
  const report = await push.pushToZotero(CFG, entries([NEWBOOK]));
  eq(report.created.length, 1, 'one created');
  eq(report.filed.length, 0, 'nothing filed');
  const made = library.items.find((i) => i.data.title === 'A Brand New Book');
  ok(made, 'item exists in the library');
  eq(made.data.collections, [coll('Chapter 1', coll('Dissertation', 'ROOT').key).key], 'filed into the group collection');
});

await check('a book already in the library is filed, not duplicated', async () => {
  resetLibrary({
    collections: [{ key: 'ROOT', name: '01 Projects', parentCollection: null }],
    items: [{ key: 'OLD', itemType: 'book', title: 'The Order of Things', ISBN: '978-0-8040-1166-2', creators: [{ creatorType: 'author', firstName: 'Michel', lastName: 'Foucault' }], date: '1966', collections: ['SOMEWHERE'] }],
  });
  push.clearIndexCache();
  const before = library.items.length;
  const report = await push.pushToZotero(CFG, entries([BOOK]));

  eq(library.items.length, before, 'no new item created');
  eq(report.created.length, 0, 'nothing created');
  eq(report.filed.length, 1, 'one filed');
  eq(report.filed[0].reason, 'same ISBN', 'matched on ISBN');
  const old = library.items.find((i) => i.key === 'OLD');
  ok(old.data.collections.includes('SOMEWHERE'), 'kept its original collection');
  eq(old.data.collections.length, 2, 'and gained the new one');
});

await check('the move option removes the item from its other collections', async () => {
  resetLibrary({
    collections: [{ key: 'ROOT', name: '01 Projects', parentCollection: null }],
    items: [{ key: 'OLD', itemType: 'book', title: 'The Order of Things', ISBN: '9780804011662', date: '1966', collections: ['SOMEWHERE', 'ELSEWHERE'] }],
  });
  push.clearIndexCache();
  const report = await push.pushToZotero(CFG, entries([BOOK]), { replaceCollections: true });
  const old = library.items.find((i) => i.key === 'OLD');
  eq(old.data.collections.length, 1, 'only in the new collection');
  ok(!old.data.collections.includes('SOMEWHERE'), 'removed from the old one');
  eq(report.filed[0].removedFrom.length, 2, 'reported what it removed');
});

await check('a DOI match is found even though Zotero keeps book DOIs in Extra', async () => {
  resetLibrary({
    collections: [{ key: 'ROOT', name: '01 Projects', parentCollection: null }],
    items: [{ key: 'OLD', itemType: 'book', title: 'Different Title Entirely', extra: 'DOI: 10.1086/230209', collections: [] }],
  });
  push.clearIndexCache();
  const report = await push.pushToZotero(CFG, entries([ARTICLE]));
  eq(report.filed.length, 1, 'matched');
  eq(report.filed[0].reason, 'same DOI', 'via Extra');
});

await check('pushing twice changes nothing the second time', async () => {
  resetLibrary({ collections: [{ key: 'ROOT', name: '01 Projects', parentCollection: null }] });
  push.clearIndexCache();
  await push.pushToZotero(CFG, entries([NEWBOOK, BOOK]));
  const afterFirst = library.items.length;
  const collectionsAfterFirst = library.collections.length;

  const second = await push.pushToZotero(CFG, entries([NEWBOOK, BOOK]));
  eq(library.items.length, afterFirst, 'no items added');
  eq(library.collections.length, collectionsAfterFirst, 'no collections added');
  eq(second.created.length, 0, 'created nothing');
  eq(second.alreadyThere.length, 2, 'both already in place');
});

await check('a dry run reports without writing anything', async () => {
  resetLibrary({ collections: [{ key: 'ROOT', name: '01 Projects', parentCollection: null }] });
  push.clearIndexCache();
  // Resolve the collections first, so the dry run has nothing left to create.
  await push.ensureCollectionPath(CFG, { rootName: '01 Projects', projectName: 'Dissertation', groupName: 'Chapter 1' });
  const itemsBefore = library.items.length;
  library.writes.length = 0;

  const report = await push.pushToZotero(CFG, entries([NEWBOOK]), { dryRun: true });
  eq(report.created.length, 1, 'would create one');
  eq(report.created[0].dryRun, true, 'marked as a preview');
  eq(library.items.length, itemsBefore, 'library untouched');
  ok(!library.writes.some((w) => w.method === 'POST' && w.path.endsWith('/items')), 'no item POST');
  ok(!library.writes.some((w) => w.method === 'PATCH'), 'no PATCH');
});

await check('books from different groups land in different subcollections', async () => {
  resetLibrary({ collections: [{ key: 'ROOT', name: '01 Projects', parentCollection: null }] });
  push.clearIndexCache();
  await push.pushToZotero(CFG, [
    { item: NEWBOOK, projectName: 'Dissertation', groupName: 'Chapter 1' },
    { item: { ...BOOK, id: 'b9' }, projectName: 'Dissertation', groupName: 'Chapter 2' },
  ]);
  const prj = coll('Dissertation', 'ROOT');
  const c1 = coll('Chapter 1', prj.key);
  const c2 = coll('Chapter 2', prj.key);
  ok(c1 && c2, 'both subcollections exist');
  const a = library.items.find((i) => i.data.title === 'A Brand New Book');
  const b = library.items.find((i) => i.data.title === 'The Order of Things');
  eq(a.data.collections, [c1.key], 'first in Chapter 1');
  eq(b.data.collections, [c2.key], 'second in Chapter 2');
});

await check('a linked copy in two groups is filed into both', async () => {
  resetLibrary({ collections: [{ key: 'ROOT', name: '01 Projects', parentCollection: null }] });
  push.clearIndexCache();
  await push.pushToZotero(CFG, [
    { item: NEWBOOK, projectName: 'Dissertation', groupName: 'Chapter 1' },
    { item: NEWBOOK, projectName: 'Dissertation', groupName: 'Chapter 2' },
  ]);
  eq(library.items.filter((i) => i.data.title === 'A Brand New Book').length, 1, 'created once');
  const made = library.items.find((i) => i.data.title === 'A Brand New Book');
  eq(made.data.collections.length, 2, 'but filed into both subcollections');
});

// ============================================================ field mapping

await check('a book maps onto the fields Zotero gives a book', () => {
  const z = zotero.toZoteroItem(BOOK, ['C1']);
  eq(z.itemType, 'book', 'type');
  eq(z.numPages, '422', 'page count');
  eq(z.ISBN, '9780804011662', 'isbn');
  eq(z.publisher, 'Gallimard', 'publisher');
  eq(z.creators, [{ creatorType: 'author', firstName: 'Michel', lastName: 'Foucault' }], 'creator split');
  eq(z.collections, ['C1'], 'collection');
  ok(!('DOI' in z), 'no DOI field — a Zotero book has none');
});

await check('a book DOI goes into Extra, where Zotero itself puts it', () => {
  const z = zotero.toZoteroItem({ ...BOOK, doi: '10.1234/x' }, []);
  ok(!('DOI' in z), 'not a top-level field');
  ok(z.extra.includes('DOI: 10.1234/x'), 'in Extra');
});

await check('an article maps onto article fields', () => {
  const z = zotero.toZoteroItem(ARTICLE, []);
  eq(z.itemType, 'journalArticle', 'type');
  eq(z.DOI, '10.1086/230209', 'doi is a real field here');
  eq(z.publicationTitle, 'AJS', 'journal');
  eq(z.pages, '559-561', 'pages');
  ok(!('numPages' in z), 'no numPages — an article has none');
});

await check('an unknown item type falls back to book rather than being rejected', () => {
  eq(zotero.toZoteroItem({ title: 'X', itemType: 'nonsense' }, []).itemType, 'book', 'fallback');
});

await check('empty fields are dropped instead of sent as blanks', () => {
  const z = zotero.toZoteroItem({ title: 'Bare', itemType: 'book' }, []);
  ok(!('publisher' in z), 'no empty publisher');
  ok(!('url' in z), 'no empty url');
  eq(z.title, 'Bare', 'title kept');
});

// ============================================================ index

await check('the index is cached and refreshed incrementally', async () => {
  resetLibrary({
    collections: [],
    items: [{ key: 'X1', itemType: 'book', title: 'First', collections: [] }],
  });
  push.clearIndexCache();
  const first = await push.loadIndex(CFG);
  eq(first.entries.length, 1, 'indexed one');

  // A new item arrives; the refresh should ask only for what changed.
  library.version += 5;
  library.items.push({ key: 'X2', version: library.version, data: { itemType: 'book', title: 'Second', collections: [] } });
  library.writes.length = 0;

  const second = await push.loadIndex(CFG);
  eq(second.entries.length, 2, 'index grew');
  const topCall = library.writes.find((w) => w.path.endsWith('/items/top'));
  ok(topCall, 'asked for items');
  eq(library.writes.filter((w) => w.path.endsWith('/items/top')).length, 1, 'a single page, not a full re-read');
});

await check('notes and attachments are kept out of the index', async () => {
  resetLibrary({
    items: [
      { key: 'N1', itemType: 'note', note: 'hi', collections: [] },
      { key: 'A1', itemType: 'attachment', title: 'file.pdf', collections: [] },
      { key: 'B1', itemType: 'book', title: 'Real Book', collections: [] },
    ],
  });
  push.clearIndexCache();
  const index = await push.loadIndex(CFG);
  eq(index.entries.map((e) => e.key), ['B1'], 'only the book');
});

// ------------------------------------------------------------------- report

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ ${passed} Zotero push tests passed.`);
