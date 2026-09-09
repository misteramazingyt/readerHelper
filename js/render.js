// render.js — the board. A pure-ish function of state: rebuild the sidebar,
// the columns, and the cards, then let dnd.js and the menus act on the result.
//
// Re-rendering wholesale keeps the data flow easy to reason about; the two
// places where that would be visibly wrong — a field being typed into, and a
// progress thumb mid-drag — are guarded explicitly.

import * as store from './store.js';
import {
  TAGS,
  TAG_COLORS,
  SORT_LABELS,
  SORT_MODES,
  orderedProjects,
  orderedGroups,
  visiblePlacements,
  itemProgress,
  projectProgress,
  authorLabel,
  isDuplicated,
} from './model.js';
import * as sel from './selection.js';
import * as actions from './actions.js';
import * as opener from './open.js';
import { el, editInline, openContextMenu, toast } from './ui.js';
import { pct } from './nlp.js';

let refs = {};
let suppressRender = false;

export function initRender() {
  refs = {
    sidebarList: document.getElementById('project-list'),
    board: document.getElementById('board'),
    projectTitle: document.getElementById('active-project-title'),
    projectMeta: document.getElementById('active-project-meta'),
    overallFill: document.getElementById('overall-fill'),
    overallLabel: document.getElementById('overall-label'),
    selectionBar: document.getElementById('selection-bar'),
    selectionCount: document.getElementById('selection-count'),
    groupSortBtn: document.getElementById('group-sort-btn'),
  };
}

export function suspendRender(on) {
  suppressRender = on;
}

export function render() {
  if (suppressRender) return;
  const state = store.getState();
  renderSidebar(state);
  renderHeader(state);
  renderBoard(state);
  renderSelectionBar();
}

// ------------------------------------------------------------------ sidebar

function renderSidebar(state) {
  const host = refs.sidebarList;
  if (!host) return;
  host.replaceChildren();
  const projects = orderedProjects(state);

  for (const project of projects) {
    const row = el('button', 'project-row');
    row.type = 'button';
    row.dataset.drag = 'project';
    row.dataset.dragId = project.id;
    row.dataset.projectId = project.id;
    if (project.id === state.ui.activeProjectId) row.classList.add('is-active');

    const grip = el('span', 'grip');
    grip.dataset.dragHandle = '';
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⠿';

    const name = el('span', 'project-row__name', project.name);
    const count = el('span', 'project-row__count', String(countBooks(state, project.id)));

    row.append(grip, name, count);
    if (project.zoteroCollectionKey) {
      const z = el('span', 'project-row__badge', 'Z');
      z.title = 'Linked to a Zotero collection';
      row.appendChild(z);
    }

    row.addEventListener('click', () => store.setActiveProject(project.id));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      actions.openProjectMenu(e.clientX, e.clientY, project.id);
    });
    host.appendChild(row);
  }

  if (!projects.length) {
    host.appendChild(el('p', 'sidebar__empty', 'No projects yet. Use + to create one, or Z to import a Zotero collection.'));
  }
}

function countBooks(state, projectId) {
  const seen = new Set();
  for (const gid of state.projects[projectId]?.groupOrder || []) {
    for (const pid of state.groups[gid]?.placementOrder || []) {
      const p = state.placements[pid];
      if (p && !state.items[p.itemId]?.archived) seen.add(p.itemId);
    }
  }
  return seen.size;
}

// ------------------------------------------------------------------- header

function renderHeader(state) {
  const project = state.projects[state.ui.activeProjectId];
  if (refs.projectTitle) {
    refs.projectTitle.textContent = project?.name || 'No project selected';
    refs.projectTitle.dataset.projectId = project?.id || '';
  }
  if (refs.projectMeta) {
    refs.projectMeta.textContent = project
      ? `${project.groupOrder.length} group(s) · ${countBooks(state, project.id)} book(s)`
      : '';
  }
  if (refs.groupSortBtn && project) {
    refs.groupSortBtn.textContent = `${SORT_LABELS[project.groupSort.mode]} ${project.groupSort.dir === 'desc' ? '↓' : '↑'}`;
    refs.groupSortBtn.hidden = false;
  } else if (refs.groupSortBtn) {
    refs.groupSortBtn.hidden = true;
  }

  const frac = project ? projectProgress(state, project.id) : 0;
  if (refs.overallFill) refs.overallFill.style.width = `${Math.round(frac * 100)}%`;
  if (refs.overallLabel) refs.overallLabel.textContent = project ? `${pct(frac)} read` : '';
}

// -------------------------------------------------------------------- board

