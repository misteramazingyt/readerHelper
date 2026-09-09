// actions.js — the operations behind context menus, buttons, and the palette.
//
// Anything that mutates the board or talks to Zotero/Todoist lives here, so the
// render layer stays a pure function of state and the palette and the menus can
// share one implementation of every command.

import * as store from './store.js';
import { TAGS, itemProgress, authorLabel } from './model.js';
import {
  toast,
  errorToast,
  openForm,
  openModal,
  confirmDialog,
  openContextMenu,
  el,
  showBusy,
} from './ui.js';
import * as todoist from './todoist.js';
import * as zotero from './zotero.js';
import * as opener from './open.js';
import { lookupAny } from './metadata.js';
import { parseReading, resolveReading, prettyField, pct, fuzzyScore } from './nlp.js';
import * as sel from './selection.js';

const READ_TAG_DEFAULT = 'read';

// =============================================================== book dialogs

/** The "+" at the bottom of a column: manual entry or DOI/ISBN import. */
export async function promptAddBook(groupId) {
  const values = await openForm({
    title: 'Add a book',
    submitLabel: 'Add',
    intro: 'Enter a DOI or ISBN and press Look up, or fill the fields in by hand.',
    fields: [
      { name: 'identifier', label: 'DOI or ISBN', placeholder: '10.1093/… or 9780674… ', autofocus: true },
      { name: 'title', label: 'Title', required: true },
      { name: 'authors', label: 'Authors', hint: 'Comma-separated.' },
      { name: 'year', label: 'Year', type: 'number' },
      { name: 'totalPages', label: 'Total pages', type: 'number', hint: 'Lets readerHelper turn pages read into a percentage.' },
      { name: 'totalChapters', label: 'Total chapters', type: 'number', hint: 'Optional; needed to log progress by chapter.' },
      { name: 'url', label: 'URL' },
      { name: 'tag', label: 'Reading mode', type: 'select', value: '', options: [{ value: '', label: '— none —' }, ...TAGS.map((t) => ({ value: t, label: t }))] },
    ],
    extraActions: [
      {
        label: 'Look up',
        onClick: async (readValues, _close, controls) => {
          const { identifier } = readValues();
          if (!identifier) {
            toast('Enter a DOI or ISBN first.', { type: 'error' });
            return;
          }
          const busy = showBusy('Looking up…');
          try {
            const meta = await lookupAny(identifier);
            const set = (name, v) => {
              const c = controls.get(name);
              if (c && v != null && v !== '') c.input.value = v;
            };
            set('title', meta.title);
            set('authors', (meta.authors || []).join(', '));
            set('year', meta.year);
            set('totalPages', meta.totalPages);
            set('url', meta.url);
            if (meta.doi) controls.get('identifier').input.value = meta.doi;
            toast(`Found via ${meta.source}.`, { type: 'success' });
          } catch (err) {
            errorToast(err, 'Lookup failed');
          } finally {
            busy.done();
          }
        },
      },
    ],
  });
  if (!values) return null;

  const identifier = values.identifier || '';
  const created = store.addItem(groupId, {
    title: values.title,
    authors: splitAuthors(values.authors),
    year: values.year || null,
    doi: /^10\./.test(identifier) ? identifier : null,
    isbn: /^\d/.test(identifier) && !/^10\./.test(identifier) ? identifier.replace(/[\s-]/g, '') : null,
    url: values.url || null,
    totalPages: values.totalPages || null,
    totalChapters: values.totalChapters || null,
    tag: values.tag || null,
  });
  toast(`Added “${values.title}”.`, { type: 'success' });
  return created;
}

