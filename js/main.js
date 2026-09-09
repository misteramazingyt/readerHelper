// main.js — wiring. Everything else is a module; this file connects them to the
// DOM, the keyboard, and the two background jobs (Zotero sync, Gist mirror).

import * as store from './store.js';
import * as render from './render.js';
import * as sel from './selection.js';
import * as actions from './actions.js';
import * as sync from './sync.js';
import * as detail from './detail.js';
import { initDnd } from './dnd.js';
import { initPalette, openPalette } from './palette.js';
import { openSettings, openArchive, openHelp, applyTheme } from './settings.js';
import { toast, closeContextMenu, errorToast } from './ui.js';
import * as gist from './gist.js';

const GIST_DEBOUNCE_MS = 8000;
let gistTimer = null;

function boot() {
  const hadState = store.loadFromDisk();
  applyTheme();
  render.initRender();

  store.subscribe(() => {
    render.render();
    scheduleGistPush();
  });
  sel.subscribeSelection(() => render.refreshSelectionStyles());

  wireChrome();
  wireKeyboard();
  wireCustomEvents();
  wireDnd();

  initPalette({
    openItem: (itemId) => detail.openDetail(itemId),
    addGroup: (projectId) => render.addGroupInteractive(projectId),
    addProject: () => render.addProjectInteractive(),
    openSettings,
    showArchive: openArchive,
    showHelp: openHelp,
  });

  if (!hadState) seedFirstRun();
  render.render();
  detail.restoreFromHash();

  // Background: refresh from Zotero, then reconcile with the Gist.
  sync.syncOnLoad();
  pullFromGistOnLoad();

  if (!hadState) setTimeout(() => openHelp(), 400);
}

/** A board with nothing on it cannot be dragged into shape — give it a shell. */
function seedFirstRun() {
  const project = store.addProject('Reading');
  store.addGroup(project.id, 'To read');
  store.addGroup(project.id, 'Reading now');
  store.addGroup(project.id, 'Finished');
  store.setActiveProject(project.id);
}

// ------------------------------------------------------------------- chrome

function wireChrome() {
  byId('add-project-btn')?.addEventListener('click', () => render.addProjectInteractive());
  byId('zotero-import-btn')?.addEventListener('click', () => sync.promptZoteroImport());
  byId('sync-btn')?.addEventListener('click', () => sync.syncAll());
  byId('settings-btn')?.addEventListener('click', () => openSettings());
  byId('help-btn')?.addEventListener('click', () => openHelp());
  byId('archive-btn')?.addEventListener('click', () => openArchive());
  byId('palette-btn')?.addEventListener('click', () => openPalette());

  byId('active-project-title')?.addEventListener('dblclick', () => render.startRenameActiveProjectTitle());

  byId('group-sort-btn')?.addEventListener('click', (e) => {
    const state = store.getState();
    const project = state.projects[state.ui.activeProjectId];
    if (!project) return;
    render.openSortMenu(e.clientX, e.clientY, project.groupSort, (mode, dir) =>
      store.setProjectGroupSort(project.id, mode, dir));
  });

  byId('project-sort-btn')?.addEventListener('click', (e) => {
    render.openSortMenu(e.clientX, e.clientY, store.getState().ui.projectSort, (mode, dir) =>
      store.setProjectSort(mode, dir));
  });

  // Selection bar
  byId('sel-clear')?.addEventListener('click', () => sel.clearSelection());
  byId('sel-actions')?.addEventListener('click', (e) => {
    const ids = sel.getSelection();
    if (!ids.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    actions.openBookMenu(r.left, r.top - 8, ids[0]);
  });

  // Mobile: the sidebar is a drawer.
  const drawer = byId('sidebar');
  const scrim = byId('scrim');
  const toggle = () => {
    const open = document.body.classList.toggle('sidebar-open');
    byId('menu-btn')?.setAttribute('aria-expanded', String(open));
  };
  byId('menu-btn')?.addEventListener('click', toggle);
  scrim?.addEventListener('click', () => {
    document.body.classList.remove('sidebar-open');
    byId('menu-btn')?.setAttribute('aria-expanded', 'false');
  });
  drawer?.addEventListener('click', (e) => {
    if (e.target.closest('.project-row') && window.matchMedia('(max-width: 860px)').matches) {
      document.body.classList.remove('sidebar-open');
    }
  });

  window.addEventListener('resize', () => {
    if (!window.matchMedia('(max-width: 860px)').matches) {
      document.body.classList.remove('sidebar-open');
    }
  });

  // Keep the board honest if another tab edits the same localStorage.
  window.addEventListener('storage', (e) => {
    if (e.key !== 'readerHelper.state.v1' || !e.newValue) return;
    store.loadFromDisk();
    render.render();
    toast('Board updated in another tab.');
  });

  window.addEventListener('beforeunload', () => {
    if (gistTimer) {
      clearTimeout(gistTimer);
      pushToGist({ quiet: true });
    }
  });
}

// ----------------------------------------------------------------- keyboard

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    const typing = e.target?.matches?.('input, textarea, select, [contenteditable="true"]');

    if (e.key === 'Escape') {
      closeContextMenu();
      if (!typing && sel.clearSelection()) e.preventDefault();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      const label = e.shiftKey ? store.redo() : store.undo();
      if (label) toast(`${e.shiftKey ? 'Redid' : 'Undid'} ${label}.`);
      else toast(e.shiftKey ? 'Nothing to redo.' : 'Nothing to undo.');
      return;
    }

    if (typing) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      const state = store.getState();
      const project = state.projects[state.ui.activeProjectId];
      if (!project) return;
      e.preventDefault();
      const ids = project.groupOrder.flatMap((gid) =>
        (state.groups[gid]?.placementOrder || []).filter((pid) => !state.items[state.placements[pid]?.itemId]?.archived));
      sel.replaceWith(ids);
      return;
    }

    if (e.key === '?' ) {
      e.preventDefault();
      openHelp();
    }
  });
}

