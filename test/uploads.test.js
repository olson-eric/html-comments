const { test, after } = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file runs in its own process, so this file gets the writable
// configuration while server.test.js keeps asserting the read-only default.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-up-test-'));
process.env.HTML_DIR = ROOT;
process.env.UPLOADS_ENABLED = '1';
process.env.UPLOAD_MAX_BYTES = '1000';
process.env.TRUST_IDENTITY_HEADER = 'X-Test-User';
delete process.env.BASE_PATH;

fs.mkdirSync(path.join(ROOT, 'docs'));
fs.writeFileSync(path.join(ROOT, 'docs', 'spec.md'), '# Spec\n');

const { app } = require('../server.js');

test('upload API', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  await t.test('api/root reports uploads enabled and the size cap', async () => {
    const root = await (await fetch(`${base}/api/root`)).json();
    assert.strictEqual(root.uploadsEnabled, true);
    assert.strictEqual(root.uploadMaxBytes, 1000);
  });

  await t.test('PUT creates a new file (and parent dirs) and reports doc path', async () => {
    const res = await fetch(`${base}/api/upload/reviews/intro.html`, {
      method: 'PUT',
      body: '<html><body>hello</body></html>',
    });
    assert.strictEqual(res.status, 200);
    const out = await res.json();
    assert.strictEqual(out.path, 'reviews/intro');
    assert.strictEqual(out.file, 'reviews/intro.html');
    assert.strictEqual(out.updated, false);
    assert.strictEqual(fs.readFileSync(path.join(ROOT, 'reviews', 'intro.html'), 'utf8'), '<html><body>hello</body></html>');
  });

  await t.test('PUT overwrites an existing path and comments survive', async () => {
    const created = await fetch(`${base}/api/upload/docs/spec.md`, { method: 'PUT', body: '# Spec v2\n' });
    assert.strictEqual((await created.json()).updated, true);

    const comment = await fetch(`${base}/api/file/comments?path=docs/spec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anchor: { startIdx: 0, length: 4, quote: 'Spec' }, text: 'nice', author: 'rev' }),
    });
    assert.strictEqual(comment.status, 200);

    await fetch(`${base}/api/upload/docs/spec.md`, { method: 'PUT', body: '# Spec v3\n' });
    const after = await (await fetch(`${base}/api/file/comments?path=docs/spec`)).json();
    assert.strictEqual(after.comments.length, 1);
    assert.strictEqual(after.comments[0].text, 'nice');
  });

  await t.test('identity header stamps authorship, overriding the body author', async () => {
    const res = await fetch(`${base}/api/file/comments?path=docs/spec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-User': 'eric.olson@corp.com' },
      body: JSON.stringify({ anchor: { startIdx: 0, length: 4, quote: 'Spec' }, text: 'signed', author: 'spoofed' }),
    });
    const comment = await res.json();
    assert.strictEqual(comment.author, 'eric.olson@corp.com');

    const reply = await fetch(`${base}/api/file/comments/${comment.id}/replies?path=docs/spec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-User': 'eric.olson@corp.com' },
      body: JSON.stringify({ text: 're', author: 'spoofed' }),
    });
    assert.strictEqual((await reply.json()).author, 'eric.olson@corp.com');
  });

  await t.test('without the header, the body author still applies', async () => {
    const res = await fetch(`${base}/api/file/comments?path=docs/spec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anchor: { startIdx: 0, length: 4, quote: 'Spec' }, text: 'plain', author: 'bob' }),
    });
    assert.strictEqual((await res.json()).author, 'bob');
  });

  await t.test('api/root reports identity and the derived home folder slug', async () => {
    const anon = await (await fetch(`${base}/api/root`)).json();
    assert.strictEqual(anon.identity, null);
    const known = await (await fetch(`${base}/api/root`, { headers: { 'X-Test-User': 'Eric.Olson@corp.com' } })).json();
    assert.deepStrictEqual(known.identity, { user: 'Eric.Olson@corp.com', home: 'eric_olson' });
  });

  await t.test('traversal, hidden segments, and unsupported extensions are rejected', async () => {
    // Encoded traversal decodes server-side (raw ../ is normalized away by the
    // HTTP client before the request is even sent).
    for (const bad of ['..%2Fescape.html', 'docs%2F..%2F..%2Fescape.html', '.html-comments/x.html', 'docs/.hidden/x.html', 'docs/evil.sh', 'docs/plain.txt']) {
      const res = await fetch(`${base}/api/upload/${bad}`, { method: 'PUT', body: 'x' });
      assert.strictEqual(res.status, 400, `expected 400 for ${bad}`);
    }
    assert.strictEqual(fs.existsSync(path.join(path.dirname(ROOT), 'escape.html')), false);
  });

  await t.test('oversize uploads are rejected with 413', async () => {
    const res = await fetch(`${base}/api/upload/big.html`, { method: 'PUT', body: 'x'.repeat(2000) });
    assert.strictEqual(res.status, 413);
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'big.html')), false);
  });

  await t.test('empty body is rejected', async () => {
    const res = await fetch(`${base}/api/upload/empty.html`, { method: 'PUT' });
    assert.strictEqual(res.status, 400);
  });

  await t.test('DELETE removes the file but keeps its comment store', async () => {
    await fetch(`${base}/api/upload/docs/gone.md`, { method: 'PUT', body: '# Gone\n' });
    await fetch(`${base}/api/file/comments?path=docs/gone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anchor: { startIdx: 0, length: 4, quote: 'Gone' }, text: 'bye', author: 'rev' }),
    });
    const del = await fetch(`${base}/api/upload/docs/gone`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'docs', 'gone.md')), false);

    // Re-upload restores the threads.
    await fetch(`${base}/api/upload/docs/gone.md`, { method: 'PUT', body: '# Gone again\n' });
    const back = await (await fetch(`${base}/api/file/comments?path=docs/gone`)).json();
    assert.strictEqual(back.comments.length, 1);
  });
});

test('change feed', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const t0 = (await (await fetch(`${base}/api/updates`)).json()).now;
  await sleep(5);

  await fetch(`${base}/api/upload/feed/doc.md`, { method: 'PUT', body: '# Feed\n', headers: { 'X-Test-User': 'eric@corp.com' } });
  const created = await (await fetch(`${base}/api/file/comments?path=feed/doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anchor: { startIdx: 0, length: 4, quote: 'Feed' }, text: 'hi', author: 'rev' }),
  })).json();
  await fetch(`${base}/api/file/comments/${created.id}/replies?path=feed/doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 're', author: 'rev2' }),
  });
  await fetch(`${base}/api/file/comments/${created.id}?path=feed/doc`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolved: true }),
  });
  await fetch(`${base}/api/file/comments/${created.id}?path=feed/doc`, { method: 'DELETE' });
  await fetch(`${base}/api/upload/feed/doc`, { method: 'DELETE' });

  const { events, now } = await (await fetch(`${base}/api/updates?since=${encodeURIComponent(t0)}`)).json();
  const kinds = events.filter((e) => e.path === 'feed/doc').map((e) => e.kind);
  assert.deepStrictEqual(kinds, ['uploaded', 'created', 'replied', 'resolved', 'deleted', 'removed']);
  const uploaded = events.find((e) => e.kind === 'uploaded' && e.path === 'feed/doc');
  assert.strictEqual(uploaded.author, 'eric@corp.com');
  assert.strictEqual(uploaded.file, 'feed/doc.md');
  const replied = events.find((e) => e.kind === 'replied');
  assert.strictEqual(replied.commentId, created.id);
  assert.strictEqual(replied.author, 'rev2');

  // Polling with the returned `now` sees nothing new.
  await sleep(5);
  const again = await (await fetch(`${base}/api/updates?since=${encodeURIComponent(now)}`)).json();
  assert.deepStrictEqual(again.events, []);
});

test('uploads work under BASE_PATH', async (t) => {
  const port = 40000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), ROOT], {
    env: { ...process.env, BASE_PATH: '/reviews', PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;

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
  assert.strictEqual(root.uploadsEnabled, true);

  const res = await fetch(`${base}/reviews/api/upload/prefixed.html`, { method: 'PUT', body: '<html>p</html>' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).path, 'prefixed');
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'prefixed.html')), true);
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
