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
  TRUST_IDENTITY_HEADER Header carrying a verified identity from your auth proxy,
                        e.g. X-Forwarded-Email (default: unset, never trusted)
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

// Name of a request header carrying a verified identity (e.g.
// X-Forwarded-Email set by an authenticating reverse proxy). Only trust it
// when explicitly configured: without a proxy stripping inbound copies, any
// client could spoof it. When set, the header value overrides client-supplied
// author names on comments, replies, and uploads.
const TRUST_IDENTITY_HEADER = String(process.env.TRUST_IDENTITY_HEADER || '').trim().toLowerCase();

// What a signed-in user's new uploads default to: 'private' (only the
// uploader until they share) or 'everyone'. Only meaningful alongside
// TRUST_IDENTITY_HEADER — anonymous uploads have no owner to be private to,
// so they are always visible to everyone. Unknown values fall back to
// 'private', the safe direction.
const DEFAULT_VISIBILITY =
  String(process.env.DEFAULT_VISIBILITY || '').trim().toLowerCase() === 'everyone' ? 'everyone' : 'private';

function identityFor(req) {
  if (!TRUST_IDENTITY_HEADER) return null;
  const v = req.headers[TRUST_IDENTITY_HEADER];
  const s = (Array.isArray(v) ? v[0] : v || '').toString().trim().slice(0, 80);
  return s || null;
}

// A user's suggested home folder, derived from their identity: the email
// local part (or the whole value if it isn't email-shaped), lowercased, with
// runs of anything outside [a-z0-9-] collapsed to "_". eric.olson@corp.com
// → eric_olson. Nothing is created until they upload into it.
function homeSlugFor(identity) {
  if (!identity) return null;
  const local = identity.includes('@') ? identity.slice(0, identity.indexOf('@')) : identity;
  const slug = local.toLowerCase().replace(/[^a-z0-9-]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || null;
}

function authorFrom(req, bodyAuthor) {
  const who = identityFor(req) || bodyAuthor;
  return (who || 'Anonymous').toString().slice(0, 80);
}

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

// Bare `node server.js <dir>` defaults the comment store to
// <dir>/.html-comments, while the container images set COMMENTS_DIR=/comments
// (a volume). Someone moving between the two would find their old comments
// silently gone. If the configured store is empty but the in-content default
// has data, import it once so comments follow the content.
const IN_CONTENT_COMMENTS_DIR = path.resolve(path.join(ROOT, '.html-comments'));
if (COMMENTS_DIR !== IN_CONTENT_COMMENTS_DIR) {
  const dataFiles = (dir) => {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'));
    } catch {
      return [];
    }
  };
  if (dataFiles(COMMENTS_DIR).length === 0) {
    const found = dataFiles(IN_CONTENT_COMMENTS_DIR);
    for (const f of found) {
      fs.copyFileSync(path.join(IN_CONTENT_COMMENTS_DIR, f), path.join(COMMENTS_DIR, f));
    }
    if (found.length) {
      console.log(`Imported ${found.length} comment file(s) from ${IN_CONTENT_COMMENTS_DIR} into ${COMMENTS_DIR}`);
    }
  }
}

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

