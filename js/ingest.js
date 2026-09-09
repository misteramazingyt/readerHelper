// ingest.js — turning a Zotero collection into board structure.
//
// Split deliberately into two phases:
//
//   buildPlan()  — all the network work, producing a plain description of what
//                  the board should contain. Async, no state touched.
//   applyPlan()  — a synchronous, pure mutation of a state object.
//
// That split is what lets the browser wrap the mutation in a single undoable
// commit, and lets the nightly GitHub Action run the exact same logic against a
// state object pulled from the Gist. One implementation, two runtimes.

import { newProject, newGroup, newItem, newPlacement, now } from './model.js';

export const UNSORTED = 'Unsorted';

/**
 * Fetch a collection and its subcollections.
 * @param {object} cfg   settings carrying zoteroApiKey / zoteroUserId
 * @param {object} zot   the zotero.js module (injected so Node and the browser share it)
 * @returns {{root, groups: Array<{name, collectionKey, items: object[]}>}}
 */
export async function buildPlan(cfg, zot, collectionKey, { onProgress } = {}) {
  const report = (msg) => onProgress?.(msg);

  const all = await zot.fetchCollections(cfg);
  const root = all.find((c) => c.key === collectionKey);
  if (!root) throw new Error('That collection no longer exists in Zotero.');

  const subs = all.filter((c) => c.parentCollection === collectionKey);
  const groups = [];

  report(`Reading “${root.name}”…`);
  const topRows = await zot.fetchCollectionItems(cfg, collectionKey);
  if (topRows.length) {
    groups.push({
      name: subs.length ? UNSORTED : root.name,
      // Only claim the collection key when this group really is the collection.
      collectionKey: subs.length ? null : collectionKey,
      items: await toFields(cfg, zot, topRows, report, root.name),
    });
  }

  for (const sub of subs) {
    report(`Reading “${sub.name}”…`);
    const rows = await zot.fetchCollectionItems(cfg, sub.key);
    groups.push({
      name: sub.name,
      collectionKey: sub.key,
      items: await toFields(cfg, zot, rows, report, sub.name),
    });
  }

  return { root, groups };
}

async function toFields(cfg, zot, rows, report, label) {
  const out = [];
  let i = 0;
  for (const row of rows) {
    i += 1;
    if (i % 5 === 0) report(`${label}: ${i}/${rows.length}…`);
    try {
      out.push(await zot.toItemFields(cfg, row));
    } catch (err) {
      // A single unreadable item should not abort a 300-item collection.
      console.warn(`skipped ${row.key}`, err?.message || err);
    }
  }
  return out;
}

/**
 * Apply a plan to a state tree. Additive by design: it creates what is missing
 * and refreshes bibliographic fields, but never deletes a card, because reading
 * progress and notes exist only here.
 *
 * @returns {{projectId, groups, added, updated, unchanged, renamed}}
 */
export function applyPlan(state, plan) {
  const report = { projectId: null, groups: 0, added: 0, updated: 0, unchanged: 0, renamed: 0 };

  let project = Object.values(state.projects).find((p) => p.zoteroCollectionKey === plan.root.key);
  if (!project) {
    project = newProject(plan.root.name, { zoteroCollectionKey: plan.root.key });
    state.projects[project.id] = project;
    state.projectOrder.push(project.id);
  } else if (project.name !== plan.root.name) {
    project.name = plan.root.name;
    project.modifiedAt = now();
    report.renamed += 1;
  }
  report.projectId = project.id;

  for (const planned of plan.groups) {
    const group = ensureGroup(state, project, planned.name, planned.collectionKey);
    report.groups += 1;
    for (const fields of planned.items) {
      ingestOne(state, group, fields, report);
    }
  }

  if (!state.ui.activeProjectId) state.ui.activeProjectId = project.id;
  state.meta.lastZoteroSync = now();
  return report;
}

function ensureGroup(state, project, name, collectionKey) {
  if (collectionKey) {
    const linked = Object.values(state.groups).find((g) => g.zoteroCollectionKey === collectionKey);
    if (linked) {
      if (linked.name !== name) {
        linked.name = name;
        linked.modifiedAt = now();
      }
      return linked;
    }
  }
  const byName = project.groupOrder
    .map((id) => state.groups[id])
    .find((g) => g && g.name.toLowerCase() === name.toLowerCase());
  if (byName) {
    if (collectionKey && !byName.zoteroCollectionKey) byName.zoteroCollectionKey = collectionKey;
    return byName;
  }
  const group = newGroup(project.id, name, { zoteroCollectionKey: collectionKey || null });
  state.groups[group.id] = group;
  project.groupOrder.push(group.id);
  project.modifiedAt = now();
  return group;
}

function ingestOne(state, group, fields, report) {
  const existing = fields.zoteroKey
    ? Object.values(state.items).find((i) => i.zoteroKey === fields.zoteroKey)
    : null;

  if (!existing) {
    const item = newItem(fields);
    state.items[item.id] = item;
    place(state, group, item.id);
    report.added += 1;
    return;
  }

  // Refresh bibliography, never reading state.
  if (existing.zoteroVersion !== fields.zoteroVersion) {
    Object.assign(existing, {
      title: fields.title,
      authors: fields.authors,
      year: fields.year,
      doi: fields.doi,
      isbn: fields.isbn,
      url: fields.url,
      citekey: fields.citekey,
      zoteroVersion: fields.zoteroVersion,
      pdfAttachmentKey: fields.pdfAttachmentKey ?? existing.pdfAttachmentKey,
      localPdfPath: fields.localPdfPath ?? existing.localPdfPath,
      // A page count the user entered by hand outranks Zotero's guess.
      totalPages: existing.totalPages || fields.totalPages,
      modifiedAt: now(),
    });
    report.updated += 1;
  } else {
    report.unchanged += 1;
  }

  const alreadyHere = group.placementOrder.some((pid) => state.placements[pid]?.itemId === existing.id);
  if (!alreadyHere) place(state, group, existing.id);
}

function place(state, group, itemId) {
  const placement = newPlacement(itemId, group.id);
  state.placements[placement.id] = placement;
  group.placementOrder.push(placement.id);
  group.modifiedAt = now();
}

/** Every collection key the board is currently tracking. */
export function linkedCollectionKeys(state) {
  return Object.values(state.projects)
    .map((p) => p.zoteroCollectionKey)
    .filter(Boolean);
}
