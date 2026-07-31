# html-comments

Point this service at a directory of `.html`, `.md`, and image files and get a browser for them with Google-Docs-style inline commenting. Reviewers leave comments by selecting text (or drawing a box on an image); an agent reads/replies/resolves comments through a JSON API.

Built for reviewing artifacts produced by coding agents — design docs, feature mockups, workflow diagrams, UI screenshots, etc.

Supported file kinds:

- **HTML** (`.html`, `.htm`) — rendered as-is in a sandboxed iframe.
- **Markdown** (`.md`, `.markdown`) — rendered to HTML server-side (headings, lists, tables, code blocks, images, links). Comment anchoring works exactly like HTML: select rendered text.
- **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.avif`, `.bmp`) — shown full-size; comments are anchored to rectangular regions you draw by dragging on the image.

## Quick start

```bash
git clone https://github.com/olson-eric/html-comments
cd html-comments && npm install
node server.js /path/to/your/html
```

Then open `http://localhost:4747` and you'll see a file tree. Click a file to open it in the viewer, select text (or drag a box on an image), and leave comments.

## URLs

Every file is addressed by an **extension-free doc path**: `docs/spec.html` lives at `/v/docs/spec`. That's the URL the viewer uses and the one **Copy link** puts on your clipboard, so a pasted link never carries a file extension — an agent given `…/v/shots/screen` knows it's looking at a page in this service (comments, anchors, the JSON API) rather than mistaking the link for a bare `.png` to fetch or upload. Old-style `/v?path=docs/spec.html` links redirect to the new form.

If two sibling files differ only by extension (`spec.html` and `spec.md`), the extension-free path resolves by kind priority (`.html`, `.htm`, `.md`, `.markdown`, then image extensions); the other file keeps its full name as its path and stays reachable that way.

To host the app under a URL prefix (e.g. behind a shared cloud gateway or an S3-backed deployment where each project mounts at its own subpath), set `BASE_PATH=/some/prefix` — every page, API route, and asset is served under it, and the frontend uses only relative URLs so links keep working wherever the app is mounted.

Comments are stored in `<html-dir>/.html-comments/` (one JSON file per page, hashed by relative path). Override with `COMMENTS_DIR=…` if you want them somewhere else.

## Publishing from the browser

With `UPLOADS_ENABLED=1`, the file browser grows an **Upload** button: pick or drag in `.html`/`.md`/image files (multi-select works), choose a destination folder, and they're published instantly — made an artifact in Claude and want comments on it? Download it and upload it here, then share the link. Uploading to an existing name updates that page in place: the link and every comment thread stay put, so this is also how you ship a revision. The UI confirms before replacing files.

When `TRUST_IDENTITY_HEADER` is configured, the destination is prefilled with your personal folder, derived from your signed-in identity (`eric.olson@corp.com` → `eric_olson/`). Nothing is created at login — the folder appears with your first upload.

Hovering a row in the file tree shows two more actions: **rename/move** (✎ — old links redirect to the new location, comments come along) and **archive** (🗄 — hides the file behind a "Show archived" toggle without touching its link or comments; unarchive puts it back).

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

Files are identified by their extension-free doc path relative to the served root, passed as `?path=docs/spec` — the same identifier that appears in viewer URLs (`/v/docs/spec`), so a pasted link maps 1:1 onto API calls. Real filenames (`?path=docs/spec.html`) are accepted too. Responses report both: `path` (the canonical doc path) and `file` (the real relative filename). All endpoints return JSON. With `BASE_PATH` set, prefix every route with it.

