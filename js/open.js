// open.js — handing a book off to Zotero or a local PDF reader.
//
// A page served over https cannot navigate to file:///C:/... — Chrome blocks it
// with no error. Custom protocols are the sanctioned escape hatch, so both
// buttons go through one:
//
//   zotero://select/items/@citekey            select the item in Zotero
//   zotero://open-pdf/library/items/KEY?page=N  open the PDF in Zotero's reader
//   readerhelper://open?path=...&page=N       hand the real path to the OS,
//                                             matching Zotero Searcher's
//                                             Ctrl+Shift+O (see tools/)
//
// Protocol navigation fails silently when nothing is registered, so every call
// reports what it attempted and offers the path on the clipboard as a fallback.

import { itemProgress } from './model.js';

/** Navigate without leaving the board: an iframe absorbs the protocol handoff. */
function fireProtocol(uri) {
  try {
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.src = uri;
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), 2000);
    return true;
  } catch (err) {
    console.error('protocol navigation failed', err);
    return false;
  }
}

export function zoteroSelectUri(item) {
  if (item.citekey) return `zotero://select/items/@${encodeURIComponent(item.citekey)}`;
  if (item.zoteroKey) {
    const lib = item.zoteroLibrary || 'library';
    const scope = lib.startsWith('users/') ? 'library' : lib;
    return `zotero://select/${scope}/items/${item.zoteroKey}`;
  }
  return null;
}

export function zoteroOpenPdfUri(item, page) {
  if (!item.pdfAttachmentKey) return null;
  const p = Number(page);
  const suffix = Number.isFinite(p) && p > 0 ? `?page=${Math.round(p)}` : '';
  return `zotero://open-pdf/library/items/${item.pdfAttachmentKey}${suffix}`;
}

export function readerHelperUri(item, page) {
  if (!item.localPdfPath) return null;
  const qs = new URLSearchParams({ path: item.localPdfPath });
  const p = Number(page);
  if (Number.isFinite(p) && p > 0) qs.set('page', String(Math.round(p)));
  return `readerhelper://open?${qs}`;
}

/** Resume page: one past where reading stopped, clamped to the book. */
export function resumePage(item) {
  const cur = Number(item.currentPage) || 0;
  if (!cur) return null;
  if (item.totalPages) return Math.min(cur + 1, item.totalPages);
  return cur + 1;
}

export function openInZotero(item) {
  const uri = zoteroSelectUri(item);
  if (!uri) return { ok: false, message: 'No Zotero item linked to this book.' };
  fireProtocol(uri);
  return { ok: true, message: 'Opening in Zotero…', uri };
}

/**
 * Open the PDF. `handler` picks the route: Zotero's built-in reader (no setup,
 * and it can jump to the resume page) or the readerhelper:// handler, which
 * opens the file in the system PDF app.
 */
export function openLocalPdf(item, settings = {}) {
  const page = resumePage(item);
  const handler = settings.localPdfHandler || 'zotero';

  if (handler === 'protocol') {
    const uri = readerHelperUri(item, page);
    if (uri) {
      fireProtocol(uri);
      return { ok: true, message: `Opening ${basename(item.localPdfPath)}…`, uri };
    }
  }

  const zUri = zoteroOpenPdfUri(item, page);
  if (zUri) {
    fireProtocol(zUri);
    return {
      ok: true,
      message: page ? `Opening PDF at p. ${page}…` : 'Opening PDF in Zotero…',
      uri: zUri,
    };
  }

  // Nothing registered and no attachment key — offer the path instead.
  if (item.localPdfPath) {
    copyText(item.localPdfPath);
    return { ok: false, message: 'No PDF handler available — path copied to clipboard.' };
  }
  const sel = zoteroSelectUri(item);
  if (sel) {
    fireProtocol(sel);
    return { ok: false, message: 'No PDF attachment found — opened the item in Zotero.' };
  }
  return { ok: false, message: 'No PDF linked to this book.' };
}

export function hasZoteroLink(item) {
  return Boolean(item.citekey || item.zoteroKey);
}

export function hasPdfLink(item) {
  return Boolean(item.pdfAttachmentKey || item.localPdfPath);
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return true;
  }
  return fallbackCopy(text);
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function basename(p) {
  if (!p) return 'PDF';
  return String(p).split(/[\\/]/).pop() || 'PDF';
}

export { itemProgress };
