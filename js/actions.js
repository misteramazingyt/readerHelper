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
import * as metadata from './metadata.js';
import * as bib from './bibliography.js';
import * as push from './zotero-push.js';
import * as goodreads from './goodreads.js';
import * as gi from './goodreads-ingest.js';
import { openBookSearch } from './booksearch.js';
import { AUTH } from './auth-config.js';
import { parseReading, resolveReading, prettyField, pct, fuzzyScore } from './nlp.js';
import * as sel from './selection.js';

const READ_TAG_DEFAULT = 'read';

// =============================================================== book dialogs

/**
 * The "+" at the bottom of a column.
 *
 * The identifier field resolves itself: paste a DOI, ISBN, arXiv id, or a
 * Google Books / archive.org / Open Library link and the rest fills in. Only
 * blank fields are written, so anything typed by hand survives a later lookup.
 */
export async function promptAddBook(groupId) {
  let resolved = null;      // the record the fields were filled from
  let lastLookedUp = '';    // avoids re-running for the same text
  let inFlight = null;      // so a fast typist cannot race two lookups

  const runLookup = async (raw, api, { quiet = false } = {}) => {
    const text = String(raw || '').trim();
    if (!text || text === lastLookedUp) return resolved;
    const { kind, label } = metadata.detect(text);
    if (kind === 'empty' || kind === 'unknown') return null;
    // Free text is only searched deliberately, not while still being typed.
    if (kind === 'query' && quiet) {
      api.setStatus('Press Enter to search for this title.', 'info');
      return null;
    }

    lastLookedUp = text;
    api.setStatus(`Looking up ${label}…`, 'busy');
    inFlight?.abort?.();
    const controller = new AbortController();
    inFlight = controller;

    try {
      const { record, candidates } = await metadata.resolve(text, {
        signal: controller.signal,
        // Adds Google Scholar to title searches, but only if the worker has a
        // SerpAPI key; without one it answers 501 and is quietly skipped.
        scholarUrl: AUTH.workerUrl || null,
        // Goodreads pages are read through the same worker.
        workerUrl: AUTH.workerUrl || null,
      });
      let chosen = record;
      if (!chosen && candidates.length) {
        api.setStatus(`${candidates.length} matches — choose one.`, 'info');
        chosen = await pickCandidate(candidates);
        if (!chosen) {
          api.setStatus('No match chosen.', 'info');
          return null;
        }
      }
      if (!chosen) {
        api.setStatus('Nothing found.', 'warn');
        return null;
      }

      resolved = chosen;
      const filled = api.fillEmpty({
        title: [chosen.title, chosen.subtitle].filter(Boolean).join(': '),
        authors: chosen.authors.join(', '),
        year: chosen.year,
        totalPages: chosen.totalPages,
        url: chosen.url,
      });
      api.setStatus(
        filled.length
          ? `Found via ${chosen.source}: ${truncate(chosen.title, 52)}`
          : `Found via ${chosen.source}, but every field is already filled in.`,
        'ok',
      );
      return chosen;
    } catch (err) {
      if (err.name === 'AbortError') return null;
      lastLookedUp = '';   // let a retry happen
      api.setStatus(err.message, 'error');
      return null;
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  };

  const values = await openForm({
    title: 'Add a book',
    submitLabel: 'Add',
    toolbar: [
      {
        label: 'Search Goodreads',
        accent: 'goodreads',
        title: 'Search Goodreads and add one or many',
        onClick: (api) => searchAndAdd({
          groupId,
          source: 'Goodreads',
          seed: api.get('identifier') || api.get('title'),
          closeForm: () => api.close(null),
        }),
      },
      {
        label: 'Search Zotero',
        accent: 'zotero',
        title: 'Search your Zotero library and add one or many',
        onClick: (api) => searchAndAdd({
          groupId,
          source: 'Zotero',
          seed: api.get('identifier') || api.get('title'),
          closeForm: () => api.close(null),
        }),
      },
    ],
    intro: 'Paste a DOI, ISBN, arXiv id, or a Goodreads / Google Books / archive.org / Open Library link — the rest fills itself in. Or type a title and press Enter to search. Everything can also be entered by hand.',
    beforeSubmit: async (v, api) => {
      // The old behaviour here was to refuse with "Title is required" while an
      // identifier sat unresolved in the field above. Resolve it instead.
      if (!v.title && v.identifier) await runLookup(v.identifier, api, { quiet: false });
      return true;
    },
    fields: [
      {
        name: 'identifier',
        label: 'DOI, ISBN, arXiv, or a book link',
        placeholder: '9780804011662 · 10.1086/230209 · goodreads.com/book/show/… · archive.org/details/…',
        autofocus: true,
        onInput: (value, api) => runLookup(value, api, { quiet: true }),
      },
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
        // Lookup is automatic; this is for retrying after a rate limit, and
        // for forcing a title search without pressing Enter in the field.
        label: 'Look up',
        onClick: async (readValues, _close, _controls, api) => {
          lastLookedUp = '';
          await runLookup(readValues().identifier, api, { quiet: false });
        },
      },
    ],
  });
  if (!values) return null;

  // Anything the lookup found but the form has no field for is worth keeping.
  const detected = metadata.detect(values.identifier || '');
  const created = store.addItem(groupId, {
    title: values.title,
    authors: splitAuthors(values.authors),
    year: values.year || null,
    doi: resolved?.doi || (detected.kind === 'doi' ? detected.value : null),
    isbn: resolved?.isbn || (detected.kind === 'isbn' ? detected.value : null),
    url: values.url || resolved?.url || null,
    totalPages: values.totalPages || null,
    totalChapters: values.totalChapters || null,
    tag: values.tag || null,
    itemType: resolved?.itemType || 'book',
    publisher: resolved?.publisher || null,
    container: resolved?.container || null,
    pages: resolved?.pages || null,
    volume: resolved?.volume || null,
    issue: resolved?.issue || null,
    abstract: resolved?.abstract || null,
    goodreadsId: resolved?.goodreadsId || (detected.kind === 'goodreads' ? detected.value : null),
    goodreadsRating: resolved?.goodreadsRating ?? null,
    // A Zotero search result arrives already linked to the library.
    zoteroKey: resolved?.zoteroKey || null,
    zoteroLibrary: resolved?.zoteroLibrary || null,
    citekey: resolved?.citekey || null,
    zoteroVersion: resolved?.zoteroVersion ?? null,
    pdfAttachmentKey: resolved?.pdfAttachmentKey || null,
    localPdfPath: resolved?.localPdfPath || null,
  });
  toast(`Added “${truncate(values.title, 44)}”.`, { type: 'success' });
  return created;
}