### Discovery

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness check, returns `{ "ok": true }` (also served un-prefixed at the root when `BASE_PATH` is set) |
| `GET` | `/api/root` | Absolute path of the served root + configured `basePath` |
| `GET` | `/api/tree` | Recursive tree of supported files, each with `path` (doc path), `file` (real filename), `kind` (`html`/`markdown`/`image`) and comment counts |
| `GET` | `/api/updates?since=<ISO>` | Recent activity across all files, oldest first: `{ now, events: [{ at, kind, path, file, commentId?, author? }] }`. Kinds: `created`, `replied`, `resolved`, `unresolved`, `deleted` (comment events) and `uploaded`, `removed`, `moved`, `archived`, `unarchived` (file events). Omit `since` for everything retained (the log is capped at the most recent ~500 events). |
| `GET` | `/api/file?path=...` | File metadata (incl. `kind`) + all comments |
| `GET` | `/api/file/html?path=...` | The raw HTML; for markdown, the *rendered* HTML (the text anchors index into) |
| `GET` | `/raw/<file>` | The file as-is, by real filename (use this for markdown source / image bytes / sibling assets) |
| `GET` | `/render/<path>` | Markdown rendered as a standalone HTML page (what the viewer's iframe shows) |

### Comments

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `GET` | `/api/file/comments?path=...&status=open\|resolved\|all` | — | List comments |
| `POST` | `/api/file/comments?path=...` | `{ anchor, text, author? }` — anchor is `{ startIdx, length, quote?, contextBefore?, contextAfter? }` for html/markdown or `{ x, y, w, h, imageWidth?, imageHeight? }` for images | Create a comment |
| `POST` | `/api/file/comments/:cid/replies?path=...` | `{ text, author? }` | Reply on a thread |
| `PATCH` | `/api/file/comments/:cid?path=...` | `{ resolved?: boolean, text?: string }` | Resolve / edit |
| `DELETE` | `/api/file/comments/:cid?path=...` | — | Delete |

### Publishing files (opt-in)

Off by default. Set `UPLOADS_ENABLED=1` to allow publishing and deleting files over HTTP; when unset, these routes return 403 and the served directory is never written to, exactly as before.

| Method | Path | Description |
| --- | --- | --- |
| `PUT` | `/api/upload/<path>` | Write the raw request body to `<path>` (a real filename with extension, e.g. `docs/spec.html`). Parent directories are created. Overwriting is the update flow — the doc path, shared links, and comment threads all stay put. Responds `{ path, file, bytes, updated }`. |
| `DELETE` | `/api/upload/<path>` | Delete a file (doc path or real filename). The comment store is kept, so re-uploading the same path restores its threads. |

```bash
# Publish (or update) a page
curl -s -X PUT --data-binary @spec.html "http://localhost:4747/api/upload/docs/spec.html"

# Bulk publish = one PUT per file
for f in *.png; do curl -s -X PUT --data-binary "@$f" "http://localhost:4747/api/upload/shots/$f"; done
```

Upload paths get the same traversal protection as everything else, must end in a supported extension, may not contain hidden (`.`-prefixed) segments, and are capped at `UPLOAD_MAX_BYTES` (default 20 MB). Writes are atomic (temp file + rename). Each upload/delete is logged with the client address.

The same flag enables rename and archive:

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| `POST` | `/api/move` | `{ from, to }` | Rename/move a file (`to` is a real filename with extension) or a whole folder. Comment threads are keyed by path, so they migrate with the move — and the old doc path gets a **tombstone**: viewer links shared before the rename redirect to the new location. Refuses to overwrite an existing destination (409). |
| `POST` | `/api/archive?path=...` | `{ archived: true\|false }` | Flag a file archived (or un-archive it). A flag, not a move: the path, shared links, and comments are untouched; `/api/tree` reports `archived: true` and the UI hides it behind a "Show archived" toggle. |

**Security caveat:** uploaded HTML runs its scripts same-origin when viewed, like any served page. Only enable uploads on deployments where everyone who can reach the service is trusted — behind your auth proxy or on a private network.

### Example agent workflow

```bash
# 1. Find files with open comments
curl -s http://localhost:4747/api/tree | jq '..|.path? // empty'

# 2. Read open comments for a file (extension-free path, same as the viewer URL)
curl -s "http://localhost:4747/api/file/comments?path=docs/spec&status=open" | jq

# Each comment includes anchor.quote (the highlighted text), text (the comment),
# author, createdAt, replies, resolved. Comments on images have a region anchor
# instead: { type: "region", x, y, w, h, imageWidth, imageHeight } with x/y/w/h
# as fractions (0..1) of the image.

# 3. After acting on a comment, reply + resolve:
curl -s -X POST "http://localhost:4747/api/file/comments/<cid>/replies?path=docs/spec" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Fixed in commit abc123","author":"agent"}'

curl -s -X PATCH "http://localhost:4747/api/file/comments/<cid>?path=docs/spec" \
  -H 'Content-Type: application/json' \
  -d '{"resolved":true}'
```

Instead of re-walking the tree, an agent can poll the change feed — pass the previous response's `now` as the next `since`:

```bash
SINCE=$(curl -s http://localhost:4747/api/updates | jq -r .now)
# ... later ...
curl -s "http://localhost:4747/api/updates?since=$SINCE" \
  | jq '.events[] | select(.kind == "created") | {path, commentId, author}'
```

## Configuration

- `HTML_DIR` (or positional arg) — directory of files to serve. Required to exist.
- `COMMENTS_DIR` (default `<html-dir>/.html-comments`) — where comment JSON is persisted.
- `BASE_PATH` (default none) — path prefix to mount the whole app under, e.g. `/reviews`.
- `PORT` (default `4747`)
- `HOST` (default `0.0.0.0`)
- `UPLOADS_ENABLED` (default off) — enable the file upload/delete API (and the Upload button in the UI). When off, the served directory is never written to.
- `UPLOAD_MAX_BYTES` (default `20971520`, 20 MB) — per-file upload size cap.
- `TRUST_IDENTITY_HEADER` (default unset) — name of a request header carrying a verified identity, e.g. `X-Forwarded-Email` from an authenticating reverse proxy. When set, the header value stamps authorship on comments, replies, and uploads (overriding any client-supplied name — the UI shows the signed-in name and locks the field), appears in audit logs, and `/api/root` reports it (with a derived home-folder suggestion, e.g. `eric.olson@corp.com` → `eric_olson`). **Only set this when an auth proxy in front of the app strips inbound copies of the header** — otherwise any client can spoof it. Leave unset (the default) and authorship stays client-supplied exactly as before.

## Deployment

Deployment artifacts live in the repo root and `deploy/`:

- **`Dockerfile`** — runs as the non-root `node` user. Mount your files at `/content` (read-only is fine) and a writable volume at `/comments` for comment persistence. Ships a healthcheck against `/health`, which is always served at the server root — healthchecks and probes keep working when `BASE_PATH` is set.
- **`docker-compose.yml`** — one-liner local/server deployment: `HTML_DIR=/path/to/files docker compose up -d`. Comments persist in a named volume. `BASE_PATH` is passed through, and `HTML_DIR` defaults to the sample `html/` directory in this repo so a bare `docker compose up` works.
- **`deploy/helm/html-comments`** — Helm chart with Service, optional Ingress, and a PVC for comments. The served directory can come from an existing PVC (`content.existingClaim`), a `content.hostPath`, or default to an emptyDir you copy files into. Keep `replicaCount: 1` — comments are JSON files on disk, not multi-writer safe. Liveness/readiness probes hit `/health` and are `BASE_PATH`-agnostic.
- **`deploy.sh`** — wrapper for the common flows. `push` publishes the git-SHA tag (primary) and a `:latest` alias.

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

Chart extension points for common setups:

- **`serviceAccount.create` / `serviceAccount.name` / `serviceAccount.annotations`** — run the pod under a dedicated ServiceAccount; annotations are how cloud IAM binds to pods (EKS IRSA, GKE Workload Identity).
- **`extraContainers`** — sidecars, e.g. an authenticating reverse proxy in front of the app or a process syncing files into `/content`. Rendered through `tpl`, so entries may use template expressions.
- **`extraVolumes` / `extraVolumeMounts`** — additional volumes and mounts for the app container (also `tpl`-rendered).
- **`service.targetPort`** (default `http`) — point the Service at a sidecar's port instead of the app, e.g. when an auth proxy terminates TLS. **`service.annotations`** — e.g. cloud load-balancer healthcheck config.
- **`comments.persistence.keepOnUninstall`** (default `true`) — annotates the comments PVC with `helm.sh/resource-policy: keep`, so `helm uninstall` leaves your comment data behind. Set to `false` if you want the PVC deleted with the release.

Remember there is no built-in authentication (see below) — keep deployments on a private network or behind an authenticating proxy.

### Writable deployments and agent access

To enable HTTP publishing (uploads, rename, archive) on a hosted deployment:

- **docker-compose**: `UPLOADS_ENABLED=1 CONTENT_MODE=rw docker compose up -d` (the content mount must be writable).
- **Helm**: set `content.readOnly: false` and `env.UPLOADS_ENABLED: "1"`; add `env.TRUST_IDENTITY_HEADER: "X-Forwarded-Email"` (or whatever your auth proxy sets) so uploads and comments are attributed to the signed-in user.

Be deliberate about the access model — the app itself has no auth, so the deployment provides it in two layers:

- **Humans** come through your authenticating proxy (oauth2-proxy sidecar via `extraContainers`, an SSO-enforcing ingress, etc.), which verifies them and sets the identity header. The proxy **must strip inbound copies** of that header or clients can spoof identities.
- **Agents** (Claude Code, or anything driving the JSON API) typically can't complete an SSO redirect. The supported pattern is a trusted internal route that bypasses the proxy: the cluster-internal Service DNS, a VPN/Tailscale address, or `kubectl port-forward`. Requests on that route carry no identity header, so they're attributed to the author the agent supplies.

The consequence to be clear-eyed about: **anyone who can reach the pod directly can read and write everything under any name.** The proxy protects humans; the network boundary protects the API. Only run writable deployments where that boundary holds (private cluster networks, VPNs). Per-agent API tokens and an MCP integration are planned follow-ups for setups that need agent auth stronger than network trust.

## Security notes

Pages render inside an `<iframe sandbox="allow-same-origin allow-scripts allow-popups allow-forms">`. Scripts in the rendered HTML can run; only host pages you trust. Markdown is rendered with HTML escaped and link/image URLs restricted to http(s)/mailto/relative. There is no authentication — put it behind your dev-server's auth (basic auth, Tailscale, etc.) if you want to share with coworkers over the public internet.

Paths are validated to stay within the configured root. The file API serves `.html`/`.htm`, markdown, and image files; sibling assets (images, CSS, etc.) referenced by relative URLs are served from `/raw/<path>` under the same root, with the same traversal protection. The `.html-comments` directory is never exposed via `/raw/`.
