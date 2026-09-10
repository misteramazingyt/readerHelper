#!/usr/bin/env node
// test-citation-live.mjs — the lookup routes against the real services.
//
// Opt-in, and deliberately NOT in CI: it depends on Crossref, Open Library,
// Google Books, OpenAlex, DataCite and archive.org actually being up and not
// rate-limiting. A red run here usually means one of them is having a moment,
// not that this repository is broken — so it must never gate a deploy.
//
//   node scripts/test-citation-live.mjs
//
// Rate limits are treated as "skipped", since a keyless shared quota is
// expected to run out sometimes.

import { resolve, detect } from '../js/metadata.js';

const CASES = [
  { label: 'ISBN-13 (Dewey)', input: '9780804011662', expect: (r) => /public and its problems/i.test(r.title) },
  { label: 'DOI (Crossref)', input: '10.1086/230209', expect: (r) => /professional quest/i.test(r.title) && !/[<>]/.test(r.title) },
  { label: 'DOI in a doi.org URL', input: 'https://doi.org/10.1086/230209', expect: (r) => r.doi === '10.1086/230209' },
  { label: 'arXiv abs URL', input: 'https://arxiv.org/abs/1706.03762', expect: (r) => /attention is all you need/i.test(r.title) },
  { label: 'archive.org details URL', input: 'https://archive.org/details/orderofthingsarc0000fouc', expect: (r) => /order of things/i.test(r.title) && r.totalPages > 100 },
  { label: 'Open Library edition', input: 'https://openlibrary.org/books/OL7353617M', expect: (r) => r.title.length > 2 },
  { label: 'Google Books volume', input: 'https://www.google.com/books/edition/_/zyTCAlFPjgYC', expect: (r) => r.title.length > 2 },
  { label: 'title search', input: 'structure of scientific revolutions kuhn', expect: (r) => /scientific revolutions/i.test(r.title), search: true },
];

let passed = 0;
let skipped = 0;
const failures = [];

for (const c of CASES) {
  const kind = detect(c.input).kind;
  try {
    const res = await resolve(c.input);
    const rec = res.record || res.candidates[0];
    if (!rec) throw new Error('no record returned');
    if (!c.expect(rec)) {
      throw new Error(`unexpected record: ${JSON.stringify({ title: rec.title, year: rec.year, source: rec.source })}`);
    }
    passed += 1;
    const extra = c.search ? ` (${res.candidates.length} candidates)` : '';
    console.log(`✓ ${c.label.padEnd(26)} [${kind}] ${rec.title.slice(0, 44)} — ${rec.source}${extra}`);
  } catch (err) {
    if (/rate-limit|429/i.test(err.message)) {
      skipped += 1;
      console.log(`· ${c.label.padEnd(26)} skipped — ${err.message}`);
      continue;
    }
    failures.push(`${c.label}: ${err.message}`);
    console.log(`✗ ${c.label.padEnd(26)} ${err.message}`);
  }
}

console.log(`\n${passed} passed, ${skipped} skipped, ${failures.length} failed.`);
process.exit(failures.length ? 1 : 0);