export async function promptEditBook(itemId) {
  const item = store.getState().items[itemId];
  if (!item) return null;
  const values = await openForm({
    title: 'Edit book',
    submitLabel: 'Save',
    fields: [
      { name: 'title', label: 'Title', value: item.title, required: true, autofocus: true },
      { name: 'authors', label: 'Authors', value: (item.authors || []).join(', ') },
      { name: 'year', label: 'Year', type: 'number', value: item.year },
      { name: 'totalPages', label: 'Total pages', type: 'number', value: item.totalPages },
      { name: 'totalChapters', label: 'Total chapters', type: 'number', value: item.totalChapters },
      { name: 'currentPage', label: 'Current page', type: 'number', value: item.currentPage },
      { name: 'url', label: 'URL', value: item.url },
      { name: 'doi', label: 'DOI', value: item.doi },
      { name: 'localPdfPath', label: 'Local PDF path', value: item.localPdfPath, hint: 'Used by the readerhelper:// handler.' },
      { name: 'tag', label: 'Reading mode', type: 'select', value: item.tag || '', options: [{ value: '', label: '— none —' }, ...TAGS.map((t) => ({ value: t, label: t }))] },
    ],
  });
  if (!values) return null;
  store.updateItem(itemId, {
    title: values.title,
    authors: splitAuthors(values.authors),
    year: values.year || null,
    totalPages: values.totalPages || null,
    totalChapters: values.totalChapters || null,
    currentPage: values.currentPage || 0,
    url: values.url || null,
    doi: values.doi || null,
    localPdfPath: values.localPdfPath || null,
    tag: values.tag || null,
  });
  maybePromptMarkRead(itemId);
  return true;
}

// ============================================================ reading (/read)

/**
 * Log reading in natural language. When the phrasing needs metadata the book
 * lacks (a page count, a chapter count), prompt for it and retry rather than
 * dropping what was typed.
 */
export async function promptReading(itemId, preset = '') {
  const item = store.getState().items[itemId];
  if (!item) return null;

  const answer = await openModal({
    title: `How much of “${truncate(item.title, 60)}” did you read?`,
    render: (body, close) => {
      const form = el('form', 'form reading-form');
      const input = document.createElement('input');
      input.className = 'reading-form__input';
      input.type = 'text';
      input.placeholder = 'e.g. 30 pages · two chapters · up to p. 210 · halfway';
      input.value = preset;
      form.appendChild(input);

      const meta = el('div', 'reading-form__meta');
      meta.textContent = item.totalPages
        ? `Currently on page ${item.currentPage || 0} of ${item.totalPages} (${pct(itemProgress(item))}).`
        : `No page count recorded yet — ${pct(itemProgress(item))} complete.`;
      form.appendChild(meta);

      const preview = el('div', 'reading-form__preview');
      preview.hidden = true;
      form.appendChild(preview);

      const update = () => {
        const intent = parseReading(input.value);
        if (!intent) {
          preview.hidden = !input.value.trim();
          preview.className = 'reading-form__preview is-warn';
          preview.textContent = input.value.trim() ? 'Not understood yet…' : '';
          return;
        }
        const res = resolveReading(intent, item);
        preview.hidden = false;
        preview.className = `reading-form__preview ${res.ok ? 'is-ok' : 'is-warn'}`;
        preview.textContent = res.ok ? res.explain : res.explain;
      };
      input.addEventListener('input', update);
      update();

      const actions = el('div', 'form__actions');
      const spacer = el('div', 'form__spacer');
      const cancel = el('button', 'btn btn--ghost', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => close(null));
      const ok = el('button', 'btn btn--primary', 'Log it');
      ok.type = 'submit';
      actions.append(spacer, cancel, ok);
      form.appendChild(actions);

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        close(input.value.trim() || null);
      });
      body.appendChild(form);
      setTimeout(() => input.focus(), 30);
    },
  });

  if (!answer) return null;
  return applyReading(itemId, answer);
}