function renderBoard(state) {
  const host = refs.board;
  if (!host) return;
  const scrollLeft = host.scrollLeft;
  host.replaceChildren();

  const project = state.projects[state.ui.activeProjectId];
  if (!project) {
    host.appendChild(emptyBoardMessage());
    return;
  }

  for (const group of orderedGroups(state, project.id)) {
    host.appendChild(renderColumn(state, group));
  }
  host.appendChild(renderAddColumn(project.id));
  host.scrollLeft = scrollLeft;
}

function emptyBoardMessage() {
  const wrap = el('div', 'board__empty');
  wrap.append(
    el('h2', 'board__empty-title', 'Nothing here yet'),
    el('p', 'board__empty-text', 'Import a Zotero collection with the Z button, or create a project with +.'),
  );
  return wrap;
}

function renderColumn(state, group) {
  const col = el('section', 'column');
  col.dataset.drag = 'column';
  col.dataset.dragId = group.id;
  col.dataset.groupId = group.id;

  // ---- header
  const header = el('header', 'column__header');
  const grip = el('span', 'grip');
  grip.dataset.dragHandle = '';
  grip.textContent = '⠿';
  grip.setAttribute('aria-hidden', 'true');

  const title = el('h2', 'column__title', group.name);
  title.tabIndex = 0;
  title.dataset.groupId = group.id;
  title.title = 'Double-click to rename';
  title.addEventListener('dblclick', () => startRenameGroup(group.id, title));
  title.addEventListener('keydown', (e) => {
    if (e.key === 'F2' || e.key === 'Enter') startRenameGroup(group.id, title);
  });

  const sortBtn = el('button', 'column__sort');
  sortBtn.type = 'button';
  sortBtn.dataset.noDrag = '';
  sortBtn.textContent = `${SORT_LABELS[group.itemSort.mode]} ${group.itemSort.dir === 'desc' ? '↓' : '↑'}`;
  sortBtn.title = 'Change how books in this group are ordered';
  sortBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSortMenu(e.clientX, e.clientY, group.itemSort, (mode, dir) => store.setGroupSort(group.id, mode, dir));
  });

  const burger = el('button', 'burger');
  burger.type = 'button';
  burger.dataset.noDrag = '';
  burger.setAttribute('aria-label', `Actions for ${group.name}`);
  burger.textContent = '☰';
  burger.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = burger.getBoundingClientRect();
    actions.openGroupMenu(r.left, r.bottom + 4, group.id);
  });

  header.append(grip, title, sortBtn, burger);
  col.appendChild(header);

  // ---- cards
  const list = el('div', 'column__cards');
  list.dataset.dropZone = 'cards';
  list.dataset.dropId = group.id;
  list.dataset.accept = 'card';

  const rows = visiblePlacements(state, group.id);
  for (const { placement, item } of rows) {
    list.appendChild(renderCard(state, placement, item));
  }
  if (!rows.length) list.appendChild(el('p', 'column__empty', 'Drop a book here'));
  col.appendChild(list);

  // ---- footer +
  const add = el('button', 'column__add', '+');
  add.type = 'button';
  add.dataset.noDrag = '';
  add.setAttribute('aria-label', `Add a book to ${group.name}`);
  add.addEventListener('click', () => actions.promptAddBook(group.id));
  col.appendChild(add);

  col.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.card')) return;
    e.preventDefault();
    actions.openGroupMenu(e.clientX, e.clientY, group.id);
  });

  return col;
}

function renderAddColumn(projectId) {
  const btn = el('button', 'column column--add');
  btn.type = 'button';
  btn.dataset.dropTail = '';
  btn.dataset.noDrag = '';
  btn.setAttribute('aria-label', 'Add a group');
  btn.appendChild(el('span', 'column--add__plus', '+'));
  btn.addEventListener('click', () => addGroupInteractive(projectId));
  return btn;
}

// --------------------------------------------------------------------- card

