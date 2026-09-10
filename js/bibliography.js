// bibliography.js — export a selection of books as a bibliography.
//
// Two sources, combined:
//
//   Zotero  For items linked to the library, Zotero's own exporter is used. It
//           knows the editors, translators, editions and places that this board
//           never stores, and its formatted styles are CSL, so they are right
//           rather than approximately right.
//   Local   Everything else is generated here from the stored fields. Always
//           available, works offline, and covers hand-entered books.
//
// The formatted styles (APA, MLA, Chicago) generated locally are explicitly an
// approximation, and say so in the export dialog. BibTeX, RIS and CSL-JSON
// generated locally are exact — they are data formats, not typeset prose.

import * as zotero from './zotero.js';

export const FORMATS = {
  bibtex: { label: 'BibTeX', ext: 'bib', mime: 'application/x-bibtex', zotero: 'bibtex' },
  ris: { label: 'RIS (EndNote, Mendeley)', ext: 'ris', mime: 'application/x-research-info-systems', zotero: 'ris' },
  csljson: { label: 'CSL-JSON', ext: 'json', mime: 'application/json', zotero: 'csljson' },
  apa: { label: 'APA 7 (formatted)', ext: 'txt', mime: 'text/plain', zotero: 'bib', style: 'apa' },
  mla: { label: 'MLA 9 (formatted)', ext: 'txt', mime: 'text/plain', zotero: 'bib', style: 'modern-language-association' },
  chicago: { label: 'Chicago (formatted)', ext: 'txt', mime: 'text/plain', zotero: 'bib', style: 'chicago-note-bibliography' },
  markdown: { label: 'Markdown list', ext: 'md', mime: 'text/markdown', zotero: null },
};

export const APPROXIMATE = new Set(['apa', 'mla', 'chicago']);

/** Zotero caps the itemKey parameter; stay well inside it. */
const ZOTERO_CHUNK = 40;

// ------------------------------------------------------------- name parsing

/**
 * Split a display name into family and given parts.
 * "Foucault, Michel" and "Michel Foucault" both work. Multi-word surnames
 * without a comma ("Ludwig van Beethoven") are guessed at using the common
 * lowercase nobiliary particles.
 */
export function splitName(name) {
  const s = String(name || '').trim();
  if (!s) return { family: '', given: '' };
  if (s.includes(',')) {
    const [family, ...rest] = s.split(',');
    return { family: family.trim(), given: rest.join(',').trim() };
  }
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { family: parts[0], given: '' };

  const particles = ['van', 'von', 'de', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'den', 'der', 'ten', 'ter', 'bin', 'ibn'];
  let cut = parts.length - 1;
  for (let i = parts.length - 2; i >= 1; i -= 1) {
    if (particles.includes(parts[i].toLowerCase())) cut = i;
    else break;
  }
  return { family: parts.slice(cut).join(' '), given: parts.slice(0, cut).join(' ') };
}

function initials(given) {
  return String(given || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `${w[0].toUpperCase()}.`)
    .join(' ');
}

// -------------------------------------------------------------- citekeys

const usedKeys = new Set();

export function citekeyFor(item, taken = usedKeys) {
  if (item.citekey) return item.citekey;
  const { family } = splitName(item.authors?.[0] || '');
  const author = (family || 'anon').toLowerCase().replace(/[^a-z]/g, '') || 'anon';
  const year = item.year || 'nd';
  const word = String(item.title || '')
    .replace(/^(the|a|an)\s+/i, '')
    .split(/\s+/)[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, '') || '';
  let base = `${author}${year}${word}`;
  let key = base;
  let n = 1;
  while (taken.has(key)) {
    n += 1;
    key = `${base}${String.fromCharCode(96 + n)}`;
  }
  taken.add(key);
  return key;
}

// ------------------------------------------------------------------ BibTeX

const BIBTEX_TYPES = {
  book: 'book',
  bookSection: 'incollection',
  journalArticle: 'article',
  thesis: 'phdthesis',
  report: 'techreport',
  conferencePaper: 'inproceedings',
  webpage: 'misc',
};

