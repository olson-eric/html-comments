const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data', 'pages');

fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

const newId = () => crypto.randomBytes(6).toString('hex');
const pageDir = (id) => path.join(DATA_DIR, id);
const metaPath = (id) => path.join(pageDir(id), 'meta.json');
const htmlPath = (id) => path.join(pageDir(id), 'content.html');

const pageExists = (id) => /^[a-f0-9]{6,32}$/.test(id) && fs.existsSync(metaPath(id));
const readMeta = (id) => JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
const writeMeta = (id, meta) => fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));

function createPage({ html, title }) {
  const id = newId();
  fs.mkdirSync(pageDir(id), { recursive: true });
  fs.writeFileSync(htmlPath(id), html);
  writeMeta(id, {
    id,
    title: title || extractTitle(html) || 'Untitled',
    createdAt: new Date().toISOString(),
    comments: [],
  });
  return id;
}

function extractTitle(html) {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return m ? m[1].trim() : null;
}

app.post('/api/pages', upload.single('file'), (req, res) => {
  let html = req.body && req.body.html;
  const title = req.body && req.body.title;
  if (!html && req.file) html = req.file.buffer.toString('utf8');
  if (!html) return res.status(400).json({ error: 'html (string) or file upload required' });
  const id = createPage({ html, title });
  res.json({ id, viewerUrl: `/p/${id}` });
});

app.get('/api/pages', (req, res) => {
  const ids = fs.readdirSync(DATA_DIR).filter((id) => pageExists(id));
  const pages = ids
    .map((id) => {
      const m = readMeta(id);
      return {
        id: m.id,
        title: m.title,
        createdAt: m.createdAt,
        commentCount: m.comments.length,
        openCount: m.comments.filter((c) => !c.resolved).length,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ pages });
});

app.get('/api/pages/:id', (req, res) => {
  if (!pageExists(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json(readMeta(req.params.id));
});

app.delete('/api/pages/:id', (req, res) => {
  if (!pageExists(req.params.id)) return res.status(404).json({ error: 'not found' });
  fs.rmSync(pageDir(req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});

app.get('/api/pages/:id/html', (req, res) => {
  if (!pageExists(req.params.id)) return res.status(404).send('not found');
  res.type('text/html; charset=utf-8').send(fs.readFileSync(htmlPath(req.params.id), 'utf8'));
});

app.get('/api/pages/:id/comments', (req, res) => {
  if (!pageExists(req.params.id)) return res.status(404).json({ error: 'not found' });
  const meta = readMeta(req.params.id);
  const status = req.query.status;
  let comments = meta.comments;
  if (status === 'open') comments = comments.filter((c) => !c.resolved);
  if (status === 'resolved') comments = comments.filter((c) => c.resolved);
  res.json({ comments });
});

app.post('/api/pages/:id/comments', (req, res) => {
  if (!pageExists(req.params.id)) return res.status(404).json({ error: 'not found' });
  const { anchor, text, author } = req.body || {};
  if (!anchor || typeof anchor !== 'object') return res.status(400).json({ error: 'anchor required' });
  if (typeof anchor.startIdx !== 'number' || typeof anchor.length !== 'number') {
    return res.status(400).json({ error: 'anchor must have startIdx and length' });
  }
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });
  const meta = readMeta(req.params.id);
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
  meta.comments.push(comment);
  writeMeta(req.params.id, meta);
  res.json(comment);
});

app.post('/api/pages/:id/comments/:cid/replies', (req, res) => {
  if (!pageExists(req.params.id)) return res.status(404).json({ error: 'not found' });
  const { text, author } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  const meta = readMeta(req.params.id);
  const comment = meta.comments.find((c) => c.id === req.params.cid);
  if (!comment) return res.status(404).json({ error: 'comment not found' });
  const reply = {
    id: newId(),
    text,
    author: (author || 'Anonymous').toString().slice(0, 80),
    createdAt: new Date().toISOString(),
  };
  comment.replies.push(reply);
  writeMeta(req.params.id, meta);
  res.json(reply);
});

app.patch('/api/pages/:id/comments/:cid', (req, res) => {
  if (!pageExists(req.params.id)) return res.status(404).json({ error: 'not found' });
  const meta = readMeta(req.params.id);
  const comment = meta.comments.find((c) => c.id === req.params.cid);
  if (!comment) return res.status(404).json({ error: 'comment not found' });
  if (typeof req.body.resolved === 'boolean') comment.resolved = req.body.resolved;
  if (typeof req.body.text === 'string') comment.text = req.body.text;
  writeMeta(req.params.id, meta);
  res.json(comment);
});

app.delete('/api/pages/:id/comments/:cid', (req, res) => {
  if (!pageExists(req.params.id)) return res.status(404).json({ error: 'not found' });
  const meta = readMeta(req.params.id);
  const idx = meta.comments.findIndex((c) => c.id === req.params.cid);
  if (idx === -1) return res.status(404).json({ error: 'comment not found' });
  meta.comments.splice(idx, 1);
  writeMeta(req.params.id, meta);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/p/:id', (req, res) => {
  if (!pageExists(req.params.id)) return res.status(404).send('Page not found');
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`html-comments listening on http://${HOST}:${PORT}`);
});
