// zotero.js — Zotero Web API client.
//
// api.zotero.org sends permissive CORS headers, so this runs straight from the
// GitHub Pages origin with no proxy. The key lives in localStorage and is sent
// as a header, never as a query string (query keys leak into referrer logs).

const API = 'https://api.zotero.org';
const PAGE_SIZE = 100;

export class ZoteroError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ZoteroError';
    this.status = status;
  }
}

function libraryPath(cfg) {
  if (!cfg?.zoteroUserId) throw new ZoteroError('No Zotero user ID configured.', 0);
  return `users/${cfg.zoteroUserId}`;
}

async function request(cfg, path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  if (!cfg?.zoteroApiKey) throw new ZoteroError('No Zotero API key configured.', 0);
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: {
      'Zotero-API-Version': '3',
      'Zotero-API-Key': cfg.zoteroApiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403) throw new ZoteroError('Zotero rejected the API key (403).', 403);
  if (res.status === 404) throw new ZoteroError(`Not found: ${path}`, 404);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ZoteroError(`Zotero ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  return raw ? res : res.json();
}

/** Follow Zotero pagination until the whole collection is in hand. */
async function requestAll(cfg, path, onProgress) {
  const out = [];
  let start = 0;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await request(cfg, `${path}${sep}limit=${PAGE_SIZE}&start=${start}`, { raw: true });
    const batch = await res.json();
    out.push(...batch);
    const total = Number(res.headers.get('Total-Results') || out.length);
    if (onProgress) onProgress(out.length, total);
    if (batch.length < PAGE_SIZE || out.length >= total) break;
    start += PAGE_SIZE;
  }
  return out;
}

export async function verifyKey(cfg) {
  const res = await fetch(`${API}/keys/${encodeURIComponent(cfg.zoteroApiKey)}`, {
    headers: { 'Zotero-API-Version': '3' },
  });
  if (!res.ok) throw new ZoteroError(`Key check failed (${res.status}).`, res.status);
  return res.json(); // { userID, username, access }
}

export async function fetchCollections(cfg) {
  const rows = await requestAll(cfg, `${libraryPath(cfg)}/collections`);
  return rows.map((r) => ({
    key: r.key,
    version: r.version,
    name: r.data.name,
    parentCollection: r.data.parentCollection || null,
  }));
}

export async function fetchSubcollections(cfg, collectionKey) {
  const rows = await requestAll(cfg, `${libraryPath(cfg)}/collections/${collectionKey}/collections`);
  return rows.map((r) => ({
    key: r.key,
    version: r.version,
    name: r.data.name,
    parentCollection: r.data.parentCollection || null,
  }));
}

/** Top-level items of a collection (child notes/attachments excluded). */
export async function fetchCollectionItems(cfg, collectionKey, onProgress) {
  const rows = await requestAll(cfg, `${libraryPath(cfg)}/collections/${collectionKey}/items/top`, onProgress);
  return rows.filter((r) => !['attachment', 'note', 'annotation'].includes(r.data.itemType));
}

export async function fetchItemChildren(cfg, itemKey) {
  return requestAll(cfg, `${libraryPath(cfg)}/items/${itemKey}/children`);
}

export async function fetchItem(cfg, itemKey) {
  return request(cfg, `${libraryPath(cfg)}/items/${itemKey}`);
}

/**
 * Add a tag to an item without clobbering its other tags. Zotero uses optimistic
 * concurrency: we re-read to get the current version, then send it back in the
 * If-Unmodified-Since-Version header so a concurrent edit fails loudly.
 */
export async function addTagToItem(cfg, itemKey, tag) {
  const current = await fetchItem(cfg, itemKey);
  const tags = current.data.tags || [];
  if (tags.some((t) => t.tag === tag)) return { changed: false, version: current.version };
  const next = [...tags, { tag }];
  const res = await request(cfg, `${libraryPath(cfg)}/items/${itemKey}`, {
    method: 'PATCH',
    body: { tags: next },
    headers: { 'If-Unmodified-Since-Version': String(current.version) },
    raw: true,
  });
  const version = Number(res.headers.get('Last-Modified-Version') || current.version + 1);
  return { changed: true, version };
}

export async function removeTagFromItem(cfg, itemKey, tag) {
  const current = await fetchItem(cfg, itemKey);
  const tags = (current.data.tags || []).filter((t) => t.tag !== tag);
  await request(cfg, `${libraryPath(cfg)}/items/${itemKey}`, {
    method: 'PATCH',
    body: { tags },
    headers: { 'If-Unmodified-Since-Version': String(current.version) },
    raw: true,
  });
  return { changed: true };
}

// ------------------------------------------------------------- writing back

/**
 * Create collections. Zotero takes up to 50 at a time and answers with a
 * per-index result, so partial success is normal and has to be unpacked.
 *
 * @param {Array<{name: string, parentCollection?: string}>} specs
 * @returns {Array<{key: string, name: string}>}
 */
export async function createCollections(cfg, specs) {
  if (!specs.length) return [];
  const out = [];
  for (let i = 0; i < specs.length; i += 50) {
    const chunk = specs.slice(i, i + 50).map((s) => ({
      name: s.name,
      parentCollection: s.parentCollection || false,
    }));
    const res = await request(cfg, `${libraryPath(cfg)}/collections`, {
      method: 'POST',
      body: chunk,
      headers: { 'Zotero-Write-Token': writeToken() },
    });
    unpackWrite(res, chunk, (index, key) => out.push({ key, name: chunk[index].name }));
  }
  return out;
}

/**
 * Create items. Each may carry a `collections` array of collection keys.
 * @returns {Array<{key: string, index: number}>}
 */
export async function createItems(cfg, items) {
  if (!items.length) return [];
  const out = [];
  for (let i = 0; i < items.length; i += 50) {
    const chunk = items.slice(i, i + 50);
    const res = await request(cfg, `${libraryPath(cfg)}/items`, {
      method: 'POST',
      body: chunk,
      headers: { 'Zotero-Write-Token': writeToken() },
    });
    unpackWrite(res, chunk, (index, key) => out.push({ key, index: i + index }));
  }
  return out;
}

/**
 * Put an existing item into a collection.
 *
 * Zotero has no "add to collection" call — the item's whole collections array
 * is rewritten — so this re-reads the item first and merges, or a PATCH would
 * silently pull the item out of every other collection it belongs to.
 */
export async function setItemCollections(cfg, itemKey, collectionKeys, { replace = false } = {}) {
  const current = await fetchItem(cfg, itemKey);
  const existing = current.data.collections || [];
  const next = replace
    ? [...new Set(collectionKeys)]
    : [...new Set([...existing, ...collectionKeys])];

  // Nothing to do; do not burn a write or bump the version.
  if (next.length === existing.length && next.every((k) => existing.includes(k))) {
    return { changed: false, collections: existing };
  }

  await request(cfg, `${libraryPath(cfg)}/items/${itemKey}`, {
    method: 'PATCH',
    body: { collections: next },
    headers: { 'If-Unmodified-Since-Version': String(current.version) },
    raw: true,
  });
  return { changed: true, collections: next, removed: existing.filter((k) => !next.includes(k)) };
}

/** The library's current version, for cheap "has anything changed?" checks. */
export async function libraryVersion(cfg) {
  const res = await request(cfg, `${libraryPath(cfg)}/items/top?limit=1&format=versions`, { raw: true });
  return Number(res.headers.get('Last-Modified-Version') || 0);
}

/**
 * Every top-level item in the library, with the library version it reflects.
 * Pass `since` for an incremental fetch — Zotero then returns only what has
 * changed, which is what makes keeping a local index affordable.
 */
export async function fetchAllTopItems(cfg, { since = null, onProgress } = {}) {
  const out = [];
  let start = 0;
  let version = since || 0;
  for (;;) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), start: String(start) });
    if (since != null) params.set('since', String(since));
    const res = await request(cfg, `${libraryPath(cfg)}/items/top?${params}`, { raw: true });
    const batch = await res.json();
    const headerVersion = Number(res.headers.get('Last-Modified-Version') || 0);
    if (headerVersion) version = headerVersion;
    out.push(...batch);
    const total = Number(res.headers.get('Total-Results') || out.length);
    onProgress?.(out.length, total);
    if (batch.length < PAGE_SIZE || out.length >= total) break;
    start += PAGE_SIZE;
  }
  return { items: out, version };
}

/** Keys deleted since a version, so a cached index can drop them. */
export async function fetchDeleted(cfg, since) {
  const data = await request(cfg, `${libraryPath(cfg)}/deleted?since=${encodeURIComponent(since)}`);
  return {
    items: data.items || [],
    collections: data.collections || [],
  };
}

/** Idempotency token: a retried POST will not create the same thing twice. */
function writeToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '');
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function unpackWrite(res, chunk, onSuccess) {
  const success = res.success || {};
  for (const [index, key] of Object.entries(success)) onSuccess(Number(index), key);

  const failed = res.failed || {};
  const problems = Object.entries(failed).map(([index, info]) => {
    const label = chunk[Number(index)]?.name || chunk[Number(index)]?.title || `item ${index}`;
    return `${label}: ${info.message || info.code}`;
  });
  if (problems.length && !Object.keys(success).length) {
    throw new ZoteroError(`Zotero rejected the write — ${problems.join('; ')}`, 400);
  }
  if (problems.length) {
    console.warn('Zotero partially rejected a write', problems);
  }
}

// --------------------------------------------------------------- conversion

const CREATOR_ROLES = ['author', 'editor', 'contributor', 'translator'];

export function creatorNames(data) {
  const creators = data.creators || [];
  const preferred = creators.filter((c) => CREATOR_ROLES.includes(c.creatorType));
  const list = preferred.length ? preferred : creators;
  return list.map((c) => c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')).filter(Boolean);
}

export function extractYear(data) {
  const m = String(data.date || '').match(/\b(1\d{3}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

/** Better BibTeX stores its citation key in the Extra field. */
export function extractCitekey(data) {
  const m = String(data.extra || '').match(/Citation Key:\s*(\S+)/i);
  return m ? m[1] : null;
}

export function extractPageCount(data) {
  const raw = data.numPages || data.numberOfPages || '';
  const m = String(raw).match(/(\d+)/);
  if (m) return Number(m[1]);
  // Journal articles carry a page range instead: "45-71"
  const range = String(data.pages || '').match(/(\d+)\s*[-–]\s*(\d+)/);
  if (range) return Math.max(1, Number(range[2]) - Number(range[1]) + 1);
  return null;
}

/**
 * Resolve the on-disk PDF path for an attachment.
 * - linked_file: Zotero stores the path directly (absolute, or relative to the
 *   configured linked-attachment base directory).
 * - imported_file/imported_url: the file lives at <dataDir>/storage/<key>/<name>.
 */
export function resolveAttachmentPath(attachment, cfg) {
  const d = attachment.data || {};
  if (d.contentType !== 'application/pdf') return null;
  const dataDir = (cfg?.zoteroDataDir || '').replace(/[\\/]+$/, '');
  const baseDir = (cfg?.zoteroLinkedBaseDir || '').replace(/[\\/]+$/, '');
  const path = d.path || '';

  if (d.linkMode === 'linked_file') {
    if (path.startsWith('attachments:')) {
      const rel = path.slice('attachments:'.length);
      return baseDir ? `${baseDir}\\${rel.replace(/\//g, '\\')}` : null;
    }
    return path || null;
  }
  if (path.startsWith('storage:')) {
    const filename = path.slice('storage:'.length);
    return dataDir ? `${dataDir}\\storage\\${attachment.key}\\${filename}` : null;
  }
  return null;
}

/** Fold a Zotero item plus its children into the fields readerHelper stores. */
export async function toItemFields(cfg, row, { withAttachments = true } = {}) {
  const d = row.data;
  const fields = {
    title: d.title || d.caseName || d.subject || 'Untitled',
    authors: creatorNames(d),
    year: extractYear(d),
    doi: d.DOI || null,
    isbn: (d.ISBN || '').split(/[\s,]+/)[0] || null,
    url: d.url || null,
    itemType: d.itemType,
    zoteroKey: row.key,
    zoteroLibrary: libraryPath(cfg),
    zoteroVersion: row.version,
    citekey: extractCitekey(d),
    totalPages: extractPageCount(d),
    abstract: d.abstractNote || '',
  };
  if (!withAttachments) return fields;
  try {
    const children = await fetchItemChildren(cfg, row.key);
    const pdf = children.find((c) => c.data?.contentType === 'application/pdf');
    if (pdf) {
      fields.pdfAttachmentKey = pdf.key;
      fields.localPdfPath = resolveAttachmentPath(pdf, cfg);
    }
  } catch (err) {
    console.warn(`attachments unavailable for ${row.key}`, err);
  }
  return fields;
}

// ------------------------------------------------- board item -> Zotero item

/** Zotero item types this board can produce, and the fields each one allows. */
const ZOTERO_TYPES = new Set(['book', 'bookSection', 'journalArticle', 'thesis', 'report', 'conferencePaper', 'webpage']);

export function splitCreator(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  if (s.includes(',')) {
    const [last, ...rest] = s.split(',');
    return { creatorType: 'author', lastName: last.trim(), firstName: rest.join(',').trim() };
  }
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { creatorType: 'author', name: s };
  return {
    creatorType: 'author',
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1],
  };
}