// ------------------------------------------------------------ custom events

function wireCustomEvents() {
  window.addEventListener('rh:open-item', (e) => detail.openDetail(e.detail.itemId));
  window.addEventListener('rh:rename-group', (e) => {
    const node = document.querySelector(`.column__title[data-group-id="${e.detail.groupId}"]`);
    node?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  window.addEventListener('rh:rename-project', (e) => render.startRenameProject(e.detail.projectId));
  window.addEventListener('rh:add-group', (e) => render.addGroupInteractive(e.detail.projectId));
  window.addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#book/') && detail.isDetailOpen()) detail.closeDetail({ silent: true });
    else detail.restoreFromHash();
  });
}

// ----------------------------------------------------------------- drag/drop

function wireDnd() {
  initDnd({
    root: document.getElementById('app'),
    getSelection: () => sel.getSelection(),
    onDrop: ({ type, id, ids, zoneType, zoneId, index }) => {
      if (type === 'card' && zoneType === 'cards') {
        const state = store.getState();
        // Drag the whole selection when the grabbed card is part of it, in
        // board order so the group keeps its shape at the destination.
        const ordered = ids.length > 1
          ? ids.slice().sort((a, b) => positionOf(state, a) - positionOf(state, b))
          : ids;
        store.batch(() => {
          ordered.forEach((pid, offset) => {
            const p = store.getState().placements[pid];
            if (!p) return;
            if (p.groupId === zoneId) store.reorderPlacement(pid, index + offset);
            else store.movePlacement(pid, zoneId, index + offset);
          });
        });
        return;
      }

      if (type === 'column' && zoneType === 'columns') {
        store.reorderGroup(id, index);
        return;
      }

      if (type === 'project' && zoneType === 'projects') {
        store.reorderProject(id, index);
      }
    },
  });
}

function positionOf(state, placementId) {
  const p = state.placements[placementId];
  if (!p) return 0;
  const g = state.groups[p.groupId];
  if (!g) return 0;
  const prj = state.projects[g.projectId];
  const gi = prj ? prj.groupOrder.indexOf(g.id) : 0;
  return gi * 10000 + g.placementOrder.indexOf(placementId);
}

// --------------------------------------------------------------- gist sync

function gistConfigured() {
  const cfg = store.getSettings();
  return Boolean(cfg.gistSyncEnabled && cfg.githubToken);
}

/** Debounced so a burst of edits results in one upload, not twenty. */
function scheduleGistPush() {
  if (!gistConfigured()) return;
  clearTimeout(gistTimer);
  gistTimer = setTimeout(() => {
    gistTimer = null;
    pushToGist({ quiet: true });
  }, GIST_DEBOUNCE_MS);
}

async function pushToGist({ quiet = false } = {}) {
  if (!gistConfigured()) return;
  const cfg = store.getSettings();
  setSyncIndicator('syncing');
  try {
    const res = await gist.pushState(cfg, store.exportState());
    if (res.gistId !== cfg.gistId) store.saveSettings({ gistId: res.gistId });
    setSyncIndicator('ok');
    if (!quiet) toast('Board pushed to the Gist.', { type: 'success' });
  } catch (err) {
    setSyncIndicator('error');
    if (!quiet) errorToast(err, 'Gist push');
    else console.warn('gist push failed', err);
  }
}

/**
 * On load, ask the Gist what it has. Push, pull, or — if the two have genuinely
 * diverged — ask, rather than picking a winner silently.
 */
async function pullFromGistOnLoad() {
  const cfg = store.getSettings();
  if (!gistConfigured() || !cfg.gistId) return;
  setSyncIndicator('syncing');
  try {
    const { state: remote } = await gist.pullState(cfg);
    const local = store.exportState();
    const { verdict, reason } = gist.compareStates(local, remote);
    setSyncIndicator('ok');

    if (verdict === 'pull') {
      store.replaceState(remote, 'pull from gist');
      toast('Board loaded from the Gist.', { type: 'success' });
    } else if (verdict === 'push') {
      pushToGist({ quiet: true });
    }
    console.info(`gist sync: ${verdict} — ${reason}`);
  } catch (err) {
    setSyncIndicator('error');
    console.warn('gist pull failed', err);
  }
}

function setSyncIndicator(status) {
  const node = byId('sync-btn');
  if (!node) return;
  node.dataset.status = status;
  node.title = {
    syncing: 'Syncing…',
    ok: `Last synced ${new Date().toLocaleTimeString()}`,
    error: 'Last sync failed — see the console',
  }[status] || 'Sync';
}

function byId(id) {
  return document.getElementById(id);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
