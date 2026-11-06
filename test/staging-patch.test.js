const { test } = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// COMMENT_TEXT_EDITS=off (with the identity flag, as staging runs it): a
// comment PATCH is exactly one of resolve/reopen, restore or reattach.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-patch-test-'));
const COMMENTS = path.join(ROOT, '.html-comments');
process.env.HTML_DIR = ROOT;
process.env.TRUST_IDENTITY_HEADER = 'X-Akasa-Email';
process.env.REQUIRE_IDENTITY = '1';
process.env.COMMENT_TEXT_EDITS = 'off';
delete process.env.LOG_MODE;
delete process.env.BASE_PATH;
delete process.env.COMMENTS_DIR;
delete process.env.UPLOADS_ENABLED;

fs.mkdirSync(path.join(ROOT, 'docs'));
fs.writeFileSync(path.join(ROOT, 'docs', 'review.md'), '# Review\n\nalpha beta gamma\n');

const { app } = require('../server.js');

const EXPERT = 'expert.reviewer@example.com';
const ANCHOR = { startIdx: 0, length: 5, quote: 'alpha', contextBefore: '', contextAfter: ' beta' };
const NEW_ANCHOR = { startIdx: 6, length: 4, quote: 'beta', contextBefore: 'alpha ', contextAfter: ' gamma' };

// The whole comment store, byte for byte: comment records and the event log.
function store() {
  const out = {};
  for (const name of fs.readdirSync(COMMENTS).sort()) {
    out[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(COMMENTS, name))).digest('hex');
  }
  return out;
}

test('COMMENT_TEXT_EDITS=off', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const send = (method, url, body, raw) =>
    fetch(`${base}${url}`, {
      method,
      headers: { 'X-Akasa-Email': EXPERT, ...(body === undefined && !raw ? {} : { 'Content-Type': 'application/json' }) },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
  const patch = (cid, body, raw) => send('PATCH', `/api/file/comments/${cid}?path=docs/review`, body, raw);
  // Straight from the store, so soft-deleted comments are included.
  const comments = async () => {
    const file = fs.readdirSync(COMMENTS).find((n) => n.endsWith('.json') && n.length === 45);
    return JSON.parse(fs.readFileSync(path.join(COMMENTS, file), 'utf8')).comments;
  };
  const events = async () => (await (await send('GET', '/api/updates')).json()).events;

  const live = await (await send('POST', '/api/file/comments?path=docs/review', { anchor: ANCHOR, text: 'original text' })).json();
  const removed = await (await send('POST', '/api/file/comments?path=docs/review', { anchor: ANCHOR, text: 'to delete' })).json();
  assert.strictEqual((await send('DELETE', `/api/file/comments/${removed.id}?path=docs/review`)).status, 200);

  const rejected = [
    ['text alone', { text: 'edited' }, 403, 'text_edits_disabled'],
    ['text plus resolved', { text: 'edited', resolved: true }, 403, 'text_edits_disabled'],
    ['text plus restore', { text: 'edited', deleted: false }, 403, 'text_edits_disabled'],
    ['text plus reattach', { text: 'edited', anchor: NEW_ANCHOR }, 403, 'text_edits_disabled'],
    ['a null text', { text: null }, 403, 'text_edits_disabled'],
    ['anchor plus restore', { anchor: NEW_ANCHOR, deleted: false }, 400, 'patch_shape'],
    ['resolved plus reattach', { resolved: true, anchor: NEW_ANCHOR }, 400, 'patch_shape'],
    ['resolved plus restore', { resolved: false, deleted: false }, 400, 'patch_shape'],
    ['an unknown key', { color: 'red' }, 400, 'patch_shape'],
    ['an unknown key named like a field', { author: 'someone' }, 400, 'patch_shape'],
    ['an empty body', {}, 400, 'patch_shape'],
    ['no body at all', undefined, 400, 'patch_shape'],
    ['an array body', null, 400, 'patch_shape', '[]'],
    ['deleted true', { deleted: true }, 400, 'patch_shape'],
    ['a string resolved', { resolved: 'true' }, 400, 'patch_shape'],
    ['a null anchor', { anchor: null }, 400, 'patch_shape'],
    ['an array anchor', { anchor: [] }, 400, 'patch_shape'],
  ];

  await t.test('forbidden and mixed bodies are refused before any mutation', async () => {
    for (const cid of [live.id, removed.id, 'nosuchcomment']) {
      for (const [label, body, status, code, raw] of rejected) {
        const before = store();
        const res = await patch(cid, body, raw);
        assert.strictEqual(res.status, status, `${label} (${cid})`);
        assert.deepStrictEqual(await res.json(), { error: code }, `${label} (${cid})`);
        assert.deepStrictEqual(store(), before, `${label} (${cid}) changed the store`);
      }
    }
    const [a, b] = await comments();
    assert.strictEqual(a.text, 'original text');
    assert.strictEqual(b.text, 'to delete');
    assert.ok(b.deletedAt);
  });

  await t.test('resolve and reopen', async () => {
    const resolved = await patch(live.id, { resolved: true });
    assert.strictEqual(resolved.status, 200);
    assert.strictEqual((await resolved.json()).resolved, true);
    const reopened = await patch(live.id, { resolved: false });
    assert.strictEqual(reopened.status, 200);
    assert.strictEqual((await reopened.json()).resolved, false);
    const kinds = (await events()).filter((e) => e.commentId === live.id && e.author === EXPERT).map((e) => e.kind);
    assert.deepStrictEqual(kinds.slice(-2), ['resolved', 'unresolved']);
  });

  await t.test('restore', async () => {
    const res = await patch(removed.id, { deleted: false });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.deletedAt, undefined);
    assert.strictEqual(body.text, 'to delete');
    assert.ok((await events()).some((e) => e.kind === 'restored' && e.commentId === removed.id && e.author === EXPERT));
  });

  await t.test('reattach keeps the old anchor in previousAnchors and emits an event naming the actor', async () => {
    const res = await patch(live.id, { anchor: NEW_ANCHOR });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.anchor, NEW_ANCHOR);
    assert.deepStrictEqual(body.previousAnchors, [ANCHOR]);
    assert.strictEqual(body.text, 'original text');
    const again = await (await patch(live.id, { anchor: ANCHOR })).json();
    assert.deepStrictEqual(again.previousAnchors, [ANCHOR, NEW_ANCHOR]);
    const reattached = (await events()).filter((e) => e.kind === 'reattached' && e.commentId === live.id);
    assert.strictEqual(reattached.length, 2);
    assert.ok(reattached.every((e) => e.author === EXPERT));
    // The durable record is the comment itself.
    const stored = (await comments()).find((c) => c.id === live.id);
    assert.deepStrictEqual(stored.previousAnchors, [ANCHOR, NEW_ANCHOR]);
  });

  await t.test('an invalid anchor is still refused without a write', async () => {
    const before = store();
    const res = await patch(live.id, { anchor: { nonsense: true } });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(store(), before);
  });
});
