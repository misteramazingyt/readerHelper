// store.js — the single mutable state tree, every mutation, undo, and persistence.
//
// Mutations go through `commit(label, fn)`. That snapshots for undo, stamps
// modifiedAt, persists to localStorage, and notifies subscribers. Nothing else
// should write to the tree directly.

import {
  SCHEMA_VERSION,
  emptyState,
  newProject,
  newGroup,
  newItem,
  newPlacement,
  now,
  uid,
  clamp01,
  itemProgress,
  placementsOfGroup,
  siblingPlacements,
} from './model.js';
import { addTombstone, pruneTombstones, PORTABLE_SETTINGS } from './merge.js';

const LS_STATE = 'readerHelper.state.v1';
const LS_SETTINGS = 'readerHelper.settings.v1';
const UNDO_LIMIT = 50;

export const DEFAULT_SETTINGS = {
  zoteroApiKey: '',
  zoteroUserId: '',
  zoteroProjectsRoot: '01 Projects',
  goodreadsUserId: '',
  goodreadsAutoUpload: false,
  goodreadsShelves: 'read, currently-reading, to-read',
  todoistApiKey: '',
  githubToken: '',
  gistId: '',
  gistSyncEnabled: true,
  localPdfHandler: 'zotero', // 'zotero' | 'protocol'
  promptMarkReadAt: 1.0,
  theme: 'auto',
};

let state = emptyState();
let settings = { ...DEFAULT_SETTINGS };
const undoStack = [];
const redoStack = [];
const listeners = new Set();
let suspendDepth = 0;
let dirtyWhileSuspended = false;

// ------------------------------------------------------------- subscriptions

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  if (suspendDepth > 0) {
    dirtyWhileSuspended = true;
    return;
  }
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error('subscriber failed', err);
    }
  }
}

/** Batch several commits into one render pass (used by multi-select actions). */
export function batch(fn) {
  suspendDepth += 1;
  try {
    return fn();
  } finally {
    suspendDepth -= 1;
    if (suspendDepth === 0 && dirtyWhileSuspended) {
      dirtyWhileSuspended = false;
      notify();
    }
  }
}

export function getState() {
  return state;
}

export function getSettings() {
  return settings;
}

// --------------------------------------------------------------- persistence

export function loadFromDisk() {
  try {
    const rawSettings = localStorage.getItem(LS_SETTINGS);
    if (rawSettings) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(rawSettings) };
    // Sync used to be opt-in, which meant a second computer silently started
    // its own board. Turn it on once for anyone carrying the old default; a
    // deliberate later toggle is respected because the flag is then set.
    if (!settings.syncDefaultsApplied) {
      settings = { ...settings, gistSyncEnabled: true, syncDefaultsApplied: true };
      try {
        localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn('settings unreadable, using defaults', err);
  }
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (raw) {
      state = migrate(JSON.parse(raw));
      return true;
    }
  } catch (err) {
    console.warn('state unreadable, starting empty', err);
  }
  return false;
}

function migrate(loaded) {
  const base = emptyState();
  const merged = { ...base, ...loaded };
  merged.ui = { ...base.ui, ...(loaded.ui || {}) };
  merged.meta = { ...base.meta, ...(loaded.meta || {}) };
  merged.version = SCHEMA_VERSION;
  // Defend against a half-written tree: drop dangling references.
  for (const [id, p] of Object.entries(merged.placements || {})) {
    if (!merged.items[p.itemId] || !merged.groups[p.groupId]) delete merged.placements[id];
  }
  for (const g of Object.values(merged.groups || {})) {
    g.placementOrder = (g.placementOrder || []).filter((pid) => merged.placements[pid]);
  }
  for (const prj of Object.values(merged.projects || {})) {
    prj.groupOrder = (prj.groupOrder || []).filter((gid) => merged.groups[gid]);
  }
  merged.projectOrder = (merged.projectOrder || []).filter((pid) => merged.projects[pid]);
  merged.deleted = pruneTombstones(merged.deleted || {});
  return merged;
}

function persist() {
  try {
    localStorage.setItem(LS_STATE, JSON.stringify(state));
  } catch (err) {
    console.error('could not persist state', err);
  }
}

