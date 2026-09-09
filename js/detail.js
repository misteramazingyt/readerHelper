// detail.js — the per-book page, in the spirit of opening a Todoist task.
//
// Slides in over the board on desktop and fills the screen on mobile. Holds the
// things that belong to the book rather than the board: its tasks (which stay
// in readerHelper), free-form notes, reading history, and the metadata that
// makes progress tracking work.

import * as store from './store.js';
import { TAGS, TAG_COLORS, itemProgress, authorLabel } from './model.js';
import { el, toast, errorToast, confirmDialog } from './ui.js';
import * as actions from './actions.js';
import * as opener from './open.js';
import { pct } from './nlp.js';

let panel = null;
let currentItemId = null;
let unsubscribe = null;
let notesTimer = null;

export function isDetailOpen() {
  return Boolean(panel);
}

export function openDetail(itemId) {
  const item = store.getState().items[itemId];
  if (!item) {
    toast('That book is no longer on the board.', { type: 'error' });
    return;
  }
  if (panel) closeDetail({ silent: true });
  currentItemId = itemId;

  panel = el('div', 'detail-overlay');
  const sheet = el('section', 'detail');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  panel.appendChild(sheet);
  document.body.appendChild(panel);
  document.body.classList.add('detail-open');

  panel.addEventListener('pointerdown', (e) => {
    if (e.target === panel) closeDetail();
  });
  document.addEventListener('keydown', onKey, true);

  unsubscribe = store.subscribe(() => paint(sheet));
  paint(sheet);
  history.replaceState(null, '', `#book/${itemId}`);
}

function onKey(e) {
  if (e.key !== 'Escape' || !panel) return;
  const inField = e.target?.matches?.('input, textarea, [contenteditable="true"]');
  if (inField) return;
  e.preventDefault();
  e.stopPropagation();
  closeDetail();
}

export function closeDetail({ silent = false } = {}) {
  flushNotes();
  unsubscribe?.();
  unsubscribe = null;
  panel?.remove();
  panel = null;
  currentItemId = null;
  document.body.classList.remove('detail-open');
  document.removeEventListener('keydown', onKey, true);
  if (!silent && location.hash.startsWith('#book/')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function flushNotes() {
  if (!notesTimer) return;
  clearTimeout(notesTimer);
  notesTimer = null;
}

function paint(sheet) {
  const state = store.getState();
  const item = state.items[currentItemId];
  if (!item) {
    closeDetail();
    return;
  }
  // Never rebuild while a field inside is focused — it would eat the keystroke.
  const active = document.activeElement;
  if (sheet.contains(active) && active.matches('input, textarea')) return;

  sheet.replaceChildren();
  sheet.append(
    renderHeader(item),
    renderProgressSection(item),
    renderMetaSection(item),
    renderTasksSection(item),
    renderNotesSection(item),
    renderHistorySection(item),
  );
}

function renderHeader(item) {
  const header = el('header', 'detail__header');

  const back = el('button', 'detail__back', '←');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back to the board');
  back.addEventListener('click', () => closeDetail());

  const titleWrap = el('div', 'detail__title-wrap');
  const title = el('h1', 'detail__title', item.title);
  title.contentEditable = 'true';
  title.spellcheck = false;
  title.addEventListener('blur', () => {
    const v = title.textContent.trim();
    if (v && v !== item.title) store.renameItem(item.id, v);
    else title.textContent = item.title;
  });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      title.blur();
    }
  });

  const sub = el('div', 'detail__sub');
  const loc = store.locationsOfItem(item.id);
  const bits = [authorLabel(item), item.year, loc.map((l) => `${l.project.name} / ${l.group.name}`).join(' · ')].filter(Boolean);
  sub.textContent = bits.join(' — ');
  titleWrap.append(title, sub);

  const menuBtn = el('button', 'burger', '☰');
  menuBtn.type = 'button';
  menuBtn.setAttribute('aria-label', 'Book actions');
  menuBtn.addEventListener('click', (e) => {
    const p = loc[0]?.placement.id;
    if (!p) return;
    const r = menuBtn.getBoundingClientRect();
    actions.openBookMenu(r.left, r.bottom + 4, p);
  });

  header.append(back, titleWrap, menuBtn);
  return header;
}

