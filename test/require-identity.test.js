const { test } = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// REQUIRE_IDENTITY=1, mounted under a base path, behind a proxy that stamps
// X-Forwarded-Email. Uploads are enabled so a 401 on
// the file routes provably comes from the identity layer, not requireUploads.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-identity-test-'));
process.env.HTML_DIR = ROOT;
process.env.BASE_PATH = '/app';
process.env.TRUST_IDENTITY_HEADER = 'X-Forwarded-Email';
process.env.REQUIRE_IDENTITY = '1';
process.env.UPLOADS_ENABLED = '1';
delete process.env.COMMENT_TEXT_EDITS;
delete process.env.LOG_MODE;
delete process.env.COMMENTS_DIR;
delete process.env.DEFAULT_VISIBILITY;
delete process.env.UPLOAD_MAX_BYTES;

fs.mkdirSync(path.join(ROOT, 'docs'));
fs.writeFileSync(path.join(ROOT, 'docs', 'spec.md'), '# Spec\n\nalpha beta gamma\n');
fs.writeFileSync(path.join(ROOT, 'docs', 'private.md'), '# Private\n\nowned text\n');
fs.writeFileSync(path.join(ROOT, 'docs', 'movable.md'), '# Movable\n');
fs.writeFileSync(path.join(ROOT, 'docs', 'gone.md'), '# Gone\n');

const { app } = require('../server.js');

const B = '/app';
const ALICE = 'alice.reviewer@example.com';
// Two identities that agree on their first 80 characters.
const LONG_A = `${'r'.repeat(84)}.one@example.com`;
const LONG_B = `${'r'.repeat(84)}.two@example.com`;

function request(base, method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const h = { ...headers };
    if (payload) {
      h['content-type'] = 'application/json';
      h['content-length'] = payload.length;
    }
    const req = http.request(`${base}${url}`, { method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Every file under the served root, comment store included, with a content hash.
function snapshot(dir = ROOT, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) snapshot(abs, out);
    else out[path.relative(ROOT, abs)] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  }
  return out;
}

// Every registered route plus the static mounts, each with a concrete
// request. The coverage check below fails if a route is added without an
// entry here.
function routeTable(cid) {
  const q = 'path=docs/spec';
  return [
    ['GET', `${B}/health`],
    ['GET', `${B}/api/root`],
    ['GET', `${B}/api/tree`],
    ['HEAD', `${B}/api/tree`],
    ['GET', `${B}/api/documents?status=all`],
    ['GET', `${B}/api/agent/home`],
    ['GET', `${B}/api/updates`],
    ['GET', `${B}/api/agent/poll?timeout=1`],
    ['GET', `${B}/api/agent/queue`],
    ['POST', `${B}/api/agent/jobs/nojob/ack`, { leaseId: 'x' }],
    ['GET', `${B}/api/agent/status?${q}`],
    ['POST', `${B}/api/agent/queue?${q}`, {}],
    ['GET', `${B}/api/file?${q}`],
    ['GET', `${B}/api/file/html?${q}`],
    ['GET', `${B}/api/file/comments?${q}`],
    ['POST', `${B}/api/file/comments?${q}`, { anchor: { startIdx: 0, length: 5, quote: 'alpha' }, text: 'note', author: 'Mallory' }],
    ['POST', `${B}/api/file/comments/${cid}/replies?${q}`, { text: 'reply', author: 'Mallory' }],
    ['POST', `${B}/api/file/comments/${cid}/complete?${q}`, { text: 'done', author: 'Mallory' }],
    ['PATCH', `${B}/api/file/comments/${cid}?${q}`, { resolved: false }],
    ['DELETE', `${B}/api/file/comments/${cid}?${q}`],
    ['GET', `${B}/api/file/permissions?${q}`],
    ['PUT', `${B}/api/file/permissions?path=docs/movable`, { visibility: 'everyone' }],
    ['PUT', `${B}/api/upload/docs/new.md`, { any: 'body' }],
    ['DELETE', `${B}/api/upload/docs/gone.md`],
    ['POST', `${B}/api/move`, { from: 'docs/movable.md', to: 'docs/moved.md' }],
    ['POST', `${B}/api/archive?${q}`, { archived: true }],
    ['GET', `${B}/raw/docs/spec.md`],
    ['GET', `${B}/render/docs/spec.md`],
    ['GET', `${B}/vendor/pdfjs/pdf.min.mjs`],
    ['GET', `${B}/viewer.js`],
    ['GET', `${B}/v/docs/spec`],
    ['GET', `${B}/v?${q}`],
    ['GET', `${B}/new`],
    ['GET', `${B}/`],
    ['GET', '/'],
    ['GET', `${B}/no-such-route`],
    ['POST', '/health', {}],
    ['GET', '/health/'],
    ['GET', '/HEALTH'],
  ];
}

// [method, path] of every route registered on the app and its router.
function registeredRoutes() {
  const out = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), layer, prefix });
      } else if (layer.name === 'router') {
        walk(layer.handle.stack, B);
      }
    }
  };
  walk(app._router.stack, '');
  return out;
}

