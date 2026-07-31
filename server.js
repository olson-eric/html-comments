#!/usr/bin/env node
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renderMarkdown } = require('./public/markdown.js');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`html-comments — render HTML, markdown, and images with inline comments

Usage:
  html-comments [<html-dir>]

Options:
  <html-dir>            Directory of .html/.md/image files to serve (default: ./html)

Environment:
  HTML_DIR              Same as positional arg
  COMMENTS_DIR          Where to persist comments (default: <html-dir>/.html-comments)
  BASE_PATH             Path prefix to mount the app under, e.g. /reviews (default: none)
  UPLOADS_ENABLED       Set to 1 to enable the upload/delete API (default: off, read-only)
  UPLOAD_MAX_BYTES      Max upload size in bytes (default: 20971520 = 20MB)
  PORT                  Listen port (default: 4747)
  HOST                  Listen host (default: 0.0.0.0)
`);
  process.exit(0);
}

const app = express();
const PORT = process.env.PORT || 4747;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(argv[0] || process.env.HTML_DIR || './html');
const COMMENTS_DIR = path.resolve(process.env.COMMENTS_DIR || path.join(ROOT, '.html-comments'));

// File mutations (upload/delete) are strictly opt-in. When unset, every
// mutating route 403s and the served directory is never written to — the
// default deployment keeps today's read-only guarantee exactly.
const UPLOADS_ENABLED = /^(1|true|yes)$/i.test(String(process.env.UPLOADS_ENABLED || ''));
const UPLOAD_MAX_BYTES = (() => {
  const n = parseInt(process.env.UPLOAD_MAX_BYTES, 10);
  return Number.isFinite(n) && n > 0 ? n : 20 * 1024 * 1024;
})();

// Normalized to "" (mounted at /) or "/prefix" with a leading slash and no
// trailing slash, so it can be prepended to absolute paths verbatim.
const BASE_PATH = (() => {
  let p = String(process.env.BASE_PATH || '').trim();
  if (!p || p === '/') return '';
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+$/, '');
})();

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error(`html-comments: HTML directory does not exist: ${ROOT}`);
  console.error(`Usage: html-comments [<html-dir>]   (or set HTML_DIR=...)`);
  process.exit(1);
}
fs.mkdirSync(COMMENTS_DIR, { recursive: true });

// Upload PUTs carry the file verbatim, whatever its Content-Type — keep the
// JSON body parser away from them so a .json-shaped HTML page or a
// text/html body isn't consumed before the raw parser sees it.
const jsonParser = express.json({ limit: '5mb' });
const isRawUpload = (req) => req.method === 'PUT' && /\/api\/upload\//.test(req.path);
app.use((req, res, next) => (isRawUpload(req) ? next() : jsonParser(req, res, next)));
const router = express.Router();

const newId = () => crypto.randomBytes(6).toString('hex');

const KIND_PATTERNS = [
  ['html', /\.html?$/i],
  ['markdown', /\.(md|markdown)$/i],
  ['image', /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i],
];

// Priority order for resolving an extension-free doc path to a file.
const EXTENSIONS = ['.html', '.htm', '.md', '.markdown', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'];

function fileKind(name) {
  for (const [kind, re] of KIND_PATTERNS) {
    if (re.test(name)) return kind;
  }
  return null;
}

function encodePath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}

// Canonical extension-free identifier for a file: "docs/spec" for
// "docs/spec.html". Files are addressed by this doc path in URLs and the API,
// so pasted links don't carry a file extension. When dropping the extension
// would be ambiguous — a sibling earlier in EXTENSIONS priority, or a real
// file named like the bare base — the full relative path stays the identifier
// (resolveFile tries the exact path first, so it remains reachable).
function docPathFor(rel) {
  const lower = rel.toLowerCase();
  const ext = EXTENSIONS.find((e) => lower.endsWith(e));
  if (!ext) return rel;
  const base = rel.slice(0, -ext.length);
  if (!base || base.endsWith('/')) return rel;
  const baseAbs = path.resolve(ROOT, base);
  if (fs.existsSync(baseAbs) && fs.statSync(baseAbs).isFile() && fileKind(base)) return rel;
  for (const e of EXTENSIONS) {
    const abs = path.resolve(ROOT, base + e);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return base + e === rel ? base : rel;
    }
  }
  return rel;
}

