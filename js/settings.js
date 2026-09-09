// settings.js — API keys, Gist sync, the archive, and the help sheet.
//
// Every credential here lives in this browser's localStorage and is sent only
// to the service it belongs to. Nothing is written into the repository, which
// is why the deployed site can be public while the keys stay private.

import * as store from './store.js';
import { openModal, openForm, toast, errorToast, showBusy, confirmDialog, el } from './ui.js';
import * as zotero from './zotero.js';
import * as todoist from './todoist.js';
import * as gist from './gist.js';
import { allItems } from './store.js';
import { itemProgress } from './model.js';
import { pct } from './nlp.js';

export function openSettings() {
  const cfg = store.getSettings();
  return openModal({
    title: 'Settings',
    width: 'wide',
    render: (body, close) => {
      const form = el('form', 'settings');

      form.append(
        section('Zotero', 'Create a key at zotero.org/settings/keys with read access — and write access if you want the read tag applied.', [
          field('zoteroApiKey', 'API key', cfg.zoteroApiKey, { type: 'password', autocomplete: 'off' }),
          field('zoteroUserId', 'User ID', cfg.zoteroUserId, { hint: 'The numeric ID shown on the same settings page.' }),
          field('zoteroReadTag', 'Tag applied on "Mark read"', cfg.zoteroReadTag || 'read'),
          field('zoteroDataDir', 'Zotero data directory', cfg.zoteroDataDir || 'C:\\Users\\Shae\\Zotero', {
            hint: 'Used to build local PDF paths for the readerhelper:// handler.',
          }),
          field('zoteroLinkedBaseDir', 'Linked-attachment base directory', cfg.zoteroLinkedBaseDir || '', {
            hint: 'Only needed if you use linked files rather than stored copies.',
          }),
        ], [
          button('Test Zotero', async (values) => {
            const busy = showBusy('Checking Zotero…');
            try {
              const info = await zotero.verifyKey({ zoteroApiKey: values.zoteroApiKey });
              busy.done();
              toast(`Key valid for ${info.username || 'user'} (${info.userID}).`, { type: 'success' });
              const idField = form.querySelector('[name="zoteroUserId"]');
              if (idField && !idField.value) idField.value = info.userID;
            } catch (err) {
              busy.done();
              errorToast(err, 'Zotero');
            }
          }),
        ]),

        section('Todoist', 'Copy your token from Todoist → Settings → Integrations → Developer.', [
          field('todoistApiKey', 'API token', cfg.todoistApiKey, { type: 'password', autocomplete: 'off' }),
        ], [
          button('Test Todoist', async (values) => {
            const busy = showBusy('Checking Todoist…');
            try {
              const info = await todoist.verifyToken({ todoistApiKey: values.todoistApiKey });
              busy.done();
              toast(`Connected — ${info.projectCount} project(s) visible.`, { type: 'success' });
            } catch (err) {
              busy.done();
              errorToast(err, 'Todoist');
            }
          }),
        ]),

        section('Sync', 'A private Gist holds your board so other devices and the nightly action can reach it.', [
          checkbox('gistSyncEnabled', 'Mirror the board to a private Gist', cfg.gistSyncEnabled),
          field('githubToken', 'GitHub token', cfg.githubToken, {
            type: 'password',
            autocomplete: 'off',
            hint: 'A fine-grained PAT with Gist read/write. Nothing else is needed.',
          }),
          field('gistId', 'Gist ID', cfg.gistId, { hint: 'Leave blank and press Push to create one.' }),
        ], [
          button('Push now', async (values) => {
            const busy = showBusy('Pushing to Gist…');
            try {
              const res = await gist.pushState(values, store.exportState());
              busy.done();
              store.saveSettings({ gistId: res.gistId });
              store.setMeta({ lastGistPush: res.pushedAt });
              const idField = form.querySelector('[name="gistId"]');
              if (idField) idField.value = res.gistId;
              toast(res.created ? `Created Gist ${res.gistId}.` : 'Pushed.', { type: 'success' });
            } catch (err) {
              busy.done();
              errorToast(err, 'Gist push');
            }
          }),
          button('Pull now', async (values) => {
            const ok = await confirmDialog({
              title: 'Replace local board?',
              message: 'Pulling overwrites this browser\u2019s board with the Gist copy.',
              confirmLabel: 'Pull and replace',
              danger: true,
            });
            if (!ok?.confirmed) return;
            const busy = showBusy('Pulling from Gist…');
            try {
              const res = await gist.pullState(values);
              busy.done();
              store.replaceState(res.state, 'pull from gist');
              toast('Board replaced from the Gist.', { type: 'success' });
              close(null);
            } catch (err) {
              busy.done();
              errorToast(err, 'Gist pull');
            }
          }),
        ]),

        section('Reading', '', [
          select('localPdfHandler', 'Local PDF button opens', cfg.localPdfHandler, [
            { value: 'zotero', label: "Zotero's built-in reader (no setup)" },
            { value: 'protocol', label: 'System PDF app via readerhelper://' },
          ], 'The protocol option needs tools/install-protocol.ps1 run once.'),
          field('promptMarkReadAt', 'Prompt to mark read at', String(cfg.promptMarkReadAt ?? 1), {
            type: 'number', min: 0.1, max: 1, step: 0.05, hint: '1 = 100%. Lower it to be asked sooner.',
          }),
          select('theme', 'Theme', cfg.theme, [
            { value: 'auto', label: 'Match the system' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]),
        ]),
      );

      // ---- data management
      const data = el('div', 'settings__section');
      data.append(el('h3', 'settings__heading', 'Data'));
      const dataRow = el('div', 'settings__buttons');
      dataRow.append(
        rawButton('Export board JSON', () => {
          const blob = new Blob([JSON.stringify(store.exportState(), null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `readerhelper-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        }),
        rawButton('Import board JSON', () => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'application/json';
          input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
              const parsed = JSON.parse(await file.text());
              const ok = await confirmDialog({
                title: 'Replace the board?',
                message: 'This replaces everything currently on the board.',
                confirmLabel: 'Replace',
                danger: true,
              });
              if (ok?.confirmed) {
                store.replaceState(parsed, 'import json');
                toast('Board imported.', { type: 'success' });
                close(null);
              }
            } catch (err) {
              errorToast(err, 'Import failed');
            }
          });
          input.click();
        }),
        rawButton('Clear all local data', async () => {
          const ok = await confirmDialog({
            title: 'Erase this board?',
            message: 'Every project, group, book, note and task in this browser is deleted. Zotero and Todoist are untouched.',
            confirmLabel: 'Erase everything',
            danger: true,
          });
          if (!ok?.confirmed) return;
          localStorage.removeItem('readerHelper.state.v1');
          location.reload();
        }, true),
      );
      data.appendChild(dataRow);
      form.appendChild(data);

      // ---- footer
      const actionsRow = el('div', 'form__actions');
      const spacer = el('div', 'form__spacer');
      const cancel = el('button', 'btn btn--ghost', 'Close');
      cancel.type = 'button';
      cancel.addEventListener('click', () => close(null));
      const save = el('button', 'btn btn--primary', 'Save');
      save.type = 'submit';
      actionsRow.append(spacer, cancel, save);
      form.appendChild(actionsRow);

      const readValues = () => {
        const out = {};
        form.querySelectorAll('[name]').forEach((node) => {
          if (node.type === 'checkbox') out[node.name] = node.checked;
          else if (node.type === 'number') out[node.name] = node.value === '' ? null : Number(node.value);
          else out[node.name] = node.value.trim();
        });
        return out;
      };
      form.__readValues = readValues;

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        store.saveSettings(readValues());
        applyTheme();
        toast('Settings saved.', { type: 'success' });
        close(readValues());
      });

      body.appendChild(form);

      function button(label, handler) {
        const b = el('button', 'btn btn--ghost', label);
        b.type = 'button';
        b.addEventListener('click', () => handler(readValues()));
        return b;
      }
    },
  });
}

function section(title, blurb, fields, buttons = []) {
  const wrap = el('div', 'settings__section');
  wrap.appendChild(el('h3', 'settings__heading', title));
  if (blurb) wrap.appendChild(el('p', 'settings__blurb', blurb));
  for (const f of fields) wrap.appendChild(f);
  if (buttons.length) {
    const row = el('div', 'settings__buttons');
    for (const b of buttons) row.appendChild(b);
    wrap.appendChild(row);
  }
  return wrap;
}

function field(name, label, value, opts = {}) {
  const row = el('div', 'form__row');
  const id = `set_${name}`;
  const l = el('label', 'form__label', label);
  l.htmlFor = id;
  const input = document.createElement('input');
  input.id = id;
  input.name = name;
  input.type = opts.type || 'text';
  input.value = value ?? '';
  if (opts.autocomplete) input.autocomplete = opts.autocomplete;
  if (opts.min !== undefined) input.min = opts.min;
  if (opts.max !== undefined) input.max = opts.max;
  if (opts.step !== undefined) input.step = opts.step;
  row.append(l, input);
  if (opts.hint) row.appendChild(el('small', 'form__hint', opts.hint));
  return row;
}

function checkbox(name, label, value) {
  const row = el('div', 'form__row form__row--inline');
  const id = `set_${name}`;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.name = name;
  input.checked = Boolean(value);
  const l = el('label', 'form__label', label);
  l.htmlFor = id;
  row.append(input, l);
  return row;
}

function select(name, label, value, options, hint) {
  const row = el('div', 'form__row');
  const id = `set_${name}`;
  const l = el('label', 'form__label', label);
  l.htmlFor = id;
  const sel = document.createElement('select');
  sel.id = id;
  sel.name = name;
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (String(o.value) === String(value)) opt.selected = true;
    sel.appendChild(opt);
  }
  row.append(l, sel);
  if (hint) row.appendChild(el('small', 'form__hint', hint));
  return row;
}

function rawButton(label, handler, danger = false) {
  const b = el('button', `btn ${danger ? 'btn--danger' : 'btn--ghost'}`, label);
  b.type = 'button';
  b.addEventListener('click', handler);
  return b;
}

// ------------------------------------------------------------------- theme

export function applyTheme() {
  const theme = store.getSettings().theme || 'auto';
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

// ----------------------------------------------------------------- archive

export function openArchive() {
  const archived = Object.values(store.getState().items).filter((i) => i.archived);
  return openModal({
    title: `Archive (${archived.length})`,
    width: 'wide',
    render: (body, close) => {
      if (!archived.length) {
        body.appendChild(el('p', 'picker__empty', 'Nothing archived yet. Marking a book read puts it here.'));
        return;
      }
      const list = el('div', 'archive-list');
      for (const item of archived.sort((a, b) => (b.markedReadAt || '').localeCompare(a.markedReadAt || ''))) {
        const row = el('div', 'archive-row');
        const info = el('div', 'archive-row__info');
        info.append(
          el('span', 'archive-row__title', item.title),
          el('span', 'archive-row__sub', [
            (item.authors || []).join(', '),
            item.markedReadAt ? `read ${new Date(item.markedReadAt).toLocaleDateString()}` : null,
            pct(itemProgress(item)),
          ].filter(Boolean).join(' · ')),
        );
        const restore = el('button', 'btn btn--ghost', 'Restore');
        restore.type = 'button';
        restore.addEventListener('click', () => {
          store.archiveItem(item.id, false);
          store.updateItem(item.id, { markReadPrompted: false });
          toast(`Restored “${item.title}”.`, { type: 'success' });
          close(null);
        });
        row.append(info, restore);
        list.appendChild(row);
      }
      body.appendChild(list);
    },
  });
}

// -------------------------------------------------------------------- help

export function openHelp() {
  return openModal({
    title: 'readerHelper',
    width: 'wide',
    render: (body) => {
      const groups = [
        ['Palette', [
          ['Shift + Space', 'Open or close the command palette'],
          ['/read', 'Pick a book, then say how much you read'],
          ['/open, /pdf, /zotero', 'Open a book page, its PDF, or the Zotero item'],
          ['/book, /group, /project', 'Create things'],
          ['/import, /sync', 'Pull a Zotero collection, or refresh'],
          ['/markread, /task', 'Archive a book, or push a Todoist task'],
          ['/archive, /settings, /help', 'Everything else'],
        ]],
        ['Board', [
          ['Click a book', 'Open its page — tasks, notes, history'],
          ['Ctrl / Cmd + click', 'Add to the selection, across projects'],
          ['Shift + click', 'Select a range within a group'],
          ['Right-click', 'Actions for a book, group, or project'],
          ['Double-click a title', 'Rename in place'],
          ['Drag the grip (⠿)', 'Reorder or move between groups'],
          ['Drag the progress bar', 'Set how far through you are'],
          ['Esc', 'Clear the selection'],
          ['Ctrl / Cmd + Z', 'Undo · Shift to redo'],
        ]],
        ['Reading phrases', [
          ['30 pages', 'Adds to where you left off'],
          ['two chapters', 'Needs a chapter count'],
          ['12 paragraphs', 'Estimated at 4 paragraphs a page'],
          ['up to p. 210', 'An absolute stopping point'],
          ['halfway, 40%', 'A proportion of the whole'],
        ]],
      ];
      for (const [title, rows] of groups) {
        const s = el('div', 'help__section');
        s.appendChild(el('h3', 'settings__heading', title));
        const table = el('div', 'help__table');
        for (const [k, v] of rows) {
          const r = el('div', 'help__row');
          r.append(el('kbd', 'help__key', k), el('span', 'help__desc', v));
          table.appendChild(r);
        }
        s.appendChild(table);
        body.appendChild(s);
      }
      const note = el('p', 'settings__blurb', 'Keys live only in this browser. Nothing is stored in the repository.');
      body.appendChild(note);
    },
  });
}

export { allItems };
