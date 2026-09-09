// metadata.js — DOI / ISBN lookup for manual book import.
//
// Both services below send permissive CORS headers and need no key, which keeps
// the "+ import" path working on a plain static deploy. Crossref asks callers to
// identify themselves; the mailto parameter is the polite-pool convention.

const CROSSREF = 'https://api.crossref.org/works';
const OPENLIBRARY = 'https://openlibrary.org/api/books';
const GOOGLE_BOOKS = 'https://www.googleapis.com/books/v1/volumes';

export function looksLikeDoi(s) {
  return /^(https?:\/\/(dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/i.test(String(s || '').trim());
}

export function looksLikeIsbn(s) {
  const digits = String(s || '').replace(/[\s-]/g, '');
  return /^(97[89])?\d{9}[\dXx]$/.test(digits);
}

export function normaliseDoi(s) {
  return String(s || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
}

export function normaliseIsbn(s) {
  return String(s || '').replace(/[\s-]/g, '');
}

export async function lookupDoi(doi) {
  const clean = normaliseDoi(doi);
  const res = await fetch(`${CROSSREF}/${encodeURIComponent(clean)}?mailto=readerhelper@users.noreply.github.com`);
  if (res.status === 404) throw new Error(`No Crossref record for ${clean}.`);
  if (!res.ok) throw new Error(`Crossref returned ${res.status}.`);
  const { message: m } = await res.json();

  const authors = (m.author || [])
    .map((a) => a.name || [a.given, a.family].filter(Boolean).join(' '))
    .filter(Boolean);
  const year =
    m.issued?.['date-parts']?.[0]?.[0] ||
    m['published-print']?.['date-parts']?.[0]?.[0] ||
    m['published-online']?.['date-parts']?.[0]?.[0] ||
    null;

  return {
    title: (m.title || [])[0] || 'Untitled',
    authors,
    year: year ? Number(year) : null,
    doi: m.DOI || clean,
    isbn: (m.ISBN || [])[0] || null,
    url: m.URL || `https://doi.org/${clean}`,
    itemType: m.type === 'book' ? 'book' : 'journalArticle',
    totalPages: pagesFromRange(m.page),
    publisher: m.publisher || null,
    container: (m['container-title'] || [])[0] || null,
    source: 'Crossref',
  };
}

export async function lookupIsbn(isbn) {
  const clean = normaliseIsbn(isbn);
  const ol = await tryOpenLibrary(clean);
  if (ol) return ol;
  const gb = await tryGoogleBooks(clean);
  if (gb) return gb;
  throw new Error(`No record found for ISBN ${clean}.`);
}

async function tryOpenLibrary(isbn) {
  const url = `${OPENLIBRARY}?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const rec = data[`ISBN:${isbn}`];
  if (!rec) return null;
  return {
    title: [rec.title, rec.subtitle].filter(Boolean).join(': ') || 'Untitled',
    authors: (rec.authors || []).map((a) => a.name).filter(Boolean),
    year: yearFrom(rec.publish_date),
    doi: null,
    isbn,
    url: rec.url || null,
    itemType: 'book',
    totalPages: rec.number_of_pages ? Number(rec.number_of_pages) : null,
    publisher: (rec.publishers || [])[0]?.name || null,
    source: 'Open Library',
  };
}

async function tryGoogleBooks(isbn) {
  const res = await fetch(`${GOOGLE_BOOKS}?q=isbn:${encodeURIComponent(isbn)}`);
  if (!res.ok) return null;
  const data = await res.json();
  const v = data.items?.[0]?.volumeInfo;
  if (!v) return null;
  return {
    title: [v.title, v.subtitle].filter(Boolean).join(': ') || 'Untitled',
    authors: v.authors || [],
    year: yearFrom(v.publishedDate),
    doi: null,
    isbn,
    url: v.infoLink || v.canonicalVolumeLink || null,
    itemType: 'book',
    totalPages: v.pageCount ? Number(v.pageCount) : null,
    publisher: v.publisher || null,
    source: 'Google Books',
  };
}

/** Accepts a DOI or an ISBN and routes to the right service. */
export async function lookupAny(identifier) {
  const s = String(identifier || '').trim();
  if (!s) throw new Error('Enter a DOI or ISBN.');
  if (looksLikeDoi(s)) return lookupDoi(s);
  if (looksLikeIsbn(s)) return lookupIsbn(s);
  // Fall back to a title search rather than refusing outright.
  const res = await fetch(`${GOOGLE_BOOKS}?q=${encodeURIComponent(s)}&maxResults=1`);
  if (res.ok) {
    const data = await res.json();
    const v = data.items?.[0]?.volumeInfo;
    if (v) {
      return {
        title: [v.title, v.subtitle].filter(Boolean).join(': '),
        authors: v.authors || [],
        year: yearFrom(v.publishedDate),
        doi: null,
        isbn: (v.industryIdentifiers || []).find((i) => i.type?.startsWith('ISBN'))?.identifier || null,
        url: v.infoLink || null,
        itemType: 'book',
        totalPages: v.pageCount ? Number(v.pageCount) : null,
        publisher: v.publisher || null,
        source: 'Google Books (title search)',
      };
    }
  }
  throw new Error(`That does not look like a DOI or ISBN, and no title match was found.`);
}

function pagesFromRange(page) {
  const m = String(page || '').match(/(\d+)\s*[-–]\s*(\d+)/);
  if (!m) return null;
  const n = Number(m[2]) - Number(m[1]) + 1;
  return n > 0 ? n : null;
}

function yearFrom(s) {
  const m = String(s || '').match(/\b(1\d{3}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
}
