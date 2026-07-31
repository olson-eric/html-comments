const { test, after } = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Scenario: comments were written by a bare `node server.js <dir>` run (store
// at <dir>/.html-comments), then the server starts with COMMENTS_DIR pointing
// somewhere else (what the container images do). The old comments must be
// imported, not silently ignored.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-import-root-'));
const NEW_STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-import-store-'));
process.env.HTML_DIR = ROOT;
process.env.COMMENTS_DIR = NEW_STORE;
delete process.env.BASE_PATH;
delete process.env.UPLOADS_ENABLED;

fs.writeFileSync(path.join(ROOT, 'doc.md'), '# Doc\n');

function seedStore(dir, relPath, text) {
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha1').update(relPath).digest('hex');
  fs.writeFileSync(
    path.join(dir, `${hash}.json`),
    JSON.stringify({
      path: relPath,
      comments: [{ id: 'seed01', anchor: { startIdx: 0, length: 3, quote: 'Doc' }, text, author: 'old-run', resolved: false, createdAt: '2026-07-01T00:00:00.000Z', replies: [] }],
    })
  );
}

seedStore(path.join(ROOT, '.html-comments'), 'doc.md', 'from the node run');

const { app } = require('../server.js');

test('empty COMMENTS_DIR imports the in-content store on startup', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const data = await (await fetch(`${base}/api/file/comments?path=doc`)).json();
  assert.strictEqual(data.comments.length, 1);
  assert.strictEqual(data.comments[0].text, 'from the node run');

  // The import copied the store; new writes go to COMMENTS_DIR only.
  const hash = crypto.createHash('sha1').update('doc.md').digest('hex');
  assert.strictEqual(fs.existsSync(path.join(NEW_STORE, `${hash}.json`)), true);
});

test('a non-empty COMMENTS_DIR is never overwritten by the in-content store', async (t) => {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-import-root2-'));
  const store2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-import-store2-'));
  t.after(() => {
    fs.rmSync(root2, { recursive: true, force: true });
    fs.rmSync(store2, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root2, 'doc.md'), '# Doc\n');
  seedStore(path.join(root2, '.html-comments'), 'doc.md', 'stale in-content comment');
  seedStore(store2, 'doc.md', 'current configured-store comment');

  const port = 40000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), root2], {
    env: { ...process.env, HTML_DIR: root2, COMMENTS_DIR: store2, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;

  let data;
  for (let i = 0; i < 50; i++) {
    try {
      data = await (await fetch(`${base}/api/file/comments?path=doc`)).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(data, 'server did not start');
  assert.strictEqual(data.comments.length, 1);
  assert.strictEqual(data.comments[0].text, 'current configured-store comment');
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(NEW_STORE, { recursive: true, force: true });
});
