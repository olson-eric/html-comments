# html-comments

Point this service at a directory of `.html`, `.md`, and image files and get a browser for them with Google-Docs-style inline commenting. Reviewers leave comments by selecting text (or drawing a box on an image); an agent reads/replies/resolves comments through a JSON API.

Built for reviewing artifacts produced by coding agents — design docs, feature mockups, workflow diagrams, UI screenshots, etc.

Supported file kinds:

- **HTML** (`.html`, `.htm`) — rendered as-is in a sandboxed iframe.
- **Markdown** (`.md`, `.markdown`) — rendered to HTML server-side (headings, lists, tables, code blocks, images, links). Comment anchoring works exactly like HTML: select rendered text.
- **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.avif`, `.bmp`) — shown full-size; comments are anchored to rectangular regions you draw by dragging on the image.

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

Then open `http://localhost:4747` and you'll see a file tree. Click a file to open it in the viewer, select text (or drag a box on an image), and leave comments.

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

**HTML and markdown** comments are anchored to a character range in the rendered page's plain text (computed by walking text nodes in document order). We also store:

- `quote` — the literal selected text
- `contextBefore` / `contextAfter` — 40 chars on either side

This survives most cosmetic edits to the underlying HTML. If you rewrite a file from scratch, anchors may drift — the quote/context remain useful for an agent to find the right spot. For markdown, anchors index into the *rendered* text (the same text `GET /api/file/html?path=doc.md` returns), not the raw markdown source.

**Image** comments are anchored to a rectangular region, stored as fractions of the image size:

```json
{ "type": "region", "x": 0.12, "y": 0.4, "w": 0.25, "h": 0.1, "imageWidth": 1440, "imageHeight": 900 }
```

`x`/`y` are the top-left corner and `w`/`h` the size, all in `0..1` of the image dimensions — so regions stay attached when the image is displayed at any scale, and survive re-exports of the same screenshot at a different resolution. `imageWidth`/`imageHeight` record the image's pixel size at comment time, so an agent can convert to pixel coordinates (`px = x * imageWidth`) and detect when the underlying image's aspect ratio has changed.

Comments are stored in `<html-dir>/.html-comments/<sha1-of-relpath>.json`, separate from your source files — the served directory is never written to.

## Agent API

Files are identified by their path relative to the served root, passed as `?path=foo/bar.html`. All endpoints return JSON.

### Discovery

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/root` | Absolute path of the served root |
| `GET` | `/api/tree` | Recursive tree of supported files, each with `kind` (`html`/`markdown`/`image`) and comment counts |
| `GET` | `/api/file?path=...` | File metadata (incl. `kind`) + all comments |
| `GET` | `/api/file/html?path=...` | The raw HTML; for markdown, the *rendered* HTML (the text anchors index into) |
| `GET` | `/raw/<path>` | The file as-is (use this for markdown source / image bytes) |
| `GET` | `/render/<path>` | Markdown rendered as a standalone HTML page (what the viewer's iframe shows) |

### Comments

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/api/file/comments?path=...&status=open\|resolved\|all` | — | List comments |
| `POST` | `/api/file/comments?path=...` | `{ anchor, text, author? }` — anchor is `{ startIdx, length, quote?, contextBefore?, contextAfter? }` for html/markdown or `{ x, y, w, h, imageWidth?, imageHeight? }` for images | Create a comment |
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
# author, createdAt, replies, resolved. Comments on images have a region anchor
# instead: { type: "region", x, y, w, h, imageWidth, imageHeight } with x/y/w/h
# as fractions (0..1) of the image.

# 3. After acting on a comment, reply + resolve:
curl -s -X POST "http://localhost:4747/api/file/comments/<cid>/replies?path=docs/spec.html" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Fixed in commit abc123","author":"agent"}'

curl -s -X PATCH "http://localhost:4747/api/file/comments/<cid>?path=docs/spec.html" \
  -H 'Content-Type: application/json' \
  -d '{"resolved":true}'
```

## Configuration

- `HTML_DIR` (or positional arg) — directory of files to serve. Required to exist.
- `COMMENTS_DIR` (default `<html-dir>/.html-comments`) — where comment JSON is persisted.
- `PORT` (default `4747`)
- `HOST` (default `0.0.0.0`)

## Deployment

Deployment artifacts live in the repo root and `deploy/`:

- **`Dockerfile`** — runs as the non-root `node` user. Mount your files at `/content` (read-only is fine) and a writable volume at `/comments` for comment persistence. Ships a healthcheck against `/api/root`.
- **`docker-compose.yml`** — one-liner local/server deployment: `HTML_DIR=/path/to/files docker compose up -d`. Comments persist in a named volume.
- **`deploy/helm/html-comments`** — Helm chart with Service, optional Ingress, and a PVC for comments. The served directory can come from an existing PVC (`content.existingClaim`), a `content.hostPath`, or default to an emptyDir you copy files into. Keep `replicaCount: 1` — comments are JSON files on disk, not multi-writer safe.
- **`deploy.sh`** — wrapper for the common flows.

```bash
# Build + run locally in Docker
./deploy.sh run /path/to/your/html

# Build + push to a registry
REGISTRY=ghcr.io/you ./deploy.sh push

# Install/upgrade on Kubernetes (uses the pushed image)
REGISTRY=ghcr.io/you NAMESPACE=reviews ./deploy.sh helm

# Chart values you'll most likely set
helm upgrade --install html-comments deploy/helm/html-comments \
  --set image.repository=ghcr.io/you/html-comments \
  --set image.tag=abc1234 \
  --set content.existingClaim=my-artifacts-pvc \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=reviews.example.com
```

Remember there is no built-in authentication (see below) — keep deployments on a private network or behind an authenticating proxy.

## Security notes

Pages render inside an `<iframe sandbox="allow-same-origin allow-scripts allow-popups allow-forms">`. Scripts in the rendered HTML can run; only host pages you trust. Markdown is rendered with HTML escaped and link/image URLs restricted to http(s)/mailto/relative. There is no authentication — put it behind your dev-server's auth (basic auth, Tailscale, etc.) if you want to share with coworkers over the public internet.

Paths are validated to stay within the configured root. The file API serves `.html`/`.htm`, markdown, and image files; sibling assets (images, CSS, etc.) referenced by relative URLs are served from `/raw/<path>` under the same root, with the same traversal protection. The `.html-comments` directory is never exposed via `/raw/`.