export function saveSettings(patch) {
  // Only a change to a *portable* setting bumps the stamp, so pasting a local
  // API key does not make this machine look like the newer authority.
  const touchesPortable = Object.keys(patch).some(
    (k) => PORTABLE_SETTINGS.includes(k) && patch[k] !== settings[k],
  );
  settings = { ...settings, ...patch };
  if (touchesPortable) settings.settingsModifiedAt = now();
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  } catch (err) {
    console.error('could not persist settings', err);
  }
  notify();
}

/** The settings that travel with the board, for the Gist mirror. */
export function portableSettings() {
  const out = {};
  for (const key of PORTABLE_SETTINGS) {
    if (settings[key] !== undefined && settings[key] !== '') out[key] = settings[key];
  }
  out.settingsModifiedAt = settings.settingsModifiedAt || '';
  return out;
}

/** Apply settings that arrived from another machine, without touching secrets. */
export function applyPortableSettings(incoming) {
  if (!incoming) return false;
  const mine = settings.settingsModifiedAt || '';
  if (incoming.settingsModifiedAt && incoming.settingsModifiedAt <= mine) return false;
  const patch = {};
  for (const key of PORTABLE_SETTINGS) {
    if (incoming[key] !== undefined && incoming[key] !== settings[key]) patch[key] = incoming[key];
  }
  if (!Object.keys(patch).length) return false;
  patch.settingsModifiedAt = incoming.settingsModifiedAt;
  settings = { ...settings, ...patch };
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  } catch { /* ignore */ }
  notify();
  return true;
}

export function replaceState(next, label = 'replace state') {
  commit(label, () => {
    state = migrate(next);
  });
}

export function exportState() {
  return JSON.parse(JSON.stringify(state));
}

// ---------------------------------------------------------------- undo/redo

export function commit(label, fn) {
  const snapshot = JSON.stringify(state);
  const result = fn(state);
  undoStack.push({ label, snapshot });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  persist();
  notify();
  return result;
}

export function undo() {
  const entry = undoStack.pop();
  if (!entry) return null;
  redoStack.push({ label: entry.label, snapshot: JSON.stringify(state) });
  state = JSON.parse(entry.snapshot);
  persist();
  notify();
  return entry.label;
}

export function redo() {
  const entry = redoStack.pop();
  if (!entry) return null;
  undoStack.push({ label: entry.label, snapshot: JSON.stringify(state) });
  state = JSON.parse(entry.snapshot);
  persist();
  notify();
  return entry.label;
}

export function canUndo() {
  return undoStack.length > 0;
}

export function canRedo() {
  return redoStack.length > 0;
}

function touch(obj) {
  if (obj) obj.modifiedAt = now();
}

// ----------------------------------------------------------------- projects

export function addProject(name = 'Untitled Project', extra = {}) {
  return commit('add project', (s) => {
    const prj = newProject(name, extra);
    s.projects[prj.id] = prj;
    s.projectOrder.push(prj.id);
    if (!s.ui.activeProjectId) s.ui.activeProjectId = prj.id;
    return prj;
  });
}

export function renameProject(projectId, name) {
  return commit('rename project', (s) => {
    const prj = s.projects[projectId];
    if (!prj) return null;
    prj.name = name;
    touch(prj);
    return prj;
  });
}

export function deleteProject(projectId, { deleteItems = false } = {}) {
  return commit('delete project', (s) => {
    const prj = s.projects[projectId];
    if (!prj) return;
    for (const gid of [...prj.groupOrder]) removeGroupInternal(s, gid, deleteItems);
    addTombstone(s, 'project', projectId);
    delete s.projects[projectId];
    s.projectOrder = s.projectOrder.filter((id) => id !== projectId);
    if (s.ui.activeProjectId === projectId) {
      s.ui.activeProjectId = s.projectOrder[0] || null;
    }
  });
}

export function setActiveProject(projectId) {
  return commit('switch project', (s) => {
    s.ui.activeProjectId = projectId;
  });
}

export function reorderProject(projectId, toIndex) {
  return commit('reorder project', (s) => {
    const from = s.projectOrder.indexOf(projectId);
    if (from < 0) return;
    s.projectOrder.splice(from, 1);
    s.projectOrder.splice(clampIndex(toIndex, s.projectOrder.length), 0, projectId);
  });
}

