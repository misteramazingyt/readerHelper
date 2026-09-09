// selection.js — multi-select that survives switching projects.
//
// Selection is keyed by placement id and deliberately NOT cleared when the
// active project changes: the spec calls for ctrl-clicking books across
// projects and having them all still selected when you come back. Esc clears.

const selected = new Set();
const listeners = new Set();

export function subscribeSelection(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(getSelection());
}

export function getSelection() {
  return [...selected];
}

export function selectionSize() {
  return selected.size;
}

export function isSelected(placementId) {
  return selected.has(placementId);
}

export function hasSelection() {
  return selected.size > 0;
}

export function toggle(placementId) {
  if (selected.has(placementId)) selected.delete(placementId);
  else selected.add(placementId);
  notify();
}

export function add(placementId) {
  if (!selected.has(placementId)) {
    selected.add(placementId);
    notify();
  }
}

export function replaceWith(ids) {
  selected.clear();
  for (const id of ids) selected.add(id);
  notify();
}

export function clearSelection() {
  if (!selected.size) return false;
  selected.clear();
  notify();
  return true;
}

/** Drop ids that no longer exist after a delete or a sync. */
export function pruneSelection(state) {
  let changed = false;
  for (const id of [...selected]) {
    const p = state.placements[id];
    if (!p || !state.items[p.itemId] || state.items[p.itemId].archived) {
      selected.delete(id);
      changed = true;
    }
  }
  if (changed) notify();
  return changed;
}

/** Range-select within one group, for shift-click. */
export function selectRange(state, groupId, fromId, toId) {
  const order = state.groups[groupId]?.placementOrder || [];
  const a = order.indexOf(fromId);
  const b = order.indexOf(toId);
  if (a < 0 || b < 0) return;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i += 1) selected.add(order[i]);
  notify();
}

/** Distinct item ids behind the current selection (a book may be selected twice). */
export function selectedItemIds(state) {
  const ids = new Set();
  for (const pid of selected) {
    const p = state.placements[pid];
    if (p) ids.add(p.itemId);
  }
  return [...ids];
}
