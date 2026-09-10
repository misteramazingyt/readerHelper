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
    execFileSync(process.execPath, [join(root, 'scripts', m.suite)], { stdio: 'pipe' });
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