/**
 * Live search over Zotero or Goodreads, with multi-select, adding straight to
 * a group.
 *
 * Zotero is filtered locally from the cached library index, so it narrows as
 * you type over thousands of items; Goodreads has to be asked, so it is
 * debounced. Either way the rows that come back are thin — enough to read and
 * choose — and full details are fetched only for what was actually picked.
 */
async function searchAndAdd({ groupId, source, closeForm, seed = '' }) {
  const cfg = store.getSettings();
  const isZotero = source === 'Zotero';

  if (isZotero && (!cfg.zoteroApiKey || !cfg.zoteroUserId)) {
    toast('Add your Zotero API key and user ID in Settings first.', { type: 'error' });
    return null;
  }

  let index = null;
  const picked = await openBookSearch({
    title: `Search ${source}`,
    source,
    seed,
    mode: isZotero ? 'local' : 'remote',
    prepare: isZotero
      ? async (report) => { index = await push.loadIndex(store.getSettings(), { onProgress: report }); }
      : null,
    search: async (q, { signal }) => {
      if (isZotero) return push.searchIndex(index, q);
      const rows = await goodreads.searchBooks(AUTH.workerUrl, q, { signal });
      return { rows };
    },
    toDisplay: (row) => (isZotero
      ? {
        title: row.displayTitle || row.title,
        authors: row.displayAuthors || [],
        date: row.year || (row.date || '').slice(0, 4),
        extra: row.type === 'book' ? '' : row.type,
      }
      : {
        title: row.title,
        authors: row.authors || [],
        date: row.year || '',
        extra: row.averageRating
          ? `★${row.averageRating}${row.ratingsCount ? ` (${row.ratingsCount.toLocaleString()})` : ''}`
          : '',
      }),
  });

  if (!picked?.length) return null;

  const busy = showBusy(`Fetching ${picked.length} book(s)…`);
  try {
    let records;
    if (isZotero) {
      // The index holds only what search needs; get the real records now.
      const rows = await zotero.fetchItemsByKeys(store.getSettings(), picked.map((p) => p.key));
      records = await Promise.all(rows.map((r) => zotero.toItemFields(store.getSettings(), r, { withAttachments: false })));
    } else {
      records = [];
      for (const [i, row] of picked.entries()) {
        busy.update(`Fetching ${i + 1}/${picked.length} from Goodreads…`);
        try {
          // The search row has no ISBN or page count; the book page does.
          records.push(await goodreads.fetchBook(AUTH.workerUrl, row.goodreadsId));
        } catch {
          records.push(row);   // the search row is still worth adding
        }
      }
    }

    const created = store.batch(() => records.map((fields) => store.addItem(groupId, {
      ...fields,
      itemType: fields.itemType || 'book',
    })));
    busy.done();
    toast(
      `Added ${created.length} book${created.length === 1 ? '' : 's'} from ${source}.`,
      { type: 'success' },
    );
    closeForm?.();
    return created;
  } catch (err) {
    busy.done();
    errorToast(err, source);
    return null;
  }
}

