// booksearch.js — a live search panel for adding several books at once.
//
// Modelled on Zotero Searcher rather than on a web form: the list narrows as
// you type, with no button to press, and rows are picked with tickboxes,
// ctrl-click and shift-click so a run of books goes onto the board in one go.
//
// Two kinds of source sit behind the same panel:
//
//   local    the Zotero library, filtered in memory from the cached index, so
//            it narrows instantly over thousands of items. A network search
//            per keystroke could never feel like this.
//   remote   Goodreads, which has to be asked. Debounced, and each request
//            aborts the one before it, so a fast typist gets one search rather
//            than eight overlapping ones.

import { el, openModal } from './ui.js';

const REMOTE_DEBOUNCE_MS = 350;
const LOCAL_DEBOUNCE_MS = 60;

/**
 * @param {object} o
 * @param {string} o.title        panel heading
 * @param {string} o.source       'Goodreads' / 'Zotero', for the copy
 * @param {'local'|'remote'} o.mode
 * @param {(q, ctx) => Promise<{rows, matched, total}>} o.search
 * @param {(row) => object} o.toDisplay   { title, authors, date, extra }
 * @param {() => Promise<void>} [o.prepare]  e.g. build the index first
 * @param {string} [o.seed]
 * @returns {Promise<object[]|null>} the chosen rows, in list order
 */