/** Parse, fill any metadata gap by prompting, then commit to the reading log. */
export async function applyReading(itemId, phrase) {
  let item = store.getState().items[itemId];
  const intent = parseReading(phrase);
  if (!intent) {
    toast(`Could not understand “${phrase}”. Try “30 pages” or “up to p. 210”.`, { type: 'error', timeout: 5000 });
    return null;
  }

  let res = resolveReading(intent, item);
  if (!res.ok) {
    const filled = await promptForMetadata(itemId, res.missing);
    if (!filled) {
      toast('Reading not logged — that needs a page count.', { type: 'error' });
      return null;
    }
    item = store.getState().items[itemId];
    res = resolveReading(intent, item);
    if (!res.ok) {
      toast(res.explain, { type: 'error' });
      return null;
    }
  }

  store.logReading(itemId, {
    raw: phrase,
    kind: intent.kind,
    unit: intent.unit,
    amount: intent.amount,
    resolvedPage: res.resolvedPage,
    resolvedFraction: res.resolvedFraction,
  });
  toast(`Logged: ${res.explain}`, { type: 'success' });
  await maybePromptMarkRead(itemId);
  return res;
}

/** Ask for the page/chapter counts a phrasing needs before it can be resolved. */
export async function promptForMetadata(itemId, missing) {
  const item = store.getState().items[itemId];
  if (!item) return false;
  const fields = [];
  if (missing.includes('totalPages')) {
    fields.push({
      name: 'totalPages',
      label: 'Total pages',
      type: 'number',
      value: item.totalPages,
      required: true,
      autofocus: true,
      hint: 'readerHelper needs this to turn pages into a percentage.',
    });
  }
  if (missing.includes('totalChapters')) {
    fields.push({
      name: 'totalChapters',
      label: 'Total chapters',
      type: 'number',
      value: item.totalChapters,
      required: true,
      hint: 'Used to convert chapters into pages.',
    });
  }
  if (!fields.length) return true;

  const values = await openForm({
    title: `How long is “${truncate(item.title, 50)}”?`,
    intro: `That needs ${missing.map(prettyField).join(' and ')} before it can be scored.`,
    submitLabel: 'Save and continue',
    fields,
  });
  if (!values) return false;
  const patch = {};
  if (values.totalPages) patch.totalPages = values.totalPages;
  if (values.totalChapters) patch.totalChapters = values.totalChapters;
  store.updateItem(itemId, patch);
  return true;
}

/** At 100% (or the configured threshold), offer to mark the book read. */
export async function maybePromptMarkRead(itemId) {
  const item = store.getState().items[itemId];
  if (!item || item.archived || item.markReadPrompted) return false;
  const threshold = store.getSettings().promptMarkReadAt ?? 1;
  if (itemProgress(item) < threshold) return false;

  store.updateItem(itemId, { markReadPrompted: true });
  const answer = await confirmDialog({
    title: 'Finished?',
    message: `“${item.title}” has reached ${pct(itemProgress(item))}. Mark it read?`,
    confirmLabel: 'Mark read',
    checkboxes: [{ name: 'tagZotero', label: `Also add the "${readTag()}" tag in Zotero`, value: Boolean(item.zoteroKey) }],
  });
  if (!answer?.confirmed) return false;
  await markItemsRead([itemId], { tagZotero: answer.tagZotero });
  return true;
}

// ============================================================ mark read

function readTag() {
  return store.getSettings().zoteroReadTag || READ_TAG_DEFAULT;
}

/** Archive locally, and (optionally) tag the source item in Zotero. */
export async function markItemsRead(itemIds, { tagZotero = true } = {}) {
  const cfg = store.getSettings();
  store.batch(() => {
    for (const id of itemIds) store.archiveItem(id, true);
  });
  const label = itemIds.length === 1 ? 'Book' : `${itemIds.length} books`;
  toast(`${label} archived as read.`, {
    type: 'success',
    action: {
      label: 'Undo',
      onClick: () => {
        store.batch(() => {
          for (const id of itemIds) store.archiveItem(id, false);
        });
      },
    },
  });

  if (!tagZotero) return;
  const withZotero = itemIds
    .map((id) => store.getState().items[id])
    .filter((i) => i?.zoteroKey);
  if (!withZotero.length) return;
  if (!cfg.zoteroApiKey || !cfg.zoteroUserId) {
    toast('Zotero not configured — tag not applied.', { type: 'error' });
    return;
  }

  const busy = showBusy(`Tagging ${withZotero.length} item(s) in Zotero…`);
  let done = 0;
  const failures = [];
  for (const item of withZotero) {
    try {
      await zotero.addTagToItem(cfg, item.zoteroKey, readTag());
      done += 1;
      busy.update(`Tagged ${done}/${withZotero.length} in Zotero…`);
    } catch (err) {
      failures.push(`${item.title}: ${err.message}`);
    }
  }
  busy.done();
  if (failures.length) {
    errorToast(new Error(failures.join('; ')), `Tagged ${done}, failed ${failures.length}`);
  } else {
    toast(`Tagged ${done} item(s) "${readTag()}" in Zotero.`, { type: 'success' });
  }
}