export function setProjectSort(mode, dir) {
  return commit('sort projects', (s) => {
    s.ui.projectSort = { mode, dir };
  });
}

/** Deep-copy a project, its groups, and a fresh set of placements onto the same items. */
export function duplicateProject(projectId) {
  return commit('duplicate project', (s) => {
    const src = s.projects[projectId];
    if (!src) return null;
    const copy = newProject(`${src.name} (copy)`, { groupSort: { ...src.groupSort } });
    s.projects[copy.id] = copy;
    s.projectOrder.splice(s.projectOrder.indexOf(projectId) + 1, 0, copy.id);
    for (const gid of src.groupOrder) {
      const g = s.groups[gid];
      if (!g) continue;
      const gCopy = newGroup(copy.id, g.name, { itemSort: { ...g.itemSort } });
      s.groups[gCopy.id] = gCopy;
      copy.groupOrder.push(gCopy.id);
      for (const pid of g.placementOrder) {
        const p = s.placements[pid];
        if (!p) continue;
        const pCopy = newPlacement(p.itemId, gCopy.id);
        s.placements[pCopy.id] = pCopy;
        gCopy.placementOrder.push(pCopy.id);
      }
    }
    return copy;
  });
}

// ------------------------------------------------------------------- groups

export function addGroup(projectId, name = 'Untitled Group', extra = {}) {
  return commit('add group', (s) => {
    const prj = s.projects[projectId];
    if (!prj) return null;
    const g = newGroup(projectId, name, extra);
    s.groups[g.id] = g;
    prj.groupOrder.push(g.id);
    touch(prj);
    return g;
  });
}

export function renameGroup(groupId, name) {
  return commit('rename group', (s) => {
    const g = s.groups[groupId];
    if (!g) return null;
    g.name = name;
    touch(g);
    return g;
  });
}

function removeGroupInternal(s, groupId, deleteItems) {
  const g = s.groups[groupId];
  if (!g) return;
  for (const pid of [...g.placementOrder]) {
    const p = s.placements[pid];
    if (!p) continue;
    addTombstone(s, 'placement', pid);
    delete s.placements[pid];
    const remaining = Object.values(s.placements).some((q) => q.itemId === p.itemId);
    if (deleteItems && !remaining) {
      addTombstone(s, 'item', p.itemId);
      delete s.items[p.itemId];
    }
  }
  const prj = s.projects[g.projectId];
  if (prj) {
    prj.groupOrder = prj.groupOrder.filter((id) => id !== groupId);
    touch(prj);
  }
  addTombstone(s, 'group', groupId);
  delete s.groups[groupId];
}

export function deleteGroup(groupId, { deleteItems = false } = {}) {
  return commit('delete group', (s) => removeGroupInternal(s, groupId, deleteItems));
}

export function moveGroup(groupId, toProjectId, toIndex = null) {
  return commit('move group', (s) => {
    const g = s.groups[groupId];
    const dest = s.projects[toProjectId];
    if (!g || !dest) return;
    const src = s.projects[g.projectId];
    if (src) {
      src.groupOrder = src.groupOrder.filter((id) => id !== groupId);
      touch(src);
    }
    g.projectId = toProjectId;
    const idx = toIndex === null ? dest.groupOrder.length : clampIndex(toIndex, dest.groupOrder.length);
    dest.groupOrder.splice(idx, 0, groupId);
    touch(g);
    touch(dest);
  });
}

export function reorderGroup(groupId, toIndex) {
  return commit('reorder group', (s) => {
    const g = s.groups[groupId];
    if (!g) return;
    const prj = s.projects[g.projectId];
    if (!prj) return;
    const from = prj.groupOrder.indexOf(groupId);
    if (from < 0) return;
    prj.groupOrder.splice(from, 1);
    prj.groupOrder.splice(clampIndex(toIndex, prj.groupOrder.length), 0, groupId);
    touch(prj);
  });
}

export function setGroupSort(groupId, mode, dir) {
  return commit('sort group', (s) => {
    const g = s.groups[groupId];
    if (!g) return;
    g.itemSort = { mode, dir };
  });
}

export function setProjectGroupSort(projectId, mode, dir) {
  return commit('sort groups', (s) => {
    const prj = s.projects[projectId];
    if (!prj) return;
    prj.groupSort = { mode, dir };
  });
}

