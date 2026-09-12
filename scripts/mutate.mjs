#!/usr/bin/env node
// mutate.mjs — a throwaway harness for checking that a test suite can fail.
//
// A green run only means something if the tests would go red when the code is
// wrong. This applies one deliberate defect, runs a suite, restores the file,
// and reports whether the defect was caught — and, importantly, refuses to
// report anything if the edit did not actually apply.
//
//   node scripts/mutate.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
  {
    name: 'ISBN checksum guard removed',
    file: 'js/metadata.js',
    find: '&& isValidIsbn(digits)) {',
    replace: ') {',
    suite: 'test-citation.mjs',
  },
  {
    name: 'BibTeX special-character escaping removed',
    file: 'js/bibliography.js',
    find: ".replace(/([&%$#_{}])/g, '\\\\$1')",
    replace: '',
    suite: 'test-citation.mjs',
  },
  {
    name: 'HTML/entity cleaning removed',
    file: 'js/metadata.js',
    find: ".replace(/<[^>]+>/g, '')\n    .replace(/&#(\\d+);/g,",
    replace: ".replace(/&#(\\d+);/g,",
    suite: 'test-citation.mjs',
  },
  {
    name: 'author names no longer inverted for BibTeX',
    file: 'js/bibliography.js',
    find: 'return given ? `${family}, ${given}` : family;\n      })\n      .filter(Boolean);',
    replace: 'return n;\n      })\n      .filter(Boolean);',
    suite: 'test-citation.mjs',
  },
  {
    name: 'arXiv version suffix no longer stripped',
    file: 'js/metadata.js',
    find: "|| raw.match(/\\barxiv:\\s*(\\d{4}\\.\\d{4,5}|[a-z-]+(?:\\.[A-Z]{2})?\\/\\d{7})/i);",
    replace: "|| raw.match(/\\barxiv:\\s*([\\w.\\-/]+?)(?:v\\d+)?\\b/i);",
    suite: 'test-citation.mjs',
  },
  {
    name: 'push stops merging a book that sits in two groups',
    file: 'js/zotero-push.js',
    find: 'const plan = plans.get(item.id) || { item, targetKeys: new Set(), wheres: [] };',
    replace: 'const plan = { item, targetKeys: new Set(), wheres: [] };',
    suite: 'test-push.mjs',
  },
  {
    name: 'push stops merging collections and overwrites them',
    file: 'js/zotero.js',
    find: '    : [...new Set([...existing, ...collectionKeys])];',
    replace: '    : [...new Set(collectionKeys)];',
    suite: 'test-push.mjs',
  },
  {
    name: 'collection lookup ignores the parent, so any same-named folder wins',
    file: 'js/zotero-push.js',
    find: "      && (c.parentCollection || null) === (parentKey || null),",
    replace: '',
    suite: 'test-push.mjs',
  },
  {
    name: 'duplicate matching accepts an ambiguous title',
    file: 'js/zotero-push.js',
    find: 'if (sameTitle.length === 1 && !surname && !year) {',
    replace: 'if (sameTitle.length >= 1) {',
    suite: 'test-push.mjs',
  },
  {
    name: 'DOIs stored in Zotero Extra are no longer read back',
    file: 'js/zotero.js',
    find: "  const m = String(data.extra || '').match(/^\\s*DOI:\\s*(\\S+)/im);",
    replace: '  const m = null;',
    suite: 'test-push.mjs',
  },
  {
    name: 'sync overwrites the local board instead of merging it',
    file: 'js/boardsync.js',
    find: 'const { state: merged, summary } = mergeStates(local, remoteState);',
    replace: 'const merged = remoteState; const summary = { fromRemote: 0, fromLocal: 0, added: 0, deleted: 0, resurrected: 0 };',
    suite: 'test-sync.mjs',
  },
  {
    name: 'a new machine creates its own gist instead of finding the shared one',
    file: 'js/gist.js',
    find: '  const found = await findStateGist(cfg);',
    replace: '  const found = null;',
    suite: 'test-sync.mjs',
  },
  {
    name: 'deletions stop leaving tombstones, so deleted books come back',
    file: 'js/merge.js',
    find: "  state.deleted[tombstoneKey(type, id)] = { type, id, at };",
    replace: '',
    suite: 'test-sync.mjs',
  },
  {
    name: 'a tombstone deletes a record even when a newer edit exists',
    file: 'js/merge.js',
    find: '        if (timeOf(grave.at) >= timeOf(winner.modifiedAt)) {',
    replace: '        if (true) {',
    suite: 'test-sync.mjs',
  },
  {
    name: 'orders are taken verbatim instead of reconciled',
    file: 'js/merge.js',
    find: '    group.placementOrder = reconcileOrder(group.placementOrder, placementIds);',
    replace: '',
    suite: 'test-sync.mjs',
  },
  {
    name: 'every sync uploads, whether or not anything changed',
    file: 'js/boardsync.js',
    find: '    if (mergedPrint !== remotePrint || settingsDiffer(merged.settings, remoteState.settings)) {',
    replace: '    if (true) {',
    suite: 'test-sync.mjs',
  },
  {
    name: 'Goodreads read dates slip a day via local-time getters',
    file: 'js/goodreads.js',
    // The day-of-month getter is the one that actually shifts: swapping it for
    // the local-time version is exactly the bug that shipped a read date one
    // day early west of Greenwich.
    find: 'd.getUTCDate()',
    replace: 'd.getDate()',
    suite: 'test-goodreads.mjs',
    env: { TZ: 'America/Los_Angeles' },
  },
  {
    name: 'the CSV reader stops honouring quoted fields',
    file: 'js/goodreads.js',
    find: "    if (c === '\"') { quoted = true; continue; }",
    replace: '',
    suite: 'test-goodreads.mjs',
  },
  {
    name: 'Goodreads import stops de-duplicating against the board',
    file: 'js/goodreads-ingest.js',
    find: '    const existing = findExisting(state, book);',
    replace: '    const existing = null;',
    suite: 'test-goodreads.mjs',
  },
  {
    name: 'Goodreads import overwrites reading progress recorded here',
    file: 'js/goodreads-ingest.js',
    find: "        if (!item.totalPages && book.totalPages) patch.totalPages = book.totalPages;",
    replace: '        patch.currentPage = book.currentPage; patch.progress = book.progress;',
    suite: 'test-goodreads.mjs',
  },
  {
    name: 'the shelf proxy trusts the caller-supplied user id',
    file: 'worker/src/worker.js',
    find: '  if (!/^\\d{1,12}$/.test(userId)) {',
    replace: '  if (false) {',
    suite: 'test-worker.mjs',
  },
  {
    name: 'the read shelf stops counting as finished without a date',
    file: 'js/goodreads.js',
    find: '    const read = shelfSaysRead || Boolean(readAt);',
    replace: '    const read = Boolean(readAt);',
    suite: 'test-goodreads.mjs',
  },
  {
    name: 'the uploader treats an unrecognised page as success',
    file: 'tools/goodreads_upload.mjs',
    find: "  return { ok: null, reason: 'unclear' };",
    replace: "  return { ok: true, reason: 'unclear' };",
    suite: 'test-goodreads.mjs',
  },
  {
    name: 'the uploader stops preferring the newest export',
    file: 'tools/goodreads_upload.mjs',
    find: '    .sort((a, b) => b.t - a.t);',
    replace: '    .sort((a, b) => a.t - b.t);',
    suite: 'test-goodreads.mjs',
  },
  {
    name: 'project export stops de-duplicating linked copies',
    file: 'js/actions.js',
    find: 'if (seen.has(item.id)) continue;   // a linked copy in two groups counts once',
    replace: '',
    suite: 'test-dom.mjs',
  },
];