function renderProgressSection(item) {
  const section = el('section', 'detail__section detail__section--progress');
  const frac = itemProgress(item);

  const top = el('div', 'detail__progress-top');
  const label = el('span', 'detail__progress-label');
  label.textContent = item.totalPages
    ? `Page ${item.currentPage || 0} of ${item.totalPages} — ${pct(frac)}`
    : `${pct(frac)} read`;

  const tagRow = el('div', 'detail__tags');
  for (const t of TAGS) {
    const chip = el('button', `tag-chip${item.tag === t ? ' is-on' : ''}`, t);
    chip.type = 'button';
    chip.style.setProperty('--tag-color', TAG_COLORS[t]);
    chip.addEventListener('click', () => store.setItemTag(item.id, item.tag === t ? null : t));
    tagRow.appendChild(chip);
  }
  top.append(label, tagRow);

  const bar = el('div', 'detail__bar');
  const fill = el('div', 'detail__bar-fill');
  fill.style.width = `${frac * 100}%`;
  bar.appendChild(fill);

  const buttons = el('div', 'detail__actions');
  const logBtn = el('button', 'btn btn--primary', 'Log reading…');
  logBtn.type = 'button';
  logBtn.addEventListener('click', () => actions.promptReading(item.id));

  const zBtn = el('button', 'btn btn--ghost', 'Zotero');
  zBtn.type = 'button';
  zBtn.disabled = !opener.hasZoteroLink(item);
  zBtn.addEventListener('click', () => actions.reportOpen(opener.openInZotero(item)));

  const pdfBtn = el('button', 'btn btn--ghost', item.currentPage ? `Open PDF (p. ${opener.resumePage(item)})` : 'Open PDF');
  pdfBtn.type = 'button';
  pdfBtn.disabled = !opener.hasPdfLink(item);
  pdfBtn.addEventListener('click', () => actions.reportOpen(opener.openLocalPdf(item, store.getSettings())));

  const todoBtn = el('button', 'btn btn--ghost', 'Todoist task…');
  todoBtn.type = 'button';
  todoBtn.addEventListener('click', () => actions.promptTodoistTaskForItem([item.id]));

  buttons.append(logBtn, zBtn, pdfBtn, todoBtn);
  section.append(top, bar, buttons);
  return section;
}

function renderMetaSection(item) {
  const section = el('section', 'detail__section');
  section.appendChild(el('h2', 'detail__heading', 'Details'));

  const grid = el('div', 'detail__grid');
  const rows = [
    ['Authors', (item.authors || []).join(', ')],
    ['Year', item.year],
    ['Type', item.itemType],
    ['Total pages', item.totalPages],
    ['Total chapters', item.totalChapters],
    ['DOI', item.doi],
    ['ISBN', item.isbn],
    ['Citation key', item.citekey],
    ['Zotero key', item.zoteroKey],
    ['Local PDF', item.localPdfPath],
  ];
  for (const [k, v] of rows) {
    if (v == null || v === '') continue;
    const row = el('div', 'detail__grid-row');
    row.append(el('span', 'detail__grid-key', k), el('span', 'detail__grid-value', String(v)));
    grid.appendChild(row);
  }
  section.appendChild(grid);

  if (item.url) {
    const link = el('a', 'detail__link', item.url);
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    section.appendChild(link);
  }

  const edit = el('button', 'btn btn--ghost', 'Edit details…');
  edit.type = 'button';
  edit.addEventListener('click', () => actions.promptEditBook(item.id));
  section.appendChild(edit);
  return section;
}

