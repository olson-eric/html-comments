const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// LOG_MODE=counts, proven against real stdout and stderr: each case runs the
// server in a child process and greps its whole output for a synthetic
// marker. The marker is also in the served root's and the store's paths, so
// a log line naming a path would leak it too.
const SERVER = path.join(__dirname, '..', 'server.js');
const MARKER = `SYNTHMARKER${crypto.randomBytes(4).toString('hex').replace(/[0-9]/g, 'q')}`;
const IDENTITY = 'reviewer@example.com';
// Every child is killed at the end, so a failed assertion can't leave one
// holding the runner open.
const children = new Set();
after(() => {
  for (const child of children) child.kill('SIGKILL');
});
function track(child) {
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
const FLAGS = ['LOG_MODE', 'REQUIRE_IDENTITY', 'COMMENT_TEXT_EDITS', 'TRUST_IDENTITY_HEADER', 'BASE_PATH', 'UPLOADS_ENABLED', 'COMMENTS_DIR'];

// Loads server.js, optionally with a test-only fault injected into fs, and
// listens on an ephemeral port. The port and control messages go over IPC so
// stdout and stderr carry only what the server itself prints.
const HARNESS = `
const fs = require('fs');
const marker = process.env.HC_MARKER;
const hook = process.env.HC_HOOK || '';
if (hook === 'vanish') {
  // The file passes resolveAsset's checks, then disappears before send.
  const realStat = fs.statSync;
  fs.statSync = function (p, ...rest) {
    const s = realStat.call(fs, p, ...rest);
    if (typeof p === 'string' && p.includes(marker) && p.endsWith('.css')) fs.unlinkSync(p);
    return s;
  };
}
if (hook === 'throw') {
  const realRead = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p.includes(marker) && p.endsWith('.html')) {
      throw new Error('EACCES: permission denied, open ' + p + ' ' + marker);
    }
    return realRead.call(fs, p, ...rest);
  };
}
const server = require(process.env.HC_SERVER);
const listener = server.app.listen(0, '127.0.0.1', () => process.send({ port: listener.address().port }));
process.on('message', (m) => {
  if (m === 'flush') { server.flushErrorCounts(); process.send('flushed'); }
  if (m === 'exit') process.exit(0);
  if (m === 'throw') setImmediate(() => { throw new Error('uncaught ' + marker); });
  if (m === 'reject') Promise.reject(new Error('rejected ' + marker));
});
`;

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hc-${MARKER}-root-`));
  fs.mkdirSync(path.join(root, MARKER));
  fs.writeFileSync(path.join(root, MARKER, `${MARKER}.md`), `# ${MARKER}\n\nalpha beta gamma\n`);
  fs.writeFileSync(path.join(root, MARKER, `${MARKER}.html`), `<html><body>${MARKER}</body></html>`);
  fs.writeFileSync(path.join(root, MARKER, `${MARKER}-a.css`), 'body {}');
  fs.writeFileSync(path.join(root, MARKER, `${MARKER}-b.css`), 'body {}');
  const comments = fs.mkdtempSync(path.join(os.tmpdir(), `hc-${MARKER}-store-`));
  return { root, comments };
}

function flagEnv(flags) {
  const env = { ...process.env };
  for (const k of FLAGS) delete env[k];
  return { ...env, NODE_ENV: 'production', ...flags };
}

