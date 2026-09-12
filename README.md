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

**Cards (Books)** — the `+` at the foot of a column opens a dialog whose first
field resolves itself.

### Adding a book

Paste anything identifying into the first field and the rest fills in. No button
to press: it resolves as you type, on paste, and on leaving the field.

| Paste | Resolved via |
|---|---|
| `9780804011662`, `978-0-8040-1166-2` | Open Library, then Google Books |
| `10.1086/230209`, or any URL containing a DOI | Crossref, then DataCite, then OpenAlex |
| `https://books.google.com/books?id=…` or `/books/edition/…/ID` | Google Books |
| `https://archive.org/details/…` | archive.org (page count comes from the scan) |
| `https://openlibrary.org/books/OL…M` | Open Library |
| `arXiv:1706.03762v5`, `arxiv.org/abs/…`, `10.48550/arXiv.…` | OpenAlex, then DataCite |
| a plain title — press Enter | Crossref + Google Books + OpenAlex, and you pick |

Every one of those is keyless and CORS-enabled, so lookup works on a bare static
deploy with nothing configured.

Two details that matter in use: **only blank fields are written**, so anything
typed by hand survives a later lookup; and **submitting with just an identifier
resolves it** rather than complaining that the title is empty.

ISBNs are checksum-validated, so a random 13-digit number falls through to a
title search instead of being looked up as a book that does not exist.

*Optionally*, Google Scholar can be added for title searches by giving the auth
worker a SerpAPI key (`wrangler secret put SERPAPI_KEY`). It is genuinely
optional — the keyless sources above already cover indexed literature, Scholar
mostly adds grey literature and older work. Responses are cached for a day, as
the free tier allows only 100 searches a month.

### Exporting a bibliography

Right-click a **book**, a **ctrl-clicked selection of books**, a **group**, or a
**project** → *Export bibliography…*. Also `/export` in the palette, which uses
the current selection if there is one.

Formats: **BibTeX**, **RIS**, **CSL-JSON**, **APA 7**, **MLA 9**, **Chicago**,
and a **Markdown list**. Preview it, then copy or download.

For books linked to Zotero, Zotero's own exporter is used — it knows the
editors, translators, editions and places this board never stores, and its
formatted styles are real CSL. Everything else is generated locally. BibTeX, RIS
and CSL-JSON generated locally are exact; the formatted styles are a good
approximation and the dialog says so when any entry falls back to them.

A book that appears in several groups as a linked copy is exported once.

### Pushing the board back into Zotero

The mirror image of the import. Right-click a **book**, a **selection**, a
**group** or a **project** -> *Add to Zotero*, or `/tozotero` in the palette.

```
01 Projects  /  <Project name>  /  <Group name>  /  the books
                sidebar entry      column
```

The root collection is `01 Projects` by default and configurable in Settings.
Anything missing along that path is created; anything already there is reused,
so pushing twice does not leave two folders of the same name. Matching is
case-insensitive, and only within the right parent — a `Chapter 1` sitting
under some unrelated collection is not mistaken for yours.

**Nothing is added twice.** Before creating an item, the library is searched for
one that is already there, in this order:

| Checked | Trusted because |
|---|---|
| the Zotero key, if the book came from Zotero | exact |
| DOI | exact — including DOIs Zotero keeps in the Extra field, as it does for books |
| ISBN | exact, hyphens and case ignored |
| URL | exact, ignoring protocol, `www.`, fragment and trailing slash |
| title **and** author surname | strong |
| title **and** year | strong |
| title alone | only when there is exactly one candidate and nothing to disagree with |

A title shared by two works with different authors or years is **not** matched —
guessing there would merge two different books, which is worse than a duplicate.

A book already in the library is **filed** into the new collection rather than
added again. By default it keeps its existing collections; tick *Also remove
these items from their other Zotero collections* for a true move. That is off by
default because it cannot be undone from here.

**Preview** runs the entire matching pass and reports what would happen without
writing anything, which is worth doing the first time.

A linked copy sitting in two groups is created once and filed into both
subcollections. After a push, each book remembers its Zotero key, so the next
push recognises its own work.

