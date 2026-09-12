#!/usr/bin/env node
/**
 * goodreads_upload.mjs — upload a CSV to Goodreads without you doing it.
 *
 * Goodreads has no write API, and /review/import sits behind a sign-in that
 * goes through Amazon: bot detection, CAPTCHAs, often an OTP. Automating that
 * login with a stored password would be both fragile and a bad idea for your
 * Amazon account.
 *
 * So this never logs in. It drives a *persistent browser profile* that you sign
 * into once, by hand:
 *
 *   node tools/goodreads_upload.mjs --login     once, a window opens, you sign in
 *   node tools/goodreads_upload.mjs             thereafter, headless
 *
 * The profile lives in tools/.goodreads-profile (gitignored). No credentials
 * pass through this script, and none are stored by it.
 *
 * It also drives the real form rather than forging the POST. The page carries a
 * Rails CSRF token; letting the browser submit it means the token, the cookies
 * and the multipart encoding are all Goodreads' own problem, not ours.
 *
 * Exit codes:  0 uploaded (or nothing to do)   2 not signed in
 *              3 no file   4 upload failed     5 Playwright missing
 *
 * NOTE: automated access is against the Goodreads Terms of Service. It is your
 * account and your data; run this knowing that.
 */

import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
export const PROFILE_DIR = join(here, '.goodreads-profile');
export const DEBUG_DIR = join(here, '.goodreads-debug');

const IMPORT_URL = 'https://www.goodreads.com/review/import';
const SIGNED_OUT = /\/user\/(new|sign_in)|amazon\.[a-z.]+\/ap\/signin/i;

// ---------------------------------------------------------------- arguments

export function parseArgs(argv) {
  const args = {
    login: false, headed: false, dryRun: false, help: false,
    file: null, name: null, dir: null, timeoutMs: 90_000, keepOpen: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--login') args.login = true;
    else if (a === '--headed') args.headed = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--keep-open') args.keepOpen = true;
    else if (a === '--file') args.file = argv[i += 1] || null;
    else if (a === '--dir') args.dir = argv[i += 1] || null;
    else if (a === '--name') args.name = argv[i += 1] || null;
    else if (a === '--timeout') args.timeoutMs = Math.max(10_000, Number(argv[i += 1]) || 90_000);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

export function downloadsDir() {
  return process.env.READERHELPER_DOWNLOADS || join(homedir(), 'Downloads');
}

/**
 * Pick the CSV to upload: an explicit path, a name in the downloads folder, or
 * the most recent goodreads-*.csv there.
 */
export function resolveCsv({ file, name, dir } = {}) {
  if (file) {
    const p = resolve(file);
    return existsSync(p) ? { path: p } : { error: `No such file: ${p}` };
  }
  const folder = dir || downloadsDir();
  if (!existsSync(folder)) return { error: `No downloads folder at ${folder}` };

  if (name) {
    const p = join(folder, basename(name));
    return existsSync(p) ? { path: p } : { error: `No such file: ${p}` };
  }

  const candidates = readdirSync(folder)
    .filter((f) => /^goodreads-.*\.csv$/i.test(f))
    .map((f) => ({ f, p: join(folder, f), t: safeMtime(join(folder, f)) }))
    .sort((a, b) => b.t - a.t);

  if (!candidates.length) {
    return { error: `No goodreads-*.csv in ${folder}. Export one from readerHelper first.` };
  }
  return { path: candidates[0].p, pickedNewestOf: candidates.length };
}

function safeMtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Decide what the page is telling us after a submit. */
export function classifyOutcome(url, bodyText) {
  const text = String(bodyText || '');
  if (SIGNED_OUT.test(String(url || ''))) return { ok: false, reason: 'signed-out' };
  if (/import(ing)? (is )?(in progress|started|queued)|we're importing|being imported/i.test(text)) {
    return { ok: true, reason: 'queued' };
  }
  if (/successfully imported|import complete|books? (were |was )?imported/i.test(text)) {
    return { ok: true, reason: 'imported' };
  }
  if (/(error|problem|could not|couldn't|failed|invalid)/i.test(text) && /import|file|csv/i.test(text)) {
    return { ok: false, reason: 'rejected' };
  }
  return { ok: null, reason: 'unclear' };
}

export function isSignedOutUrl(url) {
  return SIGNED_OUT.test(String(url || ''));
}

// ------------------------------------------------------------------ running

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    console.error(
      'Playwright is not installed. Once, from the project root:\n'
      + '\n  npm install --no-save playwright'
      + '\n  npx playwright install chromium\n'
      + '\n(~130MB. It only ever runs on this machine.)',
    );
    process.exit(5);
  }
  return null;
}

function saveDebug(name, content) {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    writeFileSync(join(DEBUG_DIR, name), content);
    return join(DEBUG_DIR, name);
  } catch {
    return null;
  }
}

