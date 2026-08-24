const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The server reads its configuration at require time, so the fixture tree has
// to exist before server.js is loaded.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-test-'));
process.env.HTML_DIR = ROOT;
delete process.env.BASE_PATH;

fs.mkdirSync(path.join(ROOT, 'docs'));
fs.mkdirSync(path.join(ROOT, 'shots'));
fs.writeFileSync(path.join(ROOT, 'docs', 'spec.html'), '<html><head><title>The Spec</title></head><body>hello spec</body></html>');
fs.writeFileSync(path.join(ROOT, 'docs', 'spec.md'), '# Spec (markdown twin)\n');
fs.writeFileSync(path.join(ROOT, 'notes.md'), '# Notes\n\nsome notes\n');
fs.writeFileSync(path.join(ROOT, 'data.json'), '{"message":"<select this>"}\n');
fs.writeFileSync(path.join(ROOT, 'events.jsonl'), '{"id":1}\n{"id":2}\n');
// 1x1 transparent PNG
fs.writeFileSync(
  path.join(ROOT, 'shots', 'screen.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
);
// A file whose extension-free base collides with a real sibling file.
fs.writeFileSync(path.join(ROOT, 'a.md'), '# a\n');
fs.writeFileSync(path.join(ROOT, 'a.md.html'), '<html><body>a.md.html</body></html>');

const { app, resolveFile, docPathFor } = require('../server.js');

test('resolveFile resolves extension-free doc paths by priority', () => {
  const f = resolveFile('docs/spec');
  assert.strictEqual(f.rel, 'docs/spec.html');
  assert.strictEqual(f.doc, 'docs/spec');
  assert.strictEqual(f.kind, 'html');
});

test('resolveFile still accepts real paths; shadowed twin keeps its extension', () => {
  const html = resolveFile('docs/spec.html');
  assert.strictEqual(html.rel, 'docs/spec.html');
  assert.strictEqual(html.doc, 'docs/spec');
  const md = resolveFile('docs/spec.md');
  assert.strictEqual(md.rel, 'docs/spec.md');
  assert.strictEqual(md.doc, 'docs/spec.md');
});

test('resolveFile handles markdown, JSON, JSONL, and images without extension', () => {
  assert.strictEqual(resolveFile('notes').rel, 'notes.md');
  assert.strictEqual(resolveFile('notes').doc, 'notes');
  assert.strictEqual(resolveFile('data').kind, 'json');
  assert.strictEqual(resolveFile('data').rel, 'data.json');
  assert.strictEqual(resolveFile('events').kind, 'json');
  assert.strictEqual(resolveFile('events').rel, 'events.jsonl');
  const img = resolveFile('shots/screen');
  assert.strictEqual(img.rel, 'shots/screen.png');
  assert.strictEqual(img.kind, 'image');
});

test('resolveFile rejects traversal and absolute paths', () => {
  assert.strictEqual(resolveFile('../secret.html'), null);
  assert.strictEqual(resolveFile('docs/../../secret.html'), null);
  assert.strictEqual(resolveFile('/etc/passwd'), null);
});

test('docPathFor keeps the full name when the bare base is a real file', () => {
  assert.strictEqual(docPathFor('a.md.html'), 'a.md.html');
  assert.strictEqual(docPathFor('a.md'), 'a');
});

test('HTTP routes', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  await t.test('health endpoint responds at the root', async () => {
    const res = await fetch(`${base}/health`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
  });

  await t.test('tree exposes extension-free path plus real file name', async () => {
    const tree = await (await fetch(`${base}/api/tree`)).json();
    const notes = tree.children.find((c) => c.name === 'notes.md');
    assert.strictEqual(notes.path, 'notes');
    assert.strictEqual(notes.file, 'notes.md');
    const docs = tree.children.find((c) => c.name === 'docs');
    const paths = docs.children.map((c) => c.path).sort();
    assert.deepStrictEqual(paths, ['docs/spec', 'docs/spec.md']);
  });

  await t.test('api/file accepts both forms and reports doc path + real file', async () => {
    const byDoc = await (await fetch(`${base}/api/file?path=docs/spec`)).json();
    assert.strictEqual(byDoc.path, 'docs/spec');
    assert.strictEqual(byDoc.file, 'docs/spec.html');
    assert.strictEqual(byDoc.title, 'The Spec');
    const byFile = await (await fetch(`${base}/api/file?path=docs/spec.html`)).json();
    assert.strictEqual(byFile.path, 'docs/spec');
  });

  await t.test('raw export downloads the original file with its real name', async () => {
    const res = await fetch(`${base}/raw/docs/spec.html?download=1`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="spec\.html"$/);
    assert.match(await res.text(), /hello spec/);
  });

  await t.test('viewer serves at /v/<doc-path> and canonicalizes', async () => {
    const ok = await fetch(`${base}/v/docs/spec`);
    assert.strictEqual(ok.status, 200);
    assert.match(await ok.text(), /<base href="\/" \/>/);

    const redir = await fetch(`${base}/v/docs/spec.html`, { redirect: 'manual' });
    assert.strictEqual(redir.status, 302);
    assert.strictEqual(redir.headers.get('location'), '/v/docs/spec');

    const missing = await fetch(`${base}/v/docs/nope`);
    assert.strictEqual(missing.status, 404);
  });

  await t.test('legacy /v?path= links redirect and keep other params', async () => {
    const res = await fetch(`${base}/v?path=docs%2Fspec.html&for=alice`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/v/docs/spec?for=alice');
  });

  await t.test('comments are shared between both addressing forms', async () => {
    const created = await fetch(`${base}/api/file/comments?path=notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anchor: { startIdx: 0, length: 5, quote: 'Notes' }, text: 'hi', author: 'test' }),
    });
    assert.strictEqual(created.status, 200);
    const byFile = await (await fetch(`${base}/api/file/comments?path=notes.md`)).json();
    assert.strictEqual(byFile.comments.length, 1);
    assert.strictEqual(byFile.path, 'notes');
    assert.strictEqual(byFile.file, 'notes.md');
  });

  await t.test('agent discovery is flat, filtered, counted, and bounded', async () => {
    const inbox = await (await fetch(`${base}/api/documents`)).json();
    assert.strictEqual(inbox.status, 'open');
    assert.strictEqual(inbox.count, 1);
    assert.strictEqual(inbox.documents[0].path, 'notes');

    const home = await (await fetch(`${base}/api/agent/home`)).json();
    assert.strictEqual(home.counts.needingReview, 1);
    assert.strictEqual(home.documents[0].openCount, 1);

    const empty = await (await fetch(`${base}/api/documents?status=open&limit=1`)).json();
    assert.strictEqual(empty.truncated, false);
    assert.strictEqual((await fetch(`${base}/api/documents?status=bogus`)).status, 400);
  });

  await t.test('complete atomically replies and resolves a comment', async () => {
    const comments = await (await fetch(`${base}/api/file/comments?path=notes&status=open`)).json();
    const completed = await fetch(`${base}/api/file/comments/${comments.comments[0].id}/complete?path=notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Applied the requested change', author: 'agent' }),
    });
    assert.strictEqual(completed.status, 200);
    const result = await completed.json();
    assert.strictEqual(result.comment.resolved, true);
    assert.strictEqual(result.comment.replies[0].text, 'Applied the requested change');

    const inbox = await (await fetch(`${base}/api/documents`)).json();
    assert.strictEqual(inbox.count, 0);
  });

  await t.test('uploads are disabled by default: mutations 403 and nothing is written', async () => {
    const put = await fetch(`${base}/api/upload/newdoc.html`, { method: 'PUT', body: '<html>x</html>' });
    assert.strictEqual(put.status, 403);
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'newdoc.html')), false);
    const del = await fetch(`${base}/api/upload/notes.md`, { method: 'DELETE' });
    assert.strictEqual(del.status, 403);
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'notes.md')), true);
    const root = await (await fetch(`${base}/api/root`)).json();
    assert.strictEqual(root.uploadsEnabled, false);
  });

  await t.test('render works for extension-free markdown paths', async () => {
    const res = await fetch(`${base}/render/notes`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /some notes/);
  });

  await t.test('JSON and JSONL render as selectable escaped source', async () => {
    const json = await fetch(`${base}/render/data`);
    assert.strictEqual(json.status, 200);
    assert.match(json.headers.get('content-type'), /^text\/html/);
    const jsonHtml = await json.text();
    assert.match(jsonHtml, /<pre>\{&quot;message&quot;:&quot;&lt;select this&gt;&quot;\}\n<\/pre>/);
    assert.doesNotMatch(jsonHtml, /<select this>/);

    const jsonl = await fetch(`${base}/render/events.jsonl`);
    assert.strictEqual(jsonl.status, 200);
    assert.match(await jsonl.text(), /<pre>\{&quot;id&quot;:1\}\n\{&quot;id&quot;:2\}\n<\/pre>/);

    const meta = await (await fetch(`${base}/api/file?path=events`)).json();
    assert.strictEqual(meta.kind, 'json');
    assert.strictEqual(meta.path, 'events');
  });
});

