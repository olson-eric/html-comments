const { test, after } = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file runs in its own process; this one exercises sharing with a
// trusted identity header configured (the auth-sidecar deployment shape).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-perm-test-'));
process.env.HTML_DIR = ROOT;
process.env.UPLOADS_ENABLED = '1';
process.env.TRUST_IDENTITY_HEADER = 'X-Test-User';
delete process.env.DEFAULT_VISIBILITY; // exercise the default: private
delete process.env.BASE_PATH;
delete process.env.UPLOAD_MAX_BYTES;

fs.mkdirSync(path.join(ROOT, 'docs'));
fs.writeFileSync(path.join(ROOT, 'docs', 'open.md'), '# Open doc\n');

const { app } = require('../server.js');

const CEO = 'ceo@corp.com';
const CFO = 'cfo@corp.com';
const EVE = 'eve@corp.com';

test('sharing permissions', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const as = (user) => (user ? { 'X-Test-User': user } : {});
  const get = (url, user) => fetch(`${base}${url}`, { headers: as(user) });
  const send = (method, url, user, body) =>
    fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...as(user) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const put = (url, user, body) => send('PUT', url, user, body);
  const setVis = (docPath, user, body) => put(`/api/file/permissions?path=${encodeURIComponent(docPath)}`, user, body);

  await t.test('unclaimed files (pre-existing or anonymous uploads) default to everyone', async () => {
    const res = await get('/api/file/permissions?path=docs/open');
    assert.strictEqual(res.status, 200);
    const p = await res.json();
    assert.strictEqual(p.visibility, 'everyone');
    assert.strictEqual(p.owner, null);
    const meta = await (await get('/api/file?path=docs/open')).json();
    assert.strictEqual(meta.visibility, 'everyone');

    // Anonymous uploads have no owner to be private to.
    await fetch(`${base}/api/upload/docs/anon.md`, { method: 'PUT', body: '# Anon\n' });
    const anonP = await (await get('/api/file/permissions?path=docs/anon')).json();
    assert.strictEqual(anonP.visibility, 'everyone');
    assert.strictEqual(anonP.owner, null);
  });

  await t.test('identified uploads default to private and stamp ownership', async () => {
    const res = await fetch(`${base}/api/upload/ceo/board.md`, { method: 'PUT', body: '# Board plan\n', headers: as(CEO) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).visibility, 'private');
    const p = await (await get('/api/file/permissions?path=ceo/board', CEO)).json();
    assert.strictEqual(p.owner, CEO);
    assert.strictEqual(p.visibility, 'private');
    // Immediately invisible to others, and owner-only for overwrites — so a
    // second uploader can neither see it nor re-stamp ownership.
    assert.strictEqual((await get('/api/file?path=ceo/board', EVE)).status, 404);
    const overwrite = await fetch(`${base}/api/upload/ceo/board.md`, { method: 'PUT', body: 'v2', headers: as(CFO) });
    assert.strictEqual(overwrite.status, 404);
  });

  await t.test('changing sharing requires an identity and ownership', async () => {
    // No identity: 403 even on an unclaimed doc.
    const anon = await setVis('docs/open', null, { visibility: 'private' });
    assert.strictEqual(anon.status, 403);
    // Non-readers get 404, not 403 — restricted docs don't reveal themselves.
    const invisible = await setVis('ceo/board', EVE, { visibility: 'private' });
    assert.strictEqual(invisible.status, 404);
    // Readers who aren't the owner get a real 403.
    await setVis('ceo/board', CEO, { visibility: 'everyone' });
    const other = await setVis('ceo/board', EVE, { visibility: 'private' });
    assert.strictEqual(other.status, 403);
    const bad = await setVis('ceo/board', CEO, { visibility: 'friends' });
    assert.strictEqual(bad.status, 400);
    const ok = await setVis('ceo/board', CEO, { visibility: 'private' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).visibility, 'private');
  });

  await t.test('private hides the doc from everyone but the owner, as 404s', async () => {
    for (const [url, user, status] of [
      ['/api/file?path=ceo/board', CEO, 200],
      ['/api/file?path=ceo/board', EVE, 404],
      ['/api/file?path=ceo/board', null, 404],
      ['/api/file/html?path=ceo/board', EVE, 404],
      ['/api/file/comments?path=ceo/board', EVE, 404],
      ['/v/ceo/board', EVE, 404],
      ['/render/ceo/board', EVE, 404],
      ['/raw/ceo/board.md', EVE, 404],
      ['/raw/ceo/board.md', CEO, 200],
    ]) {
      const res = await get(url, user);
      assert.strictEqual(res.status, status, `${url} as ${user || 'anon'}`);
    }
  });

  await t.test('the tree only lists docs the requester can read, and marks restricted ones', async () => {
    const anonTree = await (await get('/api/tree')).json();
    assert.strictEqual(anonTree.children.find((c) => c.name === 'ceo'), undefined);
    const ceoTree = await (await get('/api/tree', CEO)).json();
    const board = ceoTree.children.find((c) => c.name === 'ceo').children[0];
    assert.strictEqual(board.visibility, 'private');
    assert.strictEqual(ceoTree.children.find((c) => c.name === 'docs').children[0].visibility, undefined);
  });

  await t.test('shared-with grants read + comment to listed people (case-insensitive)', async () => {
    await setVis('ceo/board', CEO, { visibility: 'shared', sharedWith: ['CFO@Corp.com'] });
    assert.strictEqual((await get('/api/file?path=ceo/board', CFO)).status, 200);
    assert.strictEqual((await get('/api/file?path=ceo/board', EVE)).status, 404);

    const comment = await send('POST', '/api/file/comments?path=ceo/board', CFO, {
      anchor: { startIdx: 0, length: 5, quote: 'Board' },
      text: 'numbers look off',
    });
    assert.strictEqual(comment.status, 200);
    assert.strictEqual((await comment.json()).author, CFO);
  });

  await t.test('review batches are delivered only to the identity that queued them', async () => {
    const queued = await send('POST', '/api/agent/queue?path=ceo/board', CFO);
    assert.strictEqual(queued.status, 200);

    const ceoPoll = await get('/api/agent/poll?timeout=1', CEO);
    assert.strictEqual(ceoPoll.status, 204);

    const cfoPoll = await get('/api/agent/poll?timeout=1', CFO);
    assert.strictEqual(cfoPoll.status, 200);
    assert.strictEqual((await cfoPoll.json()).job.requestedBy, CFO);
  });

  await t.test('restricted docs are owner-only for file mutations', async () => {
    const overwrite = await fetch(`${base}/api/upload/ceo/board.md`, { method: 'PUT', body: 'x', headers: as(CFO) });
    assert.strictEqual(overwrite.status, 403);
    const del = await fetch(`${base}/api/upload/ceo/board`, { method: 'DELETE', headers: as(CFO) });
    assert.strictEqual(del.status, 403);
    const archive = await send('POST', '/api/archive?path=ceo/board', CFO, { archived: true });
    assert.strictEqual(archive.status, 403);
    const move = await send('POST', '/api/move', EVE, { from: 'ceo/board', to: 'ceo/stolen.md' });
    // EVE can't even see it, so the failure reads as not-found, not forbidden.
    assert.strictEqual(move.status, 404);
    const ownerOverwrite = await fetch(`${base}/api/upload/ceo/board.md`, { method: 'PUT', body: '# Board v3\n', headers: as(CEO) });
    assert.strictEqual(ownerOverwrite.status, 200);
  });

  await t.test('folder moves are blocked when they contain someone else\'s restricted doc', async () => {
    const res = await send('POST', '/api/move', CFO, { from: 'ceo', to: 'archive-of-ceo' });
    assert.strictEqual(res.status, 403);
  });

  await t.test('permissions migrate with a rename', async () => {
    const res = await send('POST', '/api/move', CEO, { from: 'ceo/board', to: 'ceo/plan.md' });
    assert.strictEqual(res.status, 200);
    const p = await (await get('/api/file/permissions?path=ceo/plan', CEO)).json();
    assert.strictEqual(p.visibility, 'shared');
    assert.deepStrictEqual(p.sharedWith, ['cfo@corp.com']);
    assert.strictEqual((await get('/api/file?path=ceo/plan', EVE)).status, 404);
  });

  await t.test('the change feed hides events on docs the requester cannot read', async () => {
    const anonEvents = (await (await get('/api/updates')).json()).events;
    assert.strictEqual(anonEvents.some((e) => e.file && e.file.startsWith('ceo/')), false);
    const ceoEvents = (await (await get('/api/updates', CEO)).json()).events;
    assert.strictEqual(ceoEvents.some((e) => e.file && e.file.startsWith('ceo/')), true);
    const cfoEvents = (await (await get('/api/updates', CFO)).json()).events;
    assert.strictEqual(cfoEvents.some((e) => e.file === 'ceo/plan.md'), true);
  });

  await t.test('setting back to everyone restores access but keeps ownership', async () => {
    await setVis('ceo/plan', CEO, { visibility: 'everyone' });
    assert.strictEqual((await get('/api/file?path=ceo/plan', EVE)).status, 200);
    assert.strictEqual((await get('/v/ceo/plan')).status, 200);
    // Ownership survives, so nobody else can restrict it out from under CEO.
    const grab = await setVis('ceo/plan', EVE, { visibility: 'private' });
    assert.strictEqual(grab.status, 403);
  });

  await t.test('permissions survive delete + re-upload, like comment stores', async () => {
    await setVis('ceo/plan', CEO, { visibility: 'private' });
    await fetch(`${base}/api/upload/ceo/plan`, { method: 'DELETE', headers: as(CEO) });
    // The path stays owner-only even while the file is gone.
    const squat = await fetch(`${base}/api/upload/ceo/plan.md`, { method: 'PUT', body: 'mine now', headers: as(EVE) });
    assert.strictEqual(squat.status, 404);
    const restore = await fetch(`${base}/api/upload/ceo/plan.md`, { method: 'PUT', body: '# Back\n', headers: as(CEO) });
    assert.strictEqual(restore.status, 200);
    const p = await (await get('/api/file/permissions?path=ceo/plan', CEO)).json();
    assert.strictEqual(p.visibility, 'private');
    assert.strictEqual(p.owner, CEO);
  });
});