async function openContext({ headless }) {
  const { chromium } = await loadPlaywright();
  mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

/** Open a real window so you can sign in once; wait until you have. */
async function runLogin(args) {
  console.log('Opening a browser. Sign in to Goodreads, then leave it — this closes itself.\n');
  const context = await openContext({ headless: false });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(IMPORT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (page.isClosed()) break;
    const url = page.url();
    if (!isSignedOutUrl(url) && /goodreads\.com\/review\/import/i.test(url)) {
      console.log('Signed in. The session is saved — future runs are headless.');
      await context.close();
      return 0;
    }
  }
  console.error('Gave up waiting for a sign-in. Nothing was saved.');
  await context.close();
  return 2;
}

/** Upload a CSV using the session already in the profile. */
async function runUpload(args) {
  const picked = resolveCsv(args);
  if (picked.error) {
    console.error(picked.error);
    return 3;
  }
  console.log(`Uploading ${picked.path}`);
  if (args.dryRun) {
    console.log('[dry run] stopping before the browser opens.');
    return 0;
  }
  if (!existsSync(PROFILE_DIR)) {
    console.error('Not signed in yet. Run once with --login.');
    return 2;
  }

  const context = await openContext({ headless: !args.headed });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(args.timeoutMs);

  try {
    await page.goto(IMPORT_URL, { waitUntil: 'domcontentloaded' });
    if (isSignedOutUrl(page.url())) {
      console.error('The saved session has expired. Run again with --login.');
      return 2;
    }

    const input = page.locator('input[type="file"]').first();
    await input.waitFor({ state: 'attached', timeout: 20_000 });
    await input.setInputFiles(picked.path);

    // Let the page submit itself: it owns the CSRF token and the encoding.
    const submit = page.locator(
      'input[type="submit"], button[type="submit"], form[action*="import"] button',
    ).first();
    if (await submit.count()) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded').catch(() => {}),
        submit.click({ timeout: 20_000 }),
      ]);
    }
    await page.waitForTimeout(4000);

    const bodyText = await page.locator('body').innerText().catch(() => '');
    const outcome = classifyOutcome(page.url(), bodyText);

    if (outcome.ok) {
      console.log(outcome.reason === 'queued'
        ? 'Goodreads accepted the file and is importing it.'
        : 'Goodreads reports the import is done.');
      return 0;
    }
    if (outcome.reason === 'signed-out') {
      console.error('Signed out mid-upload. Run again with --login.');
      return 2;
    }

    // Unclear or rejected: keep the evidence rather than guessing.
    const shot = join(DEBUG_DIR, 'last-upload.png');
    mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    const html = saveDebug('last-upload.html', await page.content().catch(() => ''));
    console.error(
      outcome.reason === 'rejected'
        ? 'Goodreads rejected the file.'
        : 'Could not tell whether it worked — Goodreads may have changed the page.',
    );
    console.error(`  page:       ${page.url()}`);
    console.error(`  screenshot: ${shot}`);
    if (html) console.error(`  html:       ${html}`);
    console.error('  Re-run with --headed to watch it happen.');
    return outcome.reason === 'rejected' ? 4 : 4;
  } catch (err) {
    console.error(`Upload failed: ${err.message}`);
    const shot = join(DEBUG_DIR, 'last-error.png');
    mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.error(`  screenshot: ${shot}`);
    return 4;
  } finally {
    if (!args.keepOpen) await context.close().catch(() => {});
  }
}

const HELP = `
goodreads_upload.mjs — upload a readerHelper CSV to Goodreads headlessly.

  --login          open a window so you can sign in once (required first)
  --file <path>    upload this file
  --name <file>    upload this filename from your Downloads folder
  --dir <path>     look in this folder instead of Downloads
  --headed         show the browser (for debugging)
  --dry-run        say what would be uploaded, then stop
  --keep-open      leave the browser open afterwards
  --timeout <ms>   default 90000

With no file argument it takes the newest goodreads-*.csv from Downloads.

Automated access is against the Goodreads Terms of Service.
`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  return args.login ? runLogin(args) : runUpload(args);
}

// Only run when executed directly, so the helpers above stay importable.
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
