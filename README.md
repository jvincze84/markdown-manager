# Markdown Manager

**English** | [Magyar](README.hu.md)

A Dockerized web application that downloads the `*.md` files from a given directory of one or more repositories on a git server, renders them nicely, makes them searchable and lets you edit them. Saving pushes to a per-file branch. The git server and the token are set via environment variables; repositories are added on the web UI.

## Screenshots

## Main Screen

<img width="1485" height="609" alt="opera_IZ3Iz3L7IN" src="https://github.com/user-attachments/assets/09f342df-de68-461c-bc72-fb4eda8d7e61" />

## Editor

<img width="1497" height="706" alt="opera_UYDkKQIytl" src="https://github.com/user-attachments/assets/9b1555f0-fee6-47b4-bf03-56ab1be9cfc9" />

## Pull Request

<img width="1427" height="88" alt="opera_LdUYE6YLT9" src="https://github.com/user-attachments/assets/c684b0da-c438-46b0-b850-0be30af424c8" />

## History


<img width="548" height="190" alt="opera_hCngY8Iplj" src="https://github.com/user-attachments/assets/d26d432f-37d0-41b1-ad0e-cc2caaf16332" />


## Getting started

```bash
cp .env.example .env      # fill in GIT_URL (the git server), GIT_TOKEN, ...
docker compose up -d --build
# → http://localhost:8080, then "⚙ Repos" → add a repository (it is downloaded right away)
```

Or without compose:

```bash
docker build -t markdown-manager .
docker run -d -p 8080:8080 -v md-data:/data \
  -e GIT_URL=https://git.example.com -e GIT_TOKEN=xxx markdown-manager
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GIT_URL` | – | HTTPS base URL of the git server, e.g. `https://git.example.com` (**required**). Repository URL: `<GIT_URL>/<repository path>` |
| `GIT_TOKEN` | – | Access token with push permission (the same one is used for all added repositories) |
| `GIT_USERNAME` | `oauth2` | User name belonging to the token (Bitbucket: `x-token-auth`) |
| `GIT_BRANCH` | `main` | Default base branch when adding a new repository |
| `EDIT_BRANCH_PREFIX` | `md-edit/` | Prefix of the edit branches |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `Markdown Manager` | Commit author |
| `GIT_CA_BUNDLE_BASE64` | – | Custom CA bundle (PEM) in base64: `base64 -w0 ca.pem`. Used together with the system CAs |
| `APP_USERNAME` / `APP_PASSWORD` | – | Optional Basic Auth for the web UI |

### Migrating from the old (single-repository) setup

In the earlier version `GIT_URL` pointed to a specific repository (`https://…/group/repo.git`), the directory was set by
`GIT_DOCS_PATH` and the image directory by `GIT_ASSETS_PATH`. If the app starts with such a `GIT_URL` ending in `.git` and
there is no added repository yet (`/data/repos.json`), it migrates automatically: the server part becomes the base URL and
the repository is added as the first repository (based on `GIT_BRANCH`, `GIT_DOCS_PATH`, `GIT_ASSETS_PATH`; the ID is derived
from the repository name). The existing local clone and any not-yet-saved image uploads are moved over, nothing has to be downloaded again.
Afterwards `GIT_URL` in `.env` can be changed to the server address, and `GIT_DOCS_PATH` / `GIT_ASSETS_PATH` can be removed.
Going back: the `v1.0.0` tag / `release/1.0` branch is the single-repository version (the multi-repository one is `v2.0.0` / `release/2.0`).

## Features

The UI is in English (buttons, messages, sync log, API error messages); dates use the British format (`en-GB`: day/month/year, 24-hour clock).

- **Multiple repositories**: the "⚙ Repos" button in the header opens the repository manager. To add a repository: its path on the server
  (e.g. `group/repo.git` – relative paths only, so the token can never be sent to another host), an ID (the top level of
  the tree; defaults to the repository name, e.g. `repo`), the base branch, the directory inside the repository (empty = repository root) and the
  image directory (defaults to `<directory>/assets`). It is downloaded right after being added. Existing repositories can be
  synced individually (⟳), edited (✎: branch, directory, image directory – re-downloaded afterwards) and
  removed (🗑: only the local clone is deleted, nothing changes on the git server). The settings are stored in
  `/data/repos.json`, the local clones under `/data/repos/<id>`.
  The same repository can be added several times (with different IDs) as long as the directories do not overlap: e.g. `docs` and
  `wiki` are fine, but `docs` and `docs/other` are not, and if the repository is added with its root (empty directory), nothing
  else can be added next to it. This also applies when editing. Each such entry has its own local clone.
- **Paths**: every file path is `<repository ID>/<path in the repository>` (e.g. `kb/docs/guide/install.md`); in the
  tree the repository is the top level (📦), with the contents of its directory below. In markdown, links starting with `/`
  are relative to the repository root; relative links pointing outside the repository are not resolved.
- **Repository filter**: with at least two repositories, several repositories can be selected in the "📦 Repo: …" dropdown; then the
  tree, the "Modified / new" list and counter, and the search only cover the selected repositories. If none
  or all are selected, there is no filtering. The browser remembers the selection.
