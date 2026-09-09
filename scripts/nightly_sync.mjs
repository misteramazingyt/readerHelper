#!/usr/bin/env node
// nightly_sync.mjs — the scheduled Zotero -> board sync.
//
// Runs in GitHub Actions at 23:00 America/Los_Angeles. It pulls the board from
// the private Gist, applies exactly the same ingest logic the browser uses
// (js/ingest.js), and pushes the result back. Open the site next morning and
// the new books are already there.
//
// Credentials come from repository Secrets, never from the repository itself:
//   ZOTERO_API_KEY, ZOTERO_USER_ID, GH_GIST_TOKEN, GIST_ID
//
// Exit codes: 0 changed or already current, 1 misconfigured or failed.

import * as zotero from '../js/zotero.js';
import * as gist from '../js/gist.js';
import { buildPlan, applyPlan, linkedCollectionKeys } from '../js/ingest.js';

const cfg = {
  zoteroApiKey: process.env.ZOTERO_API_KEY,
  zoteroUserId: process.env.ZOTERO_USER_ID,
  zoteroDataDir: process.env.ZOTERO_DATA_DIR || '',
  zoteroLinkedBaseDir: process.env.ZOTERO_LINKED_BASE_DIR || '',
  githubToken: process.env.GH_GIST_TOKEN,
  gistId: process.env.GIST_ID,
};

const DRY_RUN = process.argv.includes('--dry-run');

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`${new Date().toISOString()}  ${message}`);
}

const missing = Object.entries({
  ZOTERO_API_KEY: cfg.zoteroApiKey,
  ZOTERO_USER_ID: cfg.zoteroUserId,
  GH_GIST_TOKEN: cfg.githubToken,
  GIST_ID: cfg.gistId,
}).filter(([, v]) => !v).map(([k]) => k);

if (missing.length) {
  fail(`Missing repository secret(s): ${missing.join(', ')}. See README → Nightly sync.`);
}

let state;
let pulledAt;
try {
  log('Pulling board state from the Gist…');
  const res = await gist.pullState(cfg);
  state = res.state;
  pulledAt = res.updatedAt;
  log(`Pulled state last updated ${pulledAt}.`);
} catch (err) {
  fail(`Could not read the Gist: ${err.message}`);
}

const keys = linkedCollectionKeys(state);
if (!keys.length) {
  log('No projects are linked to a Zotero collection. Nothing to do.');
  process.exit(0);
}
log(`${keys.length} linked collection(s) to check.`);

const totals = { groups: 0, added: 0, updated: 0, unchanged: 0 };
const failures = [];

for (const key of keys) {
  try {
    const plan = await buildPlan(cfg, zotero, key, { onProgress: (m) => log(`  ${m}`) });
    const report = applyPlan(state, plan);
    totals.groups += report.groups;
    totals.added += report.added;
    totals.updated += report.updated;
    totals.unchanged += report.unchanged;
    log(`  ${plan.root.name}: +${report.added} new, ${report.updated} refreshed, ${report.unchanged} unchanged.`);
  } catch (err) {
    // A collection deleted in Zotero must not stop the others syncing.
    failures.push(`${key}: ${err.message}`);
    console.error(`::warning::Collection ${key} failed: ${err.message}`);
  }
}

const changed = totals.added > 0 || totals.updated > 0;

if (!changed) {
  log('Already up to date — not writing to the Gist.');
} else if (DRY_RUN) {
  log(`[dry run] would push: +${totals.added} new, ${totals.updated} refreshed.`);
} else {
  try {
    await gist.pushState(cfg, state);
    log(`Pushed: +${totals.added} new, ${totals.updated} refreshed, across ${totals.groups} group(s).`);
  } catch (err) {
    fail(`Could not write the Gist: ${err.message}`);
  }
}

// Surface a one-line result on the Actions summary page.
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  const lines = [
    '### readerHelper nightly sync',
    '',
    `| | |`,
    `|---|---|`,
    `| New books | ${totals.added} |`,
    `| Refreshed | ${totals.updated} |`,
    `| Unchanged | ${totals.unchanged} |`,
    `| Collections | ${keys.length} |`,
    failures.length ? `| Failures | ${failures.length} |` : '',
    '',
    failures.length ? `Problems:\n${failures.map((f) => `- ${f}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines}\n`);
}

if (failures.length && failures.length === keys.length) {
  fail('Every linked collection failed to sync.');
}
process.exit(0);
