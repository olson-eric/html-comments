# html-comments

Point this service at a directory of `.html` files and get a browser for them with Google-Docs-style inline commenting. Reviewers leave comments by selecting text; an agent reads/replies/resolves comments through a JSON API.

Built for reviewing HTML artifacts produced by coding agents — design docs, feature mockups, workflow diagrams, etc.

## Quick start

```bash
# No install needed — run straight from npm
npx html-comments /path/to/your/html

# Or install globally
npm install -g html-comments
html-comments /path/to/your/html

# Or clone + run from source
git clone https://github.com/olson-eric/html-comments
cd html-comments && npm install
node server.js /path/to/your/html
```

Then open `http://localhost:4747` and you'll see a file tree. Click an `.html` file to open it in the viewer, select text, and leave comments.

Comments are stored in `<html-dir>/.html-comments/` (one JSON file per page, hashed by relative path). Override with `COMMENTS_DIR=…` if you want them somewhere else.

## Dark mode

The app chrome (file browser, viewer, and comment sidebar) has a built-in dark
theme. Use the 🌙 / ☀️ toggle in the top-right of either screen to switch. Your
choice is saved in `localStorage`; if you've never picked one, it follows your
OS `prefers-color-scheme` and tracks live changes to it.

Rendered HTML documents are shown as-is, so a page that ships its own styling
keeps its own look. For pages that assume a light background, the viewer has a
separate **Dark page** toggle that makes a best-effort attempt to render the
document dark (it inverts the document and re-inverts images/media so they keep
their original colors). It's a heuristic — pages that already have a dark theme
usually look best with it left off.

## How comments are anchored

Each comment is anchored to a character range in the rendered page's plain text (computed by walking text nodes in document order). We also store:

- `quote` — the literal selected text
- `contextBefore` / `contextAfter` — 40 chars on either side

This survives most cosmetic edits to the underlying HTML. If you rewrite a file from scratch, anchors may drift — the quote/context remain useful for an agent to find the right spot.

Comments are stored under `data/comments/<sha1-of-relpath>.json`, separate from your source files — the HTML directory is never written to.

## Agent API

Files are identified by their path relative to the HTML root, passed as `?path=foo/bar.html`. All endpoints return JSON.

### Discovery

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/root` | Absolute path of the HTML root |
| `GET` | `/api/tree` | Recursive tree of `.html` files (with comment counts) |
| `GET` | `/api/file?path=...` | File metadata + all comments |
| `GET` | `/api/file/html?path=...` | The raw HTML |

### Comments

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/api/file/comments?path=...&status=open\|resolved\|all` | — | List comments |
| `POST` | `/api/file/comments?path=...` | `{ anchor: { startIdx, length, quote?, contextBefore?, contextAfter? }, text, author? }` | Create a comment |
| `POST` | `/api/file/comments/:cid/replies?path=...` | `{ text, author? }` | Reply on a thread |
| `PATCH` | `/api/file/comments/:cid?path=...` | `{ resolved?: boolean, text?: string }` | Resolve / edit |
| `DELETE` | `/api/file/comments/:cid?path=...` | — | Delete |

### Example agent workflow

```bash
# 1. Find files with open comments
curl -s http://localhost:4747/api/tree | jq '..|.path? // empty'

# 2. Read open comments for a file
curl -s "http://localhost:4747/api/file/comments?path=docs/spec.html&status=open" | jq

# Each comment includes anchor.quote (the highlighted text), text (the comment),
# author, createdAt, replies, resolved.

# 3. After acting on a comment, reply + resolve:
curl -s -X POST "http://localhost:4747/api/file/comments/<cid>/replies?path=docs/spec.html" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Fixed in commit abc123","author":"agent"}'

curl -s -X PATCH "http://localhost:4747/api/file/comments/<cid>?path=docs/spec.html" \
  -H 'Content-Type: application/json' \
  -d '{"resolved":true}'
```

## Configuration

- `HTML_DIR` (or positional arg) — directory of HTML files to serve. Required to exist.
- `COMMENTS_DIR` (default `<html-dir>/.html-comments`) — where comment JSON is persisted.
- `PORT` (default `4747`)
- `HOST` (default `0.0.0.0`)

## Security notes

Pages render inside an `<iframe sandbox="allow-same-origin allow-scripts allow-popups allow-forms">`. Scripts in the rendered HTML can run; only host pages you trust. There is no authentication — put it behind your dev-server's auth (basic auth, Tailscale, etc.) if you want to share with coworkers over the public internet.

Paths are validated to stay within the configured HTML root. The API only serves `.html`/`.htm` files; sibling assets (images, CSS, etc.) referenced by relative URLs in the HTML are served from `/raw/<path>` under the same root, with the same traversal protection. The `.html-comments` directory is never exposed via `/raw/`.
