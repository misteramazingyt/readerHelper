// goodreads.js — reading from and writing to Goodreads.
//
// Goodreads retired its public API: no new developer keys since December 2020,
// and the existing ones were deprecated rather than replaced. So unlike Zotero,
// there is no call to make. What remains, and what this module uses:
//
//   in   shelf RSS      live, 100 books a page, and it carries the shelves,
//                       ratings, read dates and reviews. Needs a public profile
//                       and a proxy, because goodreads.com sends no CORS
//                       headers (worker /goodreads).
//   in   library CSV    Goodreads -> My Books -> Import and export -> Export.
//                       Complete, includes private shelves, needs no setup.
//   out  import CSV     Goodreads accepts a CSV upload at /review/import. That
//                       is the only supported way to put books back, so "add to
//                       Goodreads" produces a file rather than making a request.
//
// Everything here is pure string work, so it is all testable offline.

export const SHELF_GROUPS = {
  'to-read': 'To read',
  'currently-reading': 'Reading now',
  read: 'Read',
};

/** The columns Goodreads accepts on import. Anything else is ignored by them. */
export const IMPORT_COLUMNS = [
  'Title', 'Author', 'ISBN', 'My Rating', 'Date Read', 'Date Added', 'Bookshelves', 'My Review',
];

// ------------------------------------------------------------------ CSV I/O

/**
 * A real CSV reader: quoted fields, escaped quotes, and newlines inside fields.
 * Goodreads reviews routinely contain commas and line breaks, so splitting on
 * commas would shred the file.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text || '').replace(/^﻿/, '');   // strip a BOM

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell !== ''));
}

export function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Turn a parsed CSV into objects keyed by header name. */
export function csvToObjects(rows) {
  if (!rows.length) return [];
  const [header, ...body] = rows;
  const keys = header.map((h) => h.trim());
  return body.map((cells) => {
    const o = {};
    keys.forEach((k, i) => { o[k] = (cells[i] ?? '').trim(); });
    return o;
  });
}

/** Goodreads writes ISBNs as ="0123456789" so spreadsheets keep the zeros. */
export function cleanIsbn(value) {
  const s = String(value || '').replace(/^="?|"?$/g, '').replace(/[^0-9Xx]/g, '');
  return s.length === 10 || s.length === 13 ? s.toUpperCase() : null;
}