// ============================================================ Todoist

/** Dialog pre-filled from the book, with the link Todoist will render. */
export async function promptTodoistTaskForItem(itemIds) {
  const state = store.getState();
  const items = itemIds.map((id) => state.items[id]).filter(Boolean);
  if (!items.length) return null;
  const cfg = store.getSettings();
  if (!cfg.todoistApiKey) {
    toast('Add a Todoist API token in Settings first.', { type: 'error' });
    return null;
  }

  const single = items.length === 1 ? items[0] : null;
  const preset = single
    ? todoist.defaultTaskForItem(single, { progressPct: pct(itemProgress(single)) })
    : { content: `Read ${items.length} books`, description: items.map((i) => `- ${i.title}`).join('\n') };

  const projects = await safeList(() => todoist.listProjects(cfg));
  const projectOptions = [{ value: '', label: 'Inbox' }, ...projects.map((p) => ({ value: p.id, label: p.name }))];

  const values = await openForm({
    title: single ? 'Add task to Todoist' : `Add ${items.length} tasks to Todoist`,
    submitLabel: 'Create',
    intro: single ? undefined : 'One task will be created per selected book.',
    fields: [
      ...(single
        ? [
            { name: 'content', label: 'Task', value: preset.content, required: true, autofocus: true, hint: 'Markdown link syntax is supported.' },
            { name: 'description', label: 'Description', type: 'textarea', rows: 4, value: preset.description },
          ]
        : [{ name: 'contentTemplate', label: 'Task template', value: 'Read {title}', required: true, autofocus: true, hint: '{title}, {authors}, {year} are substituted.' }]),
      { name: 'projectId', label: 'Project', type: 'select', value: '', options: projectOptions },
      { name: 'dueString', label: 'Due', placeholder: 'today, next monday, in 3 days' },
      { name: 'priority', label: 'Priority', type: 'select', value: '1', options: [
        { value: '1', label: 'P4 (none)' }, { value: '2', label: 'P3' }, { value: '3', label: 'P2' }, { value: '4', label: 'P1' },
      ] },
    ],
  });
  if (!values) return null;

  const busy = showBusy('Creating task(s)…');
  const created = [];
  const failures = [];
  try {
    for (const item of items) {
      const base = single
        ? { content: values.content, description: values.description }
        : {
            content: values.contentTemplate
              .replace(/\{title\}/g, item.title)
              .replace(/\{authors\}/g, authorLabel(item))
              .replace(/\{year\}/g, item.year || ''),
            description: todoist.defaultTaskForItem(item, { progressPct: pct(itemProgress(item)) }).description,
          };
      try {
        const task = await todoist.createTask(cfg, {
          ...base,
          projectId: values.projectId || undefined,
          dueString: values.dueString || undefined,
          priority: Number(values.priority) || 1,
        });
        created.push(task);
        store.updateItem(item.id, { todoistTaskId: task?.id || null });
      } catch (err) {
        failures.push(`${item.title}: ${err.message}`);
      }
      busy.update(`Created ${created.length}/${items.length}…`);
    }
  } finally {
    busy.done();
  }

  if (failures.length) errorToast(new Error(failures.join('; ')), `Created ${created.length}, failed ${failures.length}`);
  else toast(`Created ${created.length} Todoist task(s).`, { type: 'success' });
  return created;
}

