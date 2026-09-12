// metadata.js — turn whatever is pasted into the identifier field into a
// citation record.
//
// Accepts a DOI, an ISBN, an arXiv id, a Google Books / archive.org /
// Open Library / DOI URL, or plain words to search for. Every route below is
// keyless and CORS-enabled, so this works from a static deploy with nothing
// configured. Google Scholar can be added on top by giving the auth worker a
// SerpAPI key (worker/src/worker.js, /scholar), but it is never required.
//
// Sources, in rough order of authority for the thing they cover:
//   Crossref     DOIs for articles, chapters, many books
//   DataCite     DOIs Crossref does not have (arXiv, Zenodo, datasets)
//   OpenAlex     broad index; good for title search and arXiv
//   OpenLibrary  ISBNs and Open Library editions
//   Google Books ISBNs, volume ids, title search
//   archive.org  scanned items by identifier

import { fetchWithTimeout, TIMEOUTS } from './net.js';

const CROSSREF = 'https://api.crossref.org/works';
const DATACITE = 'https://api.datacite.org/dois';
const OPENALEX = 'https://api.openalex.org/works';
const OPENLIBRARY = 'https://openlibrary.org';
const GOOGLE_BOOKS = 'https://www.googleapis.com/books/v1/volumes';
const ARCHIVE = 'https://archive.org/metadata';

// Crossref asks callers to identify themselves; this is the polite-pool convention.
const MAILTO = 'readerhelper@users.noreply.github.com';

// --------------------------------------------------------------- detection

/**
 * Work out what was pasted.
 * @returns {{kind: string, value: string, label: string}}
 */