function renderTasksSection(item) {
  const section = el('section', 'detail__section');
  const head = el('div', 'detail__section-head');
  head.append(el('h2', 'detail__heading', 'Tasks'));
  const count = item.tasks.filter((t) => !t.done).length;
  head.append(el('span', 'detail__count', `${count} open`));
  section.appendChild(head);

  const list = el('div', 'task-list');
  for (const task of item.tasks) {
    const row = el('div', `task${task.done ? ' is-done' : ''}`);

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'task__check';
    box.checked = task.done;
    box.addEventListener('change', () => store.updateItemTask(item.id, task.id, { done: box.checked }));

    const text = el('span', 'task__text', task.text);
    text.contentEditable = 'true';
    text.addEventListener('blur', () => {
      const v = text.textContent.trim();
      if (v && v !== task.text) store.updateItemTask(item.id, task.id, { text: v });
      else if (!v) text.textContent = task.text;
    });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        text.blur();
      }
    });

    const push = el('button', 'task__push', '↗');
    push.type = 'button';
    push.title = 'Send this task to Todoist';
    push.addEventListener('click', () => pushTaskToTodoist(item, task));

    const del = el('button', 'task__delete', '×');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete task');
    del.addEventListener('click', () => store.removeItemTask(item.id, task.id));

    row.append(box, text, push, del);
    list.appendChild(row);
  }
  section.appendChild(list);

  const form = document.createElement('form');
  form.className = 'task-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-add__input';
  input.placeholder = 'Add a task for this book…';
  const add = el('button', 'btn btn--ghost', 'Add');
  add.type = 'submit';
  form.append(input, add);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    store.addItemTask(item.id, v);
    input.value = '';
    setTimeout(() => {
      panel?.querySelector('.task-add__input')?.focus();
    }, 20);
  });
  section.appendChild(form);
  return section;
}

async function pushTaskToTodoist(item, task) {
  const cfg = store.getSettings();
  if (!cfg.todoistApiKey) {
    toast('Add a Todoist API token in Settings first.', { type: 'error' });
    return;
  }
  const { createTask, bookLink } = await import('./todoist.js');
  try {
    const link = bookLink(item);
    const created = await createTask(cfg, {
      content: task.text,
      description: [item.title, link].filter(Boolean).join('\n'),
    });
    store.updateItemTask(item.id, task.id, { todoistId: created?.id || null });
    toast('Sent to Todoist.', { type: 'success' });
  } catch (err) {
    errorToast(err, 'Todoist');
  }
}

function renderNotesSection(item) {
  const section = el('section', 'detail__section');
  section.appendChild(el('h2', 'detail__heading', 'Notes'));
  const ta = document.createElement('textarea');
  ta.className = 'detail__notes';
  ta.rows = 8;
  ta.placeholder = 'Anything worth keeping about this book…';
  ta.value = item.notes || '';
  // Debounced so every keystroke is not a commit on the undo stack.
  ta.addEventListener('input', () => {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => store.setItemNotes(item.id, ta.value), 600);
  });
  ta.addEventListener('blur', () => {
    clearTimeout(notesTimer);
    notesTimer = null;
    if (ta.value !== (item.notes || '')) store.setItemNotes(item.id, ta.value);
  });
  section.appendChild(ta);
  return section;
}

function renderHistorySection(item) {
  const section = el('section', 'detail__section');
  const head = el('div', 'detail__section-head');
  head.append(el('h2', 'detail__heading', 'Reading history'));
  section.appendChild(head);

  if (!item.readingLog?.length) {
    section.appendChild(el('p', 'detail__empty', 'Nothing logged yet. Use “Log reading…” or /read.'));
    return section;
  }

  const list = el('ol', 'history');
  for (const entry of [...item.readingLog].reverse()) {
    const li = el('li', 'history__row');
    const when = new Date(entry.ts);
    li.append(
      el('span', 'history__when', when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
      el('span', 'history__raw', entry.raw),
      el('span', 'history__result', entry.resolvedPage != null ? `→ p. ${entry.resolvedPage}` : entry.resolvedFraction != null ? `→ ${pct(entry.resolvedFraction)}` : ''),
    );
    list.appendChild(li);
  }
  section.appendChild(list);

  const clear = el('button', 'btn btn--ghost', 'Clear history');
  clear.type = 'button';
  clear.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Clear reading history?',
      message: 'The log entries go; the current page and percentage stay as they are.',
      confirmLabel: 'Clear',
      danger: true,
    });
    if (ok?.confirmed) store.updateItem(item.id, { readingLog: [] });
  });
  section.appendChild(clear);
  return section;
}

/** Reopen a book page after a reload if the URL points at one. */
export function restoreFromHash() {
  const m = location.hash.match(/^#book\/(.+)$/);
  if (!m) return false;
  const itemId = decodeURIComponent(m[1]);
  if (!store.getState().items[itemId]) return false;
  openDetail(itemId);
  return true;
}