function renderCard(state, placement, item) {
  const card = el('article', 'card');
  card.dataset.drag = 'card';
  card.dataset.dragId = placement.id;
  card.dataset.placementId = placement.id;
  card.dataset.itemId = item.id;
  if (sel.isSelected(placement.id)) card.classList.add('is-selected');

  // ---- title row
  const top = el('div', 'card__top');
  const grip = el('span', 'grip grip--card');
  grip.dataset.dragHandle = '';
  grip.textContent = '⠿';
  grip.setAttribute('aria-hidden', 'true');

  const title = el('span', 'card__title', item.title);
  title.title = `${item.title}${item.authors?.length ? ` — ${authorLabel(item)}` : ''}`;
  title.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRenameItem(item.id, title);
  });

  top.append(grip, title);

  if (item.tag) {
    const tag = el('span', 'card__tag', item.tag);
    tag.style.setProperty('--tag-color', TAG_COLORS[item.tag] || '#888');
    tag.dataset.noDrag = '';
    tag.title = 'Reading mode — click to change';
    tag.addEventListener('click', (e) => {
      e.stopPropagation();
      openTagMenu(e.clientX, e.clientY, item.id, item.tag);
    });
    top.appendChild(tag);
  }

  if (isDuplicated(state, placement.id)) {
    const link = el('span', 'card__linked', '⧉');
    link.title = 'Linked copy — edits apply to every copy of this book';
    top.appendChild(link);
  }

  const burger = el('button', 'burger burger--card');
  burger.type = 'button';
  burger.dataset.noDrag = '';
  burger.setAttribute('aria-label', `Actions for ${item.title}`);
  burger.textContent = '☰';
  burger.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = burger.getBoundingClientRect();
    actions.openBookMenu(r.left, r.bottom + 4, placement.id);
  });
  top.appendChild(burger);
  card.appendChild(top);

  // ---- progress
  card.appendChild(renderProgress(item));

  // ---- open buttons
  const links = el('div', 'card__links');
  links.dataset.noDrag = '';

  const zBtn = el('button', 'chip', 'Zotero');
  zBtn.type = 'button';
  zBtn.disabled = !opener.hasZoteroLink(item);
  zBtn.title = zBtn.disabled ? 'No Zotero item linked' : 'Select this item in Zotero';
  zBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    actions.reportOpen(opener.openInZotero(item));
  });

  const pBtn = el('button', 'chip', 'Local PDF');
  pBtn.type = 'button';
  pBtn.disabled = !opener.hasPdfLink(item);
  const resume = opener.resumePage(item);
  pBtn.title = pBtn.disabled
    ? 'No PDF attachment found'
    : resume
      ? `Open the PDF at p. ${resume}`
      : 'Open the PDF';
  pBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    actions.reportOpen(opener.openLocalPdf(item, store.getSettings()));
  });

  links.append(zBtn, pBtn);
  if (item.tasks?.length) {
    const open = item.tasks.filter((t) => !t.done).length;
    const badge = el('span', 'card__tasks', `${open}/${item.tasks.length} tasks`);
    links.appendChild(badge);
  }
  card.appendChild(links);

  // ---- interaction
  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-no-drag], .inline-edit')) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      sel.toggle(placement.id);
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      const anchor = sel.getSelection().find((id) => state.placements[id]?.groupId === placement.groupId);
      if (anchor) sel.selectRange(state, placement.groupId, anchor, placement.id);
      else sel.add(placement.id);
      return;
    }
    window.dispatchEvent(new CustomEvent('rh:open-item', { detail: { itemId: item.id, placementId: placement.id } }));
  });

  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    actions.openBookMenu(e.clientX, e.clientY, placement.id);
  });

  return card;
}

/**
 * The progress bar doubles as a scrubber. Dragging the thumb sets progress
 * directly; rendering is suspended for the duration so the board does not
 * rebuild the element being dragged out from under the pointer.
 */
function renderProgress(item) {
  const frac = itemProgress(item);
  const wrap = el('div', 'progress');
  wrap.dataset.noDrag = '';
  wrap.setAttribute('role', 'slider');
  wrap.setAttribute('aria-label', `Reading progress for ${item.title}`);
  wrap.setAttribute('aria-valuemin', '0');
  wrap.setAttribute('aria-valuemax', '100');
  wrap.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  wrap.tabIndex = 0;

  const fill = el('div', 'progress__fill');
  fill.style.width = `${frac * 100}%`;
  const thumb = el('div', 'progress__thumb');
  thumb.style.left = `${frac * 100}%`;
  const label = el('span', 'progress__label');
  label.textContent = item.totalPages
    ? `${item.currentPage || 0}/${item.totalPages}`
    : pct(frac);

  wrap.append(fill, thumb, label);
  wrap.title = item.totalPages
    ? `Page ${item.currentPage || 0} of ${item.totalPages} — ${pct(frac)}. Drag to adjust.`
    : `${pct(frac)} — drag to adjust.`;

  const fracFromEvent = (e) => {
    const r = wrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };

  let dragging = false;
  wrap.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    dragging = true;
    suspendRender(true);
    wrap.setPointerCapture(e.pointerId);
    const f = fracFromEvent(e);
    fill.style.width = `${f * 100}%`;
    thumb.style.left = `${f * 100}%`;
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const f = fracFromEvent(e);
    fill.style.width = `${f * 100}%`;
    thumb.style.left = `${f * 100}%`;
    label.textContent = item.totalPages ? `${Math.round(f * item.totalPages)}/${item.totalPages}` : pct(f);
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    suspendRender(false);
    const f = fracFromEvent(e);
    store.setProgressFraction(item.id, f);
    actions.maybePromptMarkRead(item.id);
  };
  wrap.addEventListener('pointerup', finish);
  wrap.addEventListener('pointercancel', () => {
    dragging = false;
    suspendRender(false);
    render();
  });

  wrap.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      store.setProgressFraction(item.id, itemProgress(item) + step);
      actions.maybePromptMarkRead(item.id);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      store.setProgressFraction(item.id, itemProgress(item) - step);
    }
  });

  return wrap;
}

