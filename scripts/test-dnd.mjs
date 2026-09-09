#!/usr/bin/env node
// test-dnd.mjs — drive the pointer-based drag and drop for real.
//
// dnd.js hit-tests with elementFromPoint and measures with
// getBoundingClientRect, neither of which jsdom implements (no layout engine).
// So this builds a tiny geometry model: every column and card is assigned a
// rectangle, elementFromPoint resolves a coordinate against those rectangles,
// and pointer events are synthesised over the top. That exercises the real
// dnd.js — threshold, hit-testing, insertion index, touch long-press — rather
// than a mock of it.
//
// Requires jsdom:  npm install --no-save jsdom

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('· jsdom not installed — skipping drag-and-drop test.');
  process.exit(0);
}

const html = readFileSync(join(root, 'index.html'), 'utf8')
  .replace(/<script type="module"[\s\S]*?<\/script>/g, '');

const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true });
const { window } = dom;
const define = (o, n, v) => Object.defineProperty(o, n, { value: v, writable: true, configurable: true });

const memory = new Map();
define(window, 'localStorage', {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
});
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.Element.prototype.scrollIntoView = function () {};
window.Element.prototype.setPointerCapture = function () {};
window.Element.prototype.releasePointerCapture = function () {};
define(window, 'crypto', { randomUUID: () => 'uuid' });
define(window, 'fetch', async () => { throw new Error('network disabled'); });
define(window, 'CSS', { escape: (s) => String(s).replace(/["\\]/g, '\\$&') });
define(window.navigator, 'clipboard', { writeText: async () => {} });

for (const k of ['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'matchMedia',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'CustomEvent', 'Event',
  'MouseEvent', 'KeyboardEvent', 'HTMLElement', 'Element', 'Node', 'CSS', 'crypto', 'fetch']) {
  if (window[k] !== undefined) define(globalThis, k, window[k]);
}
define(globalThis, 'self', window);

const quiet = { error: console.error, warn: console.warn, info: console.info };
console.error = () => {}; console.warn = () => {}; console.info = () => {};
await import(pathToFileURL(join(root, 'js', 'main.js')).href);
await tick(40);
console.error = quiet.error; console.warn = quiet.warn; console.info = quiet.info;

const storeMod = await import(pathToFileURL(join(root, 'js', 'store.js')).href);
const selMod = await import(pathToFileURL(join(root, 'js', 'selection.js')).href);

// ------------------------------------------------------------ fake geometry

const COL_W = 300;
const COL_X0 = 16;
const CARD_H = 80;
const CARD_Y0 = 100;

/**
 * Lay the board out on a notional grid and teach the DOM about it. Columns sit
 * side by side; cards stack inside them.
 */
function layout() {
  const columns = [...window.document.querySelectorAll('#board > .column:not(.column--add)')];
  const rects = new Map();

  const board = window.document.getElementById('board');
  rects.set(board, { left: 0, top: 60, right: 2000, bottom: 800, width: 2000, height: 740 });

  columns.forEach((col, ci) => {
    const left = COL_X0 + ci * (COL_W + 14);
    rects.set(col, { left, top: 60, right: left + COL_W, bottom: 700, width: COL_W, height: 640 });

    const list = col.querySelector('.column__cards');
    rects.set(list, { left, top: CARD_Y0 - 10, right: left + COL_W, bottom: 690, width: COL_W, height: 600 });

    [...list.querySelectorAll('.card')].forEach((card, ri) => {
      const top = CARD_Y0 + ri * (CARD_H + 9);
      rects.set(card, { left: left + 10, top, right: left + COL_W - 10, bottom: top + CARD_H, width: COL_W - 20, height: CARD_H });
    });
  });

  const sidebar = window.document.getElementById('project-list');
  rects.set(sidebar, { left: 0, top: 60, right: 248, bottom: 700, width: 248, height: 640 });
  [...sidebar.querySelectorAll('.project-row')].forEach((row, i) => {
    const top = 70 + i * 45;
    rects.set(row, { left: 10, top, right: 238, bottom: top + 40, width: 228, height: 40 });
  });

  for (const [node, r] of rects) {
    node.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, toJSON() { return r; } });
  }

  // Deepest rectangle containing the point wins, as real hit-testing would.
  window.document.elementFromPoint = (x, y) => {
    let best = null;
    let bestArea = Infinity;
    for (const [node, r] of rects) {
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) { best = node; bestArea = area; }
    }
    return best;
  };
  return rects;
}

function pointer(type, target, x, y, opts = {}) {
  // jsdom has no PointerEvent; dnd.js only reads these fields off the event.
  const e = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  define(e, 'pointerId', opts.pointerId ?? 1);
  define(e, 'pointerType', opts.pointerType ?? 'mouse');
  (opts.dispatchOn || target).dispatchEvent(e);
  return e;
}

/** A full mouse drag: press on the item, move in steps, release over the target. */
async function drag(fromNode, toX, toY, { pointerType = 'mouse', steps = 6, grip = false } = {}) {
  const rects = layout();
  const r = fromNode.getBoundingClientRect();
  const startX = r.left + 20;
  const startY = r.top + 20;
  const handle = grip ? fromNode.querySelector('[data-drag-handle]') : fromNode;

  pointer('pointerdown', handle, startX, startY, { pointerType });
  if (pointerType === 'touch') await tick(380); // clear the long-press threshold

  for (let i = 1; i <= steps; i += 1) {
    const x = startX + ((toX - startX) * i) / steps;
    const y = startY + ((toY - startY) * i) / steps;
    pointer('pointermove', window, x, y, { pointerType, dispatchOn: window });
  }
  pointer('pointerup', window, toX, toY, { pointerType, dispatchOn: window });
  await tick(30);
  return rects;
}

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }
const $$ = (s) => [...window.document.querySelectorAll(s)];