/** Escape the characters BibTeX treats as syntax. */
function bibtexEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

export function toBibtex(items) {
  const taken = new Set();
  return items.map((item) => {
    const type = BIBTEX_TYPES[item.itemType] || 'book';
    const key = citekeyFor(item, taken);
    const fields = [];
    const add = (name, value) => {
      if (value == null || value === '') return;
      fields.push(`  ${name} = {${bibtexEscape(value)}}`);
    };

    // Double braces keep the title's capitalisation through BibTeX styles that
    // would otherwise lowercase it.
    if (item.title) fields.push(`  title = {{${bibtexEscape(item.title)}}}`);
    const authors = (item.authors || [])
      .map((n) => {
        const { family, given } = splitName(n);
        return given ? `${family}, ${given}` : family;
      })
      .filter(Boolean);
    if (authors.length) add('author', authors.join(' and '));
    add('year', item.year);
    if (type === 'article') {
      add('journal', item.container);
      add('volume', item.volume);
      add('number', item.issue);
    } else if (type === 'incollection') {
      add('booktitle', item.container);
    }
    add('publisher', item.publisher);
    add('pages', item.pages);
    add('isbn', item.isbn);
    add('doi', item.doi);
    add('url', item.url);
    if (item.notes) add('note', item.notes.split('\n')[0].slice(0, 200));

    return `@${type}{${key},\n${fields.join(',\n')}\n}`;
  }).join('\n\n');
}

// --------------------------------------------------------------------- RIS

const RIS_TYPES = {
  book: 'BOOK',
  bookSection: 'CHAP',
  journalArticle: 'JOUR',
  thesis: 'THES',
  report: 'RPRT',
  conferencePaper: 'CONF',
  webpage: 'ELEC',
};

export function toRis(items) {
  return items.map((item) => {
    const lines = [`TY  - ${RIS_TYPES[item.itemType] || 'BOOK'}`];
    const add = (tag, value) => {
      if (value == null || value === '') return;
      lines.push(`${tag}  - ${String(value).replace(/\r?\n/g, ' ')}`);
    };
    add('TI', item.title);
    for (const n of item.authors || []) {
      const { family, given } = splitName(n);
      add('AU', given ? `${family}, ${given}` : family);
    }
    add('PY', item.year);
    if (item.itemType === 'journalArticle') add('JO', item.container);
    else if (item.container) add('BT', item.container);
    add('VL', item.volume);
    add('IS', item.issue);
    const range = String(item.pages || '').match(/(\d+)\s*[-–]\s*(\d+)/);
    if (range) {
      add('SP', range[1]);
      add('EP', range[2]);
    } else if (item.pages) {
      add('SP', item.pages);
    }
    add('PB', item.publisher);
    add('SN', item.isbn);
    add('DO', item.doi);
    add('UR', item.url);
    add('AB', item.abstract);
    lines.push('ER  - ');
    return lines.join('\n');
  }).join('\n\n');
}

// ---------------------------------------------------------------- CSL-JSON

const CSL_TYPES = {
  book: 'book',
  bookSection: 'chapter',
  journalArticle: 'article-journal',
  thesis: 'thesis',
  report: 'report',
  conferencePaper: 'paper-conference',
  webpage: 'webpage',
};

export function toCslJson(items) {
  const taken = new Set();
  const rows = items.map((item) => {
    const entry = {
      id: citekeyFor(item, taken),
      type: CSL_TYPES[item.itemType] || 'book',
      title: item.title || undefined,
      author: (item.authors || []).map((n) => {
        const { family, given } = splitName(n);
        return given ? { family, given } : { literal: family };
      }),
    };
    if (item.year) entry.issued = { 'date-parts': [[item.year]] };
    if (item.container) entry['container-title'] = item.container;
    if (item.publisher) entry.publisher = item.publisher;
    if (item.volume) entry.volume = String(item.volume);
    if (item.issue) entry.issue = String(item.issue);
    if (item.pages) entry.page = String(item.pages);
    if (item.isbn) entry.ISBN = item.isbn;
    if (item.doi) entry.DOI = item.doi;
    if (item.url) entry.URL = item.url;
    if (item.abstract) entry.abstract = item.abstract;
    if (!entry.author.length) delete entry.author;
    return entry;
  });
  return JSON.stringify(rows, null, 2);
}

