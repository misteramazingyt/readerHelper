#!/usr/bin/env node
// test-dom.mjs — boot the real app in jsdom and drive it.
//
// jsdom cannot execute <script type="module">, so instead we build the document
// from index.html, publish the DOM onto globalThis, and let Node's own ESM
// loader import js/main.js. The modules then run against the real markup —
// which is what catches boot errors, bad element ids and broken event wiring
// that a pure unit test never reaches.
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
  console.log('· jsdom not installed — skipping DOM smoke test.');
  console.log('  npm install --no-save jsdom');
  process.exit(0);
}

// ------------------------------------------------------------------ harness

const html = readFileSync(join(root, 'index.html'), 'utf8')
  // The module script is loaded by Node below, not by jsdom.
  .replace(/<script type="module"[\s\S]*?<\/script>/g, '');

const dom = new JSDOM(html, { url: 'http://localhost:8000/', pretendToBeVisual: true });
const { window } = dom;

const consoleErrors = [];
const pageErrors = [];
window.addEventListener('error', (e) => pageErrors.push(e.message));

// --- shims for the handful of APIs jsdom lacks that the app relies on
// Several of these are getter-only on the jsdom Window, so define rather than assign.
const define = (obj, name, value) =>
  Object.defineProperty(obj, name, { value, writable: true, configurable: true });

const memory = new Map();
define(window, 'localStorage', {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
  clear: () => memory.clear(),
});
window.matchMedia = (q) => ({
  matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});

// Now that an OAuth app is configured, the board does not render until the
// sign-in gate is satisfied — including here. Seed a signed-in session before
// main.js loads. Revalidation calls api.github.com, which the stubbed fetch
// below refuses; auth.js treats an unreachable GitHub as "keep the session",
// so an offline test run stays signed in. The gate's own behaviour is covered
// exhaustively by test-auth.mjs; this is only about getting past it.
memory.set('readerHelper.auth.v1', JSON.stringify({
  token: 'gho_test_session',
  login: 'misteramazingyt',
  scope: 'gist',
  signedInAt: new Date().toISOString(),
}));

