#!/usr/bin/env node
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`html-comments — render HTML files with inline comments

Usage:
  html-comments [<html-dir>]

Options:
  <html-dir>            Directory of .html files to serve (default: ./html)

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

function resolveFile(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  if (path.isAbsolute(relPath)) return null;
  const norm = path.posix.normalize(relPath.replace(/\\/g, '/'));
  if (norm.startsWith('..') || norm.includes('/../')) return null;
  const abs = path.resolve(ROOT, norm);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  if (!/\.html?$/i.test(abs)) return null;
  return { abs, rel: norm };
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
    } else if (e.isFile() && /\.html?$/i.test(e.name)) {
      const data = readComments(childRel);
      const open = data.comments.filter((c) => !c.resolved).length;
      children.push({
        name: e.name,
        path: childRel,
        type: 'file',
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

app.get('/api/root', (_req, res) => {
  res.json({ root: ROOT, name: path.basename(ROOT) });
});

app.get('/api/tree', (_req, res) => {
  res.json(buildTree(ROOT));
});

app.get('/api/file', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  const html = fs.readFileSync(f.abs, 'utf8');
  const stat = fs.statSync(f.abs);
  const data = readComments(f.rel);
  res.json({
    path: f.rel,
    name: path.basename(f.abs),
    title: extractTitle(html) || path.basename(f.abs),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    comments: data.comments,
  });
});

app.get('/api/file/html', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).send('not found');
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

app.post('/api/file/comments', (req, res) => {
  const f = resolveFile(req.query.path);
  if (!f) return res.status(404).json({ error: 'not found' });
  const { anchor, text, author } = req.body || {};
  if (!anchor || typeof anchor !== 'object') return res.status(400).json({ error: 'anchor required' });
  if (typeof anchor.startIdx !== 'number' || typeof anchor.length !== 'number') {
    return res.status(400).json({ error: 'anchor must have startIdx and length' });
  }
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });
  const data = readComments(f.rel);
  const comment = {
    id: newId(),
    anchor: {
      startIdx: anchor.startIdx,
      length: anchor.length,
      quote: anchor.quote || '',
      contextBefore: anchor.contextBefore || '',
      contextAfter: anchor.contextAfter || '',
    },
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
