// sync.js — the browser side of Zotero import and re-sync.
//
// The actual structural logic lives in ingest.js and is shared verbatim with
// the nightly GitHub Action, so the two can never drift. This module handles
// only what is browser-specific: picking a collection, showing progress, and
// wrapping the mutation in a single undoable commit.
//
// Shape, per the spec: a Zotero collection becomes a PROJECT, and each of its
// subcollections becomes a GROUP (a column).

import * as store from './store.js';
import * as zotero from './zotero.js';
import { buildPlan, applyPlan, linkedCollectionKeys } from './ingest.js';
import { toast, errorToast, showBusy, openModal, el } from './ui.js';
import { fuzzyScore } from './nlp.js';

export function zoteroConfigured() {
  const cfg = store.getSettings();
  return Boolean(cfg.zoteroApiKey && cfg.zoteroUserId);
}

/** The "Z" button: choose a collection, then import it as a project. */
export async function promptZoteroImport() {
  if (!zoteroConfigured()) {
    toast('Add your Zotero API key and user ID in Settings first.', { type: 'error', timeout: 5000 });
    return null;
  }
  const cfg = store.getSettings();
  const busy = showBusy('Loading Zotero collections…');
  let collections;
  try {
    collections = await zotero.fetchCollections(cfg);
  } catch (err) {
    busy.done();
    errorToast(err, 'Zotero');
    return null;
  }
  busy.done();

  if (!collections.length) {
    toast('No collections found in that Zotero library.', { type: 'error' });
    return null;
  }

  const byKey = new Map(collections.map((c) => [c.key, c]));
  const childCount = new Map();
  for (const c of collections) {
    if (!c.parentCollection) continue;
    childCount.set(c.parentCollection, (childCount.get(c.parentCollection) || 0) + 1);
  }
  const alreadyLinked = new Set(linkedCollectionKeys(store.getState()));

  const rows = collections
    .map((c) => ({
      id: c.key,
      label: c.name,
      sub: [
        pathOf(c, byKey),
        childCount.get(c.key) ? `${childCount.get(c.key)} subcollection(s)` : null,
        alreadyLinked.has(c.key) ? 'already imported' : null,
      ].filter(Boolean).join(' · '),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const chosen = await pickCollection(rows);
  if (!chosen) return null;
  return importCollection(chosen);
}

function pathOf(c, byKey) {
  const parts = [];
  let cur = c.parentCollection ? byKey.get(c.parentCollection) : null;
  let guard = 0;
  while (cur && guard < 12) {
    parts.unshift(cur.name);
    cur = cur.parentCollection ? byKey.get(cur.parentCollection) : null;
    guard += 1;
  }
  return parts.length ? parts.join(' / ') : 'top level';
}

function pickCollection(rows) {
  return openModal({
    title: 'Import a Zotero collection',
    render: (body, close) => {
      body.appendChild(el('p', 'form__intro', 'The collection becomes a project; its subcollections become groups.'));
      const search = document.createElement('input');
      search.type = 'text';
      search.className = 'picker__search';
      search.placeholder = 'Filter collections…';
      body.appendChild(search);
      const list = el('div', 'picker__list picker__list--tall');
      body.appendChild(list);

      let filtered = rows;
      let active = 0;
      const paint = () => {
        list.replaceChildren();
        filtered.forEach((row, i) => {
          const btn = el('button', `picker__row${i === active ? ' is-active' : ''}`);
          btn.type = 'button';
          btn.append(el('span', 'picker__label', row.label), el('span', 'picker__sub', row.sub));
          btn.addEventListener('click', () => close(row.id));
          list.appendChild(btn);
        });
        if (!filtered.length) list.appendChild(el('p', 'picker__empty', 'No match.'));
      };
      search.addEventListener('input', () => {
        const q = search.value.trim();
        filtered = !q
          ? rows
          : rows.map((r) => ({ r, s: fuzzyScore(q, r.label) })).filter((x) => x.s >= 0)
              .sort((a, b) => b.s - a.s).map((x) => x.r);
        active = 0;
        paint();
      });
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

/**
 * Import (or refresh) one collection. All network work happens first; the board
 * then changes in a single commit, so one Ctrl+Z undoes the whole import.
 */
export async function importCollection(collectionKey) {
  const cfg = store.getSettings();
  const busy = showBusy('Reading collection…');
  try {
    const plan = await buildPlan(cfg, zotero, collectionKey, { onProgress: (m) => busy.update(m) });
    busy.update('Updating the board…');
    const report = store.commit('import zotero collection', (s) => applyPlan(s, plan));
    store.setActiveProject(report.projectId);
    toast(summarise(plan.root.name, report), { type: 'success', timeout: 6000 });
    return report;
  } catch (err) {
    errorToast(err, 'Zotero import');
    return null;
  } finally {
    busy.done();
  }
}

function summarise(name, r) {
  const bits = [`${r.groups} group(s)`];
  if (r.added) bits.push(`${r.added} new`);
  if (r.updated) bits.push(`${r.updated} refreshed`);
  if (!r.added && !r.updated) bits.push('already up to date');
  return `“${name}”: ${bits.join(', ')}`;
}

/** Re-sync every project linked to a Zotero collection. */
export async function syncAll({ quiet = false } = {}) {
  if (!zoteroConfigured()) {
    if (!quiet) toast('Zotero is not configured yet.', { type: 'error' });
    return null;
  }
  const cfg = store.getSettings();
  const keys = linkedCollectionKeys(store.getState());
  if (!keys.length) {
    if (!quiet) toast('No projects are linked to Zotero yet. Use Z to import a collection.', { type: 'error', timeout: 5000 });
    return null;
  }

  const busy = quiet ? null : showBusy('Syncing with Zotero…');
  const totals = { groups: 0, added: 0, updated: 0, unchanged: 0 };
  const failures = [];

  try {
    for (const key of keys) {
      try {
        const plan = await buildPlan(cfg, zotero, key, { onProgress: (m) => busy?.update(m) });
        const report = store.commit('sync zotero', (s) => applyPlan(s, plan));
        totals.groups += report.groups;
        totals.added += report.added;
        totals.updated += report.updated;
        totals.unchanged += report.unchanged;
      } catch (err) {
        // One deleted collection should not stop the rest from syncing.
        failures.push(err.message);
      }
    }
    busy?.done();

    if (failures.length && !quiet) {
      errorToast(new Error(failures.join('; ')), `Synced with ${failures.length} problem(s)`);
    } else if (!quiet) {
      toast(
        totals.added || totals.updated
          ? `Sync complete: ${totals.added} new, ${totals.updated} refreshed.`
          : 'Sync complete — already up to date.',
        { type: 'success' },
      );
    } else if (totals.added) {
      toast(`Zotero sync added ${totals.added} book(s).`, { type: 'success' });
    }
    return totals;
  } catch (err) {
    busy?.done();
    if (!quiet) errorToast(err, 'Zotero sync');
    else console.warn('background sync failed', err);
    return null;
  }
}

/** Quiet sync on load, skipped if one ran within the last hour. */
export async function syncOnLoad() {
  if (!zoteroConfigured()) return;
  if (!linkedCollectionKeys(store.getState()).length) return;
  const last = store.getState().meta.lastZoteroSync;
  if (last && Date.now() - new Date(last).getTime() < 60 * 60 * 1000) return;
  await syncAll({ quiet: true });
}