function buildTree(absDir, relDir = '', archived = readArchived(), perms = readPerms(), identity = null) {
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
      const sub = buildTree(childAbs, childRel, archived, perms, identity);
      if (sub.children.length) children.push(sub);
    } else if (e.isFile() && fileKind(e.name)) {
      if (!canReadRel(childRel, identity, perms)) continue;
      const data = readComments(childRel);
      const open = data.comments.filter((c) => !c.resolved).length;
      const node = {
        name: e.name,
        path: docPathFor(childRel),
        file: childRel,
        type: 'file',
        kind: fileKind(e.name),
        commentCount: data.comments.length,
        openCount: open,
      };
      if (archived.has(childRel)) node.archived = true;
      const p = perms[childRel];
      if (p && p.visibility !== 'everyone') node.visibility = p.visibility;
      children.push(node);
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

// Archive is a metadata flag, not a move: the file, its doc path, shared
// links, and comment threads all stay put; the tree just marks it archived
// and the UI hides it behind a toggle. Stored as real relative filenames.
const ARCHIVE_FILE = path.join(COMMENTS_DIR, 'archived.json');

function readArchived() {
  try {
    return new Set(JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8')).files);
  } catch {
    return new Set();
  }
}

function writeArchived(set) {
  writeJsonAtomic(ARCHIVE_FILE, { files: [...set].sort() });
}

// Per-document sharing, keyed by real relative filename (same as comment
// stores): { owner, visibility: 'private'|'shared'|'everyone', sharedWith }.
// No entry means visible to everyone — sharing is strictly opt-in per doc, so
// deployments without an identity source behave exactly as before. Identities
// come from TRUST_IDENTITY_HEADER; the recommended deployment runs an auth
// sidecar in front that authenticates humans *and* agents and stamps that
// header, so agent visibility follows the user whose token the agent holds.
const PERMS_FILE = path.join(COMMENTS_DIR, 'permissions.json');
const VISIBILITIES = ['private', 'shared', 'everyone'];
const SHARED_WITH_MAX = 200;

function readPerms() {
  try {
    return JSON.parse(fs.readFileSync(PERMS_FILE, 'utf8')).files || {};
  } catch {
    return {};
  }
}

function writePerms(files) {
  writeJsonAtomic(PERMS_FILE, { files });
}

const normIdentity = (s) => String(s || '').trim().toLowerCase();

function canReadRel(rel, identity, perms = readPerms()) {
  const p = perms[rel];
  if (!p || p.visibility === 'everyone') return true;
  if (!identity) return false;
  const who = normIdentity(identity);
  if (normIdentity(p.owner) === who) return true;
  return p.visibility === 'shared' && (p.sharedWith || []).some((e) => normIdentity(e) === who);
}

function canRead(req, rel) {
  return canReadRel(rel, identityFor(req));
}

// File mutations (overwrite, delete, move, archive) on a restricted doc are
// owner-only. Unrestricted docs keep today's anyone-can-touch behavior.
function canMutateRel(rel, identity, perms = readPerms()) {
  const p = perms[rel];
  if (!p || p.visibility === 'everyone') return true;
  return !!identity && normIdentity(p.owner) === normIdentity(identity);
}

// Restricted docs 404 (not 403) for outsiders so their existence doesn't leak.
function requireReadable(req, res, rel) {
  if (canRead(req, rel)) return true;
  res.status(404).json({ error: 'not found' });
  return false;
}

function requireMutable(req, res, rel) {
  if (!requireReadable(req, res, rel)) return false;
  if (canMutateRel(rel, identityFor(req))) return true;
  res.status(403).json({ error: 'only the owner can modify this file' });
  return false;
}

// Renames leave tombstones (old doc path → new doc path) so links pasted
// into chat before a rename keep working: /v/<old> redirects to /v/<new>.
const TOMBSTONES_FILE = path.join(COMMENTS_DIR, 'tombstones.json');

function readTombstones() {
  try {
    return JSON.parse(fs.readFileSync(TOMBSTONES_FILE, 'utf8')).moves || {};
  } catch {
    return {};
  }
}

function recordMove(oldDoc, newDoc) {
  const moves = readTombstones();
  // Repoint older tombstones at the newest location so redirects stay one hop.
  for (const [k, v] of Object.entries(moves)) {
    if (v === oldDoc) moves[k] = newDoc;
  }
  moves[oldDoc] = newDoc;
  delete moves[newDoc]; // the target exists again; no redirect wanted
  writeJsonAtomic(TOMBSTONES_FILE, { moves });
}

// Append-only activity log so agents can poll one endpoint instead of
// re-walking the tree. Kept in the comments dir (never served), JSONL, capped.
const EVENTS_FILE = path.join(COMMENTS_DIR, 'events.jsonl');
const EVENTS_MAX_BYTES = 1024 * 1024;
const EVENTS_KEEP = 500;

function recordEvent(kind, f, extra = {}) {
  const entry = { at: new Date().toISOString(), kind, path: f.doc, file: f.rel, ...extra };
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(entry) + '\n');
    if (fs.statSync(EVENTS_FILE).size > EVENTS_MAX_BYTES) {
      const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
      const tmp = `${EVENTS_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, lines.slice(-EVENTS_KEEP).join('\n') + '\n');
      fs.renameSync(tmp, EVENTS_FILE);
    }
  } catch (e) {
    console.error(`[events] failed to record: ${e.message}`);
  }
}

function readEvents(since) {
  let raw;
  try {
    raw = fs.readFileSync(EVENTS_FILE, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (!since || e.at > since) events.push(e);
    } catch {}
  }
  return events;
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

router.get('/api/root', (req, res) => {
  const user = identityFor(req);
  res.json({
    root: ROOT,
    name: path.basename(ROOT),
    basePath: BASE_PATH,
    uploadsEnabled: UPLOADS_ENABLED,
    uploadMaxBytes: UPLOAD_MAX_BYTES,
    defaultVisibility: DEFAULT_VISIBILITY,
    identity: user ? { user, home: homeSlugFor(user) } : null,
  });
});

router.get('/api/tree', (req, res) => {
  res.json(buildTree(ROOT, '', readArchived(), readPerms(), identityFor(req)));
});

// Recent activity across all files, oldest first. Poll with the returned
// `now` as the next `since` to get exactly-once delivery of new events.
// Events on restricted docs are only shown to identities that can read them.
router.get('/api/updates', (req, res) => {
  const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : null;
  const perms = readPerms();
  const identity = identityFor(req);
  const events = readEvents(since).filter((e) => !e.file || canReadRel(e.file, identity, perms));
  res.json({ now: new Date().toISOString(), since, events });
});

router.get('/api/file', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (!requireReadable(req, res, f.rel)) return;
  const stat = fs.statSync(f.abs);
  const data = readComments(f.rel);
  const p = readPerms()[f.rel];
  res.json({
    path: f.doc,
    file: f.rel,
    name: path.basename(f.abs),
    kind: f.kind,
    title: fileTitle(f),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    archived: readArchived().has(f.rel) || undefined,
    visibility: p ? p.visibility : 'everyone',
    comments: data.comments,
  });
});

// Raw HTML for .html files; rendered HTML for markdown (what the viewer shows,
// and the text that comment anchors index into).
router.get('/api/file/html', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).send('not found');
  if (!canRead(req, f.rel)) return res.status(404).send('not found');
  if (f.kind === 'image') return res.status(400).json({ error: 'not renderable as html; fetch via /raw/' });
  if (f.kind === 'markdown') {
    return res.type('text/html; charset=utf-8').send(markdownDocument(f));
  }
  res.type('text/html; charset=utf-8').send(fs.readFileSync(f.abs, 'utf8'));
});

router.get('/api/file/comments', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (!requireReadable(req, res, f.rel)) return;
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

// Anyone who can read a doc can comment on it — a reviewer who can't leave
// comments would defeat the point of sharing a doc for review.
router.post('/api/file/comments', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (!requireReadable(req, res, f.rel)) return;
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
    author: authorFrom(req, author),
    resolved: false,
    createdAt: new Date().toISOString(),
    replies: [],
  };
  data.comments.push(comment);
  writeComments(f.rel, data);
  recordEvent('created', f, { commentId: comment.id, author: comment.author });
  res.json(comment);
});

router.post('/api/file/comments/:cid/replies', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (!requireReadable(req, res, f.rel)) return;
  const { text, author } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const data = readComments(f.rel);
  const comment = data.comments.find((c) => c.id === req.params.cid);
  if (!comment) return res.status(404).json({ error: 'comment not found' });
  const reply = {
    id: newId(),
    text,
    author: authorFrom(req, author),
    createdAt: new Date().toISOString(),
  };
  comment.replies.push(reply);
  writeComments(f.rel, data);
  recordEvent('replied', f, { commentId: comment.id, author: reply.author });
  res.json(reply);
});

router.patch('/api/file/comments/:cid', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (!requireReadable(req, res, f.rel)) return;
  const data = readComments(f.rel);
  const comment = data.comments.find((c) => c.id === req.params.cid);
  if (!comment) return res.status(404).json({ error: 'comment not found' });
  const wasResolved = comment.resolved;
  if (typeof req.body.resolved === 'boolean') comment.resolved = req.body.resolved;
  if (typeof req.body.text === 'string') comment.text = req.body.text;
  writeComments(f.rel, data);
  if (comment.resolved !== wasResolved) {
    recordEvent(comment.resolved ? 'resolved' : 'unresolved', f, {
      commentId: comment.id,
      author: identityFor(req) || undefined,
    });
  }
  res.json(comment);
});

router.delete('/api/file/comments/:cid', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (!requireReadable(req, res, f.rel)) return;
  const data = readComments(f.rel);
  const idx = data.comments.findIndex((c) => c.id === req.params.cid);
  if (idx === -1) return res.status(404).json({ error: 'comment not found' });
  const [removed] = data.comments.splice(idx, 1);
  writeComments(f.rel, data);
  recordEvent('deleted', f, { commentId: removed.id, author: identityFor(req) || undefined });
  res.json({ ok: true });
});

// ----- Sharing -----
// Available regardless of UPLOADS_ENABLED (read-only deployments share too),
// but changing permissions always requires a verified identity — without an
// auth layer stamping TRUST_IDENTITY_HEADER, "private" would be theater.
router.get('/api/file/permissions', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (!requireReadable(req, res, f.rel)) return;
  const p = readPerms()[f.rel];
  res.json({
    path: f.doc,
    file: f.rel,
    visibility: p ? p.visibility : 'everyone',
    owner: (p && p.owner) || null,
    sharedWith: (p && p.sharedWith) || [],
  });
});

router.put('/api/file/permissions', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (!requireReadable(req, res, f.rel)) return;
  const identity = identityFor(req);
  if (!identity) {
    return res.status(403).json({ error: 'sharing requires a verified identity (TRUST_IDENTITY_HEADER)' });
  }
  const perms = readPerms();
  const existing = perms[f.rel];
  if (existing && existing.owner && normIdentity(existing.owner) !== normIdentity(identity)) {
    return res.status(403).json({ error: 'only the owner can change sharing' });
  }
  const { visibility, sharedWith } = req.body || {};
  if (!VISIBILITIES.includes(visibility)) {
    return res.status(400).json({ error: `visibility must be one of ${VISIBILITIES.join(', ')}` });
  }
  const entry = { owner: (existing && existing.owner) || identity, visibility };
  if (visibility === 'shared') {
    if (!Array.isArray(sharedWith) || sharedWith.some((e) => typeof e !== 'string')) {
      return res.status(400).json({ error: 'sharedWith (array of identity strings) required for visibility "shared"' });
    }
    entry.sharedWith = [...new Set(sharedWith.map(normIdentity).filter(Boolean))].slice(0, SHARED_WITH_MAX);
  }
  perms[f.rel] = entry;
  writePerms(perms);
  audit(req, 'share', `${f.rel} visibility=${visibility}`);
  recordEvent('shared', f, { author: identity, visibility });
  res.json({ path: f.doc, file: f.rel, ...entry });
});

function requireUploads(_req, res, next) {
  if (!UPLOADS_ENABLED) return res.status(403).json({ error: 'uploads are disabled (set UPLOADS_ENABLED=1)' });
  next();
}

function audit(req, action, detail) {
  console.log(`[audit] ${action} ${detail} by=${identityFor(req) || 'anonymous'} from=${req.ip}`);
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
    // The permissions entry outlives the file (like its comment store), so a
    // restricted path stays owner-only across delete/re-upload.
    if (!requireMutable(req, res, target.rel)) return;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!body.length) return res.status(400).json({ error: 'empty body' });
    const updated = fs.existsSync(target.abs);
    fs.mkdirSync(path.dirname(target.abs), { recursive: true });
    writeFileAtomic(target.abs, body);
    // First identified upload of a path claims ownership at the configured
    // default visibility; an existing entry is never re-stamped.
    const identity = identityFor(req);
    let visibility = 'everyone';
    {
      const perms = readPerms();
      if (identity && !perms[target.rel]) {
        perms[target.rel] = { owner: identity, visibility: DEFAULT_VISIBILITY };
        writePerms(perms);
      }
      if (perms[target.rel]) visibility = perms[target.rel].visibility;
    }
    audit(req, updated ? 'update' : 'upload', `${target.rel} ${body.length}b`);
    const doc = docPathFor(target.rel);
    recordEvent('uploaded', { doc, rel: target.rel }, {
      author: identity || undefined,
      bytes: body.length,
      updated,
    });
    res.json({ path: doc, file: target.rel, bytes: body.length, updated, visibility });
  }
);

// Deleting a file keeps its comment store: re-uploading the same path
// restores the threads.
router.delete(/^\/api\/upload\/(.+)$/, requireUploads, (req, res) => {
  const rel = decodedParam(req);
  if (rel === null) return res.status(400).json({ error: 'bad request' });
  const f = resolveFile(rel);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (!requireMutable(req, res, f.rel)) return;
  fs.unlinkSync(f.abs);
  audit(req, 'delete', f.rel);
  recordEvent('removed', f, { author: identityFor(req) || undefined });
  res.json({ ok: true, path: f.doc, file: f.rel });
});

// Validate a destination directory path (for folder renames): inside the
// root, no hidden segments — same rules as upload targets minus the file-kind
// requirement.
function resolveDirTarget(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  if (path.isAbsolute(relPath)) return null;
  const norm = path.posix.normalize(relPath.replace(/\\/g, '/'));
  if (norm.startsWith('..') || norm.includes('/../') || norm === '.') return null;
  if (norm.split('/').some((seg) => !seg || seg.startsWith('.') || seg === 'node_modules')) return null;
  const abs = path.resolve(ROOT, norm);
  if (abs === ROOT || !abs.startsWith(ROOT + path.sep)) return null;
  return { abs, rel: norm };
}

function migrateFileMeta(oldRel, newRel, archived, perms) {
  const oldComments = commentsFile(oldRel);
  if (fs.existsSync(oldComments)) {
    const data = readComments(oldRel);
    writeComments(newRel, data);
    fs.unlinkSync(oldComments);
  }
  if (archived.delete(oldRel)) archived.add(newRel);
  if (perms[oldRel]) {
    // Copy rather than move: change-feed events recorded under the old
    // filename stay filtered for non-readers, and the vacated path keeps its
    // owner (so it can't be re-claimed by someone else), same as a delete.
    perms[newRel] = perms[oldRel];
  }
}

function listSupportedFiles(absDir, relDir) {
  const out = [];
  for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) out.push(...listSupportedFiles(path.join(absDir, e.name), rel));
    else if (e.isFile() && fileKind(e.name)) out.push(rel);
  }
  return out;
}

// Rename/move a file or folder. Comment stores are keyed by relative path, so
// they migrate with the move, and the old doc path gets a tombstone so links
// shared before the rename redirect to the new location.
router.post('/api/move', requireUploads, (req, res) => {
  const { from, to } = req.body || {};
  if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) {
    return res.status(400).json({ error: 'from and to required' });
  }
  const who = identityFor(req) || undefined;
  const archived = readArchived();
  const perms = readPerms();

  const f = resolveFile(from);
  if (f) {
    if (!requireMutable(req, res, f.rel)) return;
    const target = resolveUploadTarget(to);
    if (!target) {
      return res.status(400).json({ error: 'invalid destination: must stay inside the served root, contain no hidden segments, and end in a supported extension' });
    }
    if (fs.existsSync(target.abs)) return res.status(409).json({ error: 'destination already exists' });
    fs.mkdirSync(path.dirname(target.abs), { recursive: true });
    fs.renameSync(f.abs, target.abs);
    migrateFileMeta(f.rel, target.rel, archived, perms);
    writeArchived(archived);
    writePerms(perms);
    const newDoc = docPathFor(target.rel);
    if (newDoc !== f.doc) recordMove(f.doc, newDoc);
    audit(req, 'move', `${f.rel} -> ${target.rel}`);
    recordEvent('moved', { doc: newDoc, rel: target.rel }, { from: f.doc, author: who });
    return res.json({ path: newDoc, file: target.rel, from: f.doc });
  }

  // Folder move: every descendant migrates its comment store, archive flag,
  // and tombstone.
  const src = resolveDirTarget(from);
  if (!src || !fs.existsSync(src.abs) || !fs.statSync(src.abs).isDirectory()) {
    return res.status(404).json({ error: 'not found' });
  }
  const dst = resolveDirTarget(to);
  if (!dst) {
    return res.status(400).json({ error: 'invalid destination: must stay inside the served root and contain no hidden segments' });
  }
  if (fs.existsSync(dst.abs)) return res.status(409).json({ error: 'destination already exists' });
  if ((dst.rel + '/').startsWith(src.rel + '/')) {
    return res.status(400).json({ error: 'cannot move a folder into itself' });
  }
  const oldDocs = new Map(listSupportedFiles(src.abs, src.rel).map((rel) => [rel, docPathFor(rel)]));
  // A folder move relocates every descendant, so it needs mutate rights on
  // all of them — one restricted doc owned by someone else blocks the move.
  const identity = identityFor(req);
  if ([...oldDocs.keys()].some((rel) => !canMutateRel(rel, identity, perms))) {
    return res.status(403).json({ error: 'folder contains restricted files only their owner can move' });
  }
  fs.mkdirSync(path.dirname(dst.abs), { recursive: true });
  fs.renameSync(src.abs, dst.abs);
  for (const [oldRel, oldDoc] of oldDocs) {
    const newRel = dst.rel + oldRel.slice(src.rel.length);
    migrateFileMeta(oldRel, newRel, archived, perms);
    const newDoc = docPathFor(newRel);
    if (newDoc !== oldDoc) recordMove(oldDoc, newDoc);
  }
  writeArchived(archived);
  writePerms(perms);
  audit(req, 'move', `${src.rel}/ -> ${dst.rel}/`);
  recordEvent('moved', { doc: dst.rel, rel: dst.rel }, { from: src.rel, folder: true, author: who });
  res.json({ path: dst.rel, from: src.rel, folder: true });
});

// Archive / unarchive a file. A flag, not a move — the path, shared links,
// and comments are untouched; the tree reports archived:true and the UI
// hides it behind a "Show archived" toggle.
router.post('/api/archive', requireUploads, (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (!requireMutable(req, res, f.rel)) return;
  const flag = (req.body || {}).archived;
  if (typeof flag !== 'boolean') return res.status(400).json({ error: 'archived (boolean) required' });
  const archived = readArchived();
  if (flag) archived.add(f.rel);
  else archived.delete(f.rel);
  writeArchived(archived);
  audit(req, flag ? 'archive' : 'unarchive', f.rel);
  recordEvent(flag ? 'archived' : 'unarchived', f, { author: identityFor(req) || undefined });
  res.json({ path: f.doc, file: f.rel, archived: flag });
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
  // /raw/ also serves sibling assets (css, fonts) that aren't docs and carry
  // no permissions; anything that IS a doc kind gets the same gate as the
  // rest of the API so restricted pages can't be fetched by real filename.
  if (fileKind(f.rel) && !canRead(req, f.rel)) return res.status(404).send('not found');
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
  if (!canRead(req, f.rel)) return res.status(404).send('not found');
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
  if (!f) {
    // Renamed? Follow the tombstone so links shared before a rename keep
    // working.
    const dest = readTombstones()[rel];
    if (dest && resolveFile(dest)) {
      return res.redirect(`${BASE_PATH}/v/${encodePath(dest)}${keepQuery(req)}`);
    }
    return res.status(404).send('File not found');
  }
  if (!canRead(req, f.rel)) return res.status(404).send('File not found');
  if (rel !== f.doc) return res.redirect(`${BASE_PATH}/v/${encodePath(f.doc)}${keepQuery(req)}`);
  res.type('text/html; charset=utf-8').send(pageHtml('viewer.html'));
});

// Legacy /v?path=... links redirect to the extension-free form.
router.get('/v', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f || !canRead(req, f.rel)) return res.status(404).send('File not found');
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