// Start the harness; resolves to a handle with request/flush/stop helpers.
async function start(flags = {}, { hook = '', tree = makeTree() } = {}) {
  const child = track(
    spawn(process.execPath, ['-e', HARNESS], {
      env: { ...flagEnv(flags), HTML_DIR: tree.root, COMMENTS_DIR: tree.comments, HC_SERVER: SERVER, HC_MARKER: MARKER, HC_HOOK: hook },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
  );
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => (out.stdout += d));
  child.stderr.on('data', (d) => (out.stderr += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const port = await new Promise((resolve, reject) => {
    child.once('message', (m) => resolve(m.port));
    child.once('exit', () => reject(new Error(`harness exited early: ${out.stderr}`)));
  });
  const headers = flags.REQUIRE_IDENTITY ? { 'x-forwarded-email': IDENTITY } : {};
  return {
    tree,
    out,
    child,
    exited,
    request: (method, url, { body, contentType = 'application/json', extraHeaders = {} } = {}) =>
      new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
        const h = { ...headers, ...extraHeaders };
        if (payload) Object.assign(h, { 'content-type': contentType, 'content-length': payload.length });
        const req = http.request(`http://127.0.0.1:${port}${url}`, { method, headers: h }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      }),
    flush: () =>
      new Promise((resolve) => {
        child.once('message', resolve);
        child.send('flush');
      }),
    stop: async () => {
      child.send('exit');
      await exited;
      return out;
    },
  };
}

function assertClean(out, label) {
  assert.ok(!out.stdout.includes(MARKER), `${label}: marker on stdout: ${out.stdout}`);
  assert.ok(!out.stderr.includes(MARKER), `${label}: marker on stderr: ${out.stderr}`);
}

// Every line a counts-mode process prints is one JSON object with a fixed key.
function assertFixedLines(out, label) {
  for (const line of (out.stdout + out.stderr).split('\n').filter(Boolean)) {
    const parsed = JSON.parse(line);
    assert.ok(['errors', 'fatal', 'audit', 'info'].includes(Object.keys(parsed)[0]), `${label}: unexpected line ${line}`);
  }
}

const COUNTS = { LOG_MODE: 'counts' };
const doc = `${MARKER}/${MARKER}`;

test('malformed JSON whose body is the marker, under all 8 flag combinations', { timeout: 60000 }, async () => {
  for (const counts of [false, true]) {
    for (const identity of [false, true]) {
      for (const noText of [false, true]) {
        const flags = {};
        if (counts) flags.LOG_MODE = 'counts';
        if (identity) Object.assign(flags, { REQUIRE_IDENTITY: '1', TRUST_IDENTITY_HEADER: 'X-Forwarded-Email' });
        if (noText) flags.COMMENT_TEXT_EDITS = 'off';
        const label = JSON.stringify(flags);
        const s = await start(flags);
        const created = await s.request('POST', `/api/file/comments?path=${doc}`, { body: MARKER });
        const patched = await s.request('PATCH', `/api/file/comments/x?path=${doc}`, { body: `{"text":"${MARKER}` });
        assert.strictEqual(created.status, 400, label);
        assert.strictEqual(patched.status, 400, label);
        if (counts) {
          assert.deepStrictEqual(JSON.parse(created.text), { error: 'body_parse' }, label);
          assert.deepStrictEqual(JSON.parse(patched.text), { error: 'body_parse' }, label);
          await s.flush();
        }
        const out = await s.stop();
        if (counts) {
          assertClean(out, label);
          assertFixedLines(out, label);
          assert.match(out.stderr, /\{"errors":\{"body_parse":2\}\}/, label);
        }
      }
    }
  }
});

test('an oversized body', { timeout: 60000 }, async () => {
  const s = await start(COUNTS);
  const big = JSON.stringify({ text: MARKER.repeat(Math.ceil((5 * 1024 * 1024) / MARKER.length) + 1) });
  const res = await s.request('POST', `/api/file/comments?path=${doc}`, { body: big });
  assert.strictEqual(res.status, 413);
  assert.deepStrictEqual(JSON.parse(res.text), { error: 'body_too_large' });
  await s.flush();
  const out = await s.stop();
  assertClean(out, 'oversized');
  assert.match(out.stderr, /\{"errors":\{"body_too_large":1\}\}/);
});

test('a sendFile failure on a marker-named file removed between resolve and send', { timeout: 60000 }, async () => {
  const s = await start(COUNTS, { hook: 'vanish' });
  const raw = await s.request('GET', `/raw/${MARKER}/${MARKER}-a.css`);
  assert.strictEqual(raw.status, 404);
  assert.deepStrictEqual(JSON.parse(raw.text), { error: 'send_file' });
  const download = await s.request('GET', `/raw/${MARKER}/${MARKER}-b.css?download=1`);
  assert.strictEqual(download.status, 404);
  assert.deepStrictEqual(JSON.parse(download.text), { error: 'send_file' });
  // The files really are gone, so the failure came from send itself.
  assert.ok(!fs.existsSync(path.join(s.tree.root, MARKER, `${MARKER}-a.css`)));
  await s.flush();
  const out = await s.stop();
  assertClean(out, 'send_file');
  assert.match(out.stderr, /\{"errors":\{"send_file":2\}\}/);
});

test('an error thrown inside a request, naming the marker', { timeout: 60000 }, async () => {
  const s = await start(COUNTS, { hook: 'throw' });
  const res = await s.request('GET', `/api/file/html?path=${doc}.html`);
  assert.strictEqual(res.status, 500);
  assert.deepStrictEqual(JSON.parse(res.text), { error: 'internal' });
  // An undecodable URL parameter (Express puts the raw value in the message).
  const bad = await s.request('GET', `/v/${MARKER}%E0%A4%A`);
  assert.strictEqual(bad.status, 400);
  assert.deepStrictEqual(JSON.parse(bad.text), { error: 'bad_request' });
  await s.flush();
  const out = await s.stop();
  assertClean(out, 'thrown');
  assert.match(out.stderr, /\{"errors":\{"internal":1,"bad_request":1\}\}/);
});

for (const [kind, code] of [['throw', 'uncaught_exception'], ['reject', 'unhandled_rejection']]) {
  test(`a process-level ${code} prints only its code and exits`, { timeout: 60000 }, async () => {
    const s = await start(COUNTS);
    await s.request('POST', `/api/file/comments?path=${doc}`, { body: MARKER });
    s.child.send(kind);
    const exitCode = await s.exited;
    assert.strictEqual(exitCode, 1);
    assertClean(s.out, code);
    assertFixedLines(s.out, code);
    assert.strictEqual(s.out.stderr, `{"errors":{"body_parse":1}}\n{"fatal":"${code}"}\n`);
  });
}

test('an unwritable event log is counted as event_write; the reattach itself is durable', { timeout: 60000 }, async () => {
  const tree = makeTree();
  // A directory where the event log should be: every append fails.
  fs.mkdirSync(path.join(tree.comments, 'events.jsonl'));
  const flags = { ...COUNTS, REQUIRE_IDENTITY: '1', TRUST_IDENTITY_HEADER: 'X-Forwarded-Email', COMMENT_TEXT_EDITS: 'off' };
  const s = await start(flags, { tree });
  const anchor = { startIdx: 0, length: 5, quote: 'alpha' };
  const created = await s.request('POST', `/api/file/comments?path=${doc}`, {
    body: JSON.stringify({ anchor, text: MARKER }),
  });
  assert.strictEqual(created.status, 200);
  const { id } = JSON.parse(created.text);
  const moved = { startIdx: 6, length: 4, quote: 'beta' };
  const res = await s.request('PATCH', `/api/file/comments/${id}?path=${doc}`, { body: JSON.stringify({ anchor: moved }) });
  assert.strictEqual(res.status, 200);
  const comment = JSON.parse(res.text);
  assert.strictEqual(comment.previousAnchors.length, 1);
  assert.strictEqual(comment.previousAnchors[0].quote, 'alpha');
  await s.flush();
  const out = await s.stop();
  assertClean(out, 'event_write');
  assert.match(out.stderr, /\{"errors":\{"event_write":2\}\}/);
});

test('audit lines keep only the action', { timeout: 60000 }, async () => {
  const s = await start({ ...COUNTS, UPLOADS_ENABLED: '1', TRUST_IDENTITY_HEADER: 'X-Forwarded-Email', REQUIRE_IDENTITY: '1' });
  const put = await s.request('PUT', `/api/upload/${MARKER}/${MARKER}-new.md`, { body: `# ${MARKER}\n`, contentType: 'text/markdown' });
  assert.strictEqual(put.status, 200);
  const share = await s.request('PUT', `/api/file/permissions?path=${doc}`, { body: JSON.stringify({ visibility: 'private' }) });
  assert.strictEqual(share.status, 200);
  const out = await s.stop();
  assertClean(out, 'audit');
  assert.strictEqual(out.stdout, '{"audit":"upload"}\n{"audit":"share"}\n');
  assert.strictEqual(out.stderr, '');
});

test('nothing is printed per request, and nothing at all when nothing failed', { timeout: 60000 }, async () => {
  const s = await start({ ...COUNTS, TRUST_IDENTITY_HEADER: 'X-Forwarded-Email', REQUIRE_IDENTITY: '1' });
  for (const url of ['/api/tree', `/api/file?path=${doc}`, `/v/${doc}`, `/raw/${doc}.md`, '/no-such-route']) {
    await s.request('GET', url);
  }
  await s.request('GET', '/api/tree', { extraHeaders: { 'x-forwarded-email': '' } });
  await s.flush();
  const out = await s.stop();
  assert.deepStrictEqual(out, { stdout: '', stderr: '' });
});

// server.js run directly, as the container does.
function runServer(flags, tree = makeTree()) {
  const child = track(
    spawn(process.execPath, [SERVER], {
      env: { ...flagEnv(flags), HTML_DIR: tree.root, COMMENTS_DIR: tree.comments, HOST: '127.0.0.1', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => (out.stdout += d));
  child.stderr.on('data', (d) => (out.stderr += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, out, exited };
}

test('startup prints a fixed line, not the served root', { timeout: 60000 }, async () => {
  const tree = makeTree();
  // An in-content store to import, so the import message is exercised too.
  fs.mkdirSync(path.join(tree.root, '.html-comments'));
  fs.writeFileSync(path.join(tree.root, '.html-comments', 'archived.json'), '{"files":[]}');
  const s = runServer(COUNTS, tree);
  const deadline = Date.now() + 5000;
  while (!s.out.stdout.includes('listening') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  s.child.kill('SIGTERM');
  await s.exited;
  assert.strictEqual(s.out.stdout, '{"info":"imported","files":1}\n{"info":"listening"}\n');
  assertClean(s.out, 'startup');
});

test('startup fails closed on a missing identity header or an unrecognized flag value', { timeout: 60000 }, async () => {
  const cases = [
    [{ REQUIRE_IDENTITY: '1' }, 'identity_header_unset'],
    [{ REQUIRE_IDENTITY: '1', TRUST_IDENTITY_HEADER: '  ' }, 'identity_header_unset'],
    [{ REQUIRE_IDENTITY: 'required', TRUST_IDENTITY_HEADER: 'X-Forwarded-Email' }, 'invalid_require_identity'],
    [{ COMMENT_TEXT_EDITS: 'disabled' }, 'invalid_comment_text_edits'],
    [{ LOG_MODE: 'count' }, 'invalid_log_mode'],
  ];
  for (const [flags, code] of cases) {
    const s = runServer(flags);
    assert.strictEqual(await s.exited, 1, code);
    assert.strictEqual(s.out.stderr, `{"fatal":"${code}"}\n`, code);
    assert.strictEqual(s.out.stdout, '');
  }
  const missing = track(
    spawn(process.execPath, [SERVER], {
      env: { ...flagEnv(COUNTS), HTML_DIR: path.join(os.tmpdir(), `${MARKER}-absent`), PORT: '0' },
    })
  );
  let stderr = '';
  missing.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => missing.on('exit', r));
  assert.strictEqual(code, 1);
  assert.strictEqual(stderr, '{"fatal":"html_dir_missing"}\n');
});

test('with every flag unset, behavior is unchanged: text edits apply and errors keep their messages', { timeout: 60000 }, async () => {
  const s = await start({});
  const created = JSON.parse(
    (await s.request('POST', `/api/file/comments?path=${doc}`, {
      body: JSON.stringify({ anchor: { startIdx: 0, length: 5, quote: 'alpha' }, text: 'first', author: 'Someone' }),
    })).text
  );
  assert.strictEqual(created.author, 'Someone');
  const edited = await s.request('PATCH', `/api/file/comments/${created.id}?path=${doc}`, {
    body: JSON.stringify({ text: 'second', resolved: true }),
  });
  assert.strictEqual(edited.status, 200);
  const body = JSON.parse(edited.text);
  assert.strictEqual(body.text, 'second');
  assert.strictEqual(body.resolved, true);
  const big = await s.request('POST', `/api/file/comments?path=${doc}`, { body: 'x'.repeat(5 * 1024 * 1024 + 10) });
  assert.strictEqual(big.status, 413);
  assert.match(JSON.parse(big.text).error, /^body too large/);
  assert.strictEqual((await s.request('GET', '/api/root')).status, 200);
  await s.stop();
});
