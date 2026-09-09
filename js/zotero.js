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
