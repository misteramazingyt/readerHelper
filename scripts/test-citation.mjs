#!/usr/bin/env node
// test-citation.mjs — identifier detection and bibliography output.
//
// Both are pure functions over strings, so they are tested offline. The network
// side (Crossref, Open Library, archive.org…) is exercised separately by
// test-citation-live.mjs, which is opt-in because it depends on third parties.

import { detect, isValidIsbn, clean } from '../js/metadata.js';
import {
  splitName, citekeyFor, toBibtex, toRis, toCslJson, toFormatted, toMarkdown,
  buildBibliography, filenameFor, FORMATS,
} from '../js/bibliography.js';

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
  if (!String(hay).includes(needle)) throw new Error(`${what} expected to contain ${JSON.stringify(needle)} in:\n${hay}`);
}

// ============================================================ detection

const D = (s) => detect(s).kind;

await check('bare and hyphenated ISBNs are recognised', () => {
  eq(D('9780804011662'), 'isbn', 'isbn-13');
  eq(D('978-0-8040-1166-2'), 'isbn', 'hyphenated');
  eq(D('0804011664'), 'isbn', 'isbn-10');
  eq(detect('978-0-8040-1166-2').value, '9780804011662', 'normalised');
});

await check('a number that is not a valid ISBN is not treated as one', () => {
  // The shape test alone is not enough: these all LOOK like ISBNs — right
  // length, right 978 prefix — and are rejected only by the check digit.
  eq(D('9781234567890'), 'query', 'isbn-13 shape, wrong check digit');
  eq(D('0804011665'), 'query', 'isbn-10 shape, wrong check digit');
  // And one that fails the shape test outright.
  eq(D('1234567890123'), 'query', 'thirteen digits with no ISBN prefix');

  eq(isValidIsbn('9780804011662'), true, 'good isbn-13');
  eq(isValidIsbn('9780804011663'), false, 'bad isbn-13 check digit');
  eq(isValidIsbn('0804011664'), true, 'good isbn-10');
  eq(isValidIsbn('080401166X'), false, 'bad isbn-10 check digit');
});

await check('DOIs are found bare, in a URL, and inside prose', () => {
  eq(D('10.1086/230209'), 'doi', 'bare');
  eq(detect('https://doi.org/10.1086/230209').value, '10.1086/230209', 'from doi.org');
  eq(detect('https://dx.doi.org/10.1086/230209').value, '10.1086/230209', 'from dx.doi.org');
  eq(detect('See Pickering (1993), doi:10.1086/230209.').value, '10.1086/230209', 'trailing period trimmed');
  eq(detect('https://www.jstor.org/stable/10.1086/230209').value, '10.1086/230209', 'inside a publisher URL');
});

await check('Google Books links are recognised in every shape', () => {
  eq(detect('https://books.google.com/books?id=zyTCAlFPjgYC&printsec=frontcover').value, 'zyTCAlFPjgYC', 'classic');
  eq(detect('https://www.google.com/books/edition/The_Order_of_Things/zyTCAlFPjgYC').value, 'zyTCAlFPjgYC', 'modern');
  eq(detect('https://books.google.co.uk/books?id=zyTCAlFPjgYC').value, 'zyTCAlFPjgYC', 'regional domain');
  eq(D('https://books.google.com/books?id=zyTCAlFPjgYC'), 'googlebooks', 'kind');
});

await check('archive.org links are recognised', () => {
  eq(detect('https://archive.org/details/orderofthings0000fouc').value, 'orderofthings0000fouc', 'details');
  eq(detect('https://archive.org/stream/discipline_punish/page/n5').value, 'discipline_punish', 'stream');
  eq(detect('https://archive.org/embed/foo').value, 'foo', 'embed');
  eq(D('https://archive.org/details/x'), 'archive', 'kind');
});

await check('Open Library editions and works are recognised', () => {
  eq(detect('https://openlibrary.org/books/OL7353617M/The_Order_of_Things').value, 'OL7353617M', 'edition');
  eq(detect('https://openlibrary.org/works/OL1234W').value, 'OL1234W', 'work');
});

await check('arXiv ids survive version suffixes and old-style paths', () => {
  eq(detect('arXiv:1706.03762v5').value, '1706.03762', 'version stripped, id intact');
  eq(detect('https://arxiv.org/abs/2301.12345v2').value, '2301.12345', 'from a URL');
  eq(detect('https://arxiv.org/pdf/hep-th/9901001').value, 'hep-th/9901001', 'old style');
  eq(detect('arXiv: math.GT/0301234').value, 'math.GT/0301234', 'old style with subject class');
  eq(detect('10.48550/arXiv.1706.03762').kind, 'arxiv', 'arXiv DOI routes to arXiv');
});

await check('anything else becomes a link or a search', () => {
  eq(D('https://example.com/paper.pdf'), 'url', 'unknown link');
  eq(D('structure of scientific revolutions'), 'query', 'free text');
  eq(D(''), 'empty', 'empty');
});

