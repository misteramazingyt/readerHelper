// goodreads-ingest.js — putting Goodreads books onto the board.
//
// Split the same way as the Zotero import: decide the shape first (pure), then
// apply it in one commit. That keeps a whole import undoable with one Ctrl+Z
// and makes the interesting part — which group a book lands in, and whether it
// is already here — testable without a network or a DOM.

import { newProject, newGroup, newItem, newPlacement, now } from './model.js';
import { normTitle, normIsbn, surnameOf } from './zotero-push.js';
import { SHELF_GROUPS, splitShelves } from './goodreads.js';

export const DEFAULT_PROJECT = 'Goodreads';
export const UNSHELVED = 'Unshelved';

/**
 * Decide which group each book belongs in.
 *
 * @param {object[]} books   from parseLibraryCsv or parseShelfRss
 * @param {object} options
 *   groupBy      'shelf'   the exclusive shelf: To read / Reading now / Read
 *                'shelves' the custom shelves — a book on three lands in three
 *                'single'  everything into one group
 *   defaultGroup used when a book has nothing to group on
 * @returns {Array<{book, groupName}>} one entry per book *per group*
 */
export function planGroups(books, { groupBy = 'shelf', defaultGroup = 'Imported' } = {}) {
  const entries = [];
  for (const book of books) {
    let names;
    if (groupBy === 'single') {
      names = [defaultGroup];
    } else if (groupBy === 'shelves') {
      const custom = (book.goodreadsShelves || []).filter(Boolean);
      names = custom.length ? custom.map(prettyShelf) : [defaultGroup];
    } else {
      const shelf = book.goodreadsShelf;
      names = [SHELF_GROUPS[shelf] || (shelf ? prettyShelf(shelf) : defaultGroup)];
    }
    for (const groupName of names) entries.push({ book, groupName });
  }
  return entries;
}

/** "historical-fiction" reads better as "Historical fiction" on a column. */
export function prettyShelf(name) {
  const s = String(name || '').replace(/[-_]+/g, ' ').trim();
  if (!s) return UNSHELVED;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Group names in the order the board should show them. */
export function orderGroupNames(names) {
  const preferred = ['To read', 'Reading now', 'Read'];
  const known = preferred.filter((p) => names.includes(p));
  const rest = names.filter((n) => !preferred.includes(n)).sort((a, b) => a.localeCompare(b));
  return [...known, ...rest];
}

// ---------------------------------------------------------------- matching

/**
 * Is this book already on the board? Goodreads id first, then ISBN, then title
 * with an author — the same ladder the Zotero push uses, and for the same
 * reason: a title alone is not enough to merge two records on.
 */
export function findExisting(state, book) {
  const items = Object.values(state.items || {});

  if (book.goodreadsId) {
    const hit = items.find((i) => i.goodreadsId && String(i.goodreadsId) === String(book.goodreadsId));
    if (hit) return { item: hit, reason: 'same Goodreads id' };
  }
  const isbn = normIsbn(book.isbn || '');
  if (isbn) {
    const hit = items.find((i) => normIsbn(i.isbn || '') === isbn);
    if (hit) return { item: hit, reason: 'same ISBN' };
  }
  const title = normTitle(book.title || '');
  if (title && title.length > 3) {
    const surname = surnameOf(book.authors?.[0] || '');
    const sameTitle = items.filter((i) => normTitle(i.title || '') === title);
    if (surname) {
      const hit = sameTitle.find((i) => surnameOf(i.authors?.[0] || '') === surname);
      if (hit) return { item: hit, reason: 'same title and author' };
    }
    if (sameTitle.length === 1 && !surname) return { item: sameTitle[0], reason: 'same title' };
  }
  return null;
}

// ------------------------------------------------------------------- apply

/**
 * Apply a plan to a state tree. Additive, like the Zotero import: it adds books
 * and groups, and refreshes Goodreads-owned fields on books it already knows,
 * but never deletes and never overwrites reading progress recorded here.
 *
 * @returns {{projectId, groups, added, linked, updated, placed}}
 */
export function applyGoodreads(state, entries, { projectName = DEFAULT_PROJECT, updateExisting = true } = {}) {
  const report = { projectId: null, groups: 0, added: 0, linked: 0, updated: 0, placed: 0 };

  let project = Object.values(state.projects).find(
    (p) => p.name.trim().toLowerCase() === projectName.trim().toLowerCase(),
  );
  if (!project) {
    project = newProject(projectName, { goodreadsProject: true });
    state.projects[project.id] = project;
    state.projectOrder.push(project.id);
  }
  report.projectId = project.id;

  const groupNames = orderGroupNames([...new Set(entries.map((e) => e.groupName))]);
  const groupsByName = new Map();
  for (const name of groupNames) {
    let group = project.groupOrder
      .map((id) => state.groups[id])
      .find((g) => g && g.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!group) {
      group = newGroup(project.id, name);
      state.groups[group.id] = group;
      project.groupOrder.push(group.id);
      project.modifiedAt = now();
      report.groups += 1;
    }
    groupsByName.set(name, group);
  }

  for (const { book, groupName } of entries) {
    const group = groupsByName.get(groupName);
    if (!group) continue;

    const existing = findExisting(state, book);
    let item;

    if (existing) {
      item = existing.item;
      report.linked += 1;
      if (updateExisting) {
        // Goodreads owns these; the board owns reading progress and tasks.
        const patch = {};
        if (book.goodreadsId && !item.goodreadsId) patch.goodreadsId = book.goodreadsId;
        if (book.goodreadsRating != null) patch.goodreadsRating = book.goodreadsRating;
        if (book.goodreadsShelves?.length) patch.goodreadsShelves = book.goodreadsShelves;
        if (!item.totalPages && book.totalPages) patch.totalPages = book.totalPages;
        if (!item.isbn && book.isbn) patch.isbn = book.isbn;
        if (!item.year && book.year) patch.year = book.year;
        if (!item.publisher && book.publisher) patch.publisher = book.publisher;
        if (!item.url && book.url) patch.url = book.url;
        if (Object.keys(patch).length) {
          Object.assign(item, patch, { modifiedAt: now() });
          report.updated += 1;
        }
      }
    } else {
      const { currentPage, progress, ...rest } = book;
      item = newItem({
        ...rest,
        // A book read on Goodreads starts here already finished.
        currentPage: currentPage || 0,
        progress: progress || 0,
        tag: progress >= 1 ? 'Full' : null,
      });
      state.items[item.id] = item;
      report.added += 1;
    }

    const alreadyHere = group.placementOrder.some((pid) => state.placements[pid]?.itemId === item.id);
    if (!alreadyHere) {
      const placement = newPlacement(item.id, group.id);
      state.placements[placement.id] = placement;
      group.placementOrder.push(placement.id);
      group.modifiedAt = now();
      report.placed += 1;
    }
  }

  if (!state.ui.activeProjectId) state.ui.activeProjectId = project.id;
  state.meta = { ...state.meta, lastGoodreadsSync: now() };
  return report;
}

export { splitShelves };
