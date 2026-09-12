// palette.js — the Shift+Space command palette.
//
// Three modes drive one input box:
//   root — slash commands plus a fuzzy search over books, projects and groups
//   pick — a command asked for a target; Tab or Enter chooses it
//   arg  — a command asked for free text (a reading amount, a name)
//
// Plain typing that is not a slash command is routed through a small natural
// language matcher first ("read 30 pages of Capital"), and falls back to search.

import * as store from './store.js';
import { allItems } from './store.js';
import { orderedProjects, itemProgress, authorLabel } from './model.js';
import { fuzzyScore, parseReading, resolveReading, pct } from './nlp.js';
import * as actions from './actions.js';
import * as sync from './sync.js';
import * as opener from './open.js';
import * as sel from './selection.js';
import { toast, el } from './ui.js';

let overlay = null;
let inputEl = null;
let listEl = null;
let hintEl = null;
let state = null;
let hooks = {};

export function initPalette(options = {}) {
  hooks = options;
  window.addEventListener('keydown', (e) => {
    // Shift+Space opens the palette, except while typing somewhere else.
    if (e.code === 'Space' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target;
      const typing = t?.matches?.('input, textarea, select, [contenteditable="true"]');
      if (typing && !overlay) return;
      e.preventDefault();
      if (overlay) closePalette();
      else openPalette();
    } else if (e.key === 'Escape' && overlay) {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
    }
  });
}

// -------------------------------------------------------------------- commands

