# html-comments

Render arbitrary HTML pages, leave inline comments on them (like Google Docs), and let agents read & act on those comments via a JSON API.

Built for reviewing HTML artifacts produced by coding agents — design docs, feature mockups, workflow diagrams, etc.

## Quick start

```bash
npm install
npm start
# → http://localhost:3000
```

1. Open `http://localhost:3000`, paste HTML (or upload an `.html` file), and click **Create page**.
2. Open the viewer link, select text in the rendered page, and click **💬 Add comment**.
3. Share the URL — anyone can read, comment, reply, and resolve.
4. Agents read comments via the JSON API and reply / resolve programmatically.

## How comments are anchored

Each comment is anchored to a character range in the rendered page's plain text (computed by walking text nodes in document order). We also store:

- `quote` — the literal selected text
- `contextBefore` / `contextAfter` — 40 chars on either side, for context

This survives most cosmetic edits to the underlying HTML. If you swap the page entirely, anchors may drift — replace the page and re-comment, or keep the original.

## Agent API

All endpoints return JSON.

### Pages

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/api/pages` | — | List pages |
| `POST` | `/api/pages` | `{ html, title? }` or multipart `file` | Create a page; returns `{ id, viewerUrl }` |
| `GET` | `/api/pages/:id` | — | Full metadata incl. comments |
| `GET` | `/api/pages/:id/html` | — | The raw HTML |
| `DELETE` | `/api/pages/:id` | — | Delete page |

### Comments

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/api/pages/:id/comments?status=open\|resolved\|all` | — | List comments |
| `POST` | `/api/pages/:id/comments` | `{ anchor: { startIdx, length, quote?, contextBefore?, contextAfter? }, text, author? }` | Create a comment |
| `POST` | `/api/pages/:id/comments/:cid/replies` | `{ text, author? }` | Reply on a thread |
| `PATCH` | `/api/pages/:id/comments/:cid` | `{ resolved?: boolean, text?: string }` | Resolve / edit |
| `DELETE` | `/api/pages/:id/comments/:cid` | — | Delete |

### Example agent workflow

```bash
# 1. Find what reviewers said
curl -s http://localhost:3000/api/pages/<id>/comments?status=open | jq

# Each comment includes anchor.quote (the highlighted text), text (the comment),
# author, createdAt, replies, and resolved=false.

# 2. After acting on a comment, reply + resolve:
curl -s -X POST http://localhost:3000/api/pages/<id>/comments/<cid>/replies \
  -H 'Content-Type: application/json' \
  -d '{"text":"Fixed in commit abc123","author":"agent"}'

curl -s -X PATCH http://localhost:3000/api/pages/<id>/comments/<cid> \
  -H 'Content-Type: application/json' \
  -d '{"resolved":true}'
```

## Storage

Pages and comments live on disk under `data/pages/<id>/`:

- `content.html` — the page
- `meta.json` — title, timestamps, comments, replies

No database; back this directory up to persist.

## Configuration

- `PORT` (default `3000`)
- `HOST` (default `0.0.0.0`)

## Security notes

Pages render inside an `<iframe sandbox="allow-same-origin allow-scripts allow-popups allow-forms">`. Scripts in the rendered HTML can run; only host pages you trust. There is no authentication — put it behind your dev-server's auth (basic auth, Tailscale, etc.) if you need to.