/** Copy a group into a project, reusing the same items (shadow copies). */
export function copyGroup(groupId, toProjectId) {
  return commit('copy group', (s) => {
    const src = s.groups[groupId];
    const dest = s.projects[toProjectId];
    if (!src || !dest) return null;
    const gCopy = newGroup(toProjectId, src.name, { itemSort: { ...src.itemSort } });
    s.groups[gCopy.id] = gCopy;
    dest.groupOrder.push(gCopy.id);
    for (const pid of src.placementOrder) {
      const p = s.placements[pid];
      if (!p) continue;
      const pCopy = newPlacement(p.itemId, gCopy.id);
      s.placements[pCopy.id] = pCopy;
      gCopy.placementOrder.push(pCopy.id);
    }
    touch(dest);
    return gCopy;
  });
}

export function duplicateGroup(groupId) {
  const g = state.groups[groupId];
  if (!g) return null;
  return copyGroup(groupId, g.projectId);
}

// -------------------------------------------------------------------- items

export function addItem(groupId, fields = {}) {
  return commit('add book', (s) => {
    const g = s.groups[groupId];
    if (!g) return null;
    const item = newItem(fields);
    s.items[item.id] = item;
    const p = newPlacement(item.id, groupId);
    s.placements[p.id] = p;
    g.placementOrder.push(p.id);
    touch(g);
    return { item, placement: p };
  });
}

export function updateItem(itemId, patch) {
  return commit('edit book', (s) => {
    const item = s.items[itemId];
    if (!item) return null;
    Object.assign(item, patch);
    touch(item);
    return item;
  });
}

export function renameItem(itemId, title) {
  return updateItem(itemId, { title });
}

export function setItemTag(itemId, tag) {
  return updateItem(itemId, { tag });
}

/**
 * Duplicate = a second placement on the SAME item. Both copies stay bound to one
 * record, so editing either edits both, but each can be dragged independently.
 */
export function duplicatePlacement(placementId, toGroupId = null) {
  return commit('duplicate book', (s) => {
    const p = s.placements[placementId];
    if (!p) return null;
    const groupId = toGroupId || p.groupId;
    const g = s.groups[groupId];
    if (!g) return null;
    const copy = newPlacement(p.itemId, groupId);
    s.placements[copy.id] = copy;
    const at = groupId === p.groupId ? g.placementOrder.indexOf(placementId) + 1 : g.placementOrder.length;
    g.placementOrder.splice(at, 0, copy.id);
    touch(g);
    return copy;
  });
}

export function movePlacement(placementId, toGroupId, toIndex = null) {
  return commit('move book', (s) => {
    const p = s.placements[placementId];
    const dest = s.groups[toGroupId];
    if (!p || !dest) return;
    const src = s.groups[p.groupId];
    if (src) {
      src.placementOrder = src.placementOrder.filter((id) => id !== placementId);
      touch(src);
    }
    p.groupId = toGroupId;
    const idx = toIndex === null ? dest.placementOrder.length : clampIndex(toIndex, dest.placementOrder.length);
    dest.placementOrder.splice(idx, 0, placementId);
    touch(dest);
  });
}

export function reorderPlacement(placementId, toIndex) {
  return commit('reorder book', (s) => {
    const p = s.placements[placementId];
    if (!p) return;
    const g = s.groups[p.groupId];
    if (!g) return;
    const from = g.placementOrder.indexOf(placementId);
    if (from < 0) return;
    g.placementOrder.splice(from, 1);
    g.placementOrder.splice(clampIndex(toIndex, g.placementOrder.length), 0, placementId);
    touch(g);
  });
}

/**
 * Remove one copy from the board. The underlying item survives as long as any
 * other placement still points at it; `purge` deletes the record outright.
 */
export function removePlacement(placementId, { purge = false } = {}) {
  return commit('remove book', (s) => {
    const p = s.placements[placementId];
    if (!p) return;
    const g = s.groups[p.groupId];
    if (g) {
      g.placementOrder = g.placementOrder.filter((id) => id !== placementId);
      touch(g);
    }
    const itemId = p.itemId;
    addTombstone(s, 'placement', placementId);
    delete s.placements[placementId];
    const orphaned = !Object.values(s.placements).some((q) => q.itemId === itemId);
    if (purge || orphaned) {
      addTombstone(s, 'item', itemId);
      delete s.items[itemId];
    }
  });
}