await check('markup and entities are stripped from source text', () => {
  eq(clean('<i>The Quest</i>'), 'The Quest', 'tags');
  eq(clean('Social&#8211;History &amp; More'), 'Social–History & More', 'entities');
  eq(clean('a   b\n c'), 'a b c', 'whitespace');
  eq(clean('<jats:italic>x</jats:italic>'), 'x', 'namespaced tags');
});

// ============================================================ names

await check('names split into family and given', () => {
  eq(splitName('Michel Foucault'), { family: 'Foucault', given: 'Michel' }, 'given first');
  eq(splitName('Foucault, Michel'), { family: 'Foucault', given: 'Michel' }, 'comma form');
  eq(splitName('Ludwig van Beethoven'), { family: 'van Beethoven', given: 'Ludwig' }, 'nobiliary particle');
  eq(splitName('Cher'), { family: 'Cher', given: '' }, 'mononym');
  eq(splitName(''), { family: '', given: '' }, 'empty');
});

await check('citekeys are derived and kept unique', () => {
  const taken = new Set();
  const a = { authors: ['Michel Foucault'], year: 1966, title: 'The Order of Things' };
  eq(citekeyFor(a, taken), 'foucault1966order', 'leading article dropped');
  eq(citekeyFor(a, taken), 'foucault1966orderb', 'second use disambiguated');
  eq(citekeyFor({ title: 'Anon' }, taken), 'anonndanon', 'missing author and year');
  eq(citekeyFor({ citekey: 'mine2020x', title: 'X' }, taken), 'mine2020x', 'existing citekey wins');
});

// ============================================================ formats

const BOOK = {
  title: 'The Order of Things',
  authors: ['Michel Foucault'],
  year: 1966,
  publisher: 'Gallimard',
  isbn: '9780804011662',
  itemType: 'book',
  totalPages: 422,
  url: 'https://example.org/order',
};

const ARTICLE = {
  title: 'The Professional Quest for Truth',
  authors: ['Andrew Pickering', 'Jane Doe'],
  year: 1993,
  itemType: 'journalArticle',
  container: 'American Journal of Sociology',
  volume: '99',
  issue: '2',
  pages: '559-561',
  doi: '10.1086/230209',
};

await check('BibTeX output is well formed', () => {
  const out = toBibtex([BOOK, ARTICLE]);
  has(out, '@book{foucault1966order,', 'book entry');
  has(out, '@article{pickering1993professional,', 'article entry');
  has(out, 'author = {Foucault, Michel}', 'author inverted');
  has(out, 'author = {Pickering, Andrew and Doe, Jane}', 'authors joined with and');
  has(out, 'journal = {American Journal of Sociology}', 'journal field');
  has(out, 'publisher = {Gallimard}', 'publisher field');
  has(out, 'doi = {10.1086/230209}', 'doi field');
  eq((out.match(/^@/gm) || []).length, 2, 'two entries');
});

await check('BibTeX braces the title to keep its capitalisation', () => {
  has(toBibtex([BOOK]), 'title = {{The Order of Things}}', 'double braced');
});

await check('BibTeX escapes the characters it treats as syntax', () => {
  const out = toBibtex([{ title: 'Cost & Effect: 50% of #1 {done}', authors: ['A B'], year: 2000 }]);
  has(out, '\\&', 'ampersand');
  has(out, '\\%', 'percent');
  has(out, '\\#', 'hash');
  has(out, '\\{', 'brace');
  ok(!/[^\\]&/.test(out.split('title = ')[1].split('\n')[0]), 'no bare ampersand in the title');
});

await check('RIS output is well formed', () => {
  const out = toRis([BOOK, ARTICLE]);
  has(out, 'TY  - BOOK', 'book type');
  has(out, 'TY  - JOUR', 'article type');
  has(out, 'AU  - Foucault, Michel', 'author');
  has(out, 'SP  - 559', 'start page split from the range');
  has(out, 'EP  - 561', 'end page');
  has(out, 'DO  - 10.1086/230209', 'doi');
  eq((out.match(/^ER  - $/gm) || []).length, 2, 'both entries terminated');
});

await check('CSL-JSON output parses and carries structured names', () => {
  const parsed = JSON.parse(toCslJson([BOOK, ARTICLE]));
  eq(parsed.length, 2, 'two entries');
  eq(parsed[0].type, 'book', 'book type');
  eq(parsed[0].author[0], { family: 'Foucault', given: 'Michel' }, 'structured name');
  eq(parsed[0].issued, { 'date-parts': [[1966]] }, 'issued date');
  eq(parsed[1].type, 'article-journal', 'article type');
  eq(parsed[1]['container-title'], 'American Journal of Sociology', 'container');
  eq(parsed[1].DOI, '10.1086/230209', 'doi');
});