// ------------------------------------------------------- formatted styles

function authorsApa(authors) {
  const names = (authors || []).map((n) => {
    const { family, given } = splitName(n);
    return given ? `${family}, ${initials(given)}` : family;
  }).filter(Boolean);
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}, & ${names[1]}`;
  if (names.length <= 20) return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
  return `${names.slice(0, 19).join(', ')}, … ${names[names.length - 1]}`;
}

function authorsMla(authors) {
  const names = (authors || []).map((n) => splitName(n));
  if (!names.length) return '';
  const first = names[0].given ? `${names[0].family}, ${names[0].given}` : names[0].family;
  if (names.length === 1) return first;
  if (names.length === 2) {
    const second = [names[1].given, names[1].family].filter(Boolean).join(' ');
    return `${first}, and ${second}`;
  }
  return `${first}, et al.`;
}

function period(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Locally formatted entries. Correct for the common cases and clearly labelled
 * as approximate in the UI — a full CSL engine is what Zotero is for, and this
 * defers to it whenever an item is linked.
 */
export function toFormatted(items, style) {
  return items.map((item) => {
    const year = item.year || 'n.d.';
    const title = item.title || 'Untitled';
    const bits = [];

    if (style === 'apa') {
      bits.push(period(authorsApa(item.authors)));
      bits.push(`(${year}).`);
      bits.push(item.itemType === 'journalArticle' ? period(title) : `${period(title)}`);
      if (item.container) {
        bits.push(period(item.container + (item.volume ? `, ${item.volume}` : '') + (item.pages ? `, ${item.pages}` : '')));
      } else if (item.publisher) {
        bits.push(period(item.publisher));
      }
      if (item.doi) bits.push(`https://doi.org/${item.doi}`);
      else if (item.url) bits.push(item.url);
    } else if (style === 'mla') {
      bits.push(period(authorsMla(item.authors)));
      bits.push(item.itemType === 'journalArticle' ? `"${period(title)}"` : `${period(title)}`);
      if (item.container) bits.push(period(item.container));
      if (item.publisher) bits.push(period(item.publisher));
      bits.push(period(year));
      if (item.pages) bits.push(period(`pp. ${item.pages}`));
      if (item.doi) bits.push(`https://doi.org/${item.doi}`);
    } else {
      // Chicago, bibliography style
      bits.push(period(authorsMla(item.authors)));
      bits.push(item.itemType === 'journalArticle' ? `"${period(title)}"` : `${period(title)}`);
      if (item.container) bits.push(period(item.container));
      if (item.publisher) bits.push(`${item.publisher},`);
      bits.push(period(year));
      if (item.doi) bits.push(`https://doi.org/${item.doi}`);
    }
    return bits.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  })
    .sort((a, b) => a.localeCompare(b))
    .join('\n\n');
}

export function toMarkdown(items) {
  return items.map((item) => {
    const authors = (item.authors || []).join(', ');
    const link = item.doi ? `https://doi.org/${item.doi}` : item.url;
    const head = link ? `[${item.title}](${link})` : item.title;
    const tail = [authors, item.year, item.publisher].filter(Boolean).join(', ');
    const progress = item.totalPages ? ` — ${item.currentPage || 0}/${item.totalPages} pp` : '';
    return `- **${head}**${tail ? ` — ${tail}` : ''}${progress}`;
  }).join('\n');
}

// ------------------------------------------------------------------ Zotero