const COMMANDS = [
  {
    id: 'read',
    slash: '/read',
    label: 'Log reading',
    hint: 'pick a book, then say how much',
    run: () => enterPick({
      command: 'read',
      prompt: 'Which book did you read?',
      rows: () => bookRows(),
      onPick: (row) => enterArg({
        command: 'read',
        itemId: row.id,
        prompt: `How much of “${row.label}”?`,
        placeholder: '30 pages · two chapters · up to p. 210 · halfway',
        onSubmit: (value) => {
          closePalette();
          actions.applyReading(row.id, value);
        },
      }),
    }),
  },
  {
    id: 'open',
    slash: '/open',
    label: 'Open a book page',
    hint: 'notes and tasks for one book',
    run: () => enterPick({
      command: 'open',
      prompt: 'Open which book?',
      rows: () => bookRows(),
      onPick: (row) => {
        closePalette();
        hooks.openItem?.(row.id);
      },
    }),
  },
  {
    id: 'pdf',
    slash: '/pdf',
    label: 'Open a PDF',
    hint: 'resumes at your last page',
    run: () => enterPick({
      command: 'pdf',
      prompt: 'Open which PDF?',
      rows: () => bookRows().filter((r) => opener.hasPdfLink(r.item)),
      onPick: (row) => {
        closePalette();
        actions.reportOpen(opener.openLocalPdf(row.item, store.getSettings()));
      },
    }),
  },
  {
    id: 'zotero',
    slash: '/zotero',
    label: 'Show a book in Zotero',
    run: () => enterPick({
      command: 'zotero',
      prompt: 'Show which book in Zotero?',
      rows: () => bookRows().filter((r) => opener.hasZoteroLink(r.item)),
      onPick: (row) => {
        closePalette();
        actions.reportOpen(opener.openInZotero(row.item));
      },
    }),
  },
  {
    id: 'markread',
    slash: '/markread',
    label: 'Mark a book read',
    hint: 'archives it and tags Zotero',
    run: () => enterPick({
      command: 'markread',
      prompt: 'Mark which book read?',
      rows: () => bookRows(),
      onPick: (row) => {
        closePalette();
        const placements = store.locationsOfItem(row.id).map((l) => l.placement.id);
        actions.markReadFlow(placements.slice(0, 1));
      },
    }),
  },
  {
    id: 'task',
    slash: '/task',
    label: 'Add a Todoist task',
    run: () => enterPick({
      command: 'task',
      prompt: 'Task for which book?',
      rows: () => bookRows(),
      onPick: (row) => {
        closePalette();
        actions.promptTodoistTaskForItem([row.id]);
      },
    }),
  },
  {
    id: 'export',
    slash: '/export',
    label: 'Export bibliography',
    hint: 'selection, or this project',
    run: () => {
      // A selection is the more specific intent, so it wins when there is one.
      const selected = sel.getSelection();
      if (selected.length) {
        closePalette();
        actions.exportBibliography(actions.itemsOfPlacements(selected), `${selected.length}-books`);
        return;
      }
      const s = store.getState();
      const project = s.projects[s.ui.activeProjectId];
      if (!project) {
        closePalette();
        toast('Select a project first.', { type: 'error' });
        return;
      }
      enterPick({
        command: 'export',
        prompt: 'Export which group? (Esc for the whole project)',
        rows: () => [
          { id: `__project__${project.id}`, label: `Whole project: ${project.name}`, sub: `${actions.itemsOfProject(project.id).length} books` },
          ...project.groupOrder.map((gid) => {
            const g = s.groups[gid];
            return g ? { id: gid, label: g.name, sub: `${actions.itemsOfGroup(gid).length} books` } : null;
          }).filter(Boolean),
        ],
        onPick: (row) => {
          closePalette();
          if (row.id.startsWith('__project__')) {
            actions.exportBibliography(actions.itemsOfProject(project.id), project.name);
          } else {
            actions.exportBibliography(actions.itemsOfGroup(row.id), s.groups[row.id]?.name);
          }
        },
      });
    },
  },
  {
    id: 'tozotero',
    slash: '/tozotero',
    label: 'Add to Zotero',
    hint: 'selection, or this project',
    run: () => {
      const selected = sel.getSelection();
      if (selected.length) {
        closePalette();
        actions.promptPushToZotero(actions.pushEntriesForPlacements(selected));
        return;
      }
      const s = store.getState();
      const project = s.projects[s.ui.activeProjectId];
      closePalette();
      if (!project) {
        toast('Select a project first.', { type: 'error' });
        return;
      }
      actions.promptPushToZotero(actions.pushEntriesForProject(project.id), project.name);
    },
  },
  {
    id: 'goodreads',
    slash: '/goodreads',
    label: 'Import from Goodreads',
    hint: 'CSV export, or a public shelf',
    run: () => {
      closePalette();
      actions.promptGoodreadsImport();
    },
  },
  {
    id: 'togoodreads',
    slash: '/togoodreads',
    label: 'Add to Goodreads',
    hint: 'CSV for their importer',
    run: () => {
      const selected = sel.getSelection();
      const s = store.getState();
      const project = s.projects[s.ui.activeProjectId];
      closePalette();
      if (selected.length) {
        actions.exportForGoodreads(actions.goodreadsEntriesForPlacements(selected), `${selected.length}-books`);
      } else if (project) {
        actions.exportForGoodreads(
          actions.pushEntriesForProject(project.id).map((e) => ({ item: e.item, groupName: e.groupName })),
          project.name,
        );
      } else {
        toast('Select a project first.', { type: 'error' });
      }
    },
  },
  {
    id: 'goto',
    slash: '/goto',
    label: 'Go to a project',
    run: () => enterPick({
      command: 'goto',
      prompt: 'Which project?',
      rows: () => projectRows(),
      onPick: (row) => {
        closePalette();
        store.setActiveProject(row.id);
      },
    }),
  },
  {
    id: 'book',
    slash: '/book',
    label: 'Add a book',
    hint: 'manual entry or DOI/ISBN',
    run: () => {
      const groupId = firstGroupOfActiveProject();
      closePalette();
      if (!groupId) return toast('Create a group first.', { type: 'error' });
      actions.promptAddBook(groupId);
    },
  },
  {
    id: 'group',
    slash: '/group',
    label: 'New group',
    hint: 'a column on the board',
    run: () => {
      const projectId = store.getState().ui.activeProjectId;
      closePalette();
      if (!projectId) return toast('Select a project first.', { type: 'error' });
      hooks.addGroup?.(projectId);
    },
  },
  {
    id: 'project',
    slash: '/project',
    label: 'New project',
    hint: 'a sidebar entry',
    run: () => {
      closePalette();
      hooks.addProject?.();
    },
  },
  {
    id: 'import',
    slash: '/import',
    label: 'Import a Zotero collection',
    hint: 'same as the Z button',
    run: () => {
      closePalette();
      sync.promptZoteroImport();
    },
  },
  {
    id: 'sync',
    slash: '/sync',
    label: 'Sync with Zotero now',
    run: () => {
      closePalette();
      sync.syncAll();
    },
  },
  {
    id: 'archive',
    slash: '/archive',
    label: 'Show archived books',
    run: () => {
      closePalette();
      hooks.showArchive?.();
    },
  },
  {
    id: 'settings',
    slash: '/settings',
    label: 'Settings',
    hint: 'API keys, sync, PDF handler',
    run: () => {
      closePalette();
      hooks.openSettings?.();
    },
  },
  {
    id: 'help',
    slash: '/help',
    label: 'Keyboard shortcuts and commands',
    run: () => {
      closePalette();
      hooks.showHelp?.();
    },
  },
];

// ------------------------------------------------------------------ rows