await check('formatted styles put the pieces in the right order', () => {
  const apa = toFormatted([ARTICLE], 'apa');
  has(apa, 'Pickering, A., & Doe, J.', 'APA authors with initials');
  has(apa, '(1993).', 'APA year in parentheses');
  has(apa, 'https://doi.org/10.1086/230209', 'APA doi');

  const mla = toFormatted([ARTICLE], 'mla');
  has(mla, 'Pickering, Andrew, and Jane Doe', 'MLA authors spelled out');

  const chicago = toFormatted([BOOK], 'chicago');
  has(chicago, 'Foucault, Michel', 'Chicago author');
  has(chicago, 'Gallimard,', 'Chicago publisher');
});

await check('APA uses an ampersand and an en dash correctly for one author', () => {
  const apa = toFormatted([BOOK], 'apa');
  has(apa, 'Foucault, M.', 'initialised');
  ok(!apa.includes('&'), 'no ampersand for a single author');
});

await check('a missing year is marked n.d. rather than blank', () => {
  has(toFormatted([{ title: 'X', authors: ['A B'] }], 'apa'), '(n.d.)', 'n.d.');
});

await check('Markdown export links to the DOI when there is one', () => {
  const md = toMarkdown([ARTICLE, BOOK]);
  has(md, '[The Professional Quest for Truth](https://doi.org/10.1086/230209)', 'doi link');
  has(md, '[The Order of Things](https://example.org/order)', 'url link');
});

await check('every declared format actually produces output', async () => {
  for (const format of Object.keys(FORMATS)) {
    const res = await buildBibliography([BOOK, ARTICLE], { format, settings: {}, useZotero: false });
    ok(res.text.length > 20, `${format} produced something`);
    eq(res.counts.total, 2, `${format} counted both`);
    eq(res.counts.zotero, 0, `${format} used no Zotero`);
  }
});

await check('entries are sorted by author surname then year', async () => {
  const items = [
    { title: 'Z', authors: ['Zoe Zeta'], year: 2000 },
    { title: 'A', authors: ['Alan Alpha'], year: 2010 },
    { title: 'A2', authors: ['Alan Alpha'], year: 1990 },
  ];
  const out = (await buildBibliography(items, { format: 'markdown', settings: {}, useZotero: false })).text;
  const order = out.split('\n').map((l) => l.match(/\*\*(?:\[)?([^\]*]+)/)?.[1]);
  eq(order, ['A2', 'A', 'Z'], 'alpha then chronological');
});

await check('formatted styles warn that local output is approximate', async () => {
  const res = await buildBibliography([BOOK], { format: 'apa', settings: {}, useZotero: false });
  ok(res.notes.some((n) => n.includes('approximate')), `expected a caveat, got ${JSON.stringify(res.notes)}`);
  const exact = await buildBibliography([BOOK], { format: 'bibtex', settings: {}, useZotero: false });
  ok(!exact.notes.some((n) => n.includes('approximate')), 'no caveat for a data format');
});

await check('Zotero is skipped when it is not configured', async () => {
  const linked = { ...BOOK, zoteroKey: 'ABCD1234' };
  const res = await buildBibliography([linked], { format: 'bibtex', settings: {}, useZotero: true });
  eq(res.counts.zotero, 0, 'no Zotero call attempted');
  has(res.text, '@book{', 'generated locally instead');
});

await check('a failing Zotero export falls back to local generation', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  try {
    const linked = { ...BOOK, zoteroKey: 'ABCD1234' };
    const res = await buildBibliography([linked], {
      format: 'bibtex',
      settings: { zoteroApiKey: 'k', zoteroUserId: '1' },
      useZotero: true,
    });
    has(res.text, '@book{foucault1966order', 'still produced an entry');
    ok(res.notes.some((n) => n.includes('Zotero export failed')), 'said what happened');
  } finally {
    globalThis.fetch = original;
  }
});

await check('Zotero output is used when the call succeeds', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, status: 200, text: async () => '@book{zotero2020real,\n  title = {{From Zotero}}\n}' };
  };
  try {
    const linked = { ...BOOK, zoteroKey: 'ABCD1234' };
    const res = await buildBibliography([linked], {
      format: 'bibtex',
      settings: { zoteroApiKey: 'k', zoteroUserId: '99' },
      useZotero: true,
    });
    has(res.text, 'From Zotero', 'used Zotero output');
    ok(!res.text.includes('Gallimard'), 'did not also generate locally');
    eq(res.counts.zotero, 1, 'counted as a Zotero entry');
    has(seen[0], '/users/99/items?', 'called the right library');
    has(seen[0], 'format=bibtex', 'asked for bibtex');
    has(seen[0], 'itemKey=ABCD1234', 'passed the key');
  } finally {
    globalThis.fetch = original;
  }
});

await check('filenames are safe and carry the right extension', () => {
  eq(filenameFor('Chapter 1: Method & Cases', 'bibtex'), 'Chapter-1-Method-Cases.bib', 'sanitised: punctuation dropped, runs of space collapsed');
  eq(filenameFor('x', 'ris'), 'x.ris', 'ris');
  eq(filenameFor('x', 'csljson'), 'x.json', 'json');
  eq(filenameFor('', 'apa'), 'bibliography.txt', 'fallback name');
});

// ------------------------------------------------------------------- report

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ ${passed} citation tests passed.`);