export function detect(input) {
  const raw = String(input || '').trim();
  if (!raw) return { kind: 'empty', value: '', label: '' };

  // A DOI anywhere in the string wins — including inside a doi.org URL, a
  // publisher URL, or a pasted citation.
  const doi = raw.match(/\b(10\.\d{4,9}\/[^\s"'<>,)\]]+)/i);
  if (doi) {
    let value = doi[1].replace(/[.,;)]+$/, '');
    // arXiv DOIs are DataCite, and OpenAlex knows them better.
    if (/^10\.48550\/arxiv\./i.test(value)) {
      return { kind: 'arxiv', value: value.replace(/^10\.48550\/arxiv\./i, ''), label: 'arXiv' };
    }
    return { kind: 'doi', value, label: 'DOI' };
  }

  // Goodreads: /book/show/<id>, optionally with a title slug. The slug is
  // decorative — Goodreads resolves on the id alone — but it is a usable
  // fallback when the page itself cannot be reached.
  const grIsbn = raw.match(/goodreads\.[a-z.]+\/book\/isbn\/([0-9Xx-]{10,17})/i);
  if (grIsbn) {
    const d = grIsbn[1].replace(/-/g, '');
    if (isValidIsbn(d)) return { kind: 'isbn', value: d.toUpperCase(), label: 'ISBN' };
  }
  const gr = raw.match(/goodreads\.[a-z.]+\/book\/show\/(\d+)/i)
    || raw.match(/goodreads\.[a-z.]+\/review\/show\/\d+[^\d]*book[_-]?id=(\d+)/i);
  if (gr) return { kind: 'goodreads', value: gr[1], label: 'Goodreads', raw };

  // Google Books: /books?id=XXX  or  /books/edition/<slug>/XXX
  const gb = raw.match(/books\.google\.[a-z.]+\/books\?[^\s]*\bid=([\w-]+)/i)
    || raw.match(/google\.[a-z.]+\/books\/edition\/[^/]*\/([\w-]+)/i)
    || raw.match(/books\.google\.[a-z.]+\/books\/about\/[^?]*\?id=([\w-]+)/i);
  if (gb) return { kind: 'googlebooks', value: gb[1], label: 'Google Books' };

  // archive.org: /details/<id>, /stream/<id>, /download/<id>
  const ia = raw.match(/archive\.org\/(?:details|stream|download|embed)\/([^/?#\s]+)/i);
  if (ia) return { kind: 'archive', value: decodeURIComponent(ia[1]), label: 'archive.org' };

  // Open Library editions and works
  const ol = raw.match(/openlibrary\.org\/(books|works)\/(OL\d+[MW])/i);
  if (ol) return { kind: 'openlibrary', value: ol[2].toUpperCase(), label: 'Open Library' };

  // arXiv, new (2301.12345) and old (hep-th/9901001) style. The id shape is
  // spelled out rather than matched lazily: a lazy pattern stops at the word
  // boundary before the dot and yields "1706" for "arXiv:1706.03762v5".
  const ax = raw.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i)
    || raw.match(/\barxiv:\s*(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i);
  if (ax) return { kind: 'arxiv', value: ax[1], label: 'arXiv' };

  // A bare ISBN, only when the checksum agrees — otherwise a 13-digit number
  // would be mistaken for one.
  const digits = raw.replace(/[\s-]/g, '');
  if (/^(97[89])?\d{9}[\dXx]$/.test(digits) && isValidIsbn(digits)) {
    return { kind: 'isbn', value: digits.toUpperCase(), label: 'ISBN' };
  }
  const labelled = raw.match(/\bISBN(?:-1[03])?:?\s*([\d\s-]{10,20}[\dXx])/i);
  if (labelled) {
    const d = labelled[1].replace(/[\s-]/g, '');
    if (isValidIsbn(d)) return { kind: 'isbn', value: d.toUpperCase(), label: 'ISBN' };
  }

  // A bare arXiv id with no prefix
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(raw)) {
    return { kind: 'arxiv', value: raw.replace(/v\d+$/, ''), label: 'arXiv' };
  }

  if (/^https?:\/\//i.test(raw)) return { kind: 'url', value: raw, label: 'link' };
  if (raw.length >= 3) return { kind: 'query', value: raw, label: 'search' };
  return { kind: 'unknown', value: raw, label: '' };
}

/** ISBN-10 mod-11 / ISBN-13 mod-10 check digits. */
export function isValidIsbn(digits) {
  const s = String(digits).replace(/[\s-]/g, '').toUpperCase();
  if (s.length === 10) {
    let sum = 0;
    for (let i = 0; i < 9; i += 1) {
      if (!/\d/.test(s[i])) return false;
      sum += (10 - i) * Number(s[i]);
    }
    const last = s[9] === 'X' ? 10 : Number(s[9]);
    if (Number.isNaN(last)) return false;
    return (sum + last) % 11 === 0;
  }
  if (s.length === 13) {
    if (!/^\d{13}$/.test(s)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i += 1) sum += Number(s[i]) * (i % 2 ? 3 : 1);
    return (10 - (sum % 10)) % 10 === Number(s[12]);
  }
  return false;
}

export function looksLikeDoi(s) {
  return detect(s).kind === 'doi';
}

export function looksLikeIsbn(s) {
  return detect(s).kind === 'isbn';
}

export function normaliseDoi(s) {
  return String(s || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
}

export function normaliseIsbn(s) {
  return String(s || '').replace(/[\s-]/g, '');
}

// ------------------------------------------------------------------ helpers

async function getJson(url, { signal, headers } = {}) {
  const res = await fetchWithTimeout(url, { signal, headers, timeoutMs: TIMEOUTS.quick });
  if (!res.ok) {
    const host = new URL(url).hostname;
    // These services are keyless and shared, so a 429 is routine rather than a
    // fault; say so, because "try again shortly" is the actual remedy.
    const err = new Error(
      res.status === 429
        ? `${host} is rate-limiting right now — try again in a moment.`
        : `${host} returned ${res.status}`,
    );
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', times: '×', deg: '°',
};

/**
 * Crossref returns JATS markup inside titles (<i>, <sub>, <scp>) and HTML
 * entities throughout. Left alone, a title arrives on the card as
 * "<i>The Professional Quest for Truth</i>".
 */
export function clean(value) {
  if (value == null) return value;
  return String(value)
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function yearFrom(s) {
  const m = String(s || '').match(/\b(1\d{3}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

function pagesFromRange(page) {
  const m = String(page || '').match(/(\d+)\s*[-–]\s*(\d+)/);
  if (!m) return null;
  const n = Number(m[2]) - Number(m[1]) + 1;
  return n > 0 ? n : null;
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * A blank record, so every source returns the same shape — and the single
 * place where text is sanitised, so no source can leak markup onto a card.
 */
function record(fields) {
  const r = {
    title: '',
    subtitle: null,
    authors: [],
    year: null,
    doi: null,
    isbn: null,
    url: null,
    itemType: 'book',
    totalPages: null,
    publisher: null,
    container: null,
    volume: null,
    issue: null,
    pages: null,
    abstract: null,
    goodreadsId: null,
    source: 'unknown',
    ...fields,
  };
  for (const key of ['title', 'subtitle', 'publisher', 'container', 'abstract']) {
    r[key] = clean(r[key]) || (key === 'title' ? '' : null);
  }
  r.authors = (r.authors || []).map(clean).filter(Boolean);
  if (!r.title) r.title = 'Untitled';
  return r;
}

// ------------------------------------------------------------------ sources

export async function lookupDoi(doi, opts = {}) {
  const clean = normaliseDoi(doi);
  try {
    const { message: m } = await getJson(`${CROSSREF}/${encodeURIComponent(clean)}?mailto=${MAILTO}`, opts);
    return fromCrossref(m);
  } catch (err) {
    if (err.status && err.status !== 404) throw err;
  }
  // Crossref does not mint every DOI; DataCite covers most of the rest.
  try {
    const { data } = await getJson(`${DATACITE}/${encodeURIComponent(clean)}`, opts);
    return fromDataCite(data);
  } catch {
    /* fall through */
  }
  const oa = await getJson(`${OPENALEX}/doi:${encodeURIComponent(clean)}?mailto=${MAILTO}`, opts);
  return fromOpenAlex(oa);
}

function fromCrossref(m) {
  const authors = (m.author || [])
    .map((a) => a.name || [a.given, a.family].filter(Boolean).join(' '))
    .filter(Boolean);
  const year =
    m.issued?.['date-parts']?.[0]?.[0] ||
    m['published-print']?.['date-parts']?.[0]?.[0] ||
    m['published-online']?.['date-parts']?.[0]?.[0] || null;
  const type = m.type === 'book' || m.type === 'monograph' ? 'book'
    : m.type === 'book-chapter' ? 'bookSection'
      : 'journalArticle';
  return record({
    title: (m.title || [])[0] || 'Untitled',
    subtitle: (m.subtitle || [])[0] || null,
    authors,
    year: year ? Number(year) : null,
    doi: m.DOI || null,
    isbn: (m.ISBN || [])[0] || null,
    url: m.URL || (m.DOI ? `https://doi.org/${m.DOI}` : null),
    itemType: type,
    totalPages: pagesFromRange(m.page),
    publisher: m.publisher || null,
    container: (m['container-title'] || [])[0] || null,
    volume: m.volume || null,
    issue: m.issue || null,
    pages: m.page || null,
    abstract: m.abstract ? String(m.abstract).replace(/<[^>]+>/g, '').trim() : null,
    source: 'Crossref',
  });
}

function fromDataCite(d) {
  const a = d.attributes || {};
  return record({
    title: (a.titles || [])[0]?.title || 'Untitled',
    authors: (a.creators || []).map((c) => c.name || [c.givenName, c.familyName].filter(Boolean).join(' ')).filter(Boolean),
    year: a.publicationYear ? Number(a.publicationYear) : yearFrom(a.published),
    doi: a.doi || null,
    url: a.url || (a.doi ? `https://doi.org/${a.doi}` : null),
    itemType: /book/i.test(a.types?.resourceTypeGeneral || '') ? 'book' : 'journalArticle',
    publisher: a.publisher || null,
    abstract: (a.descriptions || [])[0]?.description || null,
    source: 'DataCite',
  });
}

function fromOpenAlex(w) {
  const authors = (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean);
  const loc = w.primary_location || {};
  return record({
    title: w.display_name || w.title || 'Untitled',
    authors,
    year: w.publication_year || yearFrom(w.publication_date),
    doi: w.doi ? normaliseDoi(w.doi) : null,
    url: loc.landing_page_url || w.doi || null,
    itemType: w.type === 'book' ? 'book' : w.type === 'book-chapter' ? 'bookSection' : 'journalArticle',
    container: loc.source?.display_name || null,
    publisher: loc.source?.host_organization_name || null,
    volume: w.biblio?.volume || null,
    issue: w.biblio?.issue || null,
    pages: w.biblio?.first_page && w.biblio?.last_page ? `${w.biblio.first_page}-${w.biblio.last_page}` : null,
    totalPages: w.biblio?.first_page && w.biblio?.last_page
      ? pagesFromRange(`${w.biblio.first_page}-${w.biblio.last_page}`) : null,
    source: 'OpenAlex',
  });
}

export async function lookupIsbn(isbn, opts = {}) {
  const clean = normaliseIsbn(isbn);
  const ol = await tryOpenLibraryIsbn(clean, opts);
  if (ol) return ol;
  const gb = await tryGoogleBooksIsbn(clean, opts);
  if (gb) return gb;
  throw new Error(`No record found for ISBN ${clean}.`);
}

async function tryOpenLibraryIsbn(isbn, opts) {
  try {
    const data = await getJson(
      `${OPENLIBRARY}/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`, opts,
    );
    const rec = data[`ISBN:${isbn}`];
    if (!rec) return null;
    return record({
      title: rec.title || 'Untitled',
      subtitle: rec.subtitle || null,
      authors: (rec.authors || []).map((a) => a.name).filter(Boolean),
      year: yearFrom(rec.publish_date),
      isbn,
      url: rec.url || null,
      itemType: 'book',
      totalPages: rec.number_of_pages ? Number(rec.number_of_pages) : null,
      publisher: (rec.publishers || [])[0]?.name || null,
      source: 'Open Library',
    });
  } catch {
    return null;
  }
}

async function tryGoogleBooksIsbn(isbn, opts) {
  try {
    const data = await getJson(`${GOOGLE_BOOKS}?q=isbn:${encodeURIComponent(isbn)}`, opts);
    const item = data.items?.[0];
    if (!item) return null;
    return fromGoogleVolume(item, isbn);
  } catch {
    return null;
  }
}

export async function lookupGoogleBooks(volumeId, opts = {}) {
  const item = await getJson(`${GOOGLE_BOOKS}/${encodeURIComponent(volumeId)}`, opts);
  return fromGoogleVolume(item);
}

function fromGoogleVolume(item, isbnHint = null) {
  const v = item.volumeInfo || {};
  const isbn = (v.industryIdentifiers || []).find((i) => i.type === 'ISBN_13')?.identifier
    || (v.industryIdentifiers || []).find((i) => i.type === 'ISBN_10')?.identifier
    || isbnHint;
  return record({
    title: v.title || 'Untitled',
    subtitle: v.subtitle || null,
    authors: v.authors || [],
    year: yearFrom(v.publishedDate),
    isbn: isbn || null,
    url: v.canonicalVolumeLink || v.infoLink || (item.id ? `https://books.google.com/books?id=${item.id}` : null),
    itemType: 'book',
    totalPages: v.pageCount ? Number(v.pageCount) : null,
    publisher: v.publisher || null,
    abstract: v.description || null,
    source: 'Google Books',
  });
}

/** archive.org scanned items, by the identifier in the /details/ URL. */
export async function lookupArchive(identifier, opts = {}) {
  const data = await getJson(`${ARCHIVE}/${encodeURIComponent(identifier)}`, opts);
  const m = data.metadata;
  if (!m) throw new Error(`archive.org has no item called “${identifier}”.`);

  // Scanned books carry an image count; it is the closest thing to a page count.
  const imageCount = Number(
    data.files?.find((f) => f.format === 'Djvu XML' || f.format === 'Text PDF')?.pagecount
    || m.imagecount || 0,
  );
  const isbn = asArray(m.isbn).map((x) => normaliseIsbn(x)).find(isValidIsbn) || null;

  return record({
    title: asArray(m.title)[0] || identifier,
    authors: asArray(m.creator).filter(Boolean),
    year: yearFrom(m.date || m.year || m.publicdate),
    isbn,
    url: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    itemType: 'book',
    totalPages: imageCount > 0 ? imageCount : null,
    publisher: asArray(m.publisher)[0] || null,
    abstract: asArray(m.description)[0]?.replace(/<[^>]+>/g, '').trim() || null,
    source: 'archive.org',
  });
}

export async function lookupOpenLibraryKey(olid, opts = {}) {
  const kind = /W$/i.test(olid) ? 'works' : 'books';
  const d = await getJson(`${OPENLIBRARY}/${kind}/${olid}.json`, opts);

  // Author records are separate documents; resolve up to a handful of them.
  const authors = [];
  for (const a of (d.authors || []).slice(0, 8)) {
    const key = a.key || a.author?.key;
    if (!key) continue;
    try {
      const doc = await getJson(`${OPENLIBRARY}${key}.json`, opts);
      if (doc.name) authors.push(doc.name);
    } catch { /* skip an unreachable author */ }
  }

  const isbn = (d.isbn_13 || [])[0] || (d.isbn_10 || [])[0] || null;
  return record({
    title: d.title || 'Untitled',
    subtitle: d.subtitle || null,
    authors,
    year: yearFrom(d.publish_date || d.first_publish_date),
    isbn,
    url: `${OPENLIBRARY}/${kind}/${olid}`,
    itemType: 'book',
    totalPages: d.number_of_pages ? Number(d.number_of_pages) : null,
    publisher: (d.publishers || [])[0] || null,
    abstract: typeof d.description === 'string' ? d.description : d.description?.value || null,
    source: 'Open Library',
  });
}

export async function lookupArxiv(id, opts = {}) {
  const clean = String(id).replace(/^arxiv:/i, '').replace(/v\d+$/, '');
  // OpenAlex indexes arXiv and answers with CORS headers, which the arXiv
  // Atom API does not reliably do.
  try {
    return {
      ...(await lookupDoiViaOpenAlex(`10.48550/arXiv.${clean}`, opts)),
      url: `https://arxiv.org/abs/${clean}`,
    };
  } catch {
    const { data } = await getJson(`${DATACITE}/${encodeURIComponent(`10.48550/arxiv.${clean}`)}`, opts);
    return { ...fromDataCite(data), url: `https://arxiv.org/abs/${clean}` };
  }
}

async function lookupDoiViaOpenAlex(doi, opts) {
  return fromOpenAlex(await getJson(`${OPENALEX}/doi:${encodeURIComponent(doi)}?mailto=${MAILTO}`, opts));
}

/**
 * A Goodreads book link.
 *
 * Goodreads sends no CORS headers, so the page is read through the worker. When
 * that is unavailable — worker not redeployed, offline, page gone — the title
 * in the URL slug is enough to find the book in the keyless sources, which is a
 * far better answer than refusing the paste.
 */
export async function lookupGoodreads(bookId, opts = {}) {
  const gr = await import('./goodreads.js');

  if (opts.workerUrl) {
    try {
      const book = await gr.fetchBook(opts.workerUrl, bookId, { signal: opts.signal });
      // Goodreads publishes a title, author, ISBN and page count but not the
      // publisher or year; with an ISBN the keyless sources fill those in.
      if (book.isbn) {
        try {
          const enriched = await lookupIsbn(book.isbn, opts);
          return record({
            ...enriched,
            title: book.title || enriched.title,
            totalPages: book.totalPages || enriched.totalPages,
            goodreadsId: book.goodreadsId,
            url: book.url || enriched.url,
            source: `Goodreads + ${enriched.source}`,
          });
        } catch {
          /* the Goodreads record on its own is still good */
        }
      }
      return record({ ...book, source: 'Goodreads' });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('Goodreads page unavailable; falling back to the URL slug', err);
    }
  }

  const title = gr.titleFromBookUrl(opts.raw || '');
  if (!title) {
    throw new Error(
      'Could not read that Goodreads page. Redeploy the worker to resolve Goodreads links, or paste the ISBN instead.',
    );
  }
  const candidates = await search(title, opts);
  if (!candidates.length) throw new Error(`Nothing found for “${title}”.`);
  return record({
    ...candidates[0],
    goodreadsId: bookId,
    source: `${candidates[0].source} (matched from the Goodreads title)`,
  });
}

/**
 * Free-text search across Crossref, Google Books and OpenAlex — and Google
 * Scholar too, if a worker with a SerpAPI key is configured.
 *
 * All sources run together and failures are ignored individually: one service
 * being down or rate-limited should degrade the results, not lose them.
 */
export async function search(query, opts = {}) {
  const jobs = [
    searchCrossref(query, opts),
    searchGoogleBooks(query, opts),
    searchOpenAlex(query, opts),
  ];
  if (opts.scholarUrl) jobs.push(searchScholar(query, opts));

  const results = await Promise.allSettled(jobs);
  const rows = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  return dedupe(rows).slice(0, 12);
}

/**
 * Google Scholar via the auth worker, which holds the SerpAPI key. Optional by
 * design: a worker without the key answers 501 and this returns nothing.
 */
export async function searchScholar(query, opts = {}) {
  const base = String(opts.scholarUrl || '').replace(/\/$/, '');
  if (!base) return [];
  const res = await fetch(`${base}/scholar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query }),
    signal: opts.signal,
  });
  if (!res.ok) return [];   // 501 when unconfigured; never a hard failure
  const data = await res.json();
  return (data.results || []).map((r) => record({
    title: r.title,
    authors: r.authors || [],
    year: r.year,
    url: r.url,
    container: r.container,
    abstract: r.abstract,
    itemType: 'journalArticle',
    source: 'Google Scholar',
  }));
}

async function searchCrossref(query, opts) {
  const data = await getJson(
    `${CROSSREF}?query.bibliographic=${encodeURIComponent(query)}&rows=5&select=DOI,title,author,issued,type,container-title,publisher,ISBN,URL,page&mailto=${MAILTO}`,
    opts,
  );
  return (data.message?.items || []).map(fromCrossref);
}

async function searchGoogleBooks(query, opts) {
  const data = await getJson(`${GOOGLE_BOOKS}?q=${encodeURIComponent(query)}&maxResults=5`, opts);
  return (data.items || []).map((i) => fromGoogleVolume(i));
}

async function searchOpenAlex(query, opts) {
  const data = await getJson(
    `${OPENALEX}?search=${encodeURIComponent(query)}&per-page=5&mailto=${MAILTO}`, opts,
  );
  return (data.results || []).map(fromOpenAlex);
}

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r.title) continue;
    const key = (r.doi || r.isbn || `${r.title}|${r.year}`).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ------------------------------------------------------------------ resolve

/**
 * The one entry point the UI needs. Detects what was pasted and resolves it.
 *
 * @returns {{record: object|null, candidates: object[], kind: string, label: string}}
 * A single confident hit lands in `record`; an ambiguous search fills
 * `candidates` so the user can choose.
 */
export async function resolve(input, opts = {}) {
  const { kind, value, label } = detect(input);
  // The Goodreads fallback reads the title out of the URL slug, so the raw
  // text has to travel with the options.
  opts = { ...opts, raw: String(input || '') };

  switch (kind) {
    case 'doi':
      return one(await lookupDoi(value, opts), kind, label);
    case 'isbn':
      return one(await lookupIsbn(value, opts), kind, label);
    case 'googlebooks':
      return one(await lookupGoogleBooks(value, opts), kind, label);
    case 'archive':
      return one(await lookupArchive(value, opts), kind, label);
    case 'openlibrary':
      return one(await lookupOpenLibraryKey(value, opts), kind, label);
    case 'arxiv':
      return one(await lookupArxiv(value, opts), kind, label);
    case 'goodreads':
      return one(await lookupGoodreads(value, opts), kind, label);
    case 'url': {
      // No DOI in it and no host we recognise: keep the link, let the user type
      // the rest. Better than refusing outright.
      const title = titleFromUrl(value);
      return one(record({ title, url: value, source: 'link' }), kind, label);
    }
    case 'query': {
      const candidates = await search(value, opts);   // opts carries scholarUrl
      if (!candidates.length) throw new Error(`Nothing found for “${value}”.`);
      return { record: candidates.length === 1 ? candidates[0] : null, candidates, kind, label };
    }
    case 'empty':
      throw new Error('Enter a DOI, ISBN, link, or a title to search for.');
    default:
      throw new Error(`Could not make sense of “${input}”.`);
  }
}

function one(rec, kind, label) {
  return { record: rec, candidates: rec ? [rec] : [], kind, label };
}

/** Last resort for an unrecognised link: a readable name from its path. */
function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(last)
      .replace(/\.(html?|pdf|php|aspx?)$/i, '')
      .replace(/[-_+]+/g, ' ')
      .trim() || u.hostname;
  } catch {
    return '';
  }
}

/** Kept for callers that want the old single-result behaviour. */
export async function lookupAny(identifier, opts = {}) {
  const { record: rec, candidates } = await resolve(identifier, opts);
  if (rec) return rec;
  if (candidates.length) return candidates[0];
  throw new Error('No match.');
}
