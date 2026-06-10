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

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error(`html-comments: HTML directory does not exist: ${ROOT}`);
  console.error(`Usage: html-comments [<html-dir>]   (or set HTML_DIR=...)`);
  process.exit(1);
}
fs.mkdirSync(COMMENTS_DIR, { recursive: true });

app.use(express.json({ limit: '5mb' }));

const newId = () => crypto.randomBytes(6).toString('hex');

const KIND_PATTERNS = [
  ['html', /\.html?$/i],
  ['markdown', /\.(md|markdown)$/i],
  ['image', /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i],
];

function fileKind(name) {
  for (const [kind, re] of KIND_PATTERNS) {
    if (re.test(name)) return kind;
  }
  return null;
}

function resolveFile(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  if (path.isAbsolute(relPath)) return null;
  const norm = path.posix.normalize(relPath.replace(/\\/g, '/'));
  if (norm.startsWith('..') || norm.includes('/../')) return null;
  const abs = path.resolve(ROOT, norm);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const kind = fileKind(abs);
  if (!kind) return null;
  return { abs, rel: norm, kind };
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
        path: childRel,
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

function writeComments(relPath, data) {
  fs.writeFileSync(commentsFile(relPath), JSON.stringify({ ...data, path: relPath }, null, 2));
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
    '/raw/' + (dir === '.' ? '' : dir.split('/').map(encodeURIComponent).join('/') + '/');
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

app.get('/api/root', (_req, res) => {
  res.json({ root: ROOT, name: path.basename(ROOT) });
});

app.get('/api/tree', (_req, res) => {
  res.json(buildTree(ROOT));
});

app.get('/api/file', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  const stat = fs.statSync(f.abs);
  const data = readComments(f.rel);
  res.json({
    path: f.rel,
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
app.get('/api/file/html', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).send('not found');
  if (f.kind === 'image') return res.status(400).json({ error: 'not renderable as html; fetch via /raw/' });
  if (f.kind === 'markdown') {
    return res.type('text/html; charset=utf-8').send(markdownDocument(f));
  }
  res.type('text/html; charset=utf-8').send(fs.readFileSync(f.abs, 'utf8'));
});

app.get('/api/file/comments', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  const data = readComments(f.rel);
  let comments = data.comments;
  const status = req.query.status;
  if (status === 'open') comments = comments.filter((c) => !c.resolved);
  if (status === 'resolved') comments = comments.filter((c) => c.resolved);
  res.json({ path: f.rel, comments });
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

app.post('/api/file/comments', (req, res) => {
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

app.post('/api/file/comments/:cid/replies', (req, res) => {
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

app.patch('/api/file/comments/:cid', (req, res) => {
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

app.delete('/api/file/comments/:cid', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  const data = readComments(f.rel);
  const idx = data.comments.findIndex((c) => c.id === req.params.cid);
  if (idx === -1) return res.status(404).json({ error: 'comment not found' });
  data.comments.splice(idx, 1);
  writeComments(f.rel, data);
  res.json({ ok: true });
});

app.get(/^\/raw\/(.+)$/, (req, res) => {
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
app.get(/^\/render\/(.+)$/, (req, res) => {
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

app.use(express.static(path.join(__dirname, 'public')));

app.get('/v', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).send('File not found');
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`html-comments serving ${ROOT}`);
  console.log(`→ http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