// Accepts either a real relative path ("docs/spec.html") or an extension-free
// doc path ("docs/spec"). Exact match wins; otherwise EXTENSIONS are tried in
// priority order.
function resolveFile(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  if (path.isAbsolute(relPath)) return null;
  const norm = path.posix.normalize(relPath.replace(/\\/g, '/'));
  if (norm.startsWith('..') || norm.includes('/../')) return null;
  const tryRel = (rel) => {
    const abs = path.resolve(ROOT, rel);
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    const kind = fileKind(abs);
    if (!kind) return null;
    return { abs, rel, kind, doc: docPathFor(rel) };
  };
  const exact = tryRel(norm);
  if (exact) return exact;
  for (const ext of EXTENSIONS) {
    const hit = tryRel(norm + ext);
    if (hit) return hit;
  }
  return null;
}

function resolveAsset(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  if (path.isAbsolute(relPath)) return null;
  const norm = path.posix.normalize(relPath.replace(/\\/g, '/'));
  if (norm.startsWith('..') || norm.includes('/../')) return null;
  if (norm.split('/').some((seg) => seg === '.html-comments')) return null;
  const abs = path.resolve(ROOT, norm);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return { abs, rel: norm };
}

// Upload targets must stay strictly inside the root and be a supported file
// kind. Hidden segments (including .html-comments) are rejected outright —
// the tree never shows them, so an upload there would just vanish.
function resolveUploadTarget(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  if (path.isAbsolute(relPath)) return null;
  const norm = path.posix.normalize(relPath.replace(/\\/g, '/'));
  if (norm.startsWith('..') || norm.includes('/../')) return null;
  if (norm.split('/').some((seg) => !seg || seg.startsWith('.') || seg === 'node_modules')) return null;
  if (!fileKind(norm)) return null;
  const abs = path.resolve(ROOT, norm);
  if (abs === ROOT || !abs.startsWith(ROOT + path.sep)) return null;
  if (fs.existsSync(abs) && !fs.statSync(abs).isFile()) return null;
  return { abs, rel: norm };
}

function writeFileAtomic(file, buf) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

function buildTree(absDir, relDir = '') {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (e) {
    return { name: path.basename(absDir) || 'root', path: relDir, type: 'dir', children: [] };
  }
  const children = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const childRel = relDir ? `${relDir}/${e.name}` : e.name;
    const childAbs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      const sub = buildTree(childAbs, childRel);
      if (sub.children.length) children.push(sub);
    } else if (e.isFile() && fileKind(e.name)) {
      const data = readComments(childRel);
      const open = data.comments.filter((c) => !c.resolved).length;
      children.push({
        name: e.name,
        path: docPathFor(childRel),
        file: childRel,
        type: 'file',
        kind: fileKind(e.name),
        commentCount: data.comments.length,
        openCount: open,
      });
    }
  }
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { name: path.basename(absDir) || path.basename(ROOT), path: relDir, type: 'dir', children };
}

// Comments stay keyed by the real relative path (with extension), so existing
// comment stores keep working regardless of how the file was addressed.
function commentsFile(relPath) {
  const hash = crypto.createHash('sha1').update(relPath).digest('hex');
  return path.join(COMMENTS_DIR, `${hash}.json`);
}

function readComments(relPath) {
  const f = commentsFile(relPath);
  if (!fs.existsSync(f)) return { path: relPath, comments: [] };
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return { path: relPath, comments: [] };
  }
}

