// nlp.js — natural-language parsing for reading progress and palette commands.
//
// Deliberately deterministic: no model call, no API key, works offline. The
// grammar covers how reading actually gets reported — an amount consumed
// ("30 pages", "two chapters"), an absolute stopping point ("up to p. 210"),
// or a proportion ("halfway", "40%").

export const DEFAULT_PARAGRAPHS_PER_PAGE = 4;

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100,
};

const FRACTION_WORDS = {
  'all': 1, 'everything': 1, 'the whole thing': 1, 'the rest': 1, 'to the end': 1,
  'three quarters': 0.75, 'three-quarters': 0.75, 'two thirds': 2 / 3, 'two-thirds': 2 / 3,
  'half': 0.5, 'halfway': 0.5, 'a half': 0.5, 'midway': 0.5,
  'a third': 1 / 3, 'one third': 1 / 3, 'a quarter': 0.25, 'one quarter': 0.25,
};

const UNIT_ALIASES = {
  page: 'pages', pages: 'pages', pg: 'pages', pgs: 'pages', p: 'pages', pp: 'pages',
  chapter: 'chapters', chapters: 'chapters', chap: 'chapters', chaps: 'chapters', ch: 'chapters', chs: 'chapters',
  paragraph: 'paragraphs', paragraphs: 'paragraphs', para: 'paragraphs', paras: 'paragraphs', par: 'paragraphs',
  section: 'chapters', sections: 'chapters',
  percent: 'percent', '%': 'percent',
};

export function parseNumber(token) {
  if (token == null) return null;
  const t = String(token).trim().toLowerCase().replace(/,/g, '');
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  // "twenty five" / "twenty-five"
  const parts = t.split(/[\s-]+/);
  let total = 0;
  let matched = false;
  for (const part of parts) {
    const v = NUMBER_WORDS[part];
    if (v == null) continue;
    matched = true;
    total = v === 100 && total ? total * 100 : total + v;
  }
  return matched ? total : null;
}

/**
 * Parse a reading report into a structured intent.
 *
 * Returns { kind, unit, amount, raw, needs } where `kind` is one of:
 *   'absolute'  — a stopping point was named (page/chapter N)
 *   'delta'     — an amount consumed since last time
 *   'fraction'  — a proportion of the whole
 * `needs` lists metadata required to resolve it (e.g. ['totalPages']).
 */