// ------------------------------------------------------------------- set-up

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(c, what) { if (!c) throw new Error(what || 'expected true'); }

const s0 = storeMod.getState();
const project = s0.projects[s0.ui.activeProjectId];
const [gToRead, gReading, gFinished] = project.groupOrder;

storeMod.addItem(gToRead, { title: 'Alpha' });
storeMod.addItem(gToRead, { title: 'Beta' });
storeMod.addItem(gToRead, { title: 'Gamma' });
storeMod.addItem(gReading, { title: 'Delta' });
await tick(30);

const titlesIn = (groupId) => {
  const s = storeMod.getState();
  return s.groups[groupId].placementOrder.map((pid) => s.items[s.placements[pid].itemId].title);
};
const cardNamed = (t) => $$('.card').find((c) => c.querySelector('.card__title').textContent === t);
const columnFor = (groupId) => $$('#board > .column').find((c) => c.dataset.groupId === groupId);

await check('board fixture is laid out as expected', () => {
  eq(titlesIn(gToRead), ['Alpha', 'Beta', 'Gamma'], 'to-read');
  eq(titlesIn(gReading), ['Delta'], 'reading');
  eq($$('#board > .column:not(.column--add)').length, 3, 'three columns');
});

// -------------------------------------------------------------------- tests

await check('a small movement is a click, not a drag', async () => {
  layout();
  const card = cardNamed('Alpha');
  const r = card.getBoundingClientRect();
  pointer('pointerdown', card, r.left + 20, r.top + 20);
  pointer('pointermove', window, r.left + 22, r.top + 21, { dispatchOn: window });
  pointer('pointerup', window, r.left + 22, r.top + 21, { dispatchOn: window });
  await tick(20);
  eq(titlesIn(gToRead), ['Alpha', 'Beta', 'Gamma'], 'nothing moved');
  ok(!window.document.querySelector('.drag-ghost'), 'no ghost left behind');
});

await check('dragging a card to another column moves it', async () => {
  const card = cardNamed('Alpha');
  const target = columnFor(gReading).getBoundingClientRect();
  await drag(card, target.left + 150, target.top + 400);
  eq(titlesIn(gToRead), ['Beta', 'Gamma'], 'left the source');
  ok(titlesIn(gReading).includes('Alpha'), 'arrived in the target');
});

await check('the card lands at the drop position, not just at the end', async () => {
  // Drop above Delta: aim at the top half of the first card.
  const s = storeMod.getState();
  eq(titlesIn(gReading).length, 2, 'two cards to order');
  layout();
  const gamma = cardNamed('Gamma');
  const firstCard = columnFor(gReading).querySelector('.card');
  const fr = firstCard.getBoundingClientRect();
  await drag(gamma, fr.left + 100, fr.top + 5);
  eq(titlesIn(gReading)[0], 'Gamma', `dropped at the top (got ${titlesIn(gReading)})`);
});

await check('reordering within a column works', async () => {
  const before = titlesIn(gReading);
  ok(before.length >= 3, `need 3 cards, have ${before.length}`);
  layout();
  const first = cardNamed(before[0]);
  const last = columnFor(gReading).querySelectorAll('.card')[before.length - 1];
  const lr = last.getBoundingClientRect();
  await drag(first, lr.left + 100, lr.bottom - 5);
  const after = titlesIn(gReading);
  eq(after[after.length - 1], before[0], `${before[0]} moved to the end (got ${after})`);
});

await check('a card cannot be dropped on the sidebar', async () => {
  const before = titlesIn(gReading);
  const card = cardNamed(before[0]);
  await drag(card, 120, 200); // over the project list
  eq(titlesIn(gReading), before, 'unchanged');
});

await check('Escape cancels a drag in flight', async () => {
  const before = titlesIn(gReading);
  layout();
  const card = cardNamed(before[0]);
  const r = card.getBoundingClientRect();
  pointer('pointerdown', card, r.left + 20, r.top + 20);
  for (let i = 1; i <= 4; i += 1) pointer('pointermove', window, r.left + 20 + i * 40, r.top + 20, { dispatchOn: window });
  ok(window.document.querySelector('.drag-ghost'), 'ghost exists mid-drag');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(20);
  ok(!window.document.querySelector('.drag-ghost'), 'ghost removed');
  pointer('pointerup', window, r.left + 200, r.top + 20, { dispatchOn: window });
  await tick(20);
  eq(titlesIn(gReading), before, 'nothing moved');
});