// All JSON persistence goes through a temp-file-plus-rename so a crash
// mid-write can't leave a truncated file behind.
function writeJsonAtomic(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function writeComments(relPath, data) {
  writeJsonAtomic(commentsFile(relPath), { ...data, path: relPath });
}

function extractTitle(html) {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return m ? m[1].trim() : null;
}

function extractMarkdownTitle(md) {
  const m = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(md);
  return m ? m[1].trim() : null;
}

function fileTitle(f) {
  if (f.kind === 'html') {
    return extractTitle(fs.readFileSync(f.abs, 'utf8')) || path.basename(f.abs);
  }
  if (f.kind === 'markdown') {
    return extractMarkdownTitle(fs.readFileSync(f.abs, 'utf8')) || path.basename(f.abs);
  }
  return path.basename(f.abs);
}

// Wrap rendered markdown in a standalone HTML document. The <base> tag points
// at the file's directory under /raw/ so relative images and links resolve.
function markdownDocument(f) {
  const md = fs.readFileSync(f.abs, 'utf8');
  const title = extractMarkdownTitle(md) || path.basename(f.abs);
  const dir = path.posix.dirname(f.rel);
  const baseHref =
    `${BASE_PATH}/raw/` + (dir === '.' ? '' : dir.split('/').map(encodeURIComponent).join('/') + '/');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlAttr(title)}</title>
<base href="${baseHref}">
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
    color: #1f2328; background: #ffffff;
    max-width: 840px; margin: 0 auto; padding: 2.5rem 2rem 4rem;
    line-height: 1.6; font-size: 16px;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; }
  h1 { font-size: 1.9em; border-bottom: 1px solid #d8dee4; padding-bottom: 0.3em; }
  h2 { font-size: 1.45em; border-bottom: 1px solid #d8dee4; padding-bottom: 0.3em; }
  h3 { font-size: 1.2em; }
  p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
  a { color: #0969da; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.88em; background: rgba(175, 184, 193, 0.2);
    padding: 0.1em 0.35em; border-radius: 4px;
  }
  pre {
    background: #f6f8fa; padding: 0.8em 1em; border-radius: 8px;
    overflow-x: auto; line-height: 1.45;
  }
  pre code { background: none; padding: 0; font-size: 0.85em; }
  blockquote { border-left: 4px solid #d8dee4; padding: 0 1em; color: #59636e; }
  hr { border: none; border-top: 1px solid #d8dee4; margin: 1.5em 0; }
  img { max-width: 100%; }
  table { border-collapse: collapse; display: block; overflow-x: auto; }
  th, td { border: 1px solid #d8dee4; padding: 0.35em 0.8em; text-align: left; }
  th { background: #f6f8fa; }
</style>
</head>
<body>
${renderMarkdown(md, { breaks: false })}
</body>
</html>
`;
}

function escapeHtmlAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// The app chrome uses relative URLs throughout; a <base href> pointing at the
// app root makes them resolve correctly wherever the app is mounted, including
// under the nested /v/<doc-path> viewer URLs.
function pageHtml(name) {
  return fs
    .readFileSync(path.join(__dirname, 'public', name), 'utf8')
    .replace('<head>', `<head>\n    <base href="${BASE_PATH}/" />`);
}

// Preserve query params (e.g. ?for=name) across redirects, minus `drop`.
function keepQuery(req, drop = []) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (!drop.includes(k) && typeof v === 'string') qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

const healthHandler = (_req, res) => res.json({ ok: true });

router.get('/health', healthHandler);

router.get('/api/root', (_req, res) => {
  res.json({
    root: ROOT,
    name: path.basename(ROOT),
    basePath: BASE_PATH,
    uploadsEnabled: UPLOADS_ENABLED,
    uploadMaxBytes: UPLOAD_MAX_BYTES,
  });
});

router.get('/api/tree', (_req, res) => {
  res.json(buildTree(ROOT));
});

router.get('/api/file', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  const stat = fs.statSync(f.abs);
  const data = readComments(f.rel);
  res.json({
    path: f.doc,
    file: f.rel,
    name: path.basename(f.abs),
    kind: f.kind,
    title: fileTitle(f),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    comments: data.comments,
  });
});

// Raw HTML for .html files; rendered HTML for markdown (what the viewer shows,
// and the text that comment anchors index into).
router.get('/api/file/html', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).send('not found');
  if (f.kind === 'image') return res.status(400).json({ error: 'not renderable as html; fetch via /raw/' });
  if (f.kind === 'markdown') {
    return res.type('text/html; charset=utf-8').send(markdownDocument(f));
  }
  res.type('text/html; charset=utf-8').send(fs.readFileSync(f.abs, 'utf8'));
});

router.get('/api/file/comments', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  const data = readComments(f.rel);
  let comments = data.comments;
  const status = req.query.status;
  if (status === 'open') comments = comments.filter((c) => !c.resolved);
  if (status === 'resolved') comments = comments.filter((c) => c.resolved);
  res.json({ path: f.doc, file: f.rel, comments });
});

// Two anchor shapes: text anchors ({startIdx, length, quote, context*}) for
// html/markdown, and region anchors ({x, y, w, h} as fractions of the image,
// plus the image's pixel size at comment time) for images.
function normalizeAnchor(anchor) {
  const nums = ['x', 'y', 'w', 'h'];
  if (nums.every((k) => typeof anchor[k] === 'number' && Number.isFinite(anchor[k]))) {
    const clamp = (v) => Math.max(0, Math.min(1, v));
    const region = { type: 'region', x: clamp(anchor.x), y: clamp(anchor.y), w: clamp(anchor.w), h: clamp(anchor.h) };
    if (Number.isFinite(anchor.imageWidth)) region.imageWidth = Math.round(anchor.imageWidth);
    if (Number.isFinite(anchor.imageHeight)) region.imageHeight = Math.round(anchor.imageHeight);
    return region;
  }
  if (typeof anchor.startIdx === 'number' && typeof anchor.length === 'number') {
    return {
      startIdx: anchor.startIdx,
      length: anchor.length,
      quote: anchor.quote || '',
      contextBefore: anchor.contextBefore || '',
      contextAfter: anchor.contextAfter || '',
    };
  }
  return null;
}

router.post('/api/file/comments', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  const { anchor, text, author } = req.body || {};
  if (!anchor || typeof anchor !== 'object') return res.status(400).json({ error: 'anchor required' });
  const stored = normalizeAnchor(anchor);
  if (!stored) {
    return res.status(400).json({
      error: 'anchor must have startIdx+length (text) or x/y/w/h in 0..1 (image region)',
    });
  }
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });
  const data = readComments(f.rel);
  const comment = {
    id: newId(),
    anchor: stored,
    text,
    author: (author || 'Anonymous').toString().slice(0, 80),
    resolved: false,
    createdAt: new Date().toISOString(),
    replies: [],
  };
  data.comments.push(comment);
  writeComments(f.rel, data);
  res.json(comment);
});

router.post('/api/file/comments/:cid/replies', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  const { text, author } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const data = readComments(f.rel);
  const comment = data.comments.find((c) => c.id === req.params.cid);
  if (!comment) return res.status(404).json({ error: 'comment not found' });
  const reply = {
    id: newId(),
    text,
    author: (author || 'Anonymous').toString().slice(0, 80),
    createdAt: new Date().toISOString(),
  };
  comment.replies.push(reply);
  writeComments(f.rel, data);
  res.json(reply);
});

router.patch('/api/file/comments/:cid', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  const data = readComments(f.rel);
  const comment = data.comments.find((c) => c.id === req.params.cid);
  if (!comment) return res.status(404).json({ error: 'comment not found' });
  if (typeof req.body.resolved === 'boolean') comment.resolved = req.body.resolved;
  if (typeof req.body.text === 'string') comment.text = req.body.text;
  writeComments(f.rel, data);
  res.json(comment);
});

router.delete('/api/file/comments/:cid', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  const data = readComments(f.rel);
  const idx = data.comments.findIndex((c) => c.id === req.params.cid);
  if (idx === -1) return res.status(404).json({ error: 'comment not found' });
  data.comments.splice(idx, 1);
  writeComments(f.rel, data);
  res.json({ ok: true });
});

function requireUploads(_req, res, next) {
  if (!UPLOADS_ENABLED) return res.status(403).json({ error: 'uploads are disabled (set UPLOADS_ENABLED=1)' });
  next();
}

function audit(req, action, detail) {
  console.log(`[audit] ${action} ${detail} from=${req.ip}`);
}

function decodedParam(req) {
  try {
    return decodeURIComponent(req.params[0]);
  } catch {
    return null;
  }
}

// Publish a file: raw body, path in the URL. Overwriting an existing path is
// the update flow — comment threads are keyed by that path and survive, which
// is the point of anchors that tolerate edits.
router.put(
  /^\/api\/upload\/(.+)$/,
  requireUploads,
  express.raw({ type: () => true, limit: UPLOAD_MAX_BYTES }),
  (req, res) => {
    const rel = decodedParam(req);
    if (rel === null) return res.status(400).json({ error: 'bad request' });
    const target = resolveUploadTarget(rel);
    if (!target) {
      return res.status(400).json({
        error: 'invalid upload path: must stay inside the served root, contain no hidden segments, and end in a supported extension (.html/.htm/.md/.markdown or an image type)',
      });
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!body.length) return res.status(400).json({ error: 'empty body' });
    const updated = fs.existsSync(target.abs);
    fs.mkdirSync(path.dirname(target.abs), { recursive: true });
    writeFileAtomic(target.abs, body);
    audit(req, updated ? 'update' : 'upload', `${target.rel} ${body.length}b`);
    res.json({ path: docPathFor(target.rel), file: target.rel, bytes: body.length, updated });
  }
);

// Deleting a file keeps its comment store: re-uploading the same path
// restores the threads.
router.delete(/^\/api\/upload\/(.+)$/, requireUploads, (req, res) => {
  const rel = decodedParam(req);
  if (rel === null) return res.status(400).json({ error: 'bad request' });
  const f = resolveFile(rel);
  if (!f) return res.status(404).json({ error: 'not found' });
  fs.unlinkSync(f.abs);
  audit(req, 'delete', f.rel);
  res.json({ ok: true, path: f.doc, file: f.rel });
});

router.get(/^\/raw\/(.+)$/, (req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(req.params[0]);
  } catch {
    return res.status(400).send('bad request');
  }
  const f = resolveAsset(rel);
  if (!f) return res.status(404).send('not found');
  res.sendFile(f.abs);
});

// Markdown rendered as a standalone HTML page (what the viewer's iframe loads).
router.get(/^\/render\/(.+)$/, (req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(req.params[0]);
  } catch {
    return res.status(400).send('bad request');
  }
  const f = resolveFile(rel);
  if (!f || f.kind !== 'markdown') return res.status(404).send('not found');
  res.type('text/html; charset=utf-8').send(markdownDocument(f));
});

router.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Viewer. Files are addressed by extension-free doc path (/v/docs/spec);
// addressing by real path redirects to the canonical extension-free URL.
router.get(/^\/v\/(.+)$/, (req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(req.params[0]);
  } catch {
    return res.status(400).send('bad request');
  }
  const f = resolveFile(rel);
  if (!f) return res.status(404).send('File not found');
  if (rel !== f.doc) return res.redirect(`${BASE_PATH}/v/${encodePath(f.doc)}${keepQuery(req)}`);
  res.type('text/html; charset=utf-8').send(pageHtml('viewer.html'));
});

// Legacy /v?path=... links redirect to the extension-free form.
router.get('/v', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).send('File not found');
  res.redirect(`${BASE_PATH}/v/${encodePath(f.doc)}${keepQuery(req, ['path'])}`);
});

router.get('/', (_req, res) => {
  res.type('text/html; charset=utf-8').send(pageHtml('index.html'));
});

// Health stays at the root even when the app is mounted under BASE_PATH, so
// container healthchecks and Kubernetes probes don't depend on the prefix
// (it also exists under the prefix via the router).
app.get('/health', healthHandler);
if (BASE_PATH) {
  app.get('/', (_req, res) => res.redirect(`${BASE_PATH}/`));
}
app.use(BASE_PATH || '/', router);

// Body-parser size rejections come back as JSON like every other API error.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: `body too large (limit ${UPLOAD_MAX_BYTES} bytes for uploads)` });
  }
  next(err);
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`html-comments serving ${ROOT}`);
    console.log(`→ http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${BASE_PATH ? BASE_PATH + '/' : ''}`);
  });
}

module.exports = { app, resolveFile, docPathFor, BASE_PATH };