/** Right-clicking a Project or Group: "Finish <name>" straight into the Inbox. */
export async function promptTodoistTaskForContainer(name, kind) {
  const cfg = store.getSettings();
  if (!cfg.todoistApiKey) {
    toast('Add a Todoist API token in Settings first.', { type: 'error' });
    return null;
  }
  const preset = todoist.defaultTaskForContainer(name, kind);
  const values = await openForm({
    title: `Add ${kind} to Todoist`,
    submitLabel: 'Create in Inbox',
    intro: 'This lands in your Todoist Inbox.',
    fields: [
      { name: 'content', label: 'Task', value: preset.content, required: true, autofocus: true },
      { name: 'description', label: 'Description', type: 'textarea', rows: 3, value: preset.description },
      { name: 'dueString', label: 'Due', placeholder: 'today, next friday' },
    ],
  });
  if (!values) return null;
  try {
    const task = await todoist.createTask(cfg, {
      content: values.content,
      description: values.description,
      dueString: values.dueString || undefined,
    });
    toast('Added to your Todoist Inbox.', { type: 'success' });
    return task;
  } catch (err) {
    errorToast(err, 'Todoist');
    return null;
  }
}

/** Mirror a Project (and its Groups) into Todoist as a Project with Sections. */
export async function mirrorProjectToTodoist(projectId) {
  const cfg = store.getSettings();
  const state = store.getState();
  const project = state.projects[projectId];
  if (!project) return;
  if (!cfg.todoistApiKey) {
    toast('Add a Todoist API token in Settings first.', { type: 'error' });
    return;
  }
  const busy = showBusy('Mirroring to Todoist…');
  try {
    const tProject = await todoist.ensureProject(cfg, project.name);
    store.commit('link todoist project', (s) => {
      const p = s.projects[projectId];
      if (p) p.todoistProjectId = tProject.id;
    });
    let sections = 0;
    for (const groupId of project.groupOrder) {
      const g = store.getState().groups[groupId];
      if (!g) continue;
      busy.update(`Creating section “${g.name}”…`);
      const tSection = await todoist.ensureSection(cfg, g.name, tProject.id);
      store.commit('link todoist section', (s) => {
        const gg = s.groups[groupId];
        if (gg) gg.todoistSectionId = tSection.id;
      });
      sections += 1;
    }
    busy.done();
    toast(`Mirrored “${project.name}” with ${sections} section(s).`, { type: 'success' });
  } catch (err) {
    busy.done();
    errorToast(err, 'Todoist');
  }
}

async function safeList(fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn('Todoist list failed', err);
    return [];
  }
}

// ============================================================ move / copy

/** Searchable picker over every Group, headed by its Project. */
export function pickGroup({ title = 'Choose a group', excludeGroupIds = [] } = {}) {
  const state = store.getState();
  const rows = [];
  for (const projectId of state.projectOrder) {
    const project = state.projects[projectId];
    if (!project) continue;
    for (const groupId of project.groupOrder) {
      const group = state.groups[groupId];
      if (!group || excludeGroupIds.includes(groupId)) continue;
      rows.push({ id: groupId, label: group.name, sub: project.name });
    }
  }
  return pickFromList({ title, rows, emptyMessage: 'No other groups yet. Create one with the + at the end of the board.' });
}

export function pickProject({ title = 'Choose a project', excludeProjectIds = [] } = {}) {
  const state = store.getState();
  const rows = store.getState().projectOrder
    .filter((id) => !excludeProjectIds.includes(id))
    .map((id) => ({ id, label: state.projects[id]?.name || 'Untitled', sub: `${state.projects[id]?.groupOrder.length || 0} group(s)` }));
  return pickFromList({ title, rows, emptyMessage: 'No other projects yet.' });
}

