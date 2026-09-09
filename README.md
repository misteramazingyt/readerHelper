# readerHelper

A Kanban reading tracker wired to Zotero and Todoist. Static frontend, deployed
to GitHub Pages, with every API key kept in your browser rather than in this
repository.

```
Projects (sidebar)  →  Todoist Project
  Groups (columns)  →  Todoist Section
    Books (cards)   →  Todoist Task
```

Zotero maps onto the same two levels: **a collection becomes a Project, and each
of its subcollections becomes a Group.**

---

## Quick start

1. Open the deployed site.
2. Press <kbd>⚙</kbd> (or <kbd>Shift</kbd>+<kbd>Space</kbd> → `/settings`) and paste your keys.
3. Press **Z** in the bottom-left to import a Zotero collection.

Nothing works until step 2, and nothing in step 2 leaves your browser except to
Zotero, Todoist, GitHub and the DOI/ISBN lookup services.

---

## Keys, and where they live

| Key | Where to get it | Needed for |
|---|---|---|
| Zotero API key | [zotero.org/settings/keys](https://www.zotero.org/settings/keys) — read access, plus **write** if you want *Mark read* to tag Zotero | Import and sync |
| Zotero user ID | The number on that same page | Import and sync |
| Todoist token | Todoist → Settings → Integrations → Developer | Creating tasks |
| GitHub PAT | [Fine-grained token](https://github.com/settings/personal-access-tokens) with **Gists: read and write** and nothing else | Cross-device sync, nightly action |

All four are stored in `localStorage` under `readerHelper.settings.v1`. They are
never committed, never bundled, and never sent anywhere but the service they
belong to. Clearing your browser data clears them.

---

## The board

**Sidebar (Projects)** — `+` creates one and selects its title so you can type
immediately. `Z` imports a Zotero collection.

**Columns (Groups)** — the `+` at the end of the board creates one, title
selected for typing. Each has its own sort view.

**Cards (Books)** — the `+` at the foot of a column opens a dialog that takes a
DOI or ISBN (**Look up** fills the rest in from Crossref, Open Library or Google
Books) or plain manual entry.

### Ordering

Projects, groups and books each carry their own view: **Custom** (your
drag-drop order), **Modified**, **Created**, **Alphabetical**, each with an
ascending/descending toggle. Switching to a derived view does not destroy the
custom order — switch back and it is as you left it.

### Duplicates are linked, not copied

**Duplicate** and **Copy to…** create another *placement* of the same book, not
a second record. Rename it, log reading against it, tick a task off — every copy
updates, in both directions. But each copy drags independently, so the same book
can sit in three groups at once without disturbing the others.

Cards showing **⧉** have at least one linked twin. Removing one copy leaves the
rest; removing the last one deletes the record.

### Selecting across projects

<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+click adds a book to the selection.
<kbd>Shift</kbd>+click takes a range within a group. The selection **survives
switching projects** — pick two books here, switch, pick three more, and all
five are still selected. Right-click any of them to act on the whole set.
<kbd>Esc</kbd> clears it.

### Drag and drop

Drag from the **⠿** grip. Works with a mouse anywhere on the item and, on touch,
by long-pressing the grip — which is why the grip exists, so a column can still
be scrolled with a finger. Dragging a selected card carries the whole selection.

---

## Reading progress

The bar on each card is also a scrubber: drag it, or use arrow keys when it has
focus. But the intended path is `/read`.

<kbd>Shift</kbd>+<kbd>Space</kbd> → `/read` → <kbd>Tab</kbd> a book → say what
you did, in words:

| You type | It records |
|---|---|
| `30 pages` | 30 pages on from where you were |
| `two chapters` | converted via the chapter count |
| `12 paragraphs` | estimated at 4 paragraphs per page |
| `up to p. 210` | an absolute stopping point |
| `finished chapter 4` | the end of that chapter |
| `halfway`, `40%` | a proportion of the whole |
| `twenty five pages` | numbers spelled out are fine |

Everything is stored raw in the book's reading log **and** converted to a page
number and a percentage of the total.

If the phrasing needs something the book does not have yet — a page count for
`30 pages`, a chapter count for `two chapters` — you are asked for it once, then
the original phrase is applied. Nothing typed is lost.

At 100% (configurable) you are asked whether to mark the book read.

### Reading modes

`Full` · `Partial` · `Digest` · `Manual` · `Skim` — the coloured tag beside the
title. Click it to change, or use the right-click menu.

---

## Right-click

**A book** (or the ☰ on the card): open its page · open in Zotero · open the PDF
· log reading · set the reading mode · **add task to Todoist** (a dialog
pre-filled with the title, authors, progress, and a link back to the work) ·
duplicate · move to… · copy to… · **mark read** · edit details · remove.

With several books selected, every one of those applies to the whole selection.

**A group or project**: rename · **add to Todoist** (a `Finish <name>` task
straight into your Inbox) · duplicate · move to… · copy to… · delete.

Deleting offers to delete the matching Todoist project or section too. It
**never** touches the linked Zotero collection.

*Mark read* archives the book here and adds the `read` tag to it in Zotero. The
tag name is configurable in Settings.

---

## The book page

Click any card. You get, in the manner of opening a Todoist task:

- the title, editable in place, and the full bibliographic record;
- **tasks that stay in readerHelper** — with a `↗` to push any one to Todoist;
- **notes**, saved as you type;
- the reading history, every logged phrase with what it resolved to.

---

## Command palette

<kbd>Shift</kbd>+<kbd>Space</kbd>.

`/read` `/open` `/pdf` `/zotero` `/markread` `/task` `/goto` `/book` `/group`
`/project` `/import` `/sync` `/archive` `/settings` `/help`

Without a slash it searches every book, group and project. It also takes whole
sentences: **`read 30 pages of Capital`** finds the book and logs it in one
line.

---

## Opening PDFs

A page served over `https` cannot open `file:///C:/...` — browsers block it
silently. So both buttons go through a custom protocol.

**Zotero (default, no setup).** `Local PDF` opens the attachment in Zotero's own
reader via `zotero://open-pdf/...`, and jumps to the page after the one you
stopped on. `Zotero` selects the item via `zotero://select/items/@citekey`,
the same URI Zotero Searcher uses.

**System PDF app (one-time setup).** To open in your normal PDF reader instead:

```powershell
cd "D:\Inbox\00 Now\202609091401 - readerHelper\tools"
.\install-protocol.ps1
# then in readerHelper: Settings → Local PDF button opens → System PDF app
```

This registers `readerhelper://` under `HKCU` (no admin needed), pointing at
`readerhelper_open.py`, which opens the path exactly as Zotero Searcher's
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> does. With SumatraPDF or Acrobat on
PATH it also jumps to your page.

Because Windows hands that URL to the handler from *any* site you visit, the
handler treats it as untrusted: only existing `.pdf` files are opened, never
executables; UNC and relative paths are refused; and `ALLOWED_ROOTS` in the
script can restrict it to named folders. Remove it with `-Uninstall`.

Local PDF paths come from Zotero's attachment records, resolved against the
**Zotero data directory** in Settings.

---

## Locking the site

The board is gated behind **Sign in with GitHub**, restricted to a single
account. Signing in also grants the `gist` scope, so the same session mirrors
your board — there is no separate PAT to paste.

### What this does and does not do

GitHub Pages serves static files to anyone who asks, so be clear-eyed about it:

* **Protected.** Nobody but you can obtain a token, reach your Gist, or open the
  board UI in a usable state. The allowlist is enforced *inside the Worker*,
  which holds the client secret — a refused login gets a 403 and its
  freshly-issued token is revoked on the way out.
* **Not protected.** `index.html` and `js/*.js` remain publicly fetchable, as
  does this repository. A client-side gate cannot change that.

That distinction is usually fine here, because the deployed site is an empty
shell: your reading list lives in your browser and your own private Gist, never
on the server. If you need the *files* hidden too, that requires a host that
authenticates before serving — Cloudflare Access in front of Cloudflare Pages,
for instance.

### Why a Worker is needed at all

GitHub OAuth Apps support neither PKCE nor CORS on the token endpoint, so the
code-for-token exchange cannot happen in a browser. `worker/` is a ~200-line
Cloudflare Worker that does only that, and holds the only secret in the system.

### Setup, once

**1. Create the OAuth App** — <https://github.com/settings/developers> →
*New OAuth App*:

| Field | Value |
|---|---|
| Application name | readerHelper |
| Homepage URL | `https://misteramazingyt.github.io/readerHelper/` |
| Authorization callback URL | `https://misteramazingyt.github.io/readerHelper/` |

Generate a client secret and keep the tab open.

**2. Deploy the Worker**

```bash
cd worker
npm install -g wrangler        # once
wrangler login
# put the client ID in wrangler.toml -> [vars] GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET   # paste the secret; it goes nowhere else
wrangler deploy
```

Note the deployed URL. Check it with
`curl https://<your-worker>.workers.dev/health` — it should report
`configured: true` without echoing anything sensitive.

**3. Point the app at it** — in [`js/auth-config.js`](js/auth-config.js):

```js
clientId: 'Iv1.xxxxxxxxxxxx',
workerUrl: 'https://readerhelper-auth.<subdomain>.workers.dev',
```

Commit and push. The next deploy is locked.

Until step 3 is done the deployed site shows a *setup required* screen rather
than opening to the world, and `localhost` stays open so development is not
blocked.

### Adjusting it

| Want | Change |
|---|---|
| Add a person | `ALLOWED_LOGINS` in `wrangler.toml` **and** `allowedLogins` in `auth-config.js`, then redeploy both |
| Login without Gist access | `scope: ''` in `auth-config.js`; keep pasting a PAT in Settings |
| Deliberately open instance | `lockWhenUnconfigured: false` |
| Sign out / revoke | Settings → Account → Sign out |

`ALLOWED_ORIGINS` in `wrangler.toml` is what stops another site using your
Worker as a free OAuth backend. Keep it to your Pages origin and localhost.

The client ID is public by design and safe to commit; the **client secret** must
only ever live in `wrangler secret`.

---

## Sync

**On load** the board refreshes from Zotero if the last sync was over an hour
ago. **⟳** in the toolbar syncs on demand.

Sync is additive: it adds collections and books that appeared in Zotero and
refreshes bibliographic fields, but **never deletes a card and never overwrites
reading progress, notes, tasks or a page count you entered by hand.** Your
reading state exists only here, so a reorganisation in Zotero cannot destroy it.

### Cross-device, and the nightly job

Turn on **Mirror the board to a private Gist** in Settings and paste a GitHub
PAT. The board is pushed a few seconds after any change and pulled on load. If
local and remote have diverged, the newer one wins and the decision is logged to
the console rather than silently merged.

For the 11pm sync, add these as **repository secrets**
(Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `ZOTERO_API_KEY` | same key as in the app |
| `ZOTERO_USER_ID` | same id |
| `GH_GIST_TOKEN` | a PAT with Gists read/write |
| `GIST_ID` | the id shown in Settings after the first push |
| `ZOTERO_DATA_DIR` | *(optional)* to resolve PDF paths |

`.github/workflows/nightly-sync.yml` then runs at 23:00 America/Los_Angeles.
GitHub cron is UTC and ignores daylight saving, so it is scheduled at both 06:00
and 07:00 UTC and the job checks the real local hour — it stays at 11pm Pacific
year-round instead of drifting an hour each spring.

Run it by hand from the Actions tab; tick **dry run** to see what would change
without writing.

---

## Mobile

The same URL. Below 860px the sidebar becomes a drawer behind ☰, the board
becomes a snap-scrolling strip of columns, menus become bottom sheets, dialogs
become sheets, and touch targets grow. Drag by long-pressing the ⠿ grip.

It is installable — "Add to Home Screen" gives it a standalone window.

---

## Keyboard

| | |
|---|---|
| <kbd>Shift</kbd>+<kbd>Space</kbd> | Command palette |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+click | Add to selection |
| <kbd>Shift</kbd>+click | Select a range |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>A</kbd> | Select every book in the project |
| <kbd>Esc</kbd> | Clear selection / close |
| <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> | Undo (<kbd>Shift</kbd> to redo) |
| <kbd>F2</kbd> / double-click | Rename in place |
| <kbd>?</kbd> | Help |

---

## Development

No build step, no dependencies. Serve the folder and open it:

```bash
python -m http.server 8000     # ES modules need http://, not file://
```

```bash
node scripts/check.mjs         # every import and element id resolves
node scripts/test-store.mjs    # board model, incl. linked duplicates
node scripts/test-ingest.mjs   # Zotero import shape
```

CI runs all three before every Pages deploy.

```
index.html            css/style.css
js/
  model.js     shapes, ids, selectors, progress maths
  store.js     the state tree, every mutation, undo, persistence
  ingest.js    Zotero → board  (shared by the app and the nightly action)
  sync.js      browser side of import and re-sync
  zotero.js    Zotero Web API      todoist.js  Todoist API
  gist.js      GitHub Gist mirror  metadata.js DOI/ISBN lookup
  nlp.js       reading-phrase parser, fuzzy matching
  dnd.js       pointer-based drag and drop (mouse + touch)
  render.js    the board          detail.js   the book page
  palette.js   command palette    actions.js  menu and command implementations
  ui.js        toasts, modals, forms, menus
  selection.js cross-project multi-select
  settings.js  keys, archive, help
  auth.js      the GitHub sign-in gate + lock screen
  auth-config.js  public OAuth settings (no secrets)
  main.js      wiring
scripts/       checks, tests, nightly sync
tools/         readerhelper:// protocol handler
worker/        Cloudflare Worker: OAuth code-for-token exchange
```

`ingest.js` is deliberately split into `buildPlan` (async, all the network) and
`applyPlan` (sync, pure). That is what lets the browser wrap a whole import in
one undoable commit and lets the GitHub Action reuse the identical logic against
a state object pulled from the Gist.

### Deploying your own

```bash
gh repo create readerHelper --public --source=. --push
gh api -X POST repos/:owner/readerHelper/pages -f build_type=workflow
```

Or push to `main` and set Pages → Source → **GitHub Actions**.

---

## Tests

```
node scripts/check.mjs         21 modules — imports and element ids resolve
node scripts/test-store.mjs    22 tests   — board model, linked duplicates, undo
node scripts/test-ingest.mjs   12 tests   — Zotero import shape, sync safety
node scripts/test-worker.mjs   16 tests   — the auth worker: allowlist, CORS, secret handling
node scripts/test-dom.mjs      29 tests   — boots the real app in jsdom and drives it
node scripts/test-dnd.mjs      13 tests   — synthesises pointer drags over a fake layout
node scripts/test-auth.mjs     24 tests   — every outcome of the sign-in gate
```

The last two need `npm install --no-save jsdom`, and skip themselves politely if
it is absent.

`test-dom.mjs` builds the document from `index.html`, hands the DOM to Node's
module loader, and clicks through the actual UI — adding groups, opening the
book page, running `/read` end to end, checking the context menus, undoing a
duplicate.

`test-dnd.mjs` goes further. jsdom has no layout engine, so `elementFromPoint`
and `getBoundingClientRect` return nothing useful and drag-and-drop would be
untestable. It therefore assigns every column and card a rectangle, resolves
hit-tests against them, and synthesises pointer events over the top — exercising
the real `dnd.js`: the movement threshold, the insertion index, multi-select
drags, column and sidebar reordering, and the touch long-press that keeps
columns scrollable.

`test-auth.mjs` gives each scenario its own jsdom and a fresh import of
`auth.js`, stubbing the Worker at `fetch` so the paths that matter can actually
be exercised: a forged `state`, a refused account, an expired token, an offline
revalidation.

The suites are mutation-checked. Breaking the drag threshold, the drop index,
the selection carry, the touch grip, the CSRF `state` check, the allowlist (in
either the app or the Worker), the 401 handling, or the CORS origin check each
fails exactly the test that covers it. All seven run in CI before every deploy.
