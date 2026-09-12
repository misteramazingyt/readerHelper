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
import * as auth from './auth.js';
import * as zoteroPush from './zotero-push.js';
import * as opener from './open.js';

export function openSettings() {
  const cfg = store.getSettings();
  return openModal({
    title: 'Settings',
    width: 'wide',
    render: (body, close) => {
      const form = el('form', 'settings');

      form.append(accountSection(close));

      form.append(
        section('Zotero', 'Create a key at zotero.org/settings/keys with read access — and write access if you want the read tag applied.', [
          field('zoteroApiKey', 'API key', cfg.zoteroApiKey, { type: 'password', autocomplete: 'off' }),
          field('zoteroUserId', 'User ID', cfg.zoteroUserId, { hint: 'The numeric ID shown on the same settings page.' }),
          field('zoteroReadTag', 'Tag applied on "Mark read"', cfg.zoteroReadTag || 'read'),
          field('zoteroProjectsRoot', 'Collection that projects are pushed into', cfg.zoteroProjectsRoot || '01 Projects', {
            hint: 'Add to Zotero files books under <this> / <project> / <group>. Created if it does not exist.',
          }),
          field('zoteroDataDir', 'Zotero data directory', cfg.zoteroDataDir || 'C:\\Users\\Shae\\Zotero', {
            hint: 'Used to build local PDF paths for the readerhelper:// handler.',
          }),
          field('zoteroLinkedBaseDir', 'Linked-attachment base directory', cfg.zoteroLinkedBaseDir || '', {
            hint: 'Only needed if you use linked files rather than stored copies.',
          }),
        ], [
          button('Rebuild duplicate index', async () => {
            const busy = showBusy('Re-reading the Zotero library…');
            try {
              zoteroPush.clearIndexCache();
              const index = await zoteroPush.loadIndex(store.getSettings(), { force: true, onProgress: (m) => busy.update(m) });
              busy.done();
              toast(`Indexed ${index.entries.length} Zotero items.`, { type: 'success' });
            } catch (err) {
              busy.done();
              errorToast(err, 'Zotero');
            }
          }),
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

        section('Goodreads', 'Goodreads retired its API in 2020, so there is no key. Shelf sync reads the public RSS feed through your worker; the CSV route needs nothing at all.', [
          field('goodreadsUserId', 'Goodreads user ID', cfg.goodreadsUserId, {
            hint: 'The digits in your profile URL: goodreads.com/user/show/12345678-name. Shelf sync only works if the profile is public.',
          }),
          field('goodreadsShelves', 'Shelves to sync', cfg.goodreadsShelves || 'read, currently-reading, to-read', {
            hint: 'Comma-separated. Custom shelf names work too.',
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

        section('Sync', 'Your board lives in a private Gist so every computer you sign in on sees the same projects, groups and books. It syncs on load, every minute, on focus, and a few seconds after any edit. The Gist is found automatically — you should not need to paste an ID.', [
          checkbox('gistSyncEnabled', 'Keep this board in sync across devices', cfg.gistSyncEnabled),
          field('githubToken', 'GitHub token', cfg.githubToken, {
            type: 'password',
            autocomplete: 'off',
            hint: auth.isSignedIn() && auth.hasGistScope()
              ? 'Optional. Your signed-in session already grants Gist access; a token here overrides it.'
              : 'A fine-grained PAT with Gist read/write. Nothing else is needed.',
          }),
          field('gistId', 'Gist ID', cfg.gistId, {
            hint: 'Discovered automatically from your account. Blank it to force a fresh search.',
          }),
        ], [
          button('Push now', async (values) => {
            const busy = showBusy('Pushing to Gist…');
            try {
              const res = await gist.pushState(auth.withGithubToken(values), store.exportState());
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
              const res = await gist.pullState(auth.withGithubToken(values));
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
        ], [
          button('Check PDF setup', () => openPdfDiagnostics()),
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

/** Who is signed in, and the way out. Absent entirely on an open instance. */
function accountSection(close) {
  const wrap = el('div', 'settings__section');
  wrap.appendChild(el('h3', 'settings__heading', 'Account'));

  if (!auth.isConfigured()) {
    wrap.appendChild(el('p', 'settings__blurb',
      'Sign-in is not configured for this build, so the board is open to anyone who has the URL. See README → Locking the site.'));
    return wrap;
  }

  const session = auth.getSession();
  if (!session) {
    wrap.appendChild(el('p', 'settings__blurb', 'Not signed in.'));
    return wrap;
  }

  const row = el('div', 'account');
  if (session.avatarUrl) {
    const img = document.createElement('img');
    img.className = 'account__avatar';
    img.src = session.avatarUrl;
    img.alt = '';
    img.width = 34;
    img.height = 34;
    row.appendChild(img);
  }

  const info = el('div', 'account__info');
  info.appendChild(el('span', 'account__login', session.name ? `${session.name} (${session.login})` : session.login));
  const bits = [];
  if (session.signedInAt) bits.push(`signed in ${new Date(session.signedInAt).toLocaleDateString()}`);
  bits.push(auth.hasGistScope() ? 'Gist access granted' : 'identity only');
  info.appendChild(el('span', 'account__meta', bits.join(' · ')));
  row.appendChild(info);

  const out = el('button', 'btn btn--ghost', 'Sign out');
  out.type = 'button';
  out.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Sign out?',
      message: 'The session token is revoked at GitHub. Your board stays in this browser.',
      confirmLabel: 'Sign out',
    });
    if (!ok?.confirmed) return;
    close(null);
    await auth.signOut();
  });
  row.appendChild(out);

  wrap.appendChild(row);
  return wrap;
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

// ------------------------------------------------------------- PDF setup

/**
 * Answer "why will this book not open?" with the actual state of things, rather
 * than making the user infer it from a greyed-out button.
 */
export function openPdfDiagnostics() {
  const cfg = store.getSettings();
  const items = allItems();
  const withZoteroLink = items.filter((i) => i.citekey || i.zoteroKey).length;
  const withAttachment = items.filter((i) => i.pdfAttachmentKey).length;
  const withLocalPath = items.filter((i) => i.localPdfPath).length;
  const handler = cfg.localPdfHandler === 'protocol' ? 'System PDF app' : "Zotero's reader";

  const sample = items.find((i) => i.pdfAttachmentKey) || items.find((i) => i.localPdfPath);
  const zoteroSample = items.find((i) => i.citekey || i.zoteroKey);

  return openModal({
    title: 'PDF setup',
    width: 'wide',
    render: (body, close) => {
      const rows = [
        ['Books on the board', String(items.length)],
        ['Linked to a Zotero item', `${withZoteroLink} — these can use the Zotero button`],
        ['With a PDF attachment', `${withAttachment} — these can open in Zotero's reader`],
        ['With a local file path', `${withLocalPath} — these can open in your system PDF app`],
        ['Local PDF button opens', handler],
        ['Zotero data directory', cfg.zoteroDataDir || 'not set'],
      ];
      const grid = el('div', 'detail__grid');
      for (const [k, v] of rows) {
        const row = el('div', 'detail__grid-row');
        row.append(el('span', 'detail__grid-key', k), el('span', 'detail__grid-value', v));
        grid.appendChild(row);
      }
      body.appendChild(grid);

      const notes = [];
      if (!withZoteroLink) {
        notes.push('No book here is linked to Zotero yet. Import a collection with Z, or add books with Search Zotero.');
      }
      if (withZoteroLink && !withAttachment) {
        notes.push('Your books are linked to Zotero but none has a PDF attached in Zotero itself. The Zotero button will still find the item.');
      }
      if (cfg.localPdfHandler === 'protocol' && !cfg.zoteroDataDir) {
        notes.push('The system PDF app is selected, but without a Zotero data directory no file path can be built. Set it above (usually C:\Users\<you>\Zotero), then re-sync.');
      }
      if (cfg.localPdfHandler === 'protocol') {
        notes.push('That route also needs the readerhelper:// handler installed once — tools/install-protocol.ps1.');
      }
      notes.push('Both buttons hand off to Zotero through a zotero:// link, so Zotero must be installed; it will start if it is not already running. The first click per browser session asks permission — tick "always allow".');

      for (const n of notes) body.appendChild(el('p', 'push__note', n));

      const actions = el('div', 'form__actions');
      actions.appendChild(el('div', 'form__spacer'));

      if (zoteroSample) {
        const tryZotero = el('button', 'btn btn--ghost', 'Try the Zotero button');
        tryZotero.type = 'button';
        tryZotero.title = zoteroSample.title;
        tryZotero.addEventListener('click', () => {
          toast(`Asking Zotero to show “${zoteroSample.title}”…`);
          opener.openInZotero(zoteroSample);
        });
        actions.appendChild(tryZotero);
      }
      if (sample) {
        const tryPdf = el('button', 'btn btn--primary', 'Try opening a PDF');
        tryPdf.type = 'button';
        tryPdf.title = sample.title;
        tryPdf.addEventListener('click', () => {
          const res = opener.openLocalPdf(sample, store.getSettings());
          toast(res.message, { type: res.ok ? 'info' : 'error' });
        });
        actions.appendChild(tryPdf);
      }

      const done = el('button', 'btn btn--ghost', 'Close');
      done.type = 'button';
      done.addEventListener('click', () => close(null));
      actions.appendChild(done);
      body.appendChild(actions);
    },
  });
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