await check('dragging one of several selected cards carries the whole selection', async () => {
  selMod.clearSelection();
  const s = storeMod.getState();
  const reading = s.groups[gReading].placementOrder;
  const picked = reading.slice(0, 2);
  selMod.replaceWith(picked);
  await tick(20);

  const titles = picked.map((pid) => s.items[s.placements[pid].itemId].title);
  const card = cardNamed(titles[0]);
  const target = columnFor(gFinished).getBoundingClientRect();
  await drag(card, target.left + 150, target.top + 400);

  const landed = titlesIn(gFinished);
  for (const t of titles) ok(landed.includes(t), `${t} moved with the selection (got ${landed})`);
  selMod.clearSelection();
});

await check('a column can be dragged to reorder the board', async () => {
  const order = () => storeMod.getState().projects[storeMod.getState().ui.activeProjectId].groupOrder.slice();
  const before = order();
  layout();
  const firstCol = columnFor(before[0]);
  const lastCol = columnFor(before[2]);
  const lr = lastCol.getBoundingClientRect();
  await drag(firstCol, lr.right - 20, lr.top + 300, { grip: true });
  const after = order();
  ok(after[after.length - 1] === before[0], `column moved to the end (before ${before}, after ${after})`);
});

await check('a sidebar project row can be dragged to reorder', async () => {
  storeMod.addProject('Second');
  storeMod.addProject('Third');
  await tick(30);
  const before = storeMod.getState().projectOrder.slice();
  ok(before.length >= 3, 'three projects');
  layout();
  const rows = $$('.project-row');
  const firstRow = rows[0];
  const lastRect = rows[rows.length - 1].getBoundingClientRect();
  await drag(firstRow, 120, lastRect.bottom - 4, { grip: true });
  const after = storeMod.getState().projectOrder;
  ok(after[after.length - 1] === before[0], `project moved to the end (before ${before}, after ${after})`);
});

await check('a touch drag needs a long press on the grip', async () => {
  const s = storeMod.getState();
  const active = s.ui.activeProjectId;
  const groups = s.projects[active].groupOrder;
  const source = groups.find((g) => titlesIn(g).length > 0);
  const dest = groups.find((g) => g !== source);
  const before = titlesIn(source);
  layout();
  const card = cardNamed(before[0]);

  // Touching the card body, away from the grip, must not drag.
  const r = card.getBoundingClientRect();
  pointer('pointerdown', card, r.left + 120, r.top + 20, { pointerType: 'touch' });
  await tick(400);
  pointer('pointermove', window, r.left + 400, r.top + 20, { pointerType: 'touch', dispatchOn: window });
  pointer('pointerup', window, r.left + 400, r.top + 20, { pointerType: 'touch', dispatchOn: window });
  await tick(20);
  eq(titlesIn(source), before, 'body touch did not drag (so the column can scroll)');

  // The grip, held, does drag.
  const target = columnFor(dest).getBoundingClientRect();
  await drag(cardNamed(before[0]), target.left + 150, target.top + 400, { pointerType: 'touch', grip: true });
  ok(titlesIn(dest).includes(before[0]), `${before[0]} moved by touch (dest now ${titlesIn(dest)})`);
});

await check('an early touch move scrolls instead of dragging', async () => {
  const s = storeMod.getState();
  const groups = s.projects[s.ui.activeProjectId].groupOrder;
  const source = groups.find((g) => titlesIn(g).length > 0);
  const before = titlesIn(source);
  layout();
  const card = cardNamed(before[0]);
  const grip = card.querySelector('[data-drag-handle]');
  const r = card.getBoundingClientRect();
  pointer('pointerdown', grip, r.left + 12, r.top + 20, { pointerType: 'touch' });
  // Move immediately — before the hold timer — as a scroll gesture would.
  pointer('pointermove', window, r.left + 12, r.top + 120, { pointerType: 'touch', dispatchOn: window });
  await tick(400);
  pointer('pointerup', window, r.left + 12, r.top + 120, { pointerType: 'touch', dispatchOn: window });
  await tick(20);
  eq(titlesIn(source), before, 'treated as a scroll, not a drag');
});

await check('no drag artefacts are left in the document', () => {
  eq($$('.drag-ghost').length, 0, 'ghosts');
  eq($$('.drop-placeholder').length, 0, 'placeholders');
  eq($$('.is-dragging').length, 0, 'dragging classes');
  eq($$('.is-drop-target').length, 0, 'drop-target classes');
  ok(!window.document.body.classList.contains('is-dnd-active'), 'body class cleared');
});

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ ${passed} drag-and-drop tests passed.`);
process.exit(0);