function bookRows() {
  return allItems()
    .map((item) => {
      const loc = store.locationsOfItem(item.id)[0];
      return {
        id: item.id,
        item,
        label: item.title,
        sub: [authorLabel(item), item.year, loc ? `${loc.project.name} / ${loc.group.name}` : null]
          .filter(Boolean)
          .join(' · '),
        trail: pct(itemProgress(item)),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function projectRows() {
  const s = store.getState();
  return orderedProjects(s).map((p) => ({
    id: p.id,
    label: p.name,
    sub: `${p.groupOrder.length} group(s)`,
  }));
}

function firstGroupOfActiveProject() {
  const s = store.getState();
  const p = s.projects[s.ui.activeProjectId];
  return p?.groupOrder[0] || null;
}

// ------------------------------------------------------------------ palette

export function openPalette(initial = '') {
  if (overlay) return;
  state = { mode: 'root', filtered: [], active: 0 };

  overlay = el('div', 'palette-overlay');
  const box = el('div', 'palette');

  hintEl = el('div', 'palette__hint');
  hintEl.hidden = true;

  const inputWrap = el('div', 'palette__input-wrap');
  const chevron = el('span', 'palette__chevron', '›');
  inputEl = document.createElement('input');
  inputEl.type = 'text';
  inputEl.className = 'palette__input';
  inputEl.placeholder = 'Type a command (/read), search, or say what you did…';
  inputEl.value = initial;
  inputEl.autocomplete = 'off';
  inputEl.spellcheck = false;
  inputWrap.append(chevron, inputEl);

  listEl = el('div', 'palette__list');

  const footer = el('div', 'palette__footer');
  footer.append(
    kbd('↑↓', 'navigate'),
    kbd('Tab', 'choose'),
    kbd('Enter', 'run'),
    kbd('Esc', 'close'),
  );

  box.append(hintEl, inputWrap, listEl, footer);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.body.classList.add('palette-open');

  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) closePalette();
  });
  inputEl.addEventListener('input', refresh);
  inputEl.addEventListener('keydown', onKey);

  refresh();
  setTimeout(() => inputEl.focus(), 20);
}

function kbd(key, label) {
  const wrap = el('span', 'palette__kbd-group');
  wrap.append(el('kbd', 'palette__kbd', key), el('span', 'palette__kbd-label', label));
  return wrap;
}

export function closePalette() {
  overlay?.remove();
  overlay = null;
  inputEl = null;
  listEl = null;
  state = null;
  document.body.classList.remove('palette-open');
}

function enterPick({ command, prompt, rows, onPick }) {
  state = { mode: 'pick', command, prompt, rowsFn: rows, onPick, active: 0, filtered: [] };
  inputEl.value = '';
  inputEl.placeholder = 'Filter…';
  refresh();
}

function enterArg({ command, itemId, prompt, placeholder, onSubmit }) {
  state = { mode: 'arg', command, itemId, prompt, onSubmit, active: 0, filtered: [] };
  inputEl.value = '';
  inputEl.placeholder = placeholder || '';
  refresh();
}

function onKey(e) {
  if (!state) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    state.active = Math.min(state.active + 1, Math.max(0, state.filtered.length - 1));
    paint();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    state.active = Math.max(state.active - 1, 0);
    paint();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    choose();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (state.mode === 'arg') submitArg();
    else choose();
  } else if (e.key === 'Backspace' && !inputEl.value && state.mode !== 'root') {
    e.preventDefault();
    state = { mode: 'root', filtered: [], active: 0 };
    inputEl.placeholder = 'Type a command (/read), search, or say what you did…';
    refresh();
  }
}

function choose() {
  const row = state.filtered[state.active];
  if (!row) {
    if (state.mode === 'root') runNaturalLanguage(inputEl.value.trim());
    return;
  }
  if (state.mode === 'pick') {
    state.onPick(row);
    return;
  }
  if (row.kind === 'command') {
    row.command.run();
  } else if (row.kind === 'item') {
    closePalette();
    hooks.openItem?.(row.id);
  } else if (row.kind === 'project') {
    closePalette();
    store.setActiveProject(row.id);
  } else if (row.kind === 'group') {
    closePalette();
    store.setActiveProject(row.projectId);
  }
}

function submitArg() {
  const value = inputEl.value.trim();
  if (!value) return;
  state.onSubmit(value);
}

function refresh() {
  if (!state) return;
  const q = inputEl.value.trim();

  if (state.mode === 'arg') {
    hintEl.hidden = false;
    const intent = parseReading(q);
    const item = store.getState().items[state.itemId];
    if (q && intent && item) {
      const res = resolveReading(intent, item);
      hintEl.textContent = res.ok ? `${state.prompt} → ${res.explain}` : `${state.prompt} — ${res.explain}`;
      hintEl.className = `palette__hint ${res.ok ? 'is-ok' : 'is-warn'}`;
    } else {
      hintEl.textContent = state.prompt;
      hintEl.className = 'palette__hint';
    }
    state.filtered = [];
    paint();
    return;
  }

  if (state.mode === 'pick') {
    hintEl.hidden = false;
    hintEl.textContent = state.prompt;
    hintEl.className = 'palette__hint';
    const rows = state.rowsFn();
    state.filtered = !q
      ? rows.slice(0, 60)
      : rows
          .map((r) => ({ r, s: Math.max(fuzzyScore(q, r.label), fuzzyScore(q, r.sub || '') - 200) }))
          .filter((x) => x.s >= 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 60)
          .map((x) => x.r);
    state.active = 0;
    paint();
    return;
  }

  hintEl.hidden = true;
  state.filtered = rootRows(q);
  state.active = 0;
  paint();
}