/**
 * Convert a board item into the JSON Zotero expects.
 *
 * Field names are per-itemType in Zotero, and sending a field the type does not
 * have is rejected outright — a book has `numPages` and no `DOI`, an article has
 * `DOI` and no `numPages`. A book's DOI therefore goes into `extra`, which is
 * where Zotero itself puts it.
 */
export function toZoteroItem(item, collectionKeys = []) {
  const itemType = ZOTERO_TYPES.has(item.itemType) ? item.itemType : 'book';
  const out = {
    itemType,
    title: item.title || 'Untitled',
    creators: (item.authors || []).map(splitCreator).filter(Boolean),
    abstractNote: item.abstract || '',
    date: item.year ? String(item.year) : '',
    url: item.url || '',
    collections: [...new Set(collectionKeys)],
    tags: [],
    extra: '',
  };

  const extra = [];
  if (itemType === 'journalArticle' || itemType === 'conferencePaper') {
    out.publicationTitle = item.container || '';
    out.volume = item.volume ? String(item.volume) : '';
    out.issue = item.issue ? String(item.issue) : '';
    out.pages = item.pages || '';
    out.DOI = item.doi || '';
    if (item.isbn) extra.push(`ISBN: ${item.isbn}`);
  } else if (itemType === 'bookSection') {
    out.bookTitle = item.container || '';
    out.publisher = item.publisher || '';
    out.pages = item.pages || '';
    out.ISBN = item.isbn || '';
    if (item.doi) extra.push(`DOI: ${item.doi}`);
  } else {
    // book, thesis, report, webpage
    if (itemType !== 'webpage') {
      out.publisher = item.publisher || '';
      out.ISBN = item.isbn || '';
      if (item.totalPages) out.numPages = String(item.totalPages);
    }
    if (item.doi) extra.push(`DOI: ${item.doi}`);
  }

  // Keep the link back, so a later sync recognises its own work.
  if (item.citekey) extra.push(`Citation Key: ${item.citekey}`);
  out.extra = extra.join('\n');

  // Drop empty strings: Zotero accepts them, but they clutter the record.
  for (const [k, v] of Object.entries(out)) {
    if (v === '' ) delete out[k];
  }
  return out;
}

/** Pull a DOI out of the Extra field, where Zotero keeps it for books. */
export function extractDoi(data) {
  if (data.DOI) return String(data.DOI).trim();
  const m = String(data.extra || '').match(/^\s*DOI:\s*(\S+)/im);
  return m ? m[1].trim() : null;
}

export function extractIsbns(data) {
  const raw = String(data.ISBN || '');
  const fromExtra = String(data.extra || '').match(/^\s*ISBN:\s*(.+)$/im)?.[1] || '';
  return [...raw.split(/[\s,;]+/), ...fromExtra.split(/[\s,;]+/)]
    .map((s) => s.replace(/[^0-9Xx]/g, '').toUpperCase())
    .filter((s) => s.length === 10 || s.length === 13);
}

/** Build a parent -> children index so subcollections can become groups. */
export function buildCollectionTree(collections) {
  const byParent = new Map();
  for (const c of collections) {
    const key = c.parentCollection || '__root__';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(c);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return byParent;
}