// -------------------------------------------------------------------- menus

export function openSortMenu(x, y, current, onPick) {
  openContextMenu(x, y, [
    { heading: 'Order by' },
    ...SORT_MODES.map((mode) => ({
      label: SORT_LABELS[mode] + (current.mode === mode ? '  ✓' : ''),
      onClick: () => onPick(mode, current.dir),
    })),
    { separator: true },
    { label: `Ascending${current.dir !== 'desc' ? '  ✓' : ''}`, onClick: () => onPick(current.mode, 'asc') },
    { label: `Descending${current.dir === 'desc' ? '  ✓' : ''}`, onClick: () => onPick(current.mode, 'desc') },
  ]);
}

function openTagMenu(x, y, itemId, currentTag) {
  openContextMenu(x, y, [
    { heading: 'Reading mode' },
    { label: `— none —${!currentTag ? '  ✓' : ''}`, onClick: () => store.setItemTag(itemId, null) },
    ...TAGS.map((t) => ({ label: t + (currentTag === t ? '  ✓' : ''), onClick: () => store.setItemTag(itemId, t) })),
  ]);
}

// ------------------------------------------------------------ inline rename

function startRenameGroup(groupId, node) {
  const name = store.getState().groups[groupId]?.name || '';
  suspendRender(true);
  editInline(node, name, (value) => {
    suspendRender(false);
    if (value) store.renameGroup(groupId, value);
    else render();
  });
}

function startRenameItem(itemId, node) {
  const title = store.getState().items[itemId]?.title || '';
  suspendRender(true);
  editInline(node, title, (value) => {
    suspendRender(false);
    if (value) store.renameItem(itemId, value);
    else render();
  });
}

export function startRenameProject(projectId) {
  const row = refs.sidebarList?.querySelector(`[data-project-id="${projectId}"] .project-row__name`);
  if (!row) return;
  const name = store.getState().projects[projectId]?.name || '';
  suspendRender(true);
  editInline(row, name, (value) => {
    suspendRender(false);
    if (value) store.renameProject(projectId, value);
    else render();
  });
}

export function startRenameActiveProjectTitle() {
  const node = refs.projectTitle;
  const projectId = node?.dataset.projectId;
  if (!node || !projectId) return;
  const name = store.getState().projects[projectId]?.name || '';
  suspendRender(true);
  editInline(node, name, (value) => {
    suspendRender(false);
    if (value) store.renameProject(projectId, value);
    else render();
  });
}

/** New group, then immediately select its title for typing (per the spec). */
export function addGroupInteractive(projectId) {
  const group = store.addGroup(projectId, 'Untitled Group');
  if (!group) return null;
  requestAnimationFrame(() => {
    const node = refs.board?.querySelector(`.column__title[data-group-id="${group.id}"]`);
    if (node) startRenameGroup(group.id, node);
  });
  return group;
}

/** New project, then immediately select its sidebar title for typing. */
export function addProjectInteractive() {
  const project = store.addProject('Untitled Project');
  store.setActiveProject(project.id);
  requestAnimationFrame(() => startRenameProject(project.id));
  return project;
}

// ----------------------------------------------------------- selection bar

function renderSelectionBar() {
  const bar = refs.selectionBar;
  if (!bar) return;
  const n = sel.selectionSize();
  bar.hidden = n === 0;
  if (refs.selectionCount) {
    refs.selectionCount.textContent = `${n} book${n === 1 ? '' : 's'} selected`;
  }
}

export function refreshSelectionStyles() {
  const board = refs.board;
  if (!board) return;
  board.querySelectorAll('.card').forEach((card) => {
    card.classList.toggle('is-selected', sel.isSelected(card.dataset.placementId));
  });
  renderSelectionBar();
}

export { toast };
