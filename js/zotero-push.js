// zotero-push.js — send books from the board back into the Zotero library.
//
// The mirror image of the import:
//
//   Zotero        01 Projects / <Project name> / <Group name> / items
//   readerHelper                 sidebar entry     column        books
//
// Two things make this more than a series of POSTs:
//
//   Collections are reused, never duplicated. A collection already named after
//   the project (or the group) is used as-is, so pushing twice does not leave
//   two "Chapter 1" folders behind.
//
//   Items are matched before they are created. A book already in the library —
//   by DOI, ISBN, URL, or title plus author and year — is filed into the new
//   collection rather than added a second time. This is the part that makes a
//   push idempotent, and it is why the index below exists.

import * as zotero from './zotero.js';

const INDEX_KEY = 'readerHelper.zoteroIndex.v1';
const DEFAULT_ROOT = '01 Projects';

// --------------------------------------------------------------- normalising

export function normDoi(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/[.,;)]+$/, '');
}

export function normIsbn(value) {
  return String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

export function normUrl(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  return s
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/#.*$/, '')     // fragment first: "/x/#frag" must end up as "/x"
    .replace(/\/+$/, '');
}

/** Title key: case, accents, punctuation and a leading article all discarded. */
export function normTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')  // combining marks, written as escapes
    .toLowerCase()
    .replace(/^(the|a|an|le|la|les|el|der|die|das)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function surnameOf(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  if (s.includes(',')) return normTitle(s.split(',')[0]);
  return normTitle(s.split(/\s+/).pop());
}

// ------------------------------------------------------------------- index

/**
 * A compact fingerprint of every top-level item in the library.
 *
 * Only the fields duplicate detection needs are kept — storing whole item
 * records would be megabytes. Refreshes are incremental via Zotero's `since`
 * parameter, so the expensive full read happens once.
 */
export function fingerprint(row) {
  const d = row.data || {};
  return {
    key: row.key,
    version: row.version,
    type: d.itemType,
    title: normTitle(d.title || ''),
    doi: normDoi(zotero.extractDoi(d) || ''),
    isbns: zotero.extractIsbns(d),
    url: normUrl(d.url || ''),
    year: (String(d.date || '').match(/\b(1\d{3}|20\d{2})\b/) || [])[1] || '',
    surname: surnameOf(zotero.creatorNames(d)[0] || ''),
    collections: d.collections || [],
  };
}

function readCache(userId) {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // A cache from another library is worse than none.
    if (String(parsed.userId) !== String(userId)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(index) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch (err) {
    // A very large library can exceed the quota; the index still works in
    // memory for this session, it just will not be there next time.
    console.warn('could not cache the Zotero index', err);
  }
}

export function clearIndexCache() {
  try {
    localStorage.removeItem(INDEX_KEY);
  } catch { /* ignore */ }
}

/**
 * Load the library index, refreshing incrementally when a cache exists.
 * @returns {{userId, version, entries: object[]}}
 */
export async function loadIndex(cfg, { onProgress, force = false } = {}) {
  const cached = force ? null : readCache(cfg.zoteroUserId);

  if (!cached) {
    onProgress?.('Reading the Zotero library for the first time…');
    const { items, version } = await zotero.fetchAllTopItems(cfg, {
      onProgress: (n, total) => onProgress?.(`Indexing ${n}/${total || '?'} Zotero items…`),
    });
    const index = {
      userId: String(cfg.zoteroUserId),
      version,
      entries: items.filter((r) => !['attachment', 'note', 'annotation'].includes(r.data?.itemType)).map(fingerprint),
    };
    writeCache(index);
    return index;
  }

  onProgress?.('Checking Zotero for changes…');
  const { items, version } = await zotero.fetchAllTopItems(cfg, {
    since: cached.version,
    onProgress: (n, total) => onProgress?.(`${n}/${total || '?'} changed items…`),
  });

  const byKey = new Map(cached.entries.map((e) => [e.key, e]));
  for (const row of items) {
    if (['attachment', 'note', 'annotation'].includes(row.data?.itemType)) continue;
    byKey.set(row.key, fingerprint(row));
  }

  if (version > cached.version) {
    try {
      const deleted = await zotero.fetchDeleted(cfg, cached.version);
      for (const key of deleted.items) byKey.delete(key);
    } catch (err) {
      console.warn('could not read Zotero deletions', err);
    }
  }

  const index = { userId: String(cfg.zoteroUserId), version, entries: [...byKey.values()] };
  writeCache(index);
  return index;
}

// ---------------------------------------------------------------- matching

/**
 * Find an existing Zotero item for a board item.
 *
 * Ordered by how much a match is worth trusting. An identifier match is
 * conclusive; a title match is not, so it additionally requires a matching
 * author surname or year before it counts.
 *
 * @returns {{key: string, reason: string} | null}
 */
export function findMatch(index, item) {
  if (item.zoteroKey) {
    const known = index.entries.find((e) => e.key === item.zoteroKey);
    if (known) return { key: known.key, reason: 'already linked' };
  }

  const doi = normDoi(item.doi);
  if (doi) {
    const hit = index.entries.find((e) => e.doi && e.doi === doi);
    if (hit) return { key: hit.key, reason: 'same DOI' };
  }

  const isbn = normIsbn(item.isbn);
  if (isbn) {
    const hit = index.entries.find((e) => e.isbns.includes(isbn));
    if (hit) return { key: hit.key, reason: 'same ISBN' };
  }

  const url = normUrl(item.url);
  if (url) {
    const hit = index.entries.find((e) => e.url && e.url === url);
    if (hit) return { key: hit.key, reason: 'same URL' };
  }

  const title = normTitle(item.title);
  if (title && title.length > 3) {
    const year = item.year ? String(item.year) : '';
    const surname = surnameOf(item.authors?.[0] || '');
    const sameTitle = index.entries.filter((e) => e.title === title);

    if (surname) {
      const hit = sameTitle.find((e) => e.surname && e.surname === surname);
      if (hit) return { key: hit.key, reason: 'same title and author' };
    }
    if (year) {
      const hit = sameTitle.find((e) => e.year && e.year === year);
      if (hit) return { key: hit.key, reason: 'same title and year' };
    }
    // A title alone is only trusted when neither side offers anything to
    // disagree about — otherwise two editions collapse into one.
    if (sameTitle.length === 1 && !surname && !year) {
      return { key: sameTitle[0].key, reason: 'same title' };
    }
  }

  return null;
}

// -------------------------------------------------------------- collections

/** Case-insensitive lookup of a collection by name under a given parent. */
export function findCollection(collections, name, parentKey) {
  const wanted = String(name || '').trim().toLowerCase();
  return collections.find(
    (c) => c.name.trim().toLowerCase() === wanted
      && (c.parentCollection || null) === (parentKey || null),
  ) || null;
}

/**
 * Resolve 01 Projects / <project> / <group>, creating only what is missing.
 *
 * Returns every level, because the caller reports what it had to create — a
 * push that silently invents folders is hard to trust.
 */
export async function ensureCollectionPath(cfg, { rootName, projectName, groupName }, { onProgress } = {}) {
  let collections = await zotero.fetchCollections(cfg);
  const created = [];

  const ensure = async (name, parentKey) => {
    const existing = findCollection(collections, name, parentKey);
    if (existing) return existing;
    onProgress?.(`Creating collection “${name}”…`);
    const [made] = await zotero.createCollections(cfg, [{ name, parentCollection: parentKey || undefined }]);
    if (!made) throw new Error(`Zotero would not create the collection “${name}”.`);
    const entry = { key: made.key, name, parentCollection: parentKey || null };
    collections = [...collections, entry];
    created.push(entry);
    return entry;
  };

  const root = await ensure(rootName || DEFAULT_ROOT, null);
  const project = await ensure(projectName, root.key);
  const group = groupName ? await ensure(groupName, project.key) : null;

  return { root, project, group, created, target: group || project };
}

// --------------------------------------------------------------------- push

/**
 * Push books into Zotero.
 *
 * @param {object} cfg      settings (zoteroApiKey, zoteroUserId, zoteroProjectsRoot)
 * @param {Array} entries   [{ item, projectName, groupName }]
 * @param {object} options  { replaceCollections, onProgress, dryRun }
 * @returns a report describing exactly what happened, per book
 */
export async function pushToZotero(cfg, entries, { replaceCollections = false, onProgress, dryRun = false, index } = {}) {
  if (!cfg.zoteroApiKey || !cfg.zoteroUserId) {
    throw new Error('Zotero is not configured — add an API key and user ID in Settings.');
  }
  if (!entries.length) throw new Error('Nothing to push.');

  const rootName = cfg.zoteroProjectsRoot || DEFAULT_ROOT;
  const libraryIndex = index || await loadIndex(cfg, { onProgress });

  // One collection path per distinct project/group pair.
  const paths = new Map();
  const createdCollections = [];
  for (const entry of entries) {
    const pathKey = JSON.stringify([entry.projectName, entry.groupName || '']);
    if (paths.has(pathKey)) continue;
    const resolved = await ensureCollectionPath(cfg, {
      rootName,
      projectName: entry.projectName,
      groupName: entry.groupName,
    }, { onProgress });
    createdCollections.push(...resolved.created);
    paths.set(pathKey, resolved);
  }

  const report = {
    created: [],     // new Zotero items
    filed: [],       // existing items added to the collection
    alreadyThere: [],// existing items already in the collection
    failed: [],
    createdCollections,
    rootName,
  };

  // A linked copy appears once per group it sits in. Collapse those to one
  // plan per book carrying every collection it belongs in, or the same book
  // would be created once per group.
  const plans = new Map();
  for (const entry of entries) {
    const { item } = entry;
    const path = paths.get(JSON.stringify([entry.projectName, entry.groupName || '']));
    const where = [entry.projectName, entry.groupName].filter(Boolean).join(' / ');
    const plan = plans.get(item.id) || { item, targetKeys: new Set(), wheres: [] };
    plan.targetKeys.add(path.target.key);
    plan.wheres.push(where);
    plans.set(item.id, plan);
  }

  const toCreate = [];   // batched, because item creation is the expensive call

  for (const plan of plans.values()) {
    const { item } = plan;
    const targetKeys = [...plan.targetKeys];
    const where = [...new Set(plan.wheres)].join(', ');

    const match = findMatch(libraryIndex, item);
    if (match) {
      const known = libraryIndex.entries.find((e) => e.key === match.key);
      const missing = targetKeys.filter((k) => !known?.collections?.includes(k));
      if (!replaceCollections && !missing.length) {
        report.alreadyThere.push({ item, key: match.key, reason: match.reason, where });
        continue;
      }
      if (dryRun) {
        report.filed.push({ item, key: match.key, reason: match.reason, where, dryRun: true });
        continue;
      }
      try {
        onProgress?.(`Filing “${item.title}” into ${where}…`);
        const res = await zotero.setItemCollections(cfg, match.key, targetKeys, { replace: replaceCollections });
        if (known) known.collections = res.collections || known.collections;
        report.filed.push({ item, key: match.key, reason: match.reason, where, removedFrom: res.removed || [] });
      } catch (err) {
        report.failed.push({ item, message: err.message, where });
      }
      continue;
    }

    toCreate.push({ item, targetKeys, where });
  }

  if (toCreate.length && !dryRun) {
    onProgress?.(`Creating ${toCreate.length} new Zotero item(s)…`);
    const payload = toCreate.map((t) => zotero.toZoteroItem(t.item, t.targetKeys));
    try {
      const results = await zotero.createItems(cfg, payload);
      const byIndex = new Map(results.map((r) => [r.index, r.key]));
      toCreate.forEach((t, i) => {
        const key = byIndex.get(i);
        if (key) {
          report.created.push({ item: t.item, key, where: t.where });
          // Keep the index current so a second push in the same session
          // recognises what this one just made.
          libraryIndex.entries.push(fingerprint({
            key,
            version: libraryIndex.version,
            data: { ...payload[i], collections: t.targetKeys },
          }));
        } else {
          report.failed.push({ item: t.item, message: 'Zotero did not accept this item.', where: t.where });
        }
      });
    } catch (err) {
      for (const t of toCreate) report.failed.push({ item: t.item, message: err.message, where: t.where });
    }
  } else if (toCreate.length) {
    for (const t of toCreate) report.created.push({ item: t.item, key: null, where: t.where, dryRun: true });
  }

  if (!dryRun) writeCache(libraryIndex);
  return report;
}

export { DEFAULT_ROOT };
