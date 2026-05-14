# html-comments

Point this service at a directory of `.html` files and get a browser for them with Google-Docs-style inline commenting. Reviewers leave comments by selecting text; an agent reads/replies/resolves comments through a JSON API.

Built for reviewing HTML artifacts produced by coding agents — design docs, feature mockups, workflow diagrams, etc.

## Quick start

```bash
npm install

# Point at your directory of HTML files
node server.js /path/to/your/html
# …or
HTML_DIR=/path/to/your/html npm start

# Default if neither is given: ./html
```

Then open `http://localhost:3000` and you'll see a file tree. Click an `.html` file to open it in the viewer, select text, and leave comments.

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
curl -s http://localhost:3000/api/tree | jq '..|.path? // empty'

# 2. Read open comments for a file
curl -s "http://localhost:3000/api/file/comments?path=docs/spec.html&status=open" | jq

# Each comment includes anchor.quote (the highlighted text), text (the comment),
# author, createdAt, replies, resolved.

# 3. After acting on a comment, reply + resolve:
curl -s -X POST "http://localhost:3000/api/file/comments/<cid>/replies?path=docs/spec.html" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Fixed in commit abc123","author":"agent"}'

curl -s -X PATCH "http://localhost:3000/api/file/comments/<cid>?path=docs/spec.html" \
  -H 'Content-Type: application/json' \
  -d '{"resolved":true}'
```

## Configuration

- `HTML_DIR` (or positional arg) — directory of HTML files to serve. Required to exist.
- `PORT` (default `3000`)
- `HOST` (default `0.0.0.0`)

## Security notes

Pages render inside an `<iframe sandbox="allow-same-origin allow-scripts allow-popups allow-forms">`. Scripts in the rendered HTML can run; only host pages you trust. There is no authentication — put it behind your dev-server's auth (basic auth, Tailscale, etc.) if you want to share with coworkers over the public internet.

Paths are validated to stay within the configured HTML root, and only `.html`/`.htm` files are served.