export function pickFromList({ title, rows, emptyMessage }) {
  return openModal({
    title,
    render: (body, close) => {
      if (!rows.length) {
        body.appendChild(el('p', 'picker__empty', emptyMessage));
        return;
      }
      const search = document.createElement('input');
      search.type = 'text';
      search.className = 'picker__search';
      search.placeholder = 'Filter…';
      body.appendChild(search);

      const list = el('div', 'picker__list');
      body.appendChild(list);

      let active = 0;
      let filtered = rows;

      const paint = () => {
        list.replaceChildren();
        filtered.forEach((row, i) => {
          const btn = el('button', `picker__row${i === active ? ' is-active' : ''}`);
          btn.type = 'button';
          btn.append(el('span', 'picker__label', row.label), el('span', 'picker__sub', row.sub || ''));
          btn.addEventListener('click', () => close(row.id));
          btn.addEventListener('pointerenter', () => { active = i; });
          list.appendChild(btn);
        });
        if (!filtered.length) list.appendChild(el('p', 'picker__empty', 'No match.'));
      };

      const refilter = () => {
        const q = search.value.trim();
        filtered = !q
          ? rows
          : rows
              .map((r) => ({ r, s: Math.max(fuzzyScore(q, r.label), fuzzyScore(q, r.sub || '')) }))
              .filter((x) => x.s >= 0)
              .sort((a, b) => b.s - a.s)
              .map((x) => x.r);
        active = 0;
        paint();
      };

      search.addEventListener('input', refilter);
      search.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, filtered.length - 1); paint(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (filtered[active]) close(filtered[active].id); }
      });
      paint();
      setTimeout(() => search.focus(), 30);
    },
  });
}

export async function moveBooks(placementIds) {
  const state = store.getState();
  const fromGroups = new Set(placementIds.map((id) => state.placements[id]?.groupId).filter(Boolean));
  const targetId = await pickGroup({
    title: placementIds.length === 1 ? 'Move book to…' : `Move ${placementIds.length} books to…`,
    excludeGroupIds: fromGroups.size === 1 ? [...fromGroups] : [],
  });
  if (!targetId) return;
  store.batch(() => {
    for (const pid of placementIds) store.movePlacement(pid, targetId);
  });
  toast(`Moved to “${store.getState().groups[targetId]?.name}”.`, { type: 'success' });
}

export async function copyBooks(placementIds) {
  const targetId = await pickGroup({
    title: placementIds.length === 1 ? 'Copy book to…' : `Copy ${placementIds.length} books to…`,
  });
  if (!targetId) return;
  store.batch(() => {
    for (const pid of placementIds) store.duplicatePlacement(pid, targetId);
  });
  toast(`Linked copy placed in “${store.getState().groups[targetId]?.name}”. Edits stay in sync.`, { type: 'success' });
}

export function duplicateBooks(placementIds) {
  store.batch(() => {
    for (const pid of placementIds) store.duplicatePlacement(pid);
  });
  toast(placementIds.length === 1 ? 'Duplicated — edits stay in sync.' : `Duplicated ${placementIds.length} books.`, { type: 'success' });
}

