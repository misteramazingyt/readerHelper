#!/usr/bin/env node
// mutate-verify.mjs — confirm no deliberate defect was left behind.
//
// mutate.mjs restores each file in a `finally`, but a run killed outright (a
// timeout, Ctrl+C, a stopped background task) can die between the write and the
// restore, leaving a real defect in a real source file. This imports the
// harness's own mutation list and checks every `find` anchor is still present:
// if one is missing, that mutation is still applied.
//
//   node scripts/mutate-verify.mjs

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// mutate.mjs runs its whole sweep on import, so the list is re-read from the
// source text rather than imported.
const src = readFileSync(join(root, 'scripts', 'mutate.mjs'), 'utf8');
const listStart = src.indexOf('const MUTATIONS = [');
const listEnd = src.indexOf('\n];', listStart);
if (listStart < 0 || listEnd < 0) {
  console.error('Could not find the MUTATIONS list in mutate.mjs.');
  process.exit(2);
}

const literal = src.slice(listStart + 'const MUTATIONS = '.length, listEnd + 2);
// eslint-disable-next-line no-new-func -- our own source, not user input
const MUTATIONS = new Function(`return ${literal}`)();

let intact = 0;
const leftovers = [];

for (const m of MUTATIONS) {
  const body = readFileSync(join(root, m.file), 'utf8');
  if (body.includes(m.find)) intact += 1;
  else leftovers.push(m);
}

if (leftovers.length) {
  console.error(`\nLEFTOVER MUTATIONS — a killed run left ${leftovers.length} defect(s) in place:\n`);
  for (const m of leftovers) console.error(`  • ${m.file}: ${m.name}`);
  console.error('\nRestore with:  git checkout -- <file>   (or re-apply your own edits)\n');
  process.exit(1);
}

console.log(`✓ ${intact} mutation anchors intact — no defect left behind.`);