function num(value) {
  const n = Number(String(value || '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function splitAuthors(primary, additional) {
  const extra = String(additional || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [String(primary || '').trim(), ...extra].filter(Boolean);
}

// -------------------------------------------------------------- CSV -> board

/**
 * One exported CSV row as board fields.
 * `shelf` is the exclusive shelf (to-read / currently-reading / read) and
 * `shelves` the custom ones; the caller decides which becomes the group.
 */
export function fromCsvRow(row) {
  const shelf = (row['Exclusive Shelf'] || '').trim().toLowerCase();
  const rating = num(row['My Rating']);
  const pages = num(row['Number of Pages']);
  const read = shelf === 'read';

  return {
    title: (row.Title || '').trim() || 'Untitled',
    authors: splitAuthors(row.Author, row['Additional Authors']),
    year: num(row['Original Publication Year']) || num(row['Year Published']),
    isbn: cleanIsbn(row.ISBN13) || cleanIsbn(row.ISBN),
    publisher: (row.Publisher || '').trim() || null,
    totalPages: pages,
    itemType: 'book',
    notes: (row['My Review'] || '').trim(),
    goodreadsId: (row['Book Id'] || '').trim() || null,
    goodreadsRating: rating,
    goodreadsShelf: shelf || null,
    goodreadsShelves: splitShelves(row.Bookshelves),
    dateRead: (row['Date Read'] || '').trim() || null,
    dateAdded: (row['Date Added'] || '').trim() || null,
    url: (row['Book Id'] || '').trim() ? bookUrl({ goodreadsId: row['Book Id'].trim() }) : null,
    // A book on the "read" shelf is finished; without a page count there is
    // still a percentage to record.
    currentPage: read && pages ? pages : 0,
    progress: read ? 1 : 0,
  };
}

export function splitShelves(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !SHELF_GROUPS[s]);
}

export function parseLibraryCsv(text) {
  const objects = csvToObjects(parseCsv(text));
  if (!objects.length) return { books: [], error: 'That file has no rows.' };
  if (!('Title' in objects[0])) {
    return { books: [], error: 'That does not look like a Goodreads export — no Title column.' };
  }
  return { books: objects.map(fromCsvRow) };
}

// -------------------------------------------------------------- RSS -> board

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (!m) return '';
  return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
}

function yearOf(value) {
  const m = String(value || '').match(/\b(1\d{3}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Parse a Goodreads shelf RSS feed into board fields.
 *
 * `shelf` matters more than it looks. Most people never set a read date, so
 * `user_read_at` is empty on the great majority of books — on a real library,
 * 95 of 100 on the "read" shelf. Treating the date as the signal for "finished"
 * therefore imports almost everything you have read as unread. The shelf the
 * feed came from is the reliable signal; the date is a bonus.
 */
export function parseShelfRss(xml, { shelf = null } = {}) {
  const text = String(xml || '');
  const shelfTitle = stripTags(tag(text, 'title'));
  const feedShelf = shelf || shelfNameFromFeedTitle(shelfTitle);
  const shelfSaysRead = String(feedShelf || '').toLowerCase() === 'read';
  const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];

  const books = items.map((item) => {
    const pages = num(tag(item, 'num_pages'));
    const shelves = splitShelves(tag(item, 'user_shelves'));
    const readAt = tag(item, 'user_read_at');
    const read = shelfSaysRead || Boolean(readAt);

    return {
      title: stripTags(tag(item, 'title')) || 'Untitled',
      authors: [stripTags(tag(item, 'author_name'))].filter(Boolean),
      year: yearOf(tag(item, 'book_published')),
      isbn: cleanIsbn(tag(item, 'isbn')),
      totalPages: pages,
      itemType: 'book',
      notes: stripTags(tag(item, 'user_review')),
      abstract: stripTags(tag(item, 'book_description')).slice(0, 2000) || null,
      goodreadsId: tag(item, 'book_id') || null,
      goodreadsShelf: feedShelf || null,
      goodreadsRating: num(tag(item, 'user_rating')),
      goodreadsShelves: shelves,
      dateRead: readAt || null,
      dateAdded: tag(item, 'user_date_added') || null,
      url: tag(item, 'book_id') ? bookUrl({ goodreadsId: tag(item, 'book_id') }) : null,
      currentPage: read && pages ? pages : 0,
      progress: read ? 1 : 0,
    };
  });

  return { books, shelfTitle };
}

/** Which shelf a feed was for, from its own title ("X's bookshelf: read"). */
export function shelfNameFromFeedTitle(feedTitle) {
  const m = String(feedTitle || '').match(/bookshelf:\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

// --------------------------------------------------------------------- links

export function bookUrl(item) {
  if (item?.goodreadsId) return `https://www.goodreads.com/book/show/${item.goodreadsId}`;
  if (item?.isbn) return `https://www.goodreads.com/book/isbn/${item.isbn}`;
  const q = [item?.title, item?.authors?.[0]].filter(Boolean).join(' ');
  return q ? `https://www.goodreads.com/search?q=${encodeURIComponent(q)}` : null;
}

export function shelfRssUrl(userId, shelf = 'read') {
  return `https://www.goodreads.com/review/list_rss/${encodeURIComponent(userId)}?shelf=${encodeURIComponent(shelf)}`;
}

export function hasGoodreadsLink(item) {
  return Boolean(item?.goodreadsId || item?.isbn || item?.title);
}

// -------------------------------------------------------------- board -> CSV

/**
 * Goodreads wants yyyy/mm/dd.
 *
 * A read date is a calendar date, not an instant, so it must not be dragged
 * across a day boundary by the local timezone: `2026-08-18T00:00:00Z` read with
 * local getters west of Greenwich comes out as the 17th. A date-only string is
 * therefore taken verbatim, and a full timestamp is read in UTC, which is how
 * it was written.
 */
export function toGoodreadsDate(value) {
  if (!value) return '';
  const s = String(value).trim();

  const plain = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (plain) {
    return `${plain[1]}/${plain[2].padStart(2, '0')}/${plain[3].padStart(2, '0')}`;
  }

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Build a CSV in the shape Goodreads' importer accepts.
 *
 * Their importer matches on ISBN first and falls back to title and author, so
 * an ISBN is what makes a row land on the right edition. Shelf names come from
 * the board: the group a book sits in becomes a Goodreads shelf.
 */
export function toImportCsv(entries, { includeReviews = true, markRead = true } = {}) {
  const rows = [IMPORT_COLUMNS];
  for (const { item, shelves = [] } of entries) {
    const finished = markRead && (item.progress >= 1 || item.archived);
    const shelfList = [...new Set([
      ...(shelves || []),
      ...(item.goodreadsShelves || []),
      finished ? 'read' : 'to-read',
    ].filter(Boolean))];

    rows.push([
      item.title || '',
      (item.authors || [])[0] || '',
      item.isbn || '',
      item.goodreadsRating || '',
      finished ? toGoodreadsDate(item.markedReadAt || item.dateRead || Date.now()) : '',
      toGoodreadsDate(item.dateAdded || item.createdAt),
      shelfList.join(', '),
      includeReviews ? (item.notes || '').replace(/\r?\n/g, ' ') : '',
    ]);
  }
  return toCsv(rows);
}

// ------------------------------------------------------------ fetching a shelf

/**
 * Pull a whole shelf through the worker, following pages until it runs out.
 * 100 books a page is Goodreads' maximum.
 */
export async function fetchShelf(workerUrl, userId, shelf, { onProgress, maxPages = 30, signal } = {}) {
  const base = String(workerUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('No worker URL configured — Goodreads sync needs the proxy.');

  const books = [];
  let shelfTitle = '';
  let warning = null;

  for (let page = 1; page <= maxPages; page += 1) {
    onProgress?.(`Reading “${shelf}” from Goodreads — ${books.length} so far…`);
    const res = await fetch(`${base}/goodreads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, shelf, page }),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404 && data.error !== 'not_found') {
      // The worker predates this route. Say so, rather than blaming Goodreads.
      throw new Error('The worker has no /goodreads route yet — redeploy it (cd worker && npx wrangler deploy). The CSV import works without it.');
    }
    if (!res.ok) throw new Error(data.message || `The proxy returned ${res.status}.`);
    if (data.warning) warning = data.warning;

    const parsed = parseShelfRss(data.xml || '', { shelf });
    if (!shelfTitle) shelfTitle = parsed.shelfTitle;
    books.push(...parsed.books);
    if (parsed.books.length < 100) break;
  }

  return { books, shelfTitle, warning };
}

/** A shelf name Goodreads will accept: lowercase, hyphenated, no commas. */
export function toShelfName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'readerhelper';
}