export function parseReading(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const text = raw.toLowerCase().replace(/\bpp?\./g, 'p ').replace(/\bch\./g, 'ch ');

  // 1. Percentages: "40%", "40 percent"
  const pct = text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/);
  if (pct) {
    return { kind: 'fraction', unit: 'percent', amount: parseFloat(pct[1]) / 100, raw, needs: [] };
  }

  // 2. Absolute stopping point: "up to page 210", "stopped at p 88", "through chapter 4"
  const abs = text.match(
    /(?:up\s+to|to|through|thru|til|till|until|stopped\s+at|stopping\s+at|ended\s+at|finished\s+at|reached|got\s+to|now\s+on|currently\s+on|at)\s+(?:the\s+)?(?:end\s+of\s+)?(page|pages|p|pg|chapter|chapters|ch|chap|section)\s*\.?\s*([\w-]+)/,
  );
  if (abs) {
    const unit = UNIT_ALIASES[abs[1]] || 'pages';
    const amount = parseNumber(abs[2]);
    if (amount != null) {
      return {
        kind: 'absolute',
        unit,
        amount,
        raw,
        needs: unit === 'chapters' ? ['totalChapters', 'totalPages'] : [],
      };
    }
  }

  // 3. "finished chapter 4" — absolute, end of that chapter
  const finished = text.match(/(?:finished|completed|done\s+with)\s+(?:the\s+)?(chapter|chapters|ch|chap|section)\s*\.?\s*([\w-]+)/);
  if (finished) {
    const amount = parseNumber(finished[2]);
    if (amount != null) {
      return { kind: 'absolute', unit: 'chapters', amount, raw, needs: ['totalChapters', 'totalPages'] };
    }
  }

  // 4. Word fractions: "halfway", "about two thirds"
  for (const [phrase, value] of Object.entries(FRACTION_WORDS)) {
    const re = new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`);
    if (re.test(text)) {
      return { kind: 'fraction', unit: 'percent', amount: value, raw, needs: [] };
    }
  }

  // 5. Amount consumed: "30 pages", "read two chapters", "12 paragraphs"
  const delta = text.match(/([\w-]+(?:\s+[\w-]+)?)\s*(pages?|pgs?|pg|chapters?|chaps?|chs?|ch|paragraphs?|paras?|par|sections?)\b/);
  if (delta) {
    const amount = parseNumber(delta[1]) ?? parseNumber(delta[1].split(/\s+/).pop());
    const unit = UNIT_ALIASES[delta[2].replace(/s$/, '')] || UNIT_ALIASES[delta[2]] || 'pages';
    if (amount != null) {
      const needs = unit === 'chapters' ? ['totalChapters', 'totalPages'] : ['totalPages'];
      return { kind: 'delta', unit, amount, raw, needs };
    }
  }

  // 6. Bare number — assume pages consumed
  const bare = parseNumber(text);
  if (bare != null) {
    return { kind: 'delta', unit: 'pages', amount: bare, raw, needs: ['totalPages'] };
  }

  return null;
}

/**
 * Turn a parsed intent into a concrete page + fraction for a given book.
 *
 * Returns { ok, resolvedPage, resolvedFraction, missing, explain }. When `ok`
 * is false, `missing` names the metadata the caller must prompt for.
 */
export function resolveReading(intent, item, opts = {}) {
  if (!intent) return { ok: false, missing: [], explain: 'Could not read that.' };
  const parasPerPage = item?.paragraphsPerPage || opts.paragraphsPerPage || DEFAULT_PARAGRAPHS_PER_PAGE;
  const totalPages = numOrNull(item?.totalPages);
  const totalChapters = numOrNull(item?.totalChapters);
  const currentPage = Math.max(0, item?.currentPage || 0);

  const missing = [];
  const needsChapters = intent.unit === 'chapters';
  if (needsChapters && !totalChapters) missing.push('totalChapters');
  if (intent.kind !== 'fraction' && !totalPages) {
    // A page-count is what converts everything into a percentage.
    if (!(intent.kind === 'absolute' && intent.unit === 'pages')) missing.push('totalPages');
    else missing.push('totalPages');
  }
  if (missing.length) {
    return { ok: false, missing, explain: `Need ${missing.map(prettyField).join(' and ')} first.` };
  }

  let page = currentPage;
  let explain = '';

  if (intent.kind === 'fraction') {
    const frac = clamp01(intent.amount);
    page = totalPages ? Math.round(frac * totalPages) : null;
    return {
      ok: true,
      resolvedPage: page,
      resolvedFraction: frac,
      missing: [],
      explain: totalPages
        ? `${pct(frac)} of ${totalPages} pages → page ${page}`
        : `${pct(frac)} complete`,
    };
  }

  if (intent.kind === 'absolute') {
    if (intent.unit === 'pages') {
      page = intent.amount;
      explain = `stopped at page ${page}`;
    } else if (intent.unit === 'chapters') {
      const pagesPerChapter = totalPages / totalChapters;
      page = Math.round(intent.amount * pagesPerChapter);
      explain = `end of ch. ${intent.amount} ≈ page ${page} (${round1(pagesPerChapter)} pp/ch)`;
    }
  } else {
    // delta
    if (intent.unit === 'pages') {
      page = currentPage + intent.amount;
      explain = `+${intent.amount} pages from ${currentPage} → page ${page}`;
    } else if (intent.unit === 'chapters') {
      const pagesPerChapter = totalPages / totalChapters;
      page = Math.round(currentPage + intent.amount * pagesPerChapter);
      explain = `+${intent.amount} ch ≈ +${round1(intent.amount * pagesPerChapter)} pages → page ${page}`;
    } else if (intent.unit === 'paragraphs') {
      const added = intent.amount / parasPerPage;
      page = Math.round(currentPage + added);
      explain = `+${intent.amount} paragraphs ≈ +${round1(added)} pages → page ${page}`;
    }
  }

  page = Math.max(0, Math.min(page, totalPages));
  const frac = totalPages ? clamp01(page / totalPages) : 0;
  return { ok: true, resolvedPage: page, resolvedFraction: frac, missing: [], explain: `${explain} · ${pct(frac)}` };
}

export function prettyField(field) {
  return { totalPages: 'a total page count', totalChapters: 'a chapter count' }[field] || field;
}

function numOrNull(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

export function pct(frac) {
  return `${Math.round(clamp01(frac) * 100)}%`;
}

/**
 * Loose fuzzy match used by the palette pickers: every query character must
 * appear in order. Scores prefix and word-boundary hits higher.
 */
export function fuzzyScore(query, target) {
  const q = String(query || '').toLowerCase().trim();
  const t = String(target || '').toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 1000 - t.length;
  const wordStart = new RegExp(`\\b${q.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`);
  if (wordStart.test(t)) return 800 - t.length;
  const direct = t.indexOf(q);
  if (direct >= 0) return 600 - direct;
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    score += found === ti ? 3 : 1;
    ti = found + 1;
  }
  return score;
}
