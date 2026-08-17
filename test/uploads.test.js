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
// Signed-in uploads default to private; this file tests the upload flows
// themselves, so pin the open default (permissions.test.js covers sharing).
process.env.DEFAULT_VISIBILITY = 'everyone';
delete process.env.BASE_PATH;

fs.mkdirSync(path.join(ROOT, 'docs'));
fs.writeFileSync(path.join(ROOT, 'docs', 'spec.md'), '# Spec\n');

const { app } = require('../server.js');

test('upload API', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  await t.test('api/root reports uploads enabled, the size cap, and the visibility default', async () => {
    const root = await (await fetch(`${base}/api/root`)).json();
    assert.strictEqual(root.uploadsEnabled, true);
    assert.strictEqual(root.uploadMaxBytes, 1000);
    assert.strictEqual(root.defaultVisibility, 'everyone');
  });

  await t.test('DEFAULT_VISIBILITY=everyone keeps identified uploads open (but still owned)', async () => {
    await fetch(`${base}/api/upload/open/memo.md`, { method: 'PUT', body: '# Memo\n', headers: { 'X-Test-User': 'eric@corp.com' } });
    const p = await (await fetch(`${base}/api/file/permissions?path=open/memo`)).json();
    assert.strictEqual(p.visibility, 'everyone');
    assert.strictEqual(p.owner, 'eric@corp.com');
    // Visible to anonymous requests, like any unrestricted doc.
    assert.strictEqual((await fetch(`${base}/api/file?path=open/memo`)).status, 200);
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

  await t.test('PUT accepts JSON and JSONL and JSON comments re-anchor on update', async () => {
    const source = '{"status":"target"}\n';
    const created = await fetch(`${base}/api/upload/data/state.json`, { method: 'PUT', body: source });
    assert.strictEqual(created.status, 200);
    assert.strictEqual((await created.json()).path, 'data/state');

    const comment = await fetch(`${base}/api/file/comments?path=data/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anchor: { startIdx: source.indexOf('target'), length: 6, quote: 'target', contextBefore: '"status":"', contextAfter: '"}\n' },
        text: 'Review this value',
      }),
    });
    assert.strictEqual(comment.status, 200);

    const updatedSource = '{"version":1,"status":"target"}\n';
    assert.strictEqual((await fetch(`${base}/api/upload/data/state.json`, { method: 'PUT', body: updatedSource })).status, 200);
    const comments = await (await fetch(`${base}/api/file/comments?path=data/state`)).json();
    assert.strictEqual(comments.comments[0].anchor.startIdx, updatedSource.indexOf('target'));

    const jsonl = await fetch(`${base}/api/upload/data/events.jsonl`, { method: 'PUT', body: '{"id":1}\n{"id":2}\n' });
    assert.strictEqual(jsonl.status, 200);
    assert.strictEqual((await jsonl.json()).path, 'data/events');
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

  await t.test('republish re-anchors exact, repeated, fuzzy, and deleted text', async () => {
    const makeDoc = async (name, text) => {
      await fetch(`${base}/api/upload/anchors/${name}.html`, {
        method: 'PUT',
        body: `<html><body>${text}</body></html>`,
      });
    };
    const comment = async (name, anchor) => {
      const res = await fetch(`${base}/api/file/comments?path=anchors/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anchor, text: name, author: 'reviewer' }),
      });
      assert.strictEqual(res.status, 200);
      return res.json();
    };
    const comments = async (name) =>
      (await (await fetch(`${base}/api/file?path=anchors/${name}`)).json()).comments;

    await makeDoc('shifted', 'before target after');
    await comment('shifted', { startIdx: 7, length: 6, quote: 'target', contextBefore: 'before ', contextAfter: ' after' });
    await makeDoc('shifted', 'new prefix before target after');
    const shifted = (await comments('shifted'))[0].anchor;
    assert.equal(shifted.startIdx, 18);
    assert.equal(shifted.quote, 'target');
    assert.equal(shifted.stale, undefined);

    await fetch(`${base}/api/upload/anchors/markdown.md`, { method: 'PUT', body: '# Heading\n\nBefore target after\n' });
    await comment('markdown', { startIdx: 15, length: 6, quote: 'target', contextBefore: 'HeadingBefore ', contextAfter: ' after\n' });
    await fetch(`${base}/api/upload/anchors/markdown.md`, { method: 'PUT', body: '# Heading\n\nNew intro\n\nBefore target after\n' });
    assert.equal((await comments('markdown'))[0].anchor.startIdx, 24);

    await makeDoc('repeated', 'right target');
    await comment('repeated', { startIdx: 6, length: 6, quote: 'target', contextBefore: 'right ', contextAfter: ' tail' });
    const repeatedText = 'left target middle right target tail';
    await makeDoc('repeated', repeatedText);
    assert.equal((await comments('repeated'))[0].anchor.startIdx, repeatedText.lastIndexOf('target'));

    await makeDoc('fuzzy', 'before quick brown fox after');
    await comment('fuzzy', { startIdx: 7, length: 15, quote: 'quick brown fox', contextBefore: 'before ', contextAfter: ' after' });
    await makeDoc('fuzzy', 'prefix before quick brown cat after');
    const fuzzy = (await comments('fuzzy'))[0].anchor;
    assert.equal(fuzzy.startIdx, 14);
    assert.equal(fuzzy.length, 15);
    assert.equal(fuzzy.quote, 'quick brown fox');
    assert.equal(fuzzy.stale, undefined);

    await makeDoc('orphan', 'before doomed selection after');
    await comment('orphan', { startIdx: 7, length: 16, quote: 'doomed selection', contextBefore: 'before ', contextAfter: ' after' });
    await makeDoc('orphan', 'before replacement is unrelated after');
    const orphan = (await comments('orphan'))[0].anchor;
    assert.equal(orphan.stale, true);
    assert.match(orphan.staleSince, /^\d{4}-\d\d-\d\dT/);
    assert.equal(orphan.quote, 'doomed selection');

    await makeDoc('manual', 'old selected text');
    const manualComment = await comment('manual', { startIdx: 4, length: 8, quote: 'selected' });
    const newAnchor = { startIdx: 0, length: 3, quote: 'new', contextBefore: '', contextAfter: ' selected text' };
    const patched = await (await fetch(`${base}/api/file/comments/${manualComment.id}?path=anchors/manual`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anchor: newAnchor }),
    })).json();
    assert.deepEqual(patched.anchor, newAnchor);
    assert.equal(patched.previousAnchors.length, 1);
    assert.equal(patched.previousAnchors[0].quote, 'selected');

    const events = (await (await fetch(`${base}/api/updates`)).json()).events;
    assert.ok(events.some((e) => e.kind === 'anchors_rewritten' && e.path === 'anchors/fuzzy' && e.fuzzy === 1));
    assert.ok(events.some((e) => e.kind === 'anchors_orphaned' && e.path === 'anchors/orphan' && e.count === 1));
    assert.ok(events.some((e) => e.kind === 'reattached' && e.path === 'anchors/manual'));
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

  await t.test('deleting a comment is reversible and hides it from active views', async () => {
    const created = await (await fetch(`${base}/api/file/comments?path=docs/spec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anchor: { startIdx: 0, length: 4, quote: 'Spec' }, text: 'restore me', author: 'bob' }),
    })).json();
    const deleted = await (await fetch(`${base}/api/file/comments/${created.id}?path=docs/spec`, {
      method: 'DELETE',
    })).json();
    assert.match(deleted.comment.deletedAt, /^\d{4}-\d\d-\d\dT/);

    const active = await (await fetch(`${base}/api/file?path=docs/spec`)).json();
    assert.equal(active.comments.some((comment) => comment.id === created.id), false);
    const trash = await (await fetch(`${base}/api/file/comments?path=docs/spec&status=deleted`)).json();
    assert.equal(trash.comments.some((comment) => comment.id === created.id), true);

    const restored = await (await fetch(`${base}/api/file/comments/${created.id}?path=docs/spec`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleted: false }),
    })).json();
    assert.equal(restored.deletedAt, undefined);
    assert.equal(restored.text, 'restore me');
    const after = await (await fetch(`${base}/api/file?path=docs/spec`)).json();
    assert.equal(after.comments.some((comment) => comment.id === created.id), true);
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

test('move and archive', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  const post = (url, body) =>
    fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  await t.test('file rename migrates comments and leaves a redirecting tombstone', async () => {
    await fetch(`${base}/api/upload/mv/old.md`, { method: 'PUT', body: '# Move me\n' });
    await post('/api/file/comments?path=mv/old', { anchor: { startIdx: 0, length: 4, quote: 'Move' }, text: 'keep me', author: 'rev' });

    const res = await post('/api/move', { from: 'mv/old', to: 'mv/new.md' });
    assert.strictEqual(res.status, 200);
    const out = await res.json();
    assert.strictEqual(out.path, 'mv/new');
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'mv', 'new.md')), true);
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'mv', 'old.md')), false);

    const comments = await (await fetch(`${base}/api/file/comments?path=mv/new`)).json();
    assert.strictEqual(comments.comments.length, 1);
    assert.strictEqual(comments.comments[0].text, 'keep me');

    const redir = await fetch(`${base}/v/mv/old`, { redirect: 'manual' });
    assert.strictEqual(redir.status, 302);
    assert.strictEqual(redir.headers.get('location'), '/v/mv/new');
  });

  await t.test('rename onto an existing file is rejected', async () => {
    await fetch(`${base}/api/upload/mv/taken.md`, { method: 'PUT', body: '# Taken\n' });
    const res = await post('/api/move', { from: 'mv/new', to: 'mv/taken.md' });
    assert.strictEqual(res.status, 409);
  });

  await t.test('folder rename migrates every descendant', async () => {
    await fetch(`${base}/api/upload/team/docs/a.md`, { method: 'PUT', body: '# A\n' });
    await fetch(`${base}/api/upload/team/docs/deep/b.md`, { method: 'PUT', body: '# B\n' });
    await post('/api/file/comments?path=team/docs/a', { anchor: { startIdx: 0, length: 1, quote: 'A' }, text: 'on a', author: 'rev' });

    const res = await post('/api/move', { from: 'team/docs', to: 'team/guides' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'team', 'guides', 'deep', 'b.md')), true);

    const comments = await (await fetch(`${base}/api/file/comments?path=team/guides/a`)).json();
    assert.strictEqual(comments.comments.length, 1);

    const redir = await fetch(`${base}/v/team/docs/a`, { redirect: 'manual' });
    assert.strictEqual(redir.status, 302);
    assert.strictEqual(redir.headers.get('location'), '/v/team/guides/a');
  });

  await t.test('archive is a flag: link and comments stay, tree reports it', async () => {
    await fetch(`${base}/api/upload/arch/done.md`, { method: 'PUT', body: '# Done\n' });
    const res = await post('/api/archive?path=arch/done', { archived: true });
    assert.strictEqual(res.status, 200);

    const tree = await (await fetch(`${base}/api/tree`)).json();
    const arch = tree.children.find((c) => c.name === 'arch');
    assert.strictEqual(arch.children[0].archived, true);

    // Still viewable and commentable at the same path.
    assert.strictEqual((await fetch(`${base}/v/arch/done`)).status, 200);
    const meta = await (await fetch(`${base}/api/file?path=arch/done`)).json();
    assert.strictEqual(meta.archived, true);

    const undo = await post('/api/archive?path=arch/done', { archived: false });
    assert.strictEqual((await undo.json()).archived, false);
    const tree2 = await (await fetch(`${base}/api/tree`)).json();
    assert.strictEqual(tree2.children.find((c) => c.name === 'arch').children[0].archived, undefined);
  });

  await t.test('archive flag follows a rename', async () => {
    await fetch(`${base}/api/upload/arch/keep.md`, { method: 'PUT', body: '# Keep\n' });
    await post('/api/archive?path=arch/keep', { archived: true });
    await post('/api/move', { from: 'arch/keep', to: 'arch/kept.md' });
    const tree = await (await fetch(`${base}/api/tree`)).json();
    const arch = tree.children.find((c) => c.name === 'arch');
    const kept = arch.children.find((c) => c.name === 'kept.md');
    assert.strictEqual(kept.archived, true);
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