function rootRows(q) {
  const s = store.getState();
  const rows = [];

  if (q.startsWith('/')) {
    const term = q.slice(1);
    for (const c of COMMANDS) {
      const score = fuzzyScore(term, c.id + ' ' + c.label);
      if (term === '' || score >= 0) rows.push({ kind: 'command', command: c, label: c.slash, sub: c.label, trail: c.hint || '', _s: score });
    }
    return rows.sort((a, b) => b._s - a._s).slice(0, 20);
  }

  if (!q) {
    for (const c of COMMANDS.slice(0, 8)) {
      rows.push({ kind: 'command', command: c, label: c.slash, sub: c.label, trail: c.hint || '' });
    }
    return rows;
  }

  // A reading phrase like "read 30 pages of Capital" wins over plain search.
  const nl = matchReadingPhrase(q);
  if (nl) {
    rows.push({
      kind: 'command',
      command: { run: () => { closePalette(); actions.applyReading(nl.item.id, nl.phrase); } },
      label: `Log “${nl.phrase}”`,
      sub: nl.item.title,
      trail: 'natural language',
    });
  }

  for (const row of bookRows()) {
    const score = Math.max(fuzzyScore(q, row.label), fuzzyScore(q, row.sub || '') - 300);
    if (score >= 0) rows.push({ kind: 'item', id: row.id, label: row.label, sub: row.sub, trail: row.trail, _s: score });
  }
  for (const p of orderedProjects(s)) {
    const score = fuzzyScore(q, p.name);
    if (score >= 0) rows.push({ kind: 'project', id: p.id, label: p.name, sub: 'project', trail: '', _s: score });
  }
  for (const g of Object.values(s.groups)) {
    const score = fuzzyScore(q, g.name);
    if (score >= 0) rows.push({ kind: 'group', id: g.id, projectId: g.projectId, label: g.name, sub: `group in ${s.projects[g.projectId]?.name || ''}`, trail: '', _s: score });
  }

  const head = rows.filter((r) => r.trail === 'natural language');
  const rest = rows.filter((r) => r.trail !== 'natural language').sort((a, b) => (b._s || 0) - (a._s || 0));
  return [...head, ...rest].slice(0, 40);
}

/** "read 30 pages of Capital" / "40% of Ulysses" -> {item, phrase} */
function matchReadingPhrase(q) {
  const m = q.match(/^(?:i\s+)?(?:read\s+|logged\s+|did\s+)?(.+?)\s+(?:of|in|from)\s+(.+)$/i);
  if (!m) return null;
  const [, phrase, titleQuery] = m;
  if (!parseReading(phrase)) return null;
  const candidates = bookRows()
    .map((r) => ({ r, s: fuzzyScore(titleQuery, r.label) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s);
  if (!candidates.length) return null;
  return { item: candidates[0].r.item, phrase };
}

function runNaturalLanguage(q) {
  if (!q) return;
  const nl = matchReadingPhrase(q);
  if (nl) {
    closePalette();
    actions.applyReading(nl.item.id, nl.phrase);
    return;
  }
  toast(`Nothing matched “${q}”. Try /help.`, { type: 'error' });
}

function paint() {
  if (!listEl) return;
  listEl.replaceChildren();
  if (state.mode === 'arg') {
    listEl.appendChild(el('p', 'palette__empty', 'Press Enter to log it.'));
    return;
  }
  if (!state.filtered.length) {
    listEl.appendChild(el('p', 'palette__empty', state.mode === 'pick' ? 'No books match.' : 'No matches. Press Enter to try it as a sentence.'));
    return;
  }
  state.filtered.forEach((row, i) => {
    const btn = el('button', `palette__row${i === state.active ? ' is-active' : ''}`);
    btn.type = 'button';
    btn.append(el('span', 'palette__row-label', row.label));
    if (row.sub) btn.append(el('span', 'palette__row-sub', row.sub));
    if (row.trail) btn.append(el('span', 'palette__row-trail', row.trail));
    btn.addEventListener('click', () => {
      state.active = i;
      choose();
    });
    btn.addEventListener('pointerenter', () => {
      state.active = i;
      listEl.querySelectorAll('.palette__row').forEach((n, j) => n.classList.toggle('is-active', j === i));
    });
    listEl.appendChild(btn);
  });
  listEl.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
}

export { COMMANDS };