/** Let the user choose when a title search returns several plausible works. */
function pickCandidate(candidates) {
  return openModal({
    title: 'Which one?',
    width: 'wide',
    render: (body, close) => {
      const list = el('div', 'picker__list picker__list--tall');
      candidates.forEach((c, i) => {
        const btn = el('button', `picker__row candidate${i === 0 ? ' is-active' : ''}`);
        btn.type = 'button';
        const main = el('div', 'candidate__main');
        main.append(
          el('span', 'candidate__title', [c.title, c.subtitle].filter(Boolean).join(': ')),
          el('span', 'candidate__meta', [
            (c.authors || []).slice(0, 3).join(', '),
            c.year,
            c.container || c.publisher,
            c.totalPages ? `${c.totalPages} pp` : null,
            c.isbn ? `ISBN ${c.isbn}` : null,
            c.averageRating ? `★ ${c.averageRating}${c.ratingsCount ? ` (${c.ratingsCount.toLocaleString()})` : ''}` : null,
          ].filter(Boolean).join(' · ')),
        );
        btn.append(main, el('span', 'candidate__source', c.source));
        btn.addEventListener('click', () => close(c));
        list.appendChild(btn);
      });
      body.appendChild(list);

      const none = el('button', 'btn btn--ghost', 'None of these — enter by hand');
      none.type = 'button';
      none.addEventListener('click', () => close(null));
      body.appendChild(none);
    },
  });
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

// ====================================================== bibliography export

/** Distinct, non-archived items behind a set of placements. */
export function itemsOfPlacements(placementIds) {
  const state = store.getState();
  const seen = new Set();
  const out = [];
  for (const pid of placementIds) {
    const p = state.placements[pid];
    const item = p && state.items[p.itemId];
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function itemsOfGroup(groupId, { includeArchived = false } = {}) {
  const state = store.getState();
  const g = state.groups[groupId];
  if (!g) return [];
  return itemsOfPlacements(g.placementOrder).filter((i) => includeArchived || !i.archived);
}

export function itemsOfProject(projectId, { includeArchived = false } = {}) {
  const state = store.getState();
  const prj = state.projects[projectId];
  if (!prj) return [];
  const seen = new Set();
  const out = [];
  for (const gid of prj.groupOrder) {
    for (const item of itemsOfGroup(gid, { includeArchived })) {
      if (seen.has(item.id)) continue;   // a linked copy in two groups counts once
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/**
 * The export dialog: pick a format, see it, copy or download it. Regenerates
 * on every format change so what is on screen is always what gets saved.
 */
export async function exportBibliography(items, label = 'bibliography') {
  if (!items.length) {
    toast('Nothing to export.', { type: 'error' });
    return null;
  }
  const settings = store.getSettings();
  const canZotero = Boolean(settings.zoteroApiKey && settings.zoteroUserId)
    && items.some((i) => i.zoteroKey);

  return openModal({
    title: `Export bibliography — ${items.length} item${items.length === 1 ? '' : 's'}`,
    width: 'wide',
    render: (body, close) => {
      const controls = el('div', 'export__controls');

      const formatSel = document.createElement('select');
      formatSel.className = 'export__format';
      for (const [key, spec] of Object.entries(bib.FORMATS)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = spec.label;
        formatSel.appendChild(opt);
      }
      formatSel.value = settings.bibFormat || 'bibtex';

      const zoteroWrap = el('label', 'export__toggle');
      const zoteroBox = document.createElement('input');
      zoteroBox.type = 'checkbox';
      zoteroBox.checked = canZotero;
      zoteroBox.disabled = !canZotero;
      zoteroWrap.append(zoteroBox, el('span', null, canZotero
        ? 'Use Zotero for linked items'
        : 'Use Zotero (no linked items, or not configured)'));

      const formatLabel = el('label', 'export__label', 'Format');
      formatLabel.htmlFor = 'export-format';
      formatSel.id = 'export-format';
      controls.append(formatLabel, formatSel, zoteroWrap);
      body.appendChild(controls);

      const notes = el('div', 'export__notes');
      notes.hidden = true;
      body.appendChild(notes);

      const output = document.createElement('textarea');
      output.className = 'export__output';
      output.rows = 16;
      output.spellcheck = false;
      output.readOnly = true;
      body.appendChild(output);

      const actionsRow = el('div', 'form__actions');
      const copyBtn = el('button', 'btn btn--ghost', 'Copy');
      copyBtn.type = 'button';
      const downloadBtn = el('button', 'btn btn--primary', 'Download');
      downloadBtn.type = 'button';
      const closeBtn = el('button', 'btn btn--ghost', 'Close');
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', () => close(null));
      actionsRow.append(el('div', 'form__spacer'), closeBtn, copyBtn, downloadBtn);
      body.appendChild(actionsRow);

      let current = { text: '', format: formatSel.value };
      let generation = 0;

      const regenerate = async () => {
        const mine = (generation += 1);
        const format = formatSel.value;
        output.value = 'Generating…';
        notes.hidden = true;
        try {
          const result = await bib.buildBibliography(items, {
            format,
            settings,
            useZotero: zoteroBox.checked,
            onProgress: (m) => { if (mine === generation) output.value = m; },
          });
          if (mine !== generation) return;   // a later format change won
          current = result;
          output.value = result.text || '(empty)';
          if (result.notes.length) {
            notes.hidden = false;
            notes.textContent = result.notes.join(' ');
          }
        } catch (err) {
          if (mine !== generation) return;
          output.value = '';
          notes.hidden = false;
          notes.textContent = err.message;
        }
      };

      formatSel.addEventListener('change', () => {
        store.saveSettings({ bibFormat: formatSel.value });
        regenerate();
      });
      zoteroBox.addEventListener('change', regenerate);

      copyBtn.addEventListener('click', () => {
        opener.copyText(current.text);
        toast('Bibliography copied.', { type: 'success' });
      });

      downloadBtn.addEventListener('click', () => {
        const spec = bib.FORMATS[current.format] || bib.FORMATS.bibtex;
        const blob = new Blob([current.text], { type: `${spec.mime};charset=utf-8` });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = bib.filenameFor(label, current.format);
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast(`Saved ${bib.filenameFor(label, current.format)}.`, { type: 'success' });
      });

      regenerate();
    },
  });
}

// ====================================================== push back to Zotero

/**
 * One push entry per placement, not per book: a linked copy sitting in two
 * groups should be filed into both Zotero subcollections, which is what
 * mirroring the board actually means.
 */
export function pushEntriesForPlacements(placementIds) {
  const state = store.getState();
  const seen = new Set();
  const out = [];
  for (const pid of placementIds) {
    const p = state.placements[pid];
    const item = p && state.items[p.itemId];
    const group = p && state.groups[p.groupId];
    const project = group && state.projects[group.projectId];
    if (!item || !group || !project || item.archived) continue;
    const dedupe = JSON.stringify([item.id, group.id]);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ item, projectName: project.name, groupName: group.name });
  }
  return out;
}

export function pushEntriesForGroup(groupId) {
  const g = store.getState().groups[groupId];
  return g ? pushEntriesForPlacements(g.placementOrder) : [];
}

export function pushEntriesForProject(projectId) {
  const state = store.getState();
  const prj = state.projects[projectId];
  if (!prj) return [];
  return pushEntriesForPlacements(prj.groupOrder.flatMap((gid) => state.groups[gid]?.placementOrder || []));
}

/**
 * The push dialog. Three states in one modal: choose, run, report.
 *
 * A preview runs the whole matching pass without writing, so what is about to
 * happen to the library can be read before it happens.
 */
export async function promptPushToZotero(entries, label = '') {
  const cfg = store.getSettings();
  if (!cfg.zoteroApiKey || !cfg.zoteroUserId) {
    toast('Add your Zotero API key and user ID in Settings first.', { type: 'error', timeout: 5000 });
    return null;
  }
  if (!entries.length) {
    toast('No books to push.', { type: 'error' });
    return null;
  }

  const root = cfg.zoteroProjectsRoot || push.DEFAULT_ROOT;
  const paths = [...new Set(entries.map((e) => [e.projectName, e.groupName].filter(Boolean).join(' / ')))];

  return openModal({
    title: `Add to Zotero — ${entries.length} book${entries.length === 1 ? '' : 's'}`,
    width: 'wide',
    render: (body, close) => {
      const intro = el('p', 'form__intro');
      intro.textContent = `Files into ${root} / ${paths.length === 1 ? paths[0] : `${paths.length} collections`}. `
        + 'Books already in your library are filed into the collection rather than added twice.';
      body.appendChild(intro);

      const tree = el('pre', 'push__tree');
      tree.textContent = [
        root,
        ...paths.slice(0, 8).map((p) => `  └─ ${p.replace(' / ', '\n       └─ ')}`),
        paths.length > 8 ? `  … and ${paths.length - 8} more` : null,
      ].filter(Boolean).join('\n');
      body.appendChild(tree);

      const replaceWrap = el('label', 'confirm__checkbox');
      const replaceBox = document.createElement('input');
      replaceBox.type = 'checkbox';
      replaceWrap.append(replaceBox, el('span', null,
        'Also remove these items from their other Zotero collections (a true move)'));
      body.appendChild(replaceWrap);

      const status = el('div', 'form__status');
      status.hidden = true;
      body.appendChild(status);

      const results = el('div', 'push__results');
      results.hidden = true;
      body.appendChild(results);

      const actionsRow = el('div', 'form__actions');
      const spacer = el('div', 'form__spacer');
      const cancel = el('button', 'btn btn--ghost', 'Cancel');
      cancel.type = 'button';
      const preview = el('button', 'btn btn--ghost', 'Preview');
      preview.type = 'button';
      const go = el('button', 'btn btn--primary', 'Add to Zotero');
      go.type = 'button';
      actionsRow.append(spacer, cancel, preview, go);
      body.appendChild(actionsRow);

      cancel.addEventListener('click', () => close(null));

      const setStatus = (message, kind = 'busy') => {
        status.hidden = !message;
        status.textContent = message || '';
        status.className = `form__status is-${kind}`;
      };

      const run = async (dryRun) => {
        preview.disabled = true;
        go.disabled = true;
        results.hidden = true;
        try {
          const report = await push.pushToZotero(store.getSettings(), entries, {
            replaceCollections: replaceBox.checked,
            dryRun,
            onProgress: (m) => setStatus(m, 'busy'),
          });
          setStatus(
            dryRun ? 'Preview only — nothing was written.' : 'Done.',
            dryRun ? 'info' : 'ok',
          );
          renderReport(results, report, dryRun);
          results.hidden = false;

          if (!dryRun) {
            // Remember the Zotero keys, so the next push recognises its own work.
            store.batch(() => {
              for (const row of [...report.created, ...report.filed]) {
                if (row.key && !row.item.zoteroKey) store.updateItem(row.item.id, { zoteroKey: row.key });
              }
            });
            const n = report.created.length + report.filed.length;
            toast(
              `Zotero: ${report.created.length} added, ${report.filed.length} filed`
              + (report.alreadyThere.length ? `, ${report.alreadyThere.length} already there` : '')
              + (report.failed.length ? `, ${report.failed.length} failed` : ''),
              { type: report.failed.length ? 'error' : 'success', timeout: 6000 },
            );
            go.textContent = 'Done';
            cancel.textContent = 'Close';
            if (!report.failed.length && n >= 0) go.disabled = true;
            preview.disabled = true;
            return;
          }
        } catch (err) {
          setStatus(err.message, 'error');
          errorToast(err, 'Zotero push');
        } finally {
          if (dryRun) {
            preview.disabled = false;
            go.disabled = false;
          }
        }
      };

      preview.addEventListener('click', () => run(true));
      go.addEventListener('click', () => run(false));
    },
  });
}

function renderReport(host, report, dryRun) {
  host.replaceChildren();
  const verb = dryRun ? 'would be' : 'were';

  const section = (title, rows, describe) => {
    if (!rows.length) return;
    const wrap = el('div', 'push__section');
    wrap.appendChild(el('h4', 'push__heading', `${title} (${rows.length})`));
    const list = el('ul', 'push__list');
    for (const row of rows.slice(0, 40)) {
      const li = el('li', 'push__row');
      li.append(
        el('span', 'push__title', truncate(row.item.title, 58)),
        el('span', 'push__detail', describe(row)),
      );
      list.appendChild(li);
    }
    if (rows.length > 40) list.appendChild(el('li', 'push__row', `… and ${rows.length - 40} more`));
    wrap.appendChild(list);
    host.appendChild(wrap);
  };

  if (report.createdCollections.length) {
    const names = report.createdCollections.map((c) => c.name).join(', ');
    host.appendChild(el('p', 'push__note', `New collection(s) ${verb} created: ${names}`));
  }

  section(dryRun ? 'Would be added as new items' : 'Added as new items', report.created, (r) => r.where);
  section(
    dryRun ? 'Already in your library — would be filed' : 'Already in your library — filed',
    report.filed,
    (r) => `${r.reason} → ${r.where}${r.removedFrom?.length ? ` (removed from ${r.removedFrom.length} other)` : ''}`,
  );
  section('Already in that collection — nothing to do', report.alreadyThere, (r) => r.reason);
  section('Failed', report.failed, (r) => r.message);

  if (!host.children.length) host.appendChild(el('p', 'push__note', 'Nothing to do — everything is already where it should be.'));
}

// ================================================================ Goodreads

/**
 * Import from Goodreads.
 *
 * Two routes, because Goodreads left exactly two open: the library CSV export
 * (complete, private shelves included, no setup) and the per-shelf RSS feed
 * (live and repeatable, but only for a public profile, and only through the
 * worker since goodreads.com sends no CORS headers).
 */
export async function promptGoodreadsImport() {
  const cfg = store.getSettings();
  let csvBooks = null;
  let csvName = '';

  const values = await openForm({
    title: 'Import from Goodreads',
    submitLabel: 'Import',
    width: 'wide',
    intro: 'Goodreads retired its API in 2020, so there is no key to paste. Either upload the CSV it still exports, or sync a shelf from a public profile.',
    fields: [
      {
        name: 'projectName',
        label: 'Import into project',
        value: gi.DEFAULT_PROJECT,
        required: true,
        hint: 'Reused if a project of this name already exists.',
      },
      {
        name: 'groupBy',
        label: 'Make groups from',
        type: 'select',
        value: 'shelf',
        options: [
          { value: 'shelf', label: 'Reading status — To read / Reading now / Read' },
          { value: 'shelves', label: 'Your shelves — a book on three shelves lands in three groups' },
          { value: 'single', label: 'One group for everything' },
        ],
      },
      { name: 'shelves', label: 'Shelves to sync (RSS)', value: cfg.goodreadsShelves || 'read, currently-reading, to-read' },
      {
        name: 'userId',
        label: 'Goodreads user ID (RSS only)',
        value: cfg.goodreadsUserId,
        hint: 'The digits in goodreads.com/user/show/12345678-name. Leave blank if you are uploading a CSV.',
      },
    ],
    extraActions: [
      {
        label: 'Choose CSV file…',
        onClick: async (_readValues, _close, _controls, api) => {
          const file = await pickFile('.csv,text/csv');
          if (!file) return;
          api.setStatus(`Reading ${file.name}…`, 'busy');
          try {
            const { books, error } = goodreads.parseLibraryCsv(await file.text());
            if (error) {
              api.setStatus(error, 'error');
              csvBooks = null;
              return;
            }
            csvBooks = books;
            csvName = file.name;
            const shelved = new Set(books.map((b) => b.goodreadsShelf).filter(Boolean));
            api.setStatus(
              `${books.length} books in ${file.name}${shelved.size ? ` across ${shelved.size} reading states` : ''}. Press Import.`,
              'ok',
            );
          } catch (err) {
            api.setStatus(`Could not read that file: ${err.message}`, 'error');
          }
        },
      },
    ],
    validate: (v) => {
      if (!csvBooks && !v.userId) {
        return { userId: 'Either choose a CSV file, or give a user ID to sync a shelf.' };
      }
      return null;
    },
  });
  if (!values) return null;

  const busy = showBusy('Importing from Goodreads…');
  try {
    let books = csvBooks;
    let source = csvName;

    if (!books) {
      // RSS route: one request per shelf, through the worker.
      const shelves = String(values.shelves || 'read')
        .split(',').map((s) => s.trim()).filter(Boolean);
      books = [];
      for (const shelf of shelves) {
        const res = await goodreads.fetchShelf(AUTH.workerUrl, values.userId, shelf, {
          onProgress: (m) => busy.update(m),
        });
        if (res.warning && !res.books.length) {
          busy.done();
          toast(res.warning, { type: 'error', timeout: 7000 });
          return null;
        }
        // parseShelfRss already stamps the shelf on each book, and uses it to
        // decide what counts as finished.
        books.push(...res.books);
      }
      source = `${shelves.length} shelf/shelves`;
      store.saveSettings({ goodreadsUserId: values.userId, goodreadsShelves: values.shelves });
    }

    if (!books.length) {
      busy.done();
      toast('Nothing to import — no books came back.', { type: 'error' });
      return null;
    }

    busy.update(`Placing ${books.length} books…`);
    const entries = gi.planGroups(books, {
      groupBy: values.groupBy,
      defaultGroup: gi.UNSHELVED,
    });
    const report = store.commit('import from goodreads', (s) => gi.applyGoodreads(s, entries, {
      projectName: values.projectName,
    }));
    store.setActiveProject(report.projectId);
    busy.done();

    toast(
      `Goodreads (${source}): ${report.added} new, ${report.linked} already here`
      + (report.groups ? `, ${report.groups} group(s) created` : ''),
      { type: 'success', timeout: 7000 },
    );
    return report;
  } catch (err) {
    busy.done();
    errorToast(err, 'Goodreads import');
    return null;
  }
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
    input.click();
  });
}

/**
 * Produce a CSV in the shape Goodreads' importer accepts.
 *
 * This is the write direction, and it is a file rather than a request because
 * uploading at goodreads.com/review/import is the only route they still offer.
 */
export async function exportForGoodreads(entries, label = 'readerHelper') {
  if (!entries.length) {
    toast('Nothing to send to Goodreads.', { type: 'error' });
    return null;
  }
  const withIsbn = entries.filter((e) => e.item.isbn).length;

  const values = await openForm({
    title: `Add ${entries.length} book${entries.length === 1 ? '' : 's'} to Goodreads`,
    submitLabel: 'Download CSV',
    width: 'wide',
    intro: 'Goodreads has no write API, so this produces the CSV their importer takes. Either upload it yourself, or let the local bot do it — see README, Goodreads.',
    fields: [
      {
        name: 'autoUpload',
        label: 'Upload it for me',
        type: 'checkbox',
        value: Boolean(store.getSettings().goodreadsAutoUpload),
        hint: 'Hands the file to the local uploader (tools/goodreads_upload.mjs). Needs the readerhelper:// handler installed and one manual sign-in.',
      },
      {
        name: 'shelfFromGroup',
        label: 'Shelve each book under its group name',
        type: 'checkbox',
        value: true,
        hint: 'Group names become Goodreads shelves, lowercased and hyphenated.',
      },
      { name: 'markRead', label: 'Put finished books on the "read" shelf', type: 'checkbox', value: true },
      { name: 'includeReviews', label: 'Include your notes as the review', type: 'checkbox', value: false },
      {
        name: 'note',
        type: 'static',
        label: 'With an ISBN',
        value: `${withIsbn} of ${entries.length} — Goodreads matches on ISBN first, then title and author.`,
      },
    ],
  });
  if (!values) return null;

  const rows = entries.map(({ item, groupName }) => ({
    item,
    shelves: values.shelfFromGroup && groupName ? [goodreads.toShelfName(groupName)] : [],
  }));
  const csv = goodreads.toImportCsv(rows, {
    includeReviews: values.includeReviews,
    markRead: values.markRead,
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `goodreads-${goodreads.toShelfName(label)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  store.saveSettings({ goodreadsAutoUpload: Boolean(values.autoUpload) });

  if (values.autoUpload) {
    // The download lands in the browser's own folder, which the page cannot
    // read; the uploader is told the filename and finds it there itself.
    opener.runLocalAction('goodreads-upload', { name: a.download });
    toast(
      `Saved ${a.download} and asked the local uploader to send it. `
      + 'If nothing happens, the handler or the sign-in is missing — see README.',
      { type: 'info', timeout: 9000 },
    );
  } else {
    toast(`Saved ${a.download}. Upload it at goodreads.com/review/import.`, { type: 'success', timeout: 8000 });
  }
  return csv;
}

/** Entries for the Goodreads CSV: one row per book, tagged with its group. */
export function goodreadsEntriesForPlacements(placementIds) {
  return pushEntriesForPlacements(placementIds).map((e) => ({ item: e.item, groupName: e.groupName }));
}

export function openGoodreads(item) {
  const url = goodreads.bookUrl(item);
  if (!url) {
    toast('Nothing to look up on Goodreads.', { type: 'error' });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
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
    !many && goodreads.hasGoodreadsLink(item) && { label: 'Open in Goodreads', onClick: () => openGoodreads(item) },
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
    {
      label: many ? `Export bibliography (${itemIds.length})…` : 'Export bibliography…',
      onClick: () => exportBibliography(itemsOfPlacements(ids), many ? `${itemIds.length}-books` : item.title),
    },
    {
      label: many ? `Add ${ids.length} to Zotero…` : 'Add to Zotero…',
      hint: '01 Projects',
      onClick: () => promptPushToZotero(pushEntriesForPlacements(ids)),
    },
    {
      label: many ? `Add ${ids.length} to Goodreads…` : 'Add to Goodreads…',
      hint: 'CSV to upload',
      onClick: () => exportForGoodreads(goodreadsEntriesForPlacements(ids), item.title),
    },
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
    { label: 'Export bibliography…', onClick: () => exportBibliography(itemsOfGroup(groupId), group.name) },
    { label: 'Add group to Zotero…', hint: 'as a subcollection', onClick: () => promptPushToZotero(pushEntriesForGroup(groupId), group.name) },
    { label: 'Add group to Goodreads…', hint: 'CSV to upload', onClick: () => exportForGoodreads(pushEntriesForGroup(groupId).map((e) => ({ item: e.item, groupName: e.groupName })), group.name) },
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
    { label: 'Export bibliography…', hint: 'whole project', onClick: () => exportBibliography(itemsOfProject(projectId), project.name) },
    { label: 'Add project to Zotero…', hint: 'groups become subcollections', onClick: () => promptPushToZotero(pushEntriesForProject(projectId), project.name) },
    { label: 'Add project to Goodreads…', hint: 'CSV to upload', onClick: () => exportForGoodreads(pushEntriesForProject(projectId).map((e) => ({ item: e.item, groupName: e.groupName })), project.name) },
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