- **Theme**: light and dark theme; the 🌓/☀️/🌙 button in the header cycles: automatic (follows the operating system / browser setting, even on the fly) → light → dark. The browser remembers the choice. The dark theme also applies to the view, code highlighting (Material "slate" palette), the editor, the diff and Mermaid diagrams.
- **Sync**: the "⟳ Sync ▾" dropdown lets you choose what to refresh: "All repositories" (all of them, one after another) or a single repository (with the time of its last sync or an error indicator next to it). When syncing all repositories, an error in one does not stop the others; the failing repository is marked in the tree and in the status bar. Partial clone (`--filter=blob:none`) + sparse checkout, so only the `*.md` files (and embedded images) under the configured directory of the repository are downloaded. Data is kept in the `/data` volume and is available after a restart. The rendered HTML and the search index are regenerated during sync.
- **Sync log**: starting a sync opens a log window (steps, git progress, progress bar). It can be closed, the sync keeps running in the background; while a sync is running, clicking the button (instead of the dropdown) reopens it.
- **File list**: next to each file the time of the last change (relative, e.g. "2 hours ago"), the short hash of the last commit and a ✎ button that opens the file directly in the editor. For modified / new files the last save on the edit branch is shown (in yellow, with ✎). Hovering the date shows the full timestamp, the author and the commit message (for modified files the data of both the branch and the base branch). With an http/https `GIT_URL` the hash links to the commit page (GitHub / GitLab / Gitea / Bitbucket). The data is refreshed after sync, from a single `git log` (without downloading blobs).
- **Directory tree**: "⊞ Expand all" / "⊟ Collapse all" buttons; the browser remembers the expanded directories (and collapsed repositories) across reloads, saves and syncs. A newly added repository is shown expanded.
- **Clear filters**: when the search, the "Modified / new" filter or the repository filter is active, the "✕ Clear filters" button clears all of them in one click and restores the full tree.
- **Filter**: the "✎ Modified / new" button shows only files that have an edit branch, each with a "Pull request" button. It can be combined with the search.
- **Search**: two separate fields; when both are filled in, they are combined with AND:
  - **📄 File name** (`/` key): substring in the path, every word must occur, accent-insensitive.
  - **🔍 Content**: exact substring match (every word must occur, case- and accent-insensitive), with a highlighted snippet (about 160 characters before and 360 after the match, aligned to word boundaries). A multi-word phrase in quotes (`"the sentence I am looking for"`, Hungarian `„…”` quotes work too) is matched exactly, in word order (the number of spaces and line breaks does not matter; it also matches across formatting, e.g. a bold word); quoted phrases and plain words can be mixed. Numbers respect word boundaries: `172.21.23.12` does not match `172.21.23.120`. For modified files both the base and the modified version are searched. If there is no exact match and you search for plain words, typo-tolerant "similar" results are returned (marked separately).
  - When a content result is opened, the searched text is highlighted in the document and the view jumps to the first occurrence; the "‹ ›" buttons in the header (or F3 / Shift+F3) step through the matches.