test('BASE_PATH mounts the whole app under a prefix', async (t) => {
  const port = 40000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), ROOT], {
    env: { ...process.env, BASE_PATH: '/reviews', PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;

  // Wait for the child to start listening.
  let root;
  for (let i = 0; i < 50; i++) {
    try {
      root = await (await fetch(`${base}/reviews/api/root`)).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(root, 'server did not start');
  assert.strictEqual(root.basePath, '/reviews');

  const viewer = await fetch(`${base}/reviews/v/docs/spec`);
  assert.strictEqual(viewer.status, 200);
  assert.match(await viewer.text(), /<base href="\/reviews\/" \/>/);

  const redir = await fetch(`${base}/reviews/v/docs/spec.html`, { redirect: 'manual' });
  assert.strictEqual(redir.headers.get('location'), '/reviews/v/docs/spec');

  const home = await fetch(`${base}/`, { redirect: 'manual' });
  assert.strictEqual(home.status, 302);
  assert.strictEqual(home.headers.get('location'), '/reviews/');

  const md = await fetch(`${base}/reviews/render/notes`);
  assert.match(await md.text(), /<base href="\/reviews\/raw\/">/);

  // Health must stay reachable at the root (what container healthchecks and
  // k8s probes hit), and also exist under the prefix.
  const health = await fetch(`${base}/health`);
  assert.strictEqual(health.status, 200);
  assert.deepStrictEqual(await health.json(), { ok: true });
  const prefixedHealth = await fetch(`${base}/reviews/health`);
  assert.strictEqual(prefixedHealth.status, 200);
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