test('REQUIRE_IDENTITY=1', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  const as = (who) => ({ 'x-forwarded-email': who });
  const call = (method, url, opts) => request(base, method, url, opts);

  const seeded = await call('POST', `${B}/api/file/comments?path=docs/spec`, {
    headers: as(ALICE),
    body: { anchor: { startIdx: 0, length: 5, quote: 'alpha' }, text: 'seed', author: 'Mallory' },
  });
  assert.strictEqual(seeded.status, 200);
  const cid = seeded.json.id;
  const table = routeTable(cid);

  await t.test('the route table covers every registered route', () => {
    const routes = registeredRoutes();
    assert.ok(routes.length >= 30, `only ${routes.length} routes found; did the router layout change?`);
    for (const { method, layer, prefix } of routes) {
      const covered = table.some(([m, url]) => {
        if (m !== method) return false;
        const p = url.split('?')[0];
        if (!p.startsWith(prefix)) return false;
        return layer.match(p.slice(prefix.length) || '/');
      });
      assert.ok(covered, `no identity test for ${method} ${layer.route.path}`);
    }
  });

  await t.test('the root /health is exempt (GET and HEAD only)', async () => {
    const get = await call('GET', '/health');
    assert.strictEqual(get.status, 200);
    assert.deepStrictEqual(get.json, { ok: true });
    assert.strictEqual((await call('HEAD', '/health')).status, 200);
  });

  await t.test('missing, empty, two values, a comma list, a non-email and an over-long value are refused everywhere', async () => {
    const before = snapshot();
    const tooLong = `${'x'.repeat(255 - '@example.com'.length)}@example.com`;
    assert.strictEqual(tooLong.length, 255);
    const variants = [
      ['missing', {}],
      ['empty', as('')],
      ['two header lines', as([ALICE, 'bob.reviewer@example.com'])],
      ['comma list', as(`${ALICE}, bob.reviewer@example.com`)],
      ['non-email', as('Alice Reviewer')],
      ['over 254 characters', as(tooLong)],
    ];
    for (const [label, headers] of variants) {
      for (const [method, url, body] of table) {
        const res = await call(method, url, { headers, body });
        assert.strictEqual(res.status, 401, `${label}: ${method} ${url}`);
        if (method !== 'HEAD') assert.deepStrictEqual(res.json, { error: 'identity_required' }, `${label}: ${method} ${url}`);
      }
    }
    assert.deepStrictEqual(snapshot(), before, 'a refused request changed the store or the served tree');
  });

  await t.test('a verified identity reaches every route', async () => {
    for (const [method, url, body] of table) {
      if (['/health/', '/HEALTH'].includes(url)) continue;
      const res = await call(method, url, { headers: as(ALICE), body });
      assert.notStrictEqual(res.status, 401, `${method} ${url}`);
    }
    // A value of exactly 254 characters is accepted.
    const longest = `${'y'.repeat(254 - '@example.com'.length)}@example.com`;
    assert.strictEqual((await call('GET', `${B}/api/root`, { headers: as(longest) })).json.identity.user, longest);
  });

  await t.test('the author is always the verified identity, never the body', async () => {
    const created = await call('POST', `${B}/api/file/comments?path=docs/spec`, {
      headers: as(ALICE),
      body: { anchor: { startIdx: 6, length: 4, quote: 'beta' }, text: 'mine', author: 'Mallory' },
    });
    assert.strictEqual(created.json.author, ALICE);
    const reply = await call('POST', `${B}/api/file/comments/${created.json.id}/replies?path=docs/spec`, {
      headers: as(ALICE),
      body: { text: 'again', author: 'Mallory' },
    });
    assert.strictEqual(reply.json.author, ALICE);
  });

  await t.test('identities sharing their first 80 characters stay two identities', async () => {
    assert.strictEqual(LONG_A.slice(0, 80), LONG_B.slice(0, 80));
    assert.notStrictEqual(LONG_A, LONG_B);

    // Stored and attributed.
    const created = await call('POST', `${B}/api/file/comments?path=docs/private`, {
      headers: as(LONG_A),
      body: { anchor: { startIdx: 0, length: 5, quote: 'owned' }, text: 'by a' },
    });
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.json.author, LONG_A);
    const reply = await call('POST', `${B}/api/file/comments/${created.json.id}/replies?path=docs/private`, {
      headers: as(LONG_B),
      body: { text: 'by b' },
    });
    assert.strictEqual(reply.json.author, LONG_B);
    const stored = (await call('GET', `${B}/api/file/comments?path=docs/private`, { headers: as(LONG_A) })).json;
    const thread = stored.comments.find((c) => c.id === created.json.id);
    assert.strictEqual(thread.author, LONG_A);
    assert.strictEqual(thread.replies[0].author, LONG_B);

    // Evented.
    const events = (await call('GET', `${B}/api/updates`, { headers: as(LONG_A) })).json.events;
    assert.ok(events.some((e) => e.kind === 'created' && e.commentId === created.json.id && e.author === LONG_A));
    assert.ok(events.some((e) => e.kind === 'replied' && e.commentId === created.json.id && e.author === LONG_B));

    // Permission-checked: A owns the doc privately, so B can no longer see it.
    const shared = await call('PUT', `${B}/api/file/permissions?path=docs/private`, {
      headers: as(LONG_A),
      body: { visibility: 'private' },
    });
    assert.strictEqual(shared.status, 200);
    assert.strictEqual(shared.json.owner, LONG_A);
    assert.strictEqual((await call('GET', `${B}/api/file?path=docs/private`, { headers: as(LONG_A) })).status, 200);
    assert.strictEqual((await call('GET', `${B}/api/file?path=docs/private`, { headers: as(LONG_B) })).status, 404);
    const takeover = await call('PUT', `${B}/api/file/permissions?path=docs/private`, {
      headers: as(LONG_B),
      body: { visibility: 'everyone' },
    });
    assert.strictEqual(takeover.status, 404);
  });
});