export function archiveItem(itemId, archived = true) {
  return updateItem(itemId, {
    archived,
    markedReadAt: archived ? now() : null,
  });
}

// -------------------------------------------------------------- reading log

/**
 * Record a reading session. `entry` comes from nlp.parseReading and carries a
 * resolved absolute page when one could be derived.
 */
export function logReading(itemId, entry) {
  return commit('log reading', (s) => {
    const item = s.items[itemId];
    if (!item) return null;
    item.readingLog.push({ id: uid('log'), ts: now(), ...entry });
    if (typeof entry.resolvedPage === 'number' && Number.isFinite(entry.resolvedPage)) {
      item.currentPage = Math.max(0, Math.round(entry.resolvedPage));
      if (item.totalPages) item.currentPage = Math.min(item.currentPage, item.totalPages);
    }
    if (typeof entry.resolvedFraction === 'number' && !item.totalPages) {
      item.progress = clamp01(entry.resolvedFraction);
    }
    if (item.totalPages) item.progress = itemProgress(item);
    touch(item);
    return item;
  });
}

export function setProgressFraction(itemId, fraction) {
  return commit('set progress', (s) => {
    const item = s.items[itemId];
    if (!item) return null;
    const f = clamp01(fraction);
    item.progress = f;
    if (item.totalPages) item.currentPage = Math.round(f * item.totalPages);
    touch(item);
    return item;
  });
}

export function setCurrentPage(itemId, page) {
  return commit('set page', (s) => {
    const item = s.items[itemId];
    if (!item) return null;
    item.currentPage = Math.max(0, Math.round(page));
    if (item.totalPages) {
      item.currentPage = Math.min(item.currentPage, item.totalPages);
      item.progress = itemProgress(item);
    }
    touch(item);
    return item;
  });
}

// ------------------------------------------------------------- per-book work

export function addItemTask(itemId, text) {
  return commit('add task', (s) => {
    const item = s.items[itemId];
    if (!item) return null;
    const task = { id: uid('tsk'), text, done: false, todoistId: null, createdAt: now() };
    item.tasks.push(task);
    touch(item);
    return task;
  });
}

export function updateItemTask(itemId, taskId, patch) {
  return commit('edit task', (s) => {
    const item = s.items[itemId];
    const task = item?.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    Object.assign(task, patch);
    touch(item);
    return task;
  });
}

export function removeItemTask(itemId, taskId) {
  return commit('delete task', (s) => {
    const item = s.items[itemId];
    if (!item) return;
    item.tasks = item.tasks.filter((t) => t.id !== taskId);
    touch(item);
  });
}

export function setItemNotes(itemId, notes) {
  return updateItem(itemId, { notes });
}

// ------------------------------------------------------------------- lookup

export function findItemByZoteroKey(zoteroKey) {
  return Object.values(state.items).find((i) => i.zoteroKey && i.zoteroKey === zoteroKey) || null;
}

export function findGroupByCollection(collectionKey) {
  return Object.values(state.groups).find((g) => g.zoteroCollectionKey === collectionKey) || null;
}

export function findProjectByCollection(collectionKey) {
  return Object.values(state.projects).find((p) => p.zoteroCollectionKey === collectionKey) || null;
}

export function allItems({ includeArchived = false } = {}) {
  return Object.values(state.items).filter((i) => includeArchived || !i.archived);
}

/** Where does this item currently sit? Returns one row per placement. */
export function locationsOfItem(itemId) {
  return Object.values(state.placements)
    .filter((p) => p.itemId === itemId)
    .map((p) => {
      const g = state.groups[p.groupId];
      const prj = g ? state.projects[g.projectId] : null;
      return { placement: p, group: g, project: prj };
    })
    .filter((row) => row.group && row.project);
}

export function setMeta(patch) {
  return commit('update sync metadata', (s) => {
    s.meta = { ...s.meta, ...patch };
  });
}

function clampIndex(i, len) {
  if (!Number.isFinite(i)) return len;
  return Math.max(0, Math.min(len, i));
}

export { siblingPlacements, placementsOfGroup };