let caught = 0;
let missed = 0;
let skipped = 0;

for (const m of MUTATIONS) {
  const path = join(root, m.file);
  const original = readFileSync(path, 'utf8');

  if (!original.includes(m.find)) {
    console.log(`? ${m.name}\n    SKIPPED — the target text is not in ${m.file} (the mutation never applied)`);
    skipped += 1;
    continue;
  }

  writeFileSync(path, original.replace(m.find, m.replace));
  let failed = false;
  let detail = '';
  try {
    execFileSync(process.execPath, [join(root, 'scripts', m.suite)], {
      stdio: 'pipe',
      env: { ...process.env, ...(m.env || {}) },
    });
  } catch (err) {
    failed = true;
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    detail = (out.split('\n').find((l) => l.trim().startsWith('•')) || '').trim();
  } finally {
    writeFileSync(path, original);
  }

  if (failed) {
    caught += 1;
    console.log(`✓ ${m.name}\n    caught by ${m.suite}${detail ? `\n    ${detail}` : ''}`);
  } else {
    missed += 1;
    console.log(`✗ ${m.name}\n    NOT caught by ${m.suite} — that behaviour is untested`);
  }
}

console.log(`\n${caught} caught, ${missed} missed, ${skipped} skipped (of ${MUTATIONS.length}).`);
process.exit(missed > 0 || skipped > 0 ? 1 : 0);