test('the comment store (incl. permissions.json) is unreachable over HTTP', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  // Default in-content store: blocked by the hidden-segment rules.
  assert.strictEqual((await fetch(`${base}/raw/.html-comments/permissions.json`)).status, 404);
  const put = await fetch(`${base}/api/upload/.html-comments/evil.html`, { method: 'PUT', body: 'x' });
  assert.strictEqual(put.status, 400);
});

test('a non-hidden COMMENTS_DIR inside the root is still unreachable over HTTP', async (t) => {
  const ROOT2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-permdir-test-'));
  fs.writeFileSync(path.join(ROOT2, 'doc.md'), '# Doc\n');
  const STORE = path.join(ROOT2, 'comment-data');
  fs.mkdirSync(STORE);
  fs.writeFileSync(path.join(STORE, 'permissions.json'), JSON.stringify({ files: { 'doc.md': { owner: 'ceo@corp.com', visibility: 'private' } } }));
  // Bait: a supported file kind inside the store must not resolve either.
  fs.writeFileSync(path.join(STORE, 'bait.html'), '<html>secret</html>');

  const port = 41000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), ROOT2], {
    env: {
      ...process.env,
      COMMENTS_DIR: STORE,
      PORT: String(port),
      HOST: '127.0.0.1',
      UPLOADS_ENABLED: '1',
      TRUST_IDENTITY_HEADER: 'X-Test-User',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill();
    fs.rmSync(ROOT2, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      up = (await fetch(`${base}/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(up, 'server did not start');

  // The store entry is live (doc.md is private to CEO)…
  assert.strictEqual((await fetch(`${base}/api/file?path=doc`)).status, 404);
  assert.strictEqual((await fetch(`${base}/api/file?path=doc`, { headers: { 'X-Test-User': 'ceo@corp.com' } })).status, 200);

  // …but the store itself can't be read, written into, listed, or moved.
  assert.strictEqual((await fetch(`${base}/raw/comment-data/permissions.json`)).status, 404);
  assert.strictEqual((await fetch(`${base}/raw/comment-data/bait.html`)).status, 404);
  assert.strictEqual((await fetch(`${base}/api/file?path=comment-data/bait`, { headers: { 'X-Test-User': 'ceo@corp.com' } })).status, 404);
  const put = await fetch(`${base}/api/upload/comment-data/evil.html`, { method: 'PUT', body: 'x', headers: { 'X-Test-User': 'ceo@corp.com' } });
  assert.strictEqual(put.status, 400);
  const move = await fetch(`${base}/api/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-User': 'ceo@corp.com' },
    body: JSON.stringify({ from: 'comment-data', to: 'stolen' }),
  });
  assert.strictEqual(move.status, 404);
  const tree = await (await fetch(`${base}/api/tree`, { headers: { 'X-Test-User': 'ceo@corp.com' } })).json();
  assert.strictEqual(tree.children.find((c) => c.name === 'comment-data'), undefined);
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