/** Ask Zotero to export the items it knows about, in its own formatter. */
async function zoteroExport(cfg, keys, format) {
  const spec = FORMATS[format];
  if (!spec?.zotero) return null;
  const out = [];
  for (let i = 0; i < keys.length; i += ZOTERO_CHUNK) {
    const chunk = keys.slice(i, i + ZOTERO_CHUNK);
    const params = new URLSearchParams({ itemKey: chunk.join(','), format: spec.zotero });
    if (spec.style) params.set('style', spec.style);
    if (spec.zotero === 'bib') params.set('linkwrap', '0');
    const res = await fetch(`https://api.zotero.org/users/${cfg.zoteroUserId}/items?${params}`, {
      headers: { 'Zotero-API-Version': '3', 'Zotero-API-Key': cfg.zoteroApiKey },
    });
    if (!res.ok) throw new Error(`Zotero returned ${res.status} for the export.`);
    out.push(await res.text());
  }
  return out.join('\n');
}

/** Zotero's formatted bibliographies come back as HTML; flatten to text. */
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const entries = [...doc.querySelectorAll('.csl-entry')];
  const nodes = entries.length ? entries : [doc.body];
  return nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
}

function mergeCslJson(a, b) {
  const parse = (t) => {
    try {
      const v = JSON.parse(t);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  return JSON.stringify([...parse(a), ...parse(b)], null, 2);
}

// ------------------------------------------------------------------ export

/**
 * Build a bibliography.
 *
 * @param {object[]} items  board items
 * @param {object} options  { format, settings, useZotero, onProgress }
 * @returns {{text: string, format: string, counts: object, notes: string[]}}
 */
export async function buildBibliography(items, { format = 'bibtex', settings = {}, useZotero = true, onProgress } = {}) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`Unknown format: ${format}`);

  const sorted = [...items].sort((a, b) => {
    const an = splitName(a.authors?.[0] || '').family.toLowerCase();
    const bn = splitName(b.authors?.[0] || '').family.toLowerCase();
    if (an !== bn) return an.localeCompare(bn);
    return (a.year || 0) - (b.year || 0);
  });

  const notes = [];
  const zoteroCapable = Boolean(
    useZotero && spec.zotero && settings.zoteroApiKey && settings.zoteroUserId,
  );
  const linked = zoteroCapable ? sorted.filter((i) => i.zoteroKey) : [];
  const local = zoteroCapable ? sorted.filter((i) => !i.zoteroKey) : sorted;

  let zoteroText = '';
  if (linked.length) {
    onProgress?.(`Asking Zotero to format ${linked.length} item(s)…`);
    try {
      const raw = await zoteroExport(settings, linked.map((i) => i.zoteroKey), format);
      zoteroText = spec.zotero === 'bib' ? htmlToText(raw) : (raw || '').trim();
    } catch (err) {
      // Falling back is better than failing: the local generator covers
      // everything, just with less detail.
      notes.push(`Zotero export failed (${err.message}); generated locally instead.`);
      local.unshift(...linked);
      linked.length = 0;
    }
  }

  onProgress?.('Formatting…');
  let localText = '';
  if (local.length) {
    if (format === 'bibtex') localText = toBibtex(local);
    else if (format === 'ris') localText = toRis(local);
    else if (format === 'csljson') localText = toCslJson(local);
    else if (format === 'markdown') localText = toMarkdown(local);
    else localText = toFormatted(local, format);
  }

  let text;
  if (format === 'csljson' && zoteroText && localText) text = mergeCslJson(zoteroText, localText);
  else text = [zoteroText, localText].filter(Boolean).join(format === 'bibtex' || format === 'ris' ? '\n\n' : '\n\n');

  if (linked.length && local.length) {
    notes.push(`${linked.length} formatted by Zotero, ${local.length} generated locally.`);
  }
  if (APPROXIMATE.has(format) && local.length) {
    notes.push(`${local.length} entr${local.length === 1 ? 'y is' : 'ies are'} formatted approximately — link them to Zotero for exact ${spec.label.split(' ')[0]} output.`);
  }

  return {
    text: text.trim(),
    format,
    counts: { total: sorted.length, zotero: linked.length, local: local.length },
    notes,
  };
}

export function filenameFor(label, format) {
  const spec = FORMATS[format] || FORMATS.bibtex;
  const safe = String(label || 'bibliography')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'bibliography';
  return `${safe}.${spec.ext}`;
}