export async function deleteBooks(placementIds) {
  const state = store.getState();
  const names = placementIds.map((id) => state.items[state.placements[id]?.itemId]?.title).filter(Boolean);
  const linked = placementIds.filter((id) => store.siblingPlacements(state, id).length > 1).length;
  const answer = await confirmDialog({
    title: placementIds.length === 1 ? 'Remove book?' : `Remove ${placementIds.length} books?`,
    message: linked
      ? `${linked} of these are linked copies — removing one leaves the others in place. Nothing is deleted from Zotero.`
      : `${names.slice(0, 3).join(', ')}${names.length > 3 ? `, and ${names.length - 3} more` : ''} will be removed from the board. Nothing is deleted from Zotero.`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!answer?.confirmed) return;
  store.batch(() => {
    for (const pid of placementIds) store.removePlacement(pid);
  });
  sel.pruneSelection(store.getState());
  toast('Removed from the board.', { type: 'success' });
}

export async function markReadFlow(placementIds) {
  const state = store.getState();
  const itemIds = [...new Set(placementIds.map((id) => state.placements[id]?.itemId).filter(Boolean))];
  const anyZotero = itemIds.some((id) => state.items[id]?.zoteroKey);
  const answer = await confirmDialog({
    title: itemIds.length === 1 ? 'Mark read' : `Mark ${itemIds.length} books read`,
    message: 'This archives the book in readerHelper. It stays in your Zotero library.',
    confirmLabel: 'Mark read',
    checkboxes: [{ name: 'tagZotero', label: `Also add the "${readTag()}" tag in Zotero`, value: anyZotero }],
  });
  if (!answer?.confirmed) return;
  await markItemsRead(itemIds, { tagZotero: answer.tagZotero });
}

// ============================================================ context menus

/** Menu for one card, or for the whole selection when the card is part of it. */
export function openBookMenu(x, y, placementId) {
  const state = store.getState();
  const selection = sel.getSelection();
  const ids = selection.includes(placementId) && selection.length > 1 ? selection : [placementId];
  const many = ids.length > 1;
  const item = state.items[state.placements[placementId]?.itemId];
  if (!item) return;
  const itemIds = [...new Set(ids.map((id) => state.placements[id]?.itemId).filter(Boolean))];

  const items = [
    { heading: many ? `${ids.length} books selected` : truncate(item.title, 42) },
    !many && { label: 'Open book page', onClick: () => window.dispatchEvent(new CustomEvent('rh:open-item', { detail: { itemId: item.id } })) },
    !many && opener.hasZoteroLink(item) && { label: 'Open in Zotero', onClick: () => reportOpen(opener.openInZotero(item)) },
    !many && opener.hasPdfLink(item) && { label: 'Open PDF', hint: item.currentPage ? `p. ${opener.resumePage(item)}` : '', onClick: () => reportOpen(opener.openLocalPdf(item, store.getSettings())) },
    { separator: true },
    { label: many ? `Log reading for ${ids.length}…` : 'Log reading…', onClick: () => (many ? logReadingForMany(itemIds) : promptReading(item.id)) },
    {
      label: 'Reading mode',
      submenu: () => [
        { label: '— none —', onClick: () => setTagFor(itemIds, null) },
        ...TAGS.map((t) => ({ label: t + (item.tag === t && !many ? '  ✓' : ''), onClick: () => setTagFor(itemIds, t) })),
      ],
    },
    { separator: true },
    { label: 'Add task to Todoist…', onClick: () => promptTodoistTaskForItem(itemIds) },
    { label: many ? 'Duplicate all' : 'Duplicate', hint: 'linked copy', onClick: () => duplicateBooks(ids) },
    { label: 'Move to…', onClick: () => moveBooks(ids) },
    { label: 'Copy to…', hint: 'linked copy', onClick: () => copyBooks(ids) },
    { separator: true },
    { label: many ? `Mark ${itemIds.length} read` : 'Mark read', onClick: () => markReadFlow(ids) },
    !many && { label: 'Edit details…', onClick: () => promptEditBook(item.id) },
    !many && item.localPdfPath && { label: 'Copy PDF path', onClick: () => { opener.copyText(item.localPdfPath); toast('Path copied.'); } },
    { separator: true },
    { label: many ? `Remove ${ids.length} from board` : 'Remove from board', danger: true, onClick: () => deleteBooks(ids) },
  ].filter(Boolean);

  openContextMenu(x, y, items);
}

async function logReadingForMany(itemIds) {
  const values = await openForm({
    title: `Log reading for ${itemIds.length} books`,
    intro: 'The same phrase is applied to each selected book.',
    submitLabel: 'Log',
    fields: [{ name: 'phrase', label: 'How much?', placeholder: '30 pages · one chapter · halfway', required: true, autofocus: true }],
  });
  if (!values) return;
  for (const id of itemIds) await applyReading(id, values.phrase);
}

function setTagFor(itemIds, tag) {
  store.batch(() => {
    for (const id of itemIds) store.setItemTag(id, tag);
  });
}

export function openGroupMenu(x, y, groupId) {
  const state = store.getState();
  const group = state.groups[groupId];
  if (!group) return;
  openContextMenu(x, y, [
    { heading: truncate(group.name, 42) },
    { label: 'Rename', onClick: () => window.dispatchEvent(new CustomEvent('rh:rename-group', { detail: { groupId } })) },
    { label: 'Add book…', onClick: () => promptAddBook(groupId) },
    { separator: true },
    { label: 'Add to Todoist…', hint: 'Inbox', onClick: () => promptTodoistTaskForContainer(group.name, 'group') },
    { label: 'Duplicate', onClick: () => { store.duplicateGroup(groupId); toast('Group duplicated.'); } },
    {
      label: 'Move to…',
      onClick: async () => {
        const target = await pickProject({ title: 'Move group to project…', excludeProjectIds: [group.projectId] });
        if (target) { store.moveGroup(groupId, target); toast('Group moved.'); }
      },
    },
    {
      label: 'Copy to…',
      onClick: async () => {
        const target = await pickProject({ title: 'Copy group to project…' });
        if (target) { store.copyGroup(groupId, target); toast('Group copied — books stay linked.'); }
      },
    },
    { separator: true },
    { label: 'Delete group', danger: true, onClick: () => deleteGroupFlow(groupId) },
  ]);
}

export function openProjectMenu(x, y, projectId) {
  const state = store.getState();
  const project = state.projects[projectId];
  if (!project) return;
  openContextMenu(x, y, [
    { heading: truncate(project.name, 42) },
    { label: 'Rename', onClick: () => window.dispatchEvent(new CustomEvent('rh:rename-project', { detail: { projectId } })) },
    { label: 'Add group…', onClick: () => window.dispatchEvent(new CustomEvent('rh:add-group', { detail: { projectId } })) },
    { separator: true },
    { label: 'Add to Todoist…', hint: 'Inbox', onClick: () => promptTodoistTaskForContainer(project.name, 'project') },
    { label: 'Mirror to Todoist', hint: 'project + sections', onClick: () => mirrorProjectToTodoist(projectId) },
    { label: 'Duplicate', onClick: () => { store.duplicateProject(projectId); toast('Project duplicated.'); } },
    { separator: true },
    { label: 'Delete project', danger: true, onClick: () => deleteProjectFlow(projectId) },
  ]);
}

export async function deleteGroupFlow(groupId) {
  const state = store.getState();
  const group = state.groups[groupId];
  if (!group) return;
  const count = group.placementOrder.length;
  const answer = await confirmDialog({
    title: `Delete “${group.name}”?`,
    message: `${count} book(s) will be removed from the board. The linked Zotero collection is not touched.`,
    confirmLabel: 'Delete group',
    danger: true,
    checkboxes: group.todoistSectionId
      ? [{ name: 'deleteTodoist', label: 'Also delete the matching Todoist section', value: false }]
      : [],
  });
  if (!answer?.confirmed) return;
  if (answer.deleteTodoist && group.todoistSectionId) {
    try {
      await todoist.deleteSection(store.getSettings(), group.todoistSectionId);
    } catch (err) {
      errorToast(err, 'Todoist section not deleted');
    }
  }
  store.deleteGroup(groupId);
  sel.pruneSelection(store.getState());
  toast('Group deleted.');
}

export async function deleteProjectFlow(projectId) {
  const state = store.getState();
  const project = state.projects[projectId];
  if (!project) return;
  const answer = await confirmDialog({
    title: `Delete “${project.name}”?`,
    message: `Its ${project.groupOrder.length} group(s) and their books leave the board. Your Zotero collection is not deleted.`,
    confirmLabel: 'Delete project',
    danger: true,
    checkboxes: project.todoistProjectId
      ? [{ name: 'deleteTodoist', label: 'Also delete the matching Todoist project', value: false }]
      : [],
  });
  if (!answer?.confirmed) return;
  if (answer.deleteTodoist && project.todoistProjectId) {
    try {
      await todoist.deleteProject(store.getSettings(), project.todoistProjectId);
    } catch (err) {
      errorToast(err, 'Todoist project not deleted');
    }
  }
  store.deleteProject(projectId);
  sel.pruneSelection(store.getState());
  toast('Project deleted.');
}

// ============================================================ helpers

export function reportOpen(result) {
  if (!result) return;
  toast(result.message, { type: result.ok ? 'info' : 'error' });
}

export function splitAuthors(s) {
  return String(s || '')
    .split(/[,;]|\sand\s|&/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}