window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.scrollTo = () => {};
window.Element.prototype.scrollIntoView = function scrollIntoView() {};
window.Element.prototype.setPointerCapture = function setPointerCapture() {};
window.Element.prototype.releasePointerCapture = function releasePointerCapture() {};
window.document.elementFromPoint = () => null;
define(window, 'crypto', { ...(window.crypto || {}), randomUUID: () => 'test-uuid-0000' });
define(window.navigator, 'clipboard', { writeText: async () => {} });
// No test here should reach the network by accident, but some features (the
// identifier lookup, the bibliography export) exist to call it — so the stub is
// swappable per test rather than a flat refusal.
let fetchHandler = async () => { throw new Error('network disabled in smoke test'); };
const setFetch = (fn) => { fetchHandler = fn; };
define(window, 'fetch', (...args) => fetchHandler(...args));
define(window, 'CSS', { ...(window.CSS || {}), escape: (s) => String(s).replace(/["\\]/g, '\\$&') });
window.HTMLCanvasElement.prototype.getContext = () => null;

// Publish the DOM globally so the modules find it.
for (const key of [
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'matchMedia',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'CustomEvent', 'Event',
  'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'HTMLElement', 'Element', 'Node', 'CSS',
  'crypto', 'fetch', 'Blob', 'URL', 'FileReader',
]) {
  // Node 22 defines some of these (navigator, crypto, fetch) as getter-only.
  if (window[key] !== undefined) define(globalThis, key, window[key]);
}
define(globalThis, 'self', window);

const realError = console.error;
console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); };
const realWarn = console.warn;
console.warn = () => {};
const realInfo = console.info;
console.info = () => {};

// ---------------------------------------------------------------------- boot

await import(pathToFileURL(join(root, 'js', 'main.js')).href);
await tick(40);

console.error = realError;
console.warn = realWarn;
console.info = realInfo;

// --------------------------------------------------------------------- test

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

function ok(cond, what) { if (!cond) throw new Error(what || 'expected true'); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }
const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];

function click(node, init = {}) {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
}
function key(k, init = {}) {
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
}

await check('boots without throwing', () => {
  eq(pageErrors, [], 'page errors');
  eq(consoleErrors, [], 'console errors');
});

await check('seeds a first-run board', () => {
  const rows = $$('.project-row');
  ok(rows.length >= 1, 'a project row exists');
  eq(rows[0].querySelector('.project-row__name').textContent, 'Reading', 'project name');
  eq($('#active-project-title').textContent, 'Reading', 'header title');
});

await check('renders the seeded groups as columns', () => {
  const titles = $$('.column__title').map((n) => n.textContent);
  eq(titles, ['To read', 'Reading now', 'Finished'], 'column titles');
  ok($('.column--add'), 'the add-group column is present');
});

await check('every column offers an add-book button', () => {
  eq($$('.column__add').length, 3, 'add buttons');
});

await check('the help sheet opened on first run', async () => {
  await tick(450);
  ok($('.modal'), 'a modal is open');
  click($('.modal__close'));
  await tick(10);
  ok(!$('.modal'), 'closed again');
});

await check('adding a group renames in place', async () => {
  click($('.column--add'));
  await tick(20);
  const titles = $$('.column__title').map((n) => n.textContent.trim());
  ok(titles.length === 4, `expected 4 columns, got ${titles.length}`);
  const input = $('.column__title .inline-edit') || $('.inline-edit');
  ok(input, 'an inline editor is focused for the new group');
  input.value = 'Secondary literature';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(20);
  ok($$('.column__title').some((n) => n.textContent === 'Secondary literature'), 'renamed');
});

// Books, via the store rather than the dialog, then check the render.
const storeMod = await import(pathToFileURL(join(root, 'js', 'store.js')).href);
const modelMod = await import(pathToFileURL(join(root, 'js', 'model.js')).href);
const actionsMod = await import(pathToFileURL(join(root, 'js', 'actions.js')).href);

await check('a book renders with tag, progress and open buttons', async () => {
  const s = storeMod.getState();
  const groupId = s.projects[s.ui.activeProjectId].groupOrder[0];
  storeMod.addItem(groupId, {
    title: 'The Order of Things',
    authors: ['Michel Foucault'],
    totalPages: 400,
    currentPage: 100,
    tag: 'Full',
    citekey: 'foucault1966order',
    pdfAttachmentKey: 'ABCD1234',
  });
  await tick(20);
  const card = $('.card');
  ok(card, 'card rendered');
  eq(card.querySelector('.card__title').textContent, 'The Order of Things', 'title');
  eq(card.querySelector('.card__tag').textContent, 'Full', 'tag');
  eq(card.querySelector('.progress__fill').style.width, '25%', 'progress width');
  eq(card.querySelector('.progress__label').textContent, '100/400', 'progress label');
  const chips = [...card.querySelectorAll('.chip')].map((c) => c.textContent);
  eq(chips, ['Zotero', 'Local PDF'], 'open buttons');
  ok(!card.querySelector('.chip[disabled]'), 'both enabled when links exist');
});

await check('the overall bar reflects project progress', () => {
  eq($('#overall-fill').style.width, '25%', 'overall width');
  eq($('#overall-label').textContent, '25% read', 'overall label');
});

await check('ctrl-click selects, Esc clears', async () => {
  const card = $('.card');
  click(card, { ctrlKey: true });
  await tick(10);
  ok(card.classList.contains('is-selected'), 'card selected');
  ok(!$('#selection-bar').hidden, 'selection bar shown');
  eq($('#selection-count').textContent, '1 book selected', 'count');
  key('Escape');
  await tick(10);
  ok($('#selection-bar').hidden, 'selection bar hidden again');
});

await check('selection survives switching project', async () => {
  const sel = await import(pathToFileURL(join(root, 'js', 'selection.js')).href);
  click($('.card'), { ctrlKey: true });
  await tick(10);
  const other = storeMod.addProject('Elsewhere');
  storeMod.setActiveProject(other.id);
  await tick(20);
  eq($$('.card').length, 0, 'no cards in the new project');
  eq(sel.selectionSize(), 1, 'selection retained across projects');
  sel.clearSelection();
});

await check('clicking a card opens its page', async () => {
  const s = storeMod.getState();
  const first = Object.values(s.projects).find((p) => p.name === 'Reading');
  storeMod.setActiveProject(first.id);
  await tick(20);
  click($('.card'));
  await tick(20);
  ok($('.detail'), 'detail panel opened');
  eq($('.detail__title').textContent, 'The Order of Things', 'detail title');
  ok($('.detail__notes'), 'notes field present');
  ok($('.task-add__input'), 'task input present');
});

await check('a task can be added on the book page', async () => {
  const input = $('.task-add__input');
  input.value = 'Read the preface closely';
  $('.task-add').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(20);
  const tasks = $$('.task__text').map((n) => n.textContent);
  eq(tasks, ['Read the preface closely'], 'task rendered');
});

await check('closing the book page returns to the board', async () => {
  click($('.detail__back'));
  await tick(20);
  ok(!$('.detail'), 'panel closed');
  ok($('.board'), 'board present');
  ok($('.card__tasks'), 'card now shows a task badge');
});

await check('the palette opens on Shift+Space and lists commands', async () => {
  window.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Space', shiftKey: true, bubbles: true, cancelable: true }));
  await tick(20);
  ok($('.palette'), 'palette open');
  const labels = $$('.palette__row-label').map((n) => n.textContent);
  ok(labels.includes('/read'), `/read listed (got ${labels.slice(0, 4)})`);
});

await check('typing a title in the palette finds the book', async () => {
  const input = $('.palette__input');
  input.value = 'order of things';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(20);
  const labels = $$('.palette__row-label').map((n) => n.textContent);
  ok(labels.includes('The Order of Things'), `book found (got ${labels})`);
});

await check('a whole sentence is offered as a reading log', async () => {
  const input = $('.palette__input');
  input.value = 'read 30 pages of order of things';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(20);
  const first = $('.palette__row-label').textContent;
  ok(first.startsWith('Log '), `natural-language row first (got "${first}")`);
  ok(first.includes('30 pages'), 'phrase preserved');
});

await check('/read enters the book picker, Tab chooses, then it logs', async () => {
  const input = $('.palette__input');
  input.value = '/read';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(20);
  // Enter runs the highlighted command -> pick mode
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await tick(20);
  ok(!$('.palette__hint').hidden, 'prompt shown');
  ok($$('.palette__row-label').some((n) => n.textContent === 'The Order of Things'), 'books listed');

  // Tab selects the highlighted book -> argument mode
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  await tick(20);
  ok($('.palette__hint').textContent.includes('How much'), 'asks how much');

  input.value = '50 pages';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(10);
  ok($('.palette__hint').textContent.includes('page 150'), `previews the result (got "${$('.palette__hint').textContent}")`);

  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await tick(30);
  ok(!$('.palette'), 'palette closed');
  const item = Object.values(storeMod.getState().items).find((i) => i.title === 'The Order of Things');
  eq(item.currentPage, 150, 'page advanced 100 -> 150');
  eq(item.readingLog.length, 1, 'logged');
});

await check('the card reflects the new progress', async () => {
  await tick(20);
  eq($('.progress__label').textContent, '150/400', 'label updated');
  eq($('.progress__fill').style.width, '37.5%', 'fill updated');
});

await check('right-clicking a card opens its menu', async () => {
  $('.card').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  await tick(20);
  const items = $$('.context-menu__item').map((n) => n.querySelector('.context-menu__label').textContent);
  for (const expected of ['Open in Zotero', 'Open PDF', 'Add task to Todoist…', 'Duplicate', 'Move to…', 'Copy to…', 'Mark read']) {
    ok(items.includes(expected), `menu has "${expected}" (got ${items.join(' | ')})`);
  }
});

await check('Duplicate makes a linked copy on the board', async () => {
  const dup = $$('.context-menu__item').find((n) => n.querySelector('.context-menu__label').textContent === 'Duplicate');
  click(dup);
  await tick(30);
  eq($$('.card').length, 2, 'two cards');
  const titles = $$('.card__title').map((n) => n.textContent);
  eq(titles, ['The Order of Things', 'The Order of Things'], 'same book twice');
  eq($$('.card__linked').length, 2, 'both marked as linked copies');
  eq(Object.keys(storeMod.getState().items).length, 1, 'still one underlying record');
});

await check('undo reverses the duplicate', async () => {
  key('z', { ctrlKey: true });
  await tick(20);
  eq($$('.card').length, 1, 'back to one card');
});

await check('right-clicking a column opens the group menu', async () => {
  $('.column').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
  await tick(20);
  const items = $$('.context-menu__item').map((n) => n.querySelector('.context-menu__label').textContent);
  for (const expected of ['Rename', 'Add book…', 'Add to Todoist…', 'Duplicate', 'Move to…', 'Copy to…', 'Delete group']) {
    ok(items.includes(expected), `group menu has "${expected}"`);
  }
  key('Escape');
  await tick(10);
});

await check('right-clicking a project opens the project menu', async () => {
  $('.project-row').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
  await tick(20);
  const items = $$('.context-menu__item').map((n) => n.querySelector('.context-menu__label').textContent);
  for (const expected of ['Rename', 'Add group…', 'Add to Todoist…', 'Mirror to Todoist', 'Duplicate', 'Delete project']) {
    ok(items.includes(expected), `project menu has "${expected}"`);
  }
  key('Escape');
  await tick(10);
});

await check('the sort menu switches a group to alphabetical', async () => {
  const s = storeMod.getState();
  const groupId = s.projects[s.ui.activeProjectId].groupOrder[0];
  storeMod.addItem(groupId, { title: 'A Book Before' });
  await tick(20);
  eq($$('.card__title').map((n) => n.textContent), ['The Order of Things', 'A Book Before'], 'custom order');
  storeMod.setGroupSort(groupId, 'alpha', 'asc');
  await tick(20);
  eq($$('.card__title').map((n) => n.textContent), ['A Book Before', 'The Order of Things'], 'alphabetical');
  storeMod.setGroupSort(groupId, 'alpha', 'desc');
  await tick(20);
  eq($$('.card__title').map((n) => n.textContent), ['The Order of Things', 'A Book Before'], 'descending');
});

await check('a book with no links has both open buttons disabled', () => {
  const card = $$('.card').find((c) => c.querySelector('.card__title').textContent === 'A Book Before');
  const chips = [...card.querySelectorAll('.chip')];
  ok(chips.every((c) => c.disabled), 'both disabled');
});

await check('settings opens and shows the key fields', async () => {
  click($('#settings-btn'));
  await tick(30);
  const names = $$('.modal [name]').map((n) => n.name);
  for (const expected of ['zoteroApiKey', 'zoteroUserId', 'todoistApiKey', 'githubToken', 'gistId', 'localPdfHandler', 'theme']) {
    ok(names.includes(expected), `settings has ${expected}`);
  }
  click($('.modal__close'));
  await tick(10);
});

await check('the archive view opens', async () => {
  click($('#archive-btn'));
  await tick(30);
  ok($('.modal__title').textContent.startsWith('Archive'), 'archive modal');
  click($('.modal__close'));
  await tick(10);
});

// -------------------------------------------- identifier lookup and export

await check('the add-book dialog resolves an ISBN without a button press', async () => {
  setFetch(async (url) => {
    const u = String(url);
    if (u.includes('openlibrary.org/api/books')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          'ISBN:9780804011662': {
            title: 'The Public and Its Problems',
            authors: [{ name: 'John Dewey' }],
            publish_date: '1927',
            number_of_pages: 278,
            publishers: [{ name: 'Swallow Press' }],
            url: 'https://openlibrary.org/books/OL1M',
          },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${u}`);
  });

  const s = storeMod.getState();
  const groupId = s.projects[s.ui.activeProjectId].groupOrder[0];
  actionsMod.promptAddBook(groupId);
  await tick(40);

  const idField = $('.modal [name="identifier"]');
  ok(idField, 'identifier field present');
  eq($('.modal [name="title"]').value, '', 'title starts empty');

  idField.value = '9780804011662';
  // blur resolves at once, rather than waiting out the typing debounce
  idField.dispatchEvent(new window.Event('blur', { bubbles: true }));
  await tick(80);

  eq($('.modal [name="title"]').value, 'The Public and Its Problems', 'title filled in');
  eq($('.modal [name="authors"]').value, 'John Dewey', 'authors filled in');
  eq($('.modal [name="year"]').value, '1927', 'year filled in');
  eq($('.modal [name="totalPages"]').value, '278', 'page count filled in');
  ok($('.form__status').textContent.includes('Open Library'), 'says where it came from');
});

await check('a hand-typed field is not overwritten by a later lookup', async () => {
  $('.modal [name="title"]').value = 'My Own Title';
  const idField = $('.modal [name="identifier"]');
  idField.value = '978-0-8040-1166-2';   // the same book, formatted differently
  idField.dispatchEvent(new window.Event('blur', { bubbles: true }));
  await tick(80);
  eq($('.modal [name="title"]').value, 'My Own Title', 'kept what was typed');
});

await check('submitting keeps the detail the lookup found', async () => {
  $('.modal form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(80);
  ok(!$('.modal'), 'dialog closed');
  const added = Object.values(storeMod.getState().items).find((i) => i.title === 'My Own Title');
  ok(added, 'item created');
  eq(added.isbn, '9780804011662', 'isbn kept');
  eq(added.publisher, 'Swallow Press', 'publisher carried over');
  eq(added.totalPages, 278, 'page count carried over');
});

await check('submitting with ONLY an identifier resolves it instead of refusing', async () => {
  // This is the case that used to fail with "Title is required" while an
  // unresolved ISBN sat in the field above it.
  setFetch(async (url) => {
    if (String(url).includes('openlibrary.org/api/books')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          'ISBN:9780674724761': {
            title: 'A Theory of Justice',
            authors: [{ name: 'John Rawls' }],
            publish_date: '1971',
            number_of_pages: 607,
          },
        }),
      };
    }
    throw new Error('unexpected fetch');
  });

  const s = storeMod.getState();
  actionsMod.promptAddBook(s.projects[s.ui.activeProjectId].groupOrder[0]);
  await tick(40);
  // Type the ISBN and submit at once — no blur, no Look up press.
  $('.modal [name="identifier"]').value = '9780674724761';
  $('.modal form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(120);

  ok(!$('.modal'), 'the dialog closed rather than showing a validation error');
  const added = Object.values(storeMod.getState().items).find((i) => i.title === 'A Theory of Justice');
  ok(added, 'the book was added from the identifier alone');
  eq(added.totalPages, 607, 'with its page count');
});

await check('a failed lookup reports itself and does not block manual entry', async () => {
  setFetch(async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => '' }));
  const s = storeMod.getState();
  actionsMod.promptAddBook(s.projects[s.ui.activeProjectId].groupOrder[0]);
  await tick(40);
  const idField = $('.modal [name="identifier"]');
  idField.value = '9780804011662';
  idField.dispatchEvent(new window.Event('blur', { bubbles: true }));
  await tick(80);
  ok($('.form__status').textContent.length > 0, 'said something about it');
  $('.modal [name="title"]').value = 'Typed By Hand';
  $('.modal form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(80);
  ok(Object.values(storeMod.getState().items).some((i) => i.title === 'Typed By Hand'),
    'manual entry still works when the lookup fails');
});

await check('Export bibliography appears in the book menu', async () => {
  setFetch(async () => { throw new Error('offline'); });
  $('.card').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  await tick(20);
  const items = $$('.context-menu__item').map((n) => n.querySelector('.context-menu__label').textContent);
  ok(items.includes('Export bibliography…'), `book menu (got ${items.join(' | ')})`);
  key('Escape');
  await tick(10);
});

await check('Export bibliography appears in the group and project menus', async () => {
  $('.column').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
  await tick(20);
  ok($$('.context-menu__item').some((n) => n.textContent.includes('Export bibliography')), 'group menu');
  key('Escape');
  await tick(10);

  $('.project-row').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
  await tick(20);
  ok($$('.context-menu__item').some((n) => n.textContent.includes('Export bibliography')), 'project menu');
  key('Escape');
  await tick(10);
});

await check('Add to Zotero appears on books, groups and projects', async () => {
  $('.card').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  await tick(20);
  ok($$('.context-menu__item').some((n) => n.textContent.includes('Add to Zotero')), 'book menu');
  key('Escape');
  await tick(10);

  $('.column').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
  await tick(20);
  ok($$('.context-menu__item').some((n) => n.textContent.includes('Add group to Zotero')), 'group menu');
  key('Escape');
  await tick(10);

  $('.project-row').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
  await tick(20);
  ok($$('.context-menu__item').some((n) => n.textContent.includes('Add project to Zotero')), 'project menu');
  key('Escape');
  await tick(10);
});

await check('push entries carry the project and group each book sits in', () => {
  const s = storeMod.getState();
  const projectId = s.ui.activeProjectId;
  const project = s.projects[projectId];
  const entries = actionsMod.pushEntriesForProject(projectId);
  ok(entries.length > 0, 'some entries');
  for (const e of entries) {
    eq(e.projectName, project.name, 'project name attached');
    ok(project.groupOrder.some((gid) => s.groups[gid].name === e.groupName), 'group name is a real group');
    ok(e.item && e.item.title, 'carries the book');
  }
  // A linked copy must yield one entry per group it sits in — unlike the
  // bibliography export, which counts each book once. Make one here rather
  // than relying on another test having run first.
  const groups = project.groupOrder;
  const source = s.groups[groups[0]].placementOrder[0];
  const other = groups.find((g) => g !== groups[0]);
  const copy = storeMod.duplicatePlacement(source, other);

  const after = actionsMod.pushEntriesForProject(projectId);
  eq(after.length, entries.length + 1, 'the copy added an entry');
  const copiedItemId = storeMod.getState().placements[copy.id].itemId;
  const forThatBook = after.filter((e) => e.item.id === copiedItemId);
  eq(forThatBook.length, 2, 'one entry per group');
  eq(
    new Set(forThatBook.map((e) => e.groupName)).size, 2,
    'and they name different groups',
  );
  storeMod.removePlacement(copy.id);
});

await check('the push dialog refuses politely when Zotero is not configured', async () => {
  const s = storeMod.getState();
  await actionsMod.promptPushToZotero(actionsMod.pushEntriesForProject(s.ui.activeProjectId));
  await tick(20);
  ok(!$('.push__tree'), 'no dialog opened');
  const toastText = $$('.toast').map((t) => t.textContent).join(' ');
  ok(toastText.includes('Zotero'), `said why (got: ${toastText.slice(0, 80)})`);
  $$('.toast').forEach((t) => t.remove());
});

await check('the export dialog produces BibTeX for a whole group', async () => {
  const s = storeMod.getState();
  const groupId = s.projects[s.ui.activeProjectId].groupOrder[0];
  actionsMod.exportBibliography(actionsMod.itemsOfGroup(groupId), 'To read');
  await tick(120);
  const out = $('.export__output');
  ok(out, 'output shown');
  ok(out.value.includes('@book{') || out.value.includes('@article{'),
    `bibtex produced (got ${out.value.slice(0, 60)})`);
  ok($('.export__format'), 'format selector present');
  ok($$('.btn').some((b) => b.textContent === 'Download'), 'download offered');
  click($$('.btn').find((b) => b.textContent === 'Close'));
  await tick(20);
});

await check('a project export counts a linked copy only once', () => {
  const s = storeMod.getState();
  const projectId = s.ui.activeProjectId;
  const groups = s.projects[projectId].groupOrder;
  const before = actionsMod.itemsOfProject(projectId).length;

  // The copy has to land in a DIFFERENT group to test the project-level check:
  // a duplicate inside one group is already collapsed when that group is read.
  const source = s.groups[groups[0]].placementOrder[0];
  const otherGroup = groups.find((g) => g !== groups[0]);
  ok(source && otherGroup, 'fixture has a book and a second group');
  storeMod.duplicatePlacement(source, otherGroup);

  eq(actionsMod.itemsOfGroup(otherGroup).length >= 1, true, 'the copy is in the other group');
  eq(actionsMod.itemsOfProject(projectId).length, before, 'but the project still lists it once');
});

await check('state persisted to localStorage', () => {
  const raw = window.localStorage.getItem('readerHelper.state.v1');
  ok(raw, 'state written');
  const parsed = JSON.parse(raw);
  ok(Object.keys(parsed.items).length >= 2, 'items saved');
});

await check('no errors accumulated during the run', () => {
  eq(pageErrors, [], 'page errors');
  eq(consoleErrors.filter((e) => !e.includes('Not implemented')), [], 'console errors');
});

// ------------------------------------------------------------------- report

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ ${passed} DOM smoke tests passed.`);
process.exit(0);