- **Viewing**: a file opens in a new layer; relative `.md` links open further layers on top. `Esc` closes the topmost one. By default the full width is used; the "↔ Width" button switches to a narrow (reader-friendly) view, which the browser remembers.
- **History**: for an open file, the "🕘 History" dropdown shows earlier versions of the file (commits of the edit branch marked with ✎ in a separate group, below them the history of the base branch; at most 100 each). When viewing an older version, a yellow bar shows which commit you are looking at, and one click returns to the current one. The bar's "± Diff to current" button shows the differences of the markdown source between the old and the current version (the edit branch if there is one, otherwise the base branch), side by side or unified, with the commits made since. "✎ Edit" always opens the current version.
- **Code blocks**: syntax highlighting with Prism, using the same Material-like theme in the view and in the editor preview / WYSIWYG mode (`public/code-theme.css`). For bash, commands (even unknown ones, e.g. `kubectl`, `helm`, `./deploy.sh`), options (`-v`, `--dry-run`), variables and strings get distinct colors. Languages: all Prism languages in the view, about 40 in the editor (e.g. bash/shell, yaml, json, sql, python, js/ts, java, go, rust, c/c++, c#, php, ruby, powershell, dockerfile, nginx, hcl/terraform, ini, toml, xml/html, diff, markdown, etc.), with a language label and a "⧉ Copy" button (shown on hover). Works over plain HTTP too (with a clipboard fallback).
- **Metadata (front matter)**: a YAML block at the start of the file (`---` … `---`) is not shown as text but as a metadata table at the top of the document: lists (e.g. `labels`) as tags, URLs as links opening in a new tab, ISO timestamps shortened (`2026-11-11 14:45`, the full value in the tooltip), empty values as "–". Invalid or non key-value YAML is shown as a highlighted code block. The `title` field (if present) is the file's title in the list and in search results; metadata values are searchable. The editor preserves the block unchanged (in WYSIWYG mode too); it is not shown in the preview.
- **Tables**: columns of rendered tables can be sorted by clicking the header (ascending → descending → original; numbers such as "16 GB" or "2,5" are sorted numerically, text in Hungarian alphabetical order).
- **Editing**: Toast UI Editor (15px font size) with a side-by-side preview (the ◫ button switches to tabs; WYSIWYG mode is available too). `Ctrl+S` saves.
  - The **😀** toolbar button opens an emoji picker: search by English names and keywords (e.g. "heart", "check", "rocket", "thumbs up", GitHub shortcodes: "tada"), categories, recently used. Clicking inserts the emoji at the cursor (as a Unicode character), Shift+click keeps the picker open for more emojis; Enter in the search field inserts the first match.
  - The **⊞⇥ Format tables** toolbar button aligns all markdown tables in the document: pads cells with spaces so the columns line up (respecting `:---:` alignment; code blocks are not touched). Can be undone with `Ctrl+Z`. In the markdown editor table rows are shown in a monospaced font.
- **Inserting images**: an image added from the editor's "Insert image" dialog, pasted from the clipboard (e.g. a screenshot) or dropped in is not embedded as base64; it is uploaded to the repository's image directory (default `<directory>/assets`, e.g. `docs/assets`) and a short relative link is inserted, e.g. `![diagram](../assets/diagram-1a2b3c4d.png)`. The file name is accent-free and ends with a hash of the content (the same image is not duplicated). The image is committed **in the same commit** as the markdown file when it is saved, on the file's own branch – so the PR contains the image too. Until then it waits on the server (`/data/uploads/<repo>`, removed after 30 days). Formats: png, jpg, gif, webp, svg (max. 20 MB).
- **Attaching files**: with the **📎 Attach file** toolbar button (several files can be selected), or by dropping / pasting a non-image file, any file (e.g. pdf, zip, docx, csv, txt) can be uploaded. It goes to the repository's image directory as well (default `<directory>/assets`, accent-free name + content hash), a link is inserted at the cursor, e.g. `[Description.pdf](../assets/description-1a2b3c4d.pdf)`, and the file is committed in the same commit as the markdown file when it is saved. On save, the (not yet saved) uploads referenced in the markdown are committed: images, links (`[..](..)`, `[id]: ..`) or HTML `src` / `href`. Markdown files cannot be attached (use "＋ New file" for those); max. 20 MB. In the view the link opens in a new tab. For security reasons images, pdf, txt and md files open in the browser, everything else is downloaded (`Content-Disposition: attachment`, sandbox CSP), so e.g. an uploaded HTML file never runs as the app. Attached files are not downloaded by sync (the sparse checkout only covers md + images); the server reads them from git on demand when opened.
- **Saving**: each file (in its own repository) has a deterministic branch, e.g. `docs/guide/install.md` → `md-edit/docs__guide__install.md`. The first save creates it from the base branch, later saves add new commits to the same branch. If the branch has been deleted in the meantime (e.g. after a merge), the next save starts again from the fresh base branch. Saving does not change the local, displayed base version; if a file has an edit branch, the layer lets you choose whether the modified or the base version is shown. For GitHub / GitLab / Gitea / Bitbucket a "Pull request" link is shown as well.
- **Diff**: for a modified file the "Modified / main / ± Diff" switch shows the changes compared to the base branch (PR-style, from the merge base), side by side or unified, with word-level highlighting and the commits of the branch.
- **Deleting**: the "🗑 Delete" button (after confirmation) adds a deleting commit to the file's own branch (e.g. `md-edit/docs__guide__install.md`), so the file is removed from the base branch once the pull request is merged. Until then it is shown as "deleted" (struck through) in the list; when opened, a red bar indicates it, it cannot be edited, and "± Diff" shows the deletion. "↺ Discard" reverts it. New files (existing only on a branch) have no separate delete: Discard removes them.
- **Discarding**: the "↺ Discard" button (after confirmation) deletes the edit branch from the server; the file returns to the base version (for a file marked for deletion the deletion is reverted), a new file disappears.
- **New file**: with the "＋ New file" button. With several repositories you first choose the repository (by default the one selected alone in the repository filter, otherwise the last used one). The path is relative to the repository directory (e.g. `guide/new-page`, the `.md` extension is added automatically), and the repository's existing directories are offered. On save the file goes to its own branch the same way (`md-edit/docs__guide__new-page.md`). Until it is merged it is shown as "new" in the list and in search results. Detection is based on the commit's `File:` trailer, so it survives restarts and syncs.
- The token lives only in an environment variable (it reaches git through a `GIT_ASKPASS` helper) and is never written to `.git/config`.

## Development, tests

No local Node is needed, everything runs in Docker:

```bash
tests/run.sh              # build + unit tests + browser (Playwright) tests
tests/run.sh unit         # unit tests only
tests/run.sh e2e -g emoji # filtered browser tests only
KEEP=1 tests/run.sh e2e   # the test container (http://localhost:18080) keeps running
```

The tests work with disposable git repositories (`tests/fixture/make-repo.sh`, `make-repo2.sh`) and do not touch real repositories.
Development notes (architecture, decisions, pitfalls): `CLAUDE.md` (in Hungarian).
