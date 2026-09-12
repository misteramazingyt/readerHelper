#!/usr/bin/env node
// test-goodreads.mjs — the Goodreads routes.
//
// Goodreads has no API, so everything here is parsing and shaping: their CSV
// export, their shelf RSS, and the CSV their importer accepts. All of it is
// string work, so all of it is tested offline against fixtures taken from the
// real formats.

import {
  parseCsv, toCsv, csvToObjects, cleanIsbn, fromCsvRow, parseLibraryCsv,
  parseShelfRss, shelfNameFromFeedTitle, bookUrl, shelfRssUrl, toImportCsv,
  toShelfName, toGoodreadsDate, splitShelves, IMPORT_COLUMNS,
  parseBookPage, titleFromBookUrl,
} from '../js/goodreads.js';
import {
  planGroups, prettyShelf, orderGroupNames, findExisting, applyGoodreads,
  DEFAULT_PROJECT, UNSHELVED,
} from '../js/goodreads-ingest.js';
import { emptyState } from '../js/model.js';

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(c, what) { if (!c) throw new Error(what || 'expected true'); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function has(hay, needle, what = '') {
  if (!String(hay).includes(needle)) throw new Error(`${what} expected to contain ${JSON.stringify(needle)}`);
}

// ================================================================ CSV input

await check('the CSV reader survives quotes, commas and newlines in a review', () => {
  // A Goodreads review routinely contains all three; splitting on commas
  // would shred the file.
  const csv = 'Title,My Review\n'
    + '"Dune, Part One","He said ""hello"", then\nleft."\n'
    + 'Plain,Simple\n';
  const rows = parseCsv(csv);
  eq(rows.length, 3, 'three rows');
  eq(rows[1][0], 'Dune, Part One', 'comma inside quotes kept');
  eq(rows[1][1], 'He said "hello", then\nleft.', 'escaped quotes and a newline kept');
  eq(rows[2], ['Plain', 'Simple'], 'the next row is unaffected');
});

await check('a byte-order mark does not poison the first column name', () => {
  const rows = parseCsv('﻿Title,Author\nA,B\n');
  eq(csvToObjects(rows)[0].Title, 'A', 'header read correctly');
});

await check('Goodreads spreadsheet-escaped ISBNs are unwrapped', () => {
  // They export ="0123456789" so Excel keeps the leading zeros.
  eq(cleanIsbn('="159017416X"'), '159017416X', 'isbn-10 with the = wrapper');
  eq(cleanIsbn('="9780140449136"'), '9780140449136', 'isbn-13');
  eq(cleanIsbn('=""'), null, 'the empty form');
  eq(cleanIsbn(''), null, 'blank');
  eq(cleanIsbn('not-an-isbn'), null, 'rubbish');
});

const CSV_EXPORT = [
  'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies',
  '10081041,The Long Ships,Frans G. Bengtsson,"Bengtsson, Frans G.",Michael Meyer,="159017416X",="9781590174166",5,4.38,NYRB Classics,Paperback,528,2010,1941,2026/08/18,2026/09/11,"adventure, norway",adventure,read,"A fine saga, truly.",,,1,0',
  '999,Unread Thing,Jane Doe,"Doe, Jane",,="",="",0,3.90,Verso,Paperback,200,2020,2019,,2026/01/02,"theory",theory,to-read,,,,0,0',
].join('\n');

await check('an exported row becomes a book', () => {
  const { books, error } = parseLibraryCsv(CSV_EXPORT);
  ok(!error, 'parsed');
  eq(books.length, 2, 'two books');

  const [long] = books;
  eq(long.title, 'The Long Ships', 'title');
  eq(long.authors, ['Frans G. Bengtsson', 'Michael Meyer'], 'additional authors folded in');
  eq(long.isbn, '9781590174166', 'ISBN13 preferred over ISBN10');
  eq(long.totalPages, 528, 'pages');
  eq(long.year, 1941, 'original publication year wins over the edition year');
  eq(long.publisher, 'NYRB Classics', 'publisher');
  eq(long.goodreadsRating, 5, 'rating');
  eq(long.goodreadsId, '10081041', 'id');
  eq(long.goodreadsShelf, 'read', 'exclusive shelf');
  eq(long.goodreadsShelves, ['adventure', 'norway'], 'custom shelves');
  eq(long.notes, 'A fine saga, truly.', 'review kept as notes');
});

await check('a book on the read shelf arrives finished', () => {
  const { books } = parseLibraryCsv(CSV_EXPORT);
  eq(books[0].progress, 1, 'read -> 100%');
  eq(books[0].currentPage, 528, 'and on the last page');
  eq(books[1].progress, 0, 'to-read -> 0%');
  eq(books[1].currentPage, 0, 'page 0');
});

await check('a missing ISBN does not become a fake one', () => {
  const { books } = parseLibraryCsv(CSV_EXPORT);
  eq(books[1].isbn, null, 'empty ="" stays null');
});

await check('a file that is not a Goodreads export is refused clearly', () => {
  const { books, error } = parseLibraryCsv('Name,Age\nBob,3\n');
  eq(books.length, 0, 'nothing imported');
  has(error, 'Title', 'says what was missing');
  ok(parseLibraryCsv('').error, 'an empty file is refused too');
});

// ================================================================ RSS input

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title><![CDATA[Shae's bookshelf: read]]></title>
<item>
  <title><![CDATA[The Order of Things]]></title>
  <book_id>73142</book_id>
  <isbn>0679753354</isbn>
  <num_pages>387</num_pages>
  <author_name><![CDATA[Michel Foucault]]></author_name>
  <book_published>1966</book_published>
  <user_rating>4</user_rating>
  <average_rating>4.14</average_rating>
  <user_read_at>Tue, 18 Aug 2026 00:00:00 +0000</user_read_at>
  <user_date_added>Fri, 11 Sep 2026 10:07:58 -0700</user_date_added>
  <user_shelves>theory, history-of-ideas</user_shelves>
  <user_review><![CDATA[Dense but <b>rewarding</b>.<br/>Worth a second pass.]]></user_review>
  <book_description><![CDATA[<p>An archaeology of the human sciences &amp; more.</p>]]></book_description>
</item>
<item>
  <title><![CDATA[Unread Book]]></title>
  <book_id>555</book_id>
  <isbn></isbn>
  <num_pages>120</num_pages>
  <author_name><![CDATA[Someone Else]]></author_name>
  <book_published>2001</book_published>
  <user_rating>0</user_rating>
  <user_read_at></user_read_at>
  <user_shelves></user_shelves>
  <user_review></user_review>
</item>
</channel></rss>`;

await check('a shelf feed becomes books', () => {
  const { books, shelfTitle } = parseShelfRss(RSS);
  eq(books.length, 2, 'two books');
  eq(shelfNameFromFeedTitle(shelfTitle), 'read', 'shelf name read off the feed title');

  const [first] = books;
  eq(first.title, 'The Order of Things', 'title');
  eq(first.authors, ['Michel Foucault'], 'author');
  eq(first.isbn, '0679753354', 'isbn');
  eq(first.totalPages, 387, 'pages');
  eq(first.year, 1966, 'year');
  eq(first.goodreadsRating, 4, 'rating');
  eq(first.goodreadsId, '73142', 'id');
  eq(first.goodreadsShelves, ['theory', 'history-of-ideas'], 'shelves');
});

await check('markup in a review or description is flattened, not shown raw', () => {
  const [first] = parseShelfRss(RSS).books;
  eq(first.notes, 'Dense but rewarding.\nWorth a second pass.', 'tags stripped, <br> became a newline');
  eq(first.abstract, 'An archaeology of the human sciences & more.', 'entities decoded');
});

await check('everything on the read shelf counts as finished, date or not', () => {
  // Found on a real library: 95 of 100 books on the "read" shelf had no
  // user_read_at. Keying "finished" off the date imported 95 books the user
  // had read as unread. The shelf is the signal.
  const { books } = parseShelfRss(RSS, { shelf: 'read' });
  eq(books[0].progress, 1, 'has a read date');
  eq(books[0].currentPage, 387, 'and lands on the last page');
  eq(books[1].progress, 1, 'no read date, but it is on the read shelf');
  eq(books[1].currentPage, 120, 'also finished');
});

await check('the shelf is inferred from the feed title when not passed', () => {
  // The fixture's title is "Shae's bookshelf: read".
  eq(parseShelfRss(RSS).books[1].progress, 1, 'inferred as read');
  eq(parseShelfRss(RSS).books[0].goodreadsShelf, 'read', 'and stamped on the book');
});

await check('an unread shelf leaves progress alone, unless a date says otherwise', () => {
  const { books } = parseShelfRss(RSS, { shelf: 'to-read' });
  eq(books[1].progress, 0, 'no date, not the read shelf');
  eq(books[0].progress, 1, 'a real read date still counts');
  eq(books[0].goodreadsShelf, 'to-read', 'shelf recorded as given');
});

await check('an empty feed parses to nothing rather than throwing', () => {
  eq(parseShelfRss('<rss><channel><title>x</title></channel></rss>').books, [], 'no items');
  eq(parseShelfRss('').books, [], 'no input');
});

// ================================================================= grouping

const BOOKS = () => [
  { title: 'A', goodreadsShelf: 'read', goodreadsShelves: ['theory', 'norway'] },
  { title: 'B', goodreadsShelf: 'to-read', goodreadsShelves: [] },
  { title: 'C', goodreadsShelf: 'currently-reading', goodreadsShelves: ['theory'] },
];

await check('reading status becomes the three familiar columns', () => {
  const entries = planGroups(BOOKS(), { groupBy: 'shelf' });
  eq(entries.map((e) => e.groupName), ['Read', 'To read', 'Reading now'], 'mapped names');
  eq(entries.length, 3, 'one entry per book');
});

await check('custom shelves put a book in every shelf it is on', () => {
  const entries = planGroups(BOOKS(), { groupBy: 'shelves', defaultGroup: UNSHELVED });
  const a = entries.filter((e) => e.book.title === 'A');
  eq(a.map((e) => e.groupName), ['Theory', 'Norway'], 'A is on two shelves, so two entries');
  eq(entries.find((e) => e.book.title === 'B').groupName, UNSHELVED, 'a book on none falls back');
});

await check('one group for everything is available', () => {
  const entries = planGroups(BOOKS(), { groupBy: 'single', defaultGroup: 'All' });
  eq([...new Set(entries.map((e) => e.groupName))], ['All'], 'one group');
  eq(entries.length, 3, 'every book');
});

await check('shelf names are made readable, and ordered sensibly', () => {
  eq(prettyShelf('history-of-ideas'), 'History of ideas', 'hyphens and case');
  eq(prettyShelf(''), UNSHELVED, 'blank');
  eq(
    orderGroupNames(['Zebra', 'Read', 'Apple', 'To read', 'Reading now']),
    ['To read', 'Reading now', 'Read', 'Apple', 'Zebra'],
    'reading order first, then alphabetical',
  );
});

await check('the three reading states are not treated as custom shelves', () => {
  eq(splitShelves('read, theory, to-read'), ['theory'], 'only the real shelf survives');
});

// ================================================================= applying

await check('an import creates the project, groups and books', () => {
  const state = emptyState();
  const { books } = parseLibraryCsv(CSV_EXPORT);
  const report = applyGoodreads(state, planGroups(books, { groupBy: 'shelf' }), {});

  const project = state.projects[report.projectId];
  eq(project.name, DEFAULT_PROJECT, 'project name');
  eq(project.groupOrder.map((id) => state.groups[id].name), ['To read', 'Read'], 'groups in reading order');
  eq(report.added, 2, 'two books');
  eq(Object.keys(state.placements).length, 2, 'two cards');
});

await check('importing twice adds nothing the second time', () => {
  const state = emptyState();
  const { books } = parseLibraryCsv(CSV_EXPORT);
  const entries = planGroups(books, { groupBy: 'shelf' });
  applyGoodreads(state, entries, {});
  const second = applyGoodreads(state, entries, {});

  eq(second.added, 0, 'no new books');
  eq(second.placed, 0, 'no new cards');
  eq(second.linked, 2, 'both recognised');
  eq(Object.keys(state.items).length, 2, 'still two books');
});

await check('a book already on the board is matched, not duplicated', () => {
  const state = emptyState();
  // A book added by hand, with the same ISBN and no Goodreads id.
  const existing = { id: 'itm_x', title: 'The Long Ships', authors: ['Frans G. Bengtsson'], isbn: '9781590174166', modifiedAt: 'x' };
  state.items[existing.id] = existing;

  const { books } = parseLibraryCsv(CSV_EXPORT);
  const report = applyGoodreads(state, planGroups(books, { groupBy: 'shelf' }), {});
  eq(report.linked, 1, 'matched the existing one');
  eq(report.added, 1, 'only the genuinely new book was added');
  eq(state.items.itm_x.goodreadsId, '10081041', 'and gained its Goodreads id');
  eq(state.items.itm_x.goodreadsRating, 5, 'and the rating');
});

await check('an import never overwrites reading progress recorded here', () => {
  const state = emptyState();
  state.items.itm_x = {
    id: 'itm_x', title: 'The Long Ships', isbn: '9781590174166',
    currentPage: 42, progress: 0.08, totalPages: 528, notes: 'my own note', modifiedAt: 'x',
  };
  const { books } = parseLibraryCsv(CSV_EXPORT);
  applyGoodreads(state, planGroups(books, { groupBy: 'shelf' }), {});

  eq(state.items.itm_x.currentPage, 42, 'page kept');
  eq(state.items.itm_x.progress, 0.08, 'progress kept even though Goodreads says read');
  eq(state.items.itm_x.notes, 'my own note', 'notes kept');
});

await check('matching finds a book by title and author when there is no ISBN', () => {
  const state = emptyState();
  state.items.a = { id: 'a', title: 'The Order of Things', authors: ['Michel Foucault'], modifiedAt: 'x' };
  const hit = findExisting(state, { title: 'the order of things', authors: ['Foucault, Michel'] });
  ok(hit, 'matched');
  eq(hit.reason, 'same title and author', 'on title and author');
});

await check('a different book with the same title is not matched', () => {
  const state = emptyState();
  state.items.a = { id: 'a', title: 'Ulysses', authors: ['James Joyce'], modifiedAt: 'x' };
  state.items.b = { id: 'b', title: 'Ulysses', authors: ['Alfred Tennyson'], modifiedAt: 'x' };
  eq(findExisting(state, { title: 'Ulysses', authors: ['Someone Unrelated'] }), null, 'refused');
});

await check('a linked copy is not created twice in the same group', () => {
  const state = emptyState();
  const book = { title: 'A', goodreadsShelf: 'read', goodreadsShelves: ['x'], isbn: '9781590174166' };
  applyGoodreads(state, [{ book, groupName: 'Read' }, { book, groupName: 'Read' }], {});
  eq(Object.keys(state.placements).length, 1, 'one card');
});

await check('a book on two shelves gets a card in each group', () => {
  const state = emptyState();
  const book = { title: 'A', isbn: '9781590174166', goodreadsShelves: ['theory', 'norway'] };
  applyGoodreads(state, [{ book, groupName: 'Theory' }, { book, groupName: 'Norway' }], {});
  eq(Object.keys(state.items).length, 1, 'one book record');
  eq(Object.keys(state.placements).length, 2, 'two cards');
});

// ================================================================ CSV output

const ITEM = {
  title: 'The Long Ships',
  authors: ['Frans G. Bengtsson', 'Michael Meyer'],
  isbn: '9781590174166',
  goodreadsRating: 5,
  notes: 'A fine saga.\nTruly.',
  progress: 1,
  createdAt: '2026-01-02T00:00:00Z',
  markedReadAt: '2026-08-18T00:00:00Z',
};

await check('the export uses exactly the columns Goodreads imports', () => {
  const rows = parseCsv(toImportCsv([{ item: ITEM, shelves: ['chapter-one'] }]));
  eq(rows[0], IMPORT_COLUMNS, 'header');
});

await check('a book exports with its shelf, rating and read date', () => {
  const out = csvToObjects(parseCsv(toImportCsv([{ item: ITEM, shelves: ['chapter-one'] }])))[0];
  eq(out.Title, 'The Long Ships', 'title');
  eq(out.Author, 'Frans G. Bengtsson', 'first author — Goodreads takes one');
  eq(out.ISBN, '9781590174166', 'isbn');
  eq(out['My Rating'], '5', 'rating');
  eq(out['Date Read'], '2026/08/18', 'read date in their format');
  has(out.Bookshelves, 'chapter-one', 'the group became a shelf');
  has(out.Bookshelves, 'read', 'and it is marked read');
});

await check('an unfinished book goes to to-read with no read date', () => {
  const out = csvToObjects(parseCsv(toImportCsv([{ item: { ...ITEM, progress: 0.3, markedReadAt: null } }])))[0];
  eq(out['Date Read'], '', 'no read date');
  has(out.Bookshelves, 'to-read', 'shelved as unread');
});

await check('reviews are only included when asked for', () => {
  const withReview = csvToObjects(parseCsv(toImportCsv([{ item: ITEM }], { includeReviews: true })))[0];
  eq(withReview['My Review'], 'A fine saga. Truly.', 'newlines flattened for the CSV');
  const without = csvToObjects(parseCsv(toImportCsv([{ item: ITEM }], { includeReviews: false })))[0];
  eq(without['My Review'], '', 'omitted');
});

await check('a review containing a comma and a quote round-trips', () => {
  const tricky = { ...ITEM, notes: 'He said "yes", then left' };
  const out = csvToObjects(parseCsv(toImportCsv([{ item: tricky }], { includeReviews: true })))[0];
  eq(out['My Review'], 'He said "yes", then left', 'survived quoting');
});

await check('shelf names are made acceptable to Goodreads', () => {
  eq(toShelfName('Chapter 1: Method & Cases'), 'chapter-1-method-cases', 'lowercased and hyphenated');
  eq(toShelfName(''), 'readerhelper', 'fallback');
  ok(!toShelfName('a, b').includes(','), 'no commas — they separate shelves');
});

await check('dates convert to yyyy/mm/dd without slipping a day', () => {
  // A read date is a calendar date. Reading a UTC midnight with local getters
  // moves it to the previous day anywhere west of Greenwich.
  eq(toGoodreadsDate('2026-08-18T00:00:00Z'), '2026/08/18', 'UTC midnight stays on the 18th');
  eq(toGoodreadsDate('2026-08-18T23:59:00Z'), '2026/08/18', 'late in the day, still the 18th');
  eq(toGoodreadsDate('2026-08-18'), '2026/08/18', 'a date-only string is taken verbatim');
  eq(toGoodreadsDate('2026/8/1'), '2026/08/01', 'their own format, zero-padded');
  eq(toGoodreadsDate('nonsense'), '', 'unparseable');
  eq(toGoodreadsDate(null), '', 'null');
});

// =================================================================== links

await check('a book links to Goodreads by the best identifier it has', () => {
  eq(bookUrl({ goodreadsId: '73142' }), 'https://www.goodreads.com/book/show/73142', 'by id');
  eq(bookUrl({ isbn: '0679753354' }), 'https://www.goodreads.com/book/isbn/0679753354', 'by isbn');
  has(bookUrl({ title: 'The Order of Things', authors: ['Michel Foucault'] }), '/search?q=', 'falls back to search');
  eq(bookUrl({}), null, 'nothing to link to');
});

await check('the shelf feed URL is built correctly', () => {
  eq(shelfRssUrl('12345', 'read'), 'https://www.goodreads.com/review/list_rss/12345?shelf=read', 'url');
  has(shelfRssUrl('1', 'to read'), 'shelf=to%20read', 'shelf is encoded');
});

// ========================================================== a single book

// Trimmed from a real Goodreads book page: the JSON-LD block and the
// OpenGraph tags, which is everything the parser reads.
const BOOK_PAGE = `<!DOCTYPE html><html><head>
<meta property="og:title" content="Black Cloud: A Still Life" />
<meta property="og:url" content="https://www.goodreads.com/book/show/73142.Black_Cloud" />
<meta property="books:isbn" content="9780595183395" />
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Book","name":"Black Cloud: A Still Life",
 "bookFormat":"Paperback","numberOfPages":364,"inLanguage":"English",
 "isbn":"9780595183395","author":[{"@type":"Person","name":"Mark Anderson"}]}
</script>
</head><body>irrelevant</body></html>`;

await check('a book page yields its details from the JSON-LD', () => {
  const book = parseBookPage(BOOK_PAGE, { goodreadsId: '73142' });
  eq(book.title, 'Black Cloud: A Still Life', 'title');
  eq(book.authors, ['Mark Anderson'], 'author');
  eq(book.isbn, '9780595183395', 'isbn');
  eq(book.totalPages, 364, 'pages');
  eq(book.goodreadsId, '73142', 'id');
  eq(book.url, 'https://www.goodreads.com/book/show/73142', 'canonical link');
});

await check('the id is recovered from the page when it was not passed in', () => {
  eq(parseBookPage(BOOK_PAGE).goodreadsId, '73142', 'read out of og:url');
});

await check('OpenGraph carries it when the JSON-LD is missing or broken', () => {
  const noLd = BOOK_PAGE.replace(/<script[\s\S]*?<\/script>/, '');
  const book = parseBookPage(noLd, { goodreadsId: '73142' });
  eq(book.title, 'Black Cloud: A Still Life', 'title from og:title');
  eq(book.isbn, '9780595183395', 'isbn from books:isbn');

  const brokenLd = BOOK_PAGE.replace('"numberOfPages":364,', '"numberOfPages":364');
  ok(parseBookPage(brokenLd)?.title, 'malformed JSON does not throw, og: still works');
});

await check('a page with no book on it yields nothing rather than a blank book', () => {
  eq(parseBookPage('<html><head></head></html>'), null, 'empty page');
  eq(parseBookPage(''), null, 'no page');
});

await check('the title in the URL slug is recoverable', () => {
  // The fallback for when the page itself cannot be fetched.
  eq(titleFromBookUrl('https://www.goodreads.com/book/show/73142.The_Order_of_Things'),
    'The Order of Things', 'underscore slug');
  eq(titleFromBookUrl('https://www.goodreads.com/book/show/1885-pride-and-prejudice'),
    'pride and prejudice', 'hyphen slug');
  eq(titleFromBookUrl('https://www.goodreads.com/book/show/73142'), null, 'no slug to read');
});

// ========================================================= the upload bot

import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseArgs, resolveCsv, classifyOutcome, isSignedOutUrl,
} from '../tools/goodreads_upload.mjs';

await check('the uploader reads its arguments', () => {
  eq(parseArgs(['--login']).login, true, 'login');
  eq(parseArgs(['--headed', '--dry-run']).dryRun, true, 'dry run');
  eq(parseArgs(['--file', 'x.csv']).file, 'x.csv', 'explicit file');
  eq(parseArgs(['--name', 'y.csv']).name, 'y.csv', 'name in downloads');
  eq(parseArgs(['--timeout', '5000']).timeoutMs, 10_000, 'a silly timeout is floored');
  eq(parseArgs([]).file, null, 'nothing by default');
  // The value must not be mistaken for the next flag.
  eq(parseArgs(['--file', 'a.csv', '--headed']).headed, true, 'flags after a value still parse');
});

await check('it picks the newest export when not told which', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rh-gr-'));
  const older = join(dir, 'goodreads-old.csv');
  const newer = join(dir, 'goodreads-new.csv');
  writeFileSync(older, 'a');
  writeFileSync(newer, 'b');
  const past = new Date(Date.now() - 60_000);
  utimesSync(older, past, past);
  writeFileSync(join(dir, 'unrelated.csv'), 'c');
  writeFileSync(join(dir, 'goodreads-notes.txt'), 'd');

  const picked = resolveCsv({ dir });
  eq(picked.path, newer, 'took the most recent');
  eq(picked.pickedNewestOf, 2, 'only the goodreads-*.csv files were candidates');
});

await check('it can be pointed at one file, by path or by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rh-gr-'));
  const p = join(dir, 'goodreads-pick.csv');
  writeFileSync(p, 'x');
  eq(resolveCsv({ file: p }).path, p, 'by path');
  eq(resolveCsv({ name: 'goodreads-pick.csv', dir }).path, p, 'by name');
  // A name is a name, not a path: traversal is stripped before it is used.
  eq(resolveCsv({ name: '../../../etc/passwd', dir }).error !== undefined, true, 'traversal refused');
});

await check('it says what is wrong rather than uploading nothing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'rh-gr-'));
  has(resolveCsv({ dir: empty }).error, 'No goodreads-', 'nothing to upload');
  has(resolveCsv({ file: '/definitely/not/here.csv' }).error, 'No such file', 'missing file');
  has(resolveCsv({ dir: '/definitely/not/a/folder' }).error, 'No downloads folder', 'missing folder');
});

await check('it can tell what Goodreads said afterwards', () => {
  eq(classifyOutcome('https://www.goodreads.com/review/import', 'Your import is in progress').ok, true, 'queued');
  eq(classifyOutcome('https://www.goodreads.com/review/import', 'Successfully imported 12 books').ok, true, 'done');
  eq(classifyOutcome('https://www.goodreads.com/user/new', 'Sign in').reason, 'signed-out', 'bounced to sign-in');
  eq(classifyOutcome('https://www.goodreads.com/review/import', 'There was a problem with your file').ok, false, 'rejected');
  // Unrecognised is not success: it keeps the evidence instead of claiming it worked.
  eq(classifyOutcome('https://www.goodreads.com/review/import', 'something unfamiliar').ok, null, 'unclear');
});

await check('a sign-in URL is recognised, including the Amazon one', () => {
  eq(isSignedOutUrl('https://www.goodreads.com/user/new'), true, 'goodreads sign-up wall');
  eq(isSignedOutUrl('https://www.amazon.com/ap/signin?openid=x'), true, 'amazon sign-in');
  eq(isSignedOutUrl('https://www.goodreads.com/review/import'), false, 'the real page');
});

// ------------------------------------------------------------------- report

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ ${passed} Goodreads tests passed.`);
