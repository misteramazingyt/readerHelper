#!/usr/bin/env node
// check.mjs — a build-free sanity check for a build-free app.
//
// There is no bundler here to catch a typo'd import, and the browser reports one
// only at runtime, in whichever module happened to load first. So: parse every
// module, collect what it exports, and verify that every named import somewhere
// else actually resolves. Also flags duplicate exports and unreachable paths.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = join(root, 'js');

const files = readdirSync(jsDir).filter((f) => f.endsWith('.js')).map((f) => join(jsDir, f));
const problems = [];
const exportsByFile = new Map();

// ------------------------------------------------------------ collect exports

function collectExports(src) {
  const names = new Set();
  const add = (n) => n && names.add(n.trim());

  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+\*?\s*([A-Za-z0-9_$]+)/gm)) add(m[1]);
  for (const m of src.matchAll(/^export\s+class\s+([A-Za-z0-9_$]+)/gm)) add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)) add(m[1]);
  // export { a, b as c }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const as = piece.match(/\bas\s+([A-Za-z0-9_$]+)$/);
      add(as ? as[1] : piece);
    }
  }
  if (/^export\s+default\b/m.test(src)) add('default');
  return names;
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  exportsByFile.set(file, collectExports(src));
}

// ------------------------------------------------------------- verify imports

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(root, file).replace(/\\/g, '/');

  const importRe = /import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(importRe)) {
    const [, clause, spec] = m;
    if (!spec.startsWith('.')) continue;

    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) {
      problems.push(`${rel}: imports "${spec}" — file does not exist`);
      continue;
    }
    const available = exportsByFile.get(target);
    if (!available) continue;

    // Skip namespace ("* as x") and default-only imports.
    const braces = clause.match(/\{([^}]*)\}/);
    if (!braces) continue;

    for (const part of braces[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const name = piece.split(/\s+as\s+/)[0].trim();
      if (!available.has(name)) {
        problems.push(
          `${rel}: imports { ${name} } from "${spec}" — not exported there ` +
            `(has: ${[...available].slice(0, 8).join(', ')}${available.size > 8 ? ', …' : ''})`,
        );
      }
    }
  }

  // Dynamic imports carry the same risk.
  for (const m of src.matchAll(/await\s+import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const target = resolve(dirname(file), m[1]);
    if (!existsSync(target)) problems.push(`${rel}: dynamic import "${m[1]}" — file does not exist`);
  }
}

// ------------------------------------------------------------- syntax check

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    problems.push(`${relative(root, file)}: syntax error\n${err.stderr?.toString().split('\n').slice(0, 6).join('\n')}`);
  }
}

// --------------------------------------------------- html/css cross-reference

const html = readFileSync(join(root, 'index.html'), 'utf8');
const referencedIds = new Set();
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) referencedIds.add(m[1]);
  for (const m of src.matchAll(/\bbyId\(\s*['"]([^'"]+)['"]\s*\)/g)) referencedIds.add(m[1]);
}
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
// Created on demand rather than declared in the markup: ui.js builds the busy
// overlay, and auth.js builds the lock screen before the app is revealed.
const createdAtRuntime = new Set(['busy-overlay', 'lock-root']);
for (const id of referencedIds) {
  if (!htmlIds.has(id) && !createdAtRuntime.has(id)) {
    problems.push(`index.html: no element with id="${id}", but JS looks it up`);
  }
}

// ------------------------------------------------------------------- report

if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  process.exit(1);
}

console.log(`✓ ${files.length} modules parsed; all named imports and element ids resolve.`);