Duplicate detection needs to know what is in your library, so the first push
reads it once and caches a compact fingerprint of each item. Later pushes fetch
only what changed (Zotero's `since` parameter). *Settings -> Rebuild duplicate
index* forces a full re-read if it ever drifts.

### Goodreads

Goodreads **retired its public API** — no new developer keys since December
2020, and it was deprecated rather than replaced. Nobody can build a read/write
integration like the Zotero one. What is left is still useful:

**In — a shelf, live.** *G* in the sidebar, or `/goodreads`. Paste your user ID
into Settings once; it travels to your other computers with the rest of the
board.

A note from testing against a real library: most people never set a read date,
so `user_read_at` is empty on the great majority of books — 95 of 100 on one
real `read` shelf. "Finished" is therefore taken from **the shelf**, not the
date, or almost everything you have read would import as unread.
 Reads your shelf
RSS feeds, which still work and carry title, author, ISBN, page count, year,
your rating, read date, review and shelves. Needs your numeric user ID (the
digits in `goodreads.com/user/show/12345678-name`) and a **public** profile.

Goodreads sends no CORS headers, so this goes through your Worker. The Worker
builds the Goodreads URL itself from a numeric id and a shelf name — it never
forwards a URL you hand it, which would make it an open proxy for anything
reachable from Cloudflare's network. Responses are cached for ten minutes.

**In — the whole library.** The same dialog takes the CSV from Goodreads → *My
Books* → *Import and export* → *Export Library*. Complete, includes private
shelves, needs no setup and no public profile.

Either way you choose what becomes a group:

| Group by | Result |
|---|---|
| Reading status | **To read** / **Reading now** / **Read** |
| Your shelves | one group per shelf; a book on three shelves gets a card in each |
| One group | everything together |

A book already on the board is **matched, not duplicated** — Goodreads id, then
ISBN, then title with an author. Import is additive: it fills in blanks and
records your Goodreads rating, but **never overwrites reading progress, notes or
tasks kept here**. Importing the same file twice changes nothing.

**Out.** Right-click a book, selection, group or project → *Add to Goodreads*,
or `/togoodreads`. Goodreads has no write API either, so this produces a CSV in
the shape their importer accepts; upload it at
[goodreads.com/review/import](https://www.goodreads.com/review/import). Group
names become shelves, finished books land on `read` with their date, and your
notes can go along as the review. Their importer matches on ISBN first, so the
dialog tells you how many of the selected books have one.

Each book also gets **Open in Goodreads** in its menu.

#### Letting a bot do the upload

Tick **Upload it for me** in the export dialog and the CSV is handed to a local
bot instead of sitting in your Downloads folder waiting for you.

It never logs in. Goodreads sign-in goes through Amazon — bot detection,
CAPTCHAs, often an OTP — and automating that with a stored password would be
both fragile and a bad idea for your Amazon account. Instead the bot drives a
browser profile that **you sign into once, by hand**; every run after that is
headless and reuses that session. No credential passes through it.

It also drives the real form rather than forging the POST. Goodreads is Rails
and the page carries a CSRF token; letting the browser submit makes the token,
the cookies and the multipart encoding Goodreads' problem, not ours.

```bash
npm run goodreads:setup     # once: Playwright + Chromium, ~130MB, local only
npm run goodreads:login     # once: a window opens, you sign in, it saves
npm run goodreads:upload    # headless; takes the newest goodreads-*.csv
```

After that the checkbox in the app does it for you, through the same
`readerhelper://` handler that opens PDFs. The URL can only carry a *filename* —
it is stripped to a basename and refused unless it ends `.csv`, so a page cannot
name an arbitrary path.

| Flag | |
|---|---|
| `--file <path>` | upload a specific file |
| `--name <file>` | a filename in Downloads |
| `--headed` | watch it happen |
| `--dry-run` | say what would be uploaded, then stop |

The session lives in `tools/.goodreads-profile` (gitignored). When it expires
the bot says so and stops rather than guessing. If Goodreads answers with
something it does not recognise it **does not claim success** — it saves a
screenshot and the HTML to `tools/.goodreads-debug` and tells you where.

**Automated access is against the Goodreads Terms of Service.** It is your
account and your data, so it is your call, but if they notice it is your account
at risk. The manual download is always there.

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
duplicate · move to… · copy to… · **export bibliography** · **add to Zotero** ·
**mark read** · edit details · remove.

With several books selected, every one of those applies to the whole selection.

**A group or project**: rename · **add to Todoist** (a `Finish <name>` task
straight into your Inbox) · **export bibliography** · **add to Zotero** ·
duplicate · move to… · copy to… · delete.

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

`/read` `/open` `/pdf` `/zotero` `/markread` `/task` `/export` `/tozotero`
`/goodreads` `/togoodreads` `/goto` `/book` `/group` `/project` `/import`
`/sync` `/archive` `/settings` `/help`

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
**OAuth Apps** → *New OAuth App*. Note this is an **OAuth App**, not a GitHub
App; they are different things on adjacent tabs, and only the OAuth App flow is
implemented here. Its client ID will begin `Ov23li` (a GitHub App's begins
`Iv`, which is the giveaway that you picked the wrong tab).

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
clientId: 'Ov23liXXXXXXXXXXXXXX',
workerUrl: 'https://readerhelper-auth.<subdomain>.workers.dev',
```

Commit and push. The next deploy is locked.

Until step 3 is done the deployed site shows a *setup required* screen rather
than opening to the world, and `localhost` stays open so development is not
blocked. If you need the deployed board before finishing setup, run this once in
the browser console:

```js
localStorage.setItem('readerHelper.auth.devBypass', '1'); location.reload();
```

That escape hatch works **only** while no OAuth app is configured — once
`clientId` is set it is ignored, and there is a test asserting exactly that.

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

### Every computer, the same board

Sign in on any machine and you get the same projects, groups and books. There is
nothing to configure: the board lives in a private Gist, and the Gist is **found
in your account** rather than remembered per machine.

That last part matters. Previously each computer stored the Gist ID locally, so
a second machine had none — and its first save created a *second* Gist. Two
devices, two boards, drifting apart without a word. The ID is now discovered, and
a Gist is only created when the account genuinely has none.

Syncing runs by itself: on load, once a minute, when the tab regains focus, when
the network comes back, and a few seconds after any edit. ⟳ forces it.

**Every sync is a read-modify-write.** It pulls what the Gist holds, merges it
with this machine's copy, adopts the result, and pushes back only if something
changed. Uploading without reading first is what loses work — two machines each
send their whole board and the later one wins outright.

The merge works **record by record**, not file by file. Add a book on the laptop
and rename a group on the desktop, and you keep both: each project, group and
book carries a `modifiedAt`, and only that record is contested.

Deletions leave a **tombstone**, because "absent here, present there" is
otherwise ambiguous — it could be an addition on one side or a deletion on the
other. Guessing wrong either resurrects deleted books forever or deletes new
ones. A tombstone older than the record's last edit loses, so a book edited
after it was deleted elsewhere comes back rather than vanishing. Tombstones are
pruned after 90 days.

This is last-write-wins at record granularity, not a CRDT: two machines editing
the *same field of the same book* in the same minute still lose one edit. For one
person moving between their own computers, that is the right trade.

**What does not travel:** every API key and token (secrets stay on the machine
they were pasted into), the Zotero data directory and linked-attachment path
(they differ per computer), and which PDF handler is installed. Your Zotero user
ID, read tag, projects root, theme and reading threshold do travel, so a new
machine only needs its keys.

### The nightly job

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
  gist.js      GitHub Gist mirror
  nlp.js       reading-phrase parser, fuzzy matching
  metadata.js  identifier detection + DOI/ISBN/arXiv/archive.org resolution
  bibliography.js  BibTeX / RIS / CSL-JSON / APA / MLA / Chicago export
  zotero-push.js   board -> Zotero: collection tree, duplicate matching
  merge.js     record-level merge + tombstones, for two machines
  boardsync.js the pull-merge-push loop and its triggers
  goodreads.js     their CSV and RSS in, their import CSV out
  goodreads-ingest.js  grouping, matching, and applying to the board
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
tools/         readerhelper:// protocol handler, Goodreads upload bot
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
node scripts/check.mjs         27 modules — imports and element ids resolve
node scripts/test-store.mjs    22 tests   — board model, linked duplicates, undo
node scripts/test-ingest.mjs   12 tests   — Zotero import shape, sync safety
node scripts/test-worker.mjs   27 tests   — auth worker: allowlist, CORS, secrets, Scholar cache
node scripts/test-citation.mjs 27 tests   — identifier detection and every export format
node scripts/test-push.mjs     25 tests   — pushing to Zotero, against a fake Zotero API
node scripts/test-sync.mjs     24 tests   — the merge, and the pull-merge-push loop
node scripts/test-goodreads.mjs 41 tests  — their CSV, their RSS, the CSV they import, the bot
python scripts/test_protocol.py 10 tests  — what the readerhelper:// handler refuses
node scripts/test-dom.mjs      41 tests   — boots the real app in jsdom and drives it
node scripts/test-dnd.mjs      13 tests   — synthesises pointer drags over a fake layout
node scripts/test-auth.mjs     26 tests   — every outcome of the sign-in gate

node scripts/mutate.mjs                   — checks the suites can actually fail
node scripts/test-citation-live.mjs       — opt-in: the real Crossref/OpenLibrary/… routes
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

The suites are mutation-checked, and `scripts/mutate.mjs` automates it: it
applies a deliberate defect, runs the relevant suite, restores the file, and
reports whether the defect was caught — refusing to claim anything if the edit
did not actually apply, which is how a green mutation run can otherwise lie.

That harness has already earned its keep. It showed that a test for the ISBN
checksum was passing for the wrong reason (the length regex rejected the example
before the checksum ran), and that the project-level de-duplication of linked
copies was untested (the fixture duplicated a book inside one group, where a
lower-level check already collapsed it). It now covers eleven defects across
matching, escaping, collection lookup, the Zotero push and cross-device sync —
twenty-four defects in all, including "sync overwrites instead of merging", "a
new machine creates its own Gist", "the shelf proxy trusts a caller-supplied
URL", and "the uploader treats an unrecognised page as success" — the ones that
would quietly cost real work, open a hole, or lie about having worked.

`test-push.mjs` stubs `fetch` with a small in-memory Zotero server rather than
mocking the client module, so the real pagination, the real PATCH-merge and the
real write-unpacking all run, and the assertions are about the state the library
ends up in — which is what matters when writing to someone's library.

Everything except the live lookup test runs in CI before every deploy.
