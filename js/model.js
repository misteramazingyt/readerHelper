// model.js — data shapes, ids, and pure helpers.
//
// Core idea: a book is an ITEM (canonical, edited once). It appears on the board
// through PLACEMENTS. Duplicating a book creates a second placement pointing at
// the same itemId, so edits propagate both ways automatically, while dragging a
// placement moves only that copy.

export const SCHEMA_VERSION = 1;

export const TAGS = ['Full', 'Partial', 'Digest', 'Manual', 'Skim'];

export const TAG_COLORS = {
  Full: '#38d16a',
  Partial: '#f5c542',
  Digest: '#4aa3ff',
  Manual: '#c78bff',
  Skim: '#ff8a5c',
};

export const SORT_MODES = ['custom', 'modified', 'created', 'alpha'];

export const SORT_LABELS = {
  custom: 'Custom',
  modified: 'Modified',
  created: 'Created',
  alpha: 'Alphabetical',
};

let idCounter = 0;

export function uid(prefix = 'id') {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

export function now() {
  return new Date().toISOString();
}

export function emptyState() {
  return {
    version: SCHEMA_VERSION,
    projects: {},   // sidebar entries  -> Todoist Project
    groups: {},     // kanban columns   -> Todoist Section
    items: {},      // canonical books
    placements: {}, // book appearances on the board
    projectOrder: [],
    ui: {
      activeProjectId: null,
      projectSort: { mode: 'custom', dir: 'asc' },
    },
    meta: {
      lastZoteroSync: null,
      lastGistPush: null,
      gistId: null,
    },
  };
}

export function newProject(name = 'Untitled Project', extra = {}) {
  return {
    id: uid('prj'),
    name,
    groupOrder: [],
    groupSort: { mode: 'custom', dir: 'asc' },
    zoteroCollectionKey: null,
    todoistProjectId: null,
    createdAt: now(),
    modifiedAt: now(),
    ...extra,
  };
}

export function newGroup(projectId, name = 'Untitled Group', extra = {}) {
  return {
    id: uid('grp'),
    projectId,
    name,
    placementOrder: [],
    itemSort: { mode: 'custom', dir: 'asc' },
    zoteroCollectionKey: null,
    todoistSectionId: null,
    createdAt: now(),
    modifiedAt: now(),
    ...extra,
  };
}

export function newItem(fields = {}) {
  return {
    id: uid('itm'),
    title: 'Untitled',
    authors: [],
    year: null,
    doi: null,
    isbn: null,
    url: null,
    itemType: 'book',
    // Bibliographic detail, kept so a bibliography can be exported without
    // going back to the network for what a lookup already told us.
    publisher: null,
    container: null,   // journal or book title for a chapter
    volume: null,
    issue: null,
    pages: null,       // the range within a container, e.g. "45-71"
    abstract: null,
    // Zotero linkage
    zoteroKey: null,
    zoteroLibrary: null, // e.g. "users/12345"
    citekey: null,
    zoteroVersion: null,
    localPdfPath: null,
    pdfAttachmentKey: null,
    // reading progress
    totalPages: null,
    totalChapters: null,
    paragraphsPerPage: null, // per-book override of the global estimate
    currentPage: 0,
    progress: 0, // 0..1, authoritative when totalPages is unknown
    tag: null,
    readingLog: [],
    // per-book workspace
    tasks: [],
    notes: '',
    archived: false,
    markedReadAt: null,
    createdAt: now(),
    modifiedAt: now(),
    ...fields,
  };
}

export function newPlacement(itemId, groupId, extra = {}) {
  return {
    id: uid('plc'),
    itemId,
    groupId,
    createdAt: now(),
    ...extra,
  };
}

export function newTask(text = '') {
  return {
    id: uid('tsk'),
    text,
    done: false,
    todoistId: null,
    createdAt: now(),
  };
}

// ---------------------------------------------------------------- selectors

export function itemOfPlacement(state, placementId) {
  const p = state.placements[placementId];
  return p ? state.items[p.itemId] : null;
}

/** Every placement of the same item — the original plus all shadow copies. */
export function siblingPlacements(state, placementId) {
  const p = state.placements[placementId];
  if (!p) return [];
  return Object.values(state.placements).filter((q) => q.itemId === p.itemId);
}

export function isDuplicated(state, placementId) {
  return siblingPlacements(state, placementId).length > 1;
}

export function groupsOfProject(state, projectId) {
  const prj = state.projects[projectId];
  if (!prj) return [];
  return prj.groupOrder.map((id) => state.groups[id]).filter(Boolean);
}

export function placementsOfGroup(state, groupId) {
  const g = state.groups[groupId];
  if (!g) return [];
  return g.placementOrder.map((id) => state.placements[id]).filter(Boolean);
}

/** Visible (non-archived) placements of a group, ordered per the group sort view. */
export function visiblePlacements(state, groupId) {
  const g = state.groups[groupId];
  if (!g) return [];
  const rows = placementsOfGroup(state, groupId)
    .map((p) => ({ placement: p, item: state.items[p.itemId] }))
    .filter((r) => r.item && !r.item.archived);
  return applySort(rows, g.itemSort, {
    alpha: (r) => (r.item.title || '').toLowerCase(),
    created: (r) => r.item.createdAt,
    modified: (r) => r.item.modifiedAt,
  });
}

export function orderedGroups(state, projectId) {
  const prj = state.projects[projectId];
  if (!prj) return [];
  const rows = groupsOfProject(state, projectId).map((g) => ({ group: g }));
  return applySort(rows, prj.groupSort, {
    alpha: (r) => (r.group.name || '').toLowerCase(),
    created: (r) => r.group.createdAt,
    modified: (r) => r.group.modifiedAt,
  }).map((r) => r.group);
}

export function orderedProjects(state) {
  const rows = state.projectOrder
    .map((id) => state.projects[id])
    .filter(Boolean)
    .map((p) => ({ p }));
  return applySort(rows, state.ui.projectSort, {
    alpha: (r) => (r.p.name || '').toLowerCase(),
    created: (r) => r.p.createdAt,
    modified: (r) => r.p.modifiedAt,
  }).map((r) => r.p);
}

/**
 * Sort helper. `custom` preserves the stored drag-drop order; every other mode
 * derives a key. `dir` flips all of them, custom included.
 */
export function applySort(rows, sort, keyFns) {
  const mode = sort?.mode || 'custom';
  const dir = sort?.dir === 'desc' ? -1 : 1;
  if (mode === 'custom') return dir === 1 ? rows : [...rows].reverse();
  const keyFn = keyFns[mode];
  if (!keyFn) return rows;
  return [...rows].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka === kb) return 0;
    return (ka > kb ? 1 : -1) * dir;
  });
}

// ------------------------------------------------------------ progress math

/**
 * Progress is stored as a 0..1 fraction. When totalPages is known, currentPage
 * is authoritative and progress is derived; otherwise progress stands alone.
 */
export function itemProgress(item) {
  if (!item) return 0;
  if (item.totalPages && item.totalPages > 0) {
    return clamp01((item.currentPage || 0) / item.totalPages);
  }
  return clamp01(item.progress || 0);
}

export function clamp01(n) {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Mean progress across every distinct (non-archived) book in a project. */
export function projectProgress(state, projectId) {
  const seen = new Set();
  let sum = 0;
  let count = 0;
  for (const g of groupsOfProject(state, projectId)) {
    for (const p of placementsOfGroup(state, g.id)) {
      if (seen.has(p.itemId)) continue;
      const item = state.items[p.itemId];
      if (!item || item.archived) continue;
      seen.add(p.itemId);
      sum += itemProgress(item);
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

export function authorLabel(item) {
  if (!item?.authors?.length) return '';
  const [first] = item.authors;
  if (item.authors.length === 1) return first;
  if (item.authors.length === 2) return `${first} & ${item.authors[1]}`;
  return `${first} et al.`;
}
