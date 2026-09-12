// boardsync.js — keeping the board the same on every computer.
//
// Every sync is a read-modify-write, never a blind overwrite:
//
//   1. pull whatever the Gist holds
//   2. merge it with this machine's copy, record by record (see merge.js)
//   3. adopt the result locally
//   4. push it back, but only if it differs from what was there
//
// Pushing without reading first is what loses work: two machines each upload
// their whole board and the later one wins outright. Reading first means the
// two are combined instead.
//
// The Gist id is *discovered* from the account rather than remembered per
// machine, so signing in on a new computer finds the existing board instead of
// starting a second one.

import * as store from './store.js';
import * as gist from './gist.js';
import * as auth from './auth.js';
import { mergeStates, fingerprintState } from './merge.js';

const PUSH_DEBOUNCE_MS = 4000;
const POLL_MS = 60_000;
const FOCUS_COOLDOWN_MS = 10_000;

let timer = null;
let poll = null;
let applying = false;      // suppresses the echo when sync writes to the store
let running = null;        // the in-flight sync, so two cannot overlap
let lastSyncAt = 0;
let onStatus = () => {};
let started = false;

export function syncEnabled() {
  const cfg = store.getSettings();
  if (cfg.gistSyncEnabled === false) return false;
  return Boolean(auth.githubToken(cfg));
}

function cfgWithToken() {
  return auth.withGithubToken(store.getSettings());
}

function status(state, detail) {
  onStatus(state, detail);
}

// ------------------------------------------------------------------- syncing

/**
 * Pull, merge, adopt, push. Safe to call at any time; overlapping calls share
 * the one in flight.
 */
export async function syncNow({ reason = 'manual', quiet = true } = {}) {
  if (!syncEnabled()) return { skipped: 'disabled' };
  if (running) return running;
  running = doSync(reason, quiet).finally(() => {
    running = null;
    lastSyncAt = Date.now();
  });
  return running;
}

async function doSync(reason, quiet) {
  status('syncing');
  try {
    let cfg = cfgWithToken();

    // Resolve which gist to use — configured, discovered, or newly created.
    if (!cfg.gistId) {
      const resolved = await gist.resolveGist(cfg, store.exportState());
      store.saveSettings({ gistId: resolved.gistId });
      cfg = cfgWithToken();
      if (resolved.source === 'discovered') {
        status('ok');
        console.info(`board sync: adopted existing gist ${resolved.gistId}`);
      } else if (resolved.source === 'created') {
        console.info(`board sync: created gist ${resolved.gistId}`);
        status('ok');
        return { created: true, gistId: resolved.gistId };
      }
    }

    let remote = null;
    try {
      remote = await gist.pullState(cfg);
    } catch (err) {
      if (err.status === 404) {
        // The gist went away; forget it and let the next run resolve again.
        store.saveSettings({ gistId: '' });
        throw new Error('The synced Gist no longer exists — it will be recreated on the next sync.');
      }
      throw err;
    }

    const local = store.exportState();
    const remoteState = remote.state || {};
    const { state: merged, summary } = mergeStates(local, remoteState);
    merged.settings = newerSettings(store.portableSettings(), remoteState.settings);

    const localPrint = fingerprintState(local);
    const mergedPrint = fingerprintState(merged);
    const remotePrint = fingerprintState(remoteState);

    if (mergedPrint !== localPrint) {
      applying = true;
      try {
        store.replaceState(merged, 'sync');
      } finally {
        applying = false;
      }
    }
    store.applyPortableSettings(remoteState.settings);

    let pushed = false;
    if (mergedPrint !== remotePrint || settingsDiffer(merged.settings, remoteState.settings)) {
      const res = await gist.pushState(cfgWithToken(), merged);
      if (res.gistId && res.gistId !== cfg.gistId) store.saveSettings({ gistId: res.gistId });
      // Recording the push is bookkeeping, not an edit — without this guard it
      // would schedule another sync, which would find nothing and stop anyway.
      applying = true;
      try {
        store.setMeta({ lastGistPush: res.pushedAt });
      } finally {
        applying = false;
      }
      pushed = true;
    }

    status('ok');
    const changed = summary.fromRemote + summary.added + summary.deleted;
    if (changed && !quiet) {
      status('ok', `${summary.added} new, ${summary.fromRemote} updated, ${summary.deleted} removed`);
    }
    console.info(`board sync (${reason}):`, { ...summary, pushed });
    return { summary, pushed, changed };
  } catch (err) {
    status('error', err.message);
    if (!quiet) throw err;
    console.warn(`board sync (${reason}) failed`, err);
    return { error: err.message };
  }
}

function newerSettings(mine, theirs) {
  if (!theirs) return mine;
  const a = mine?.settingsModifiedAt || '';
  const b = theirs.settingsModifiedAt || '';
  return b > a ? theirs : mine;
}

function settingsDiffer(a, b) {
  return JSON.stringify(a || {}) !== JSON.stringify(b || {});
}

// ------------------------------------------------------------------ triggers

/** Debounced after an edit, so a burst of changes becomes one sync. */
export function scheduleSync() {
  if (applying || !syncEnabled()) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    syncNow({ reason: 'edit' });
  }, PUSH_DEBOUNCE_MS);
}

/** Flush a pending sync immediately, e.g. before the page goes away. */
export function flushSync() {
  if (!timer) return null;
  clearTimeout(timer);
  timer = null;
  return syncNow({ reason: 'flush' });
}

export function startBoardSync({ onStatus: statusFn } = {}) {
  if (statusFn) onStatus = statusFn;
  if (started) return;
  started = true;

  store.subscribe(() => scheduleSync());

  // Regular polling is what makes a second machine notice the first one's
  // work without a reload.
  poll = setInterval(() => syncNow({ reason: 'poll' }), POLL_MS);

  const wake = () => {
    if (document.visibilityState === 'hidden') return;
    if (Date.now() - lastSyncAt < FOCUS_COOLDOWN_MS) return;
    syncNow({ reason: 'focus' });
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('online', () => syncNow({ reason: 'online' }));

  window.addEventListener('beforeunload', () => {
    // Best effort: the browser may not let this finish, which is exactly why
    // the debounce is short and polling exists.
    flushSync();
  });

  return syncNow({ reason: 'startup' });
}

export function stopBoardSync() {
  clearTimeout(timer);
  clearInterval(poll);
  timer = null;
  poll = null;
  started = false;
}

export function syncState() {
  return {
    enabled: syncEnabled(),
    gistId: store.getSettings().gistId || null,
    lastSyncAt: lastSyncAt || null,
    pending: Boolean(timer),
    inFlight: Boolean(running),
  };
}

export { PUSH_DEBOUNCE_MS, POLL_MS };