export function openBookSearch({ title, source, mode = 'remote', search, toDisplay, prepare, seed = '' }) {
  return openModal({
    title,
    width: 'wide',
    render: (body, close) => {
      // ---- input
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'booksearch__input';
      input.placeholder = mode === 'local'
        ? 'Type to narrow — title, author, year'
        : `Search ${source} — title, author, or ISBN`;
      input.value = seed;
      input.autocomplete = 'off';
      input.spellcheck = false;
      body.appendChild(input);

      const status = el('div', 'booksearch__status');
      body.appendChild(status);

      const list = el('div', 'booksearch__list');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-multiselectable', 'true');
      body.appendChild(list);

      // ---- footer
      const actions = el('div', 'form__actions');
      const count = el('div', 'booksearch__count');
      const cancel = el('button', 'btn btn--ghost', 'Cancel');
      cancel.type = 'button';
      const add = el('button', 'btn btn--primary', 'Add');
      add.type = 'button';
      add.disabled = true;
      actions.append(count, el('div', 'form__spacer'), cancel, add);
      body.appendChild(actions);

      // ---- state
      let rows = [];                 // what is on screen
      const chosen = new Map();      // key -> row, insertion-ordered
      let cursor = 0;                // the row arrow keys act on
      let anchor = null;             // where a shift-range starts
      let timer = null;
      let inFlight = null;
      let generation = 0;
      let ready = !prepare;

      const keyOf = (row, i) => row.key || row.goodreadsId || row.id || `row${i}`;

      const setStatus = (text, kind = '') => {
        status.textContent = text || '';
        status.className = `booksearch__status${kind ? ` is-${kind}` : ''}`;
      };

      const refreshCount = () => {
        const n = chosen.size;
        add.disabled = n === 0;
        add.textContent = n ? `Add ${n} book${n === 1 ? '' : 's'}` : 'Add';
        count.textContent = n ? `${n} selected` : '';
      };

      const paint = () => {
        list.replaceChildren();
        if (!rows.length) {
          list.appendChild(el('p', 'booksearch__empty',
            input.value.trim() ? 'Nothing matched.' : 'Start typing to search.'));
          refreshCount();
          return;
        }

        rows.forEach((row, i) => {
          const k = keyOf(row, i);
          const d = toDisplay(row);
          const node = el('div', `booksearch__row${chosen.has(k) ? ' is-chosen' : ''}${i === cursor ? ' is-cursor' : ''}`);
          node.setAttribute('role', 'option');
          node.setAttribute('aria-selected', String(chosen.has(k)));

          const box = document.createElement('input');
          box.type = 'checkbox';
          box.className = 'booksearch__check';
          box.checked = chosen.has(k);
          box.tabIndex = -1;
          box.addEventListener('click', (e) => {
            e.stopPropagation();
            toggle(i, { additive: true });
          });

          node.append(
            box,
            el('span', 'booksearch__author', (d.authors || []).join('; ') || '—'),
            el('span', 'booksearch__title', d.title || 'Untitled'),
            el('span', 'booksearch__date', d.date || '—'),
            el('span', 'booksearch__extra', d.extra || ''),
          );

          node.addEventListener('click', (e) => {
            if (e.shiftKey) selectRange(i);
            else toggle(i, { additive: e.ctrlKey || e.metaKey });
          });
          list.appendChild(node);
        });
        refreshCount();
      };

      /**
       * Plain click selects just that row (and clicking the only selected row
       * clears it). Ctrl/Cmd-click — and the tickbox — add to the selection
       * without disturbing the rest. This is how a file list behaves.
       */
      const toggle = (i, { additive }) => {
        const k = keyOf(rows[i], i);
        if (additive) {
          if (chosen.has(k)) chosen.delete(k);
          else chosen.set(k, rows[i]);
        } else {
          const wasTheOnlyOne = chosen.size === 1 && chosen.has(k);
          chosen.clear();
          if (!wasTheOnlyOne) chosen.set(k, rows[i]);
        }
        cursor = i;
        anchor = i;
        paint();
      };

      const selectRange = (i) => {
        const from = anchor == null ? cursor : anchor;
        const [lo, hi] = from <= i ? [from, i] : [i, from];
        for (let j = lo; j <= hi; j += 1) chosen.set(keyOf(rows[j], j), rows[j]);
        cursor = i;
        paint();
      };

      const move = (delta) => {
        if (!rows.length) return;
        cursor = Math.max(0, Math.min(rows.length - 1, cursor + delta));
        paint();
        list.children[cursor]?.scrollIntoView({ block: 'nearest' });
      };

      // ---- searching
      const run = async () => {
        const q = input.value.trim();
        const mine = (generation += 1);

        if (!ready) {
          setStatus(`Reading your ${source} library…`, 'busy');
          try {
            await prepare((m) => { if (mine === generation) setStatus(m, 'busy'); });
            ready = true;
          } catch (err) {
            setStatus(err.message, 'error');
            return;
          }
          if (mine !== generation) return;
        }

        if (mode === 'remote' && q.length < 2) {
          rows = [];
          setStatus('Type at least two characters.');
          paint();
          return;
        }

        setStatus(mode === 'remote' ? `Searching ${source}…` : 'Filtering…', 'busy');
        inFlight?.abort?.();
        const controller = new AbortController();
        inFlight = controller;

        try {
          const res = await search(q, { signal: controller.signal });
          if (mine !== generation) return;     // a later keystroke won
          rows = res.rows || [];
          cursor = 0;
          anchor = null;
          setStatus(
            res.total != null
              ? `${res.matched} of ${res.total} in your ${source} library`
              : `${rows.length} result${rows.length === 1 ? '' : 's'} from ${source}`,
          );
          paint();
        } catch (err) {
          if (err.name === 'AbortError' || mine !== generation) return;
          setStatus(err.message, 'error');
          rows = [];
          paint();
        } finally {
          if (inFlight === controller) inFlight = null;
        }
      };

      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(run, mode === 'local' ? LOCAL_DEBOUNCE_MS : REMOTE_DEBOUNCE_MS);
      };

      input.addEventListener('input', schedule);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); if (rows[cursor]) toggle(cursor, { additive: true }); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          // Enter with nothing ticked takes the row under the cursor.
          if (!chosen.size && rows[cursor]) chosen.set(keyOf(rows[cursor], cursor), rows[cursor]);
          if (chosen.size) close([...chosen.values()]);
        } else if (e.key === 'Escape') {
          // Handled by the modal; do not let it also clear the input first.
        } else {
          schedule();
        }
      });

      cancel.addEventListener('click', () => close(null));
      add.addEventListener('click', () => close([...chosen.values()]));

      paint();
      run();
      setTimeout(() => input.focus(), 30);
    },
  });
}
