const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exec = promisify(execFile);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cli-test-'));
process.env.HTML_DIR = ROOT;
delete process.env.BASE_PATH;
delete process.env.TRUST_IDENTITY_HEADER;

fs.writeFileSync(path.join(ROOT, 'review.md'), '# Review\n\nSome copy.\n');

const { app } = require('../server.js');
const CLI = path.join(__dirname, '..', 'cli.js');

function runWithInput(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout)));
    child.stdin.end(input);
  });
}

test('agent CLI supports the review workflow', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const created = await fetch(`${base}/api/file/comments?path=review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      anchor: { startIdx: 0, length: 6, quote: 'Review' },
      text: 'Clarify this section',
      author: 'reviewer',
    }),
  });
  const comment = await created.json();

  const run = async (...args) => JSON.parse((await exec(process.execPath, [CLI, ...args, '--server', base])).stdout);

  const home = await run();
  assert.strictEqual(home.counts.needingReview, 1);
  assert.match(home.next_step, /show/);

  const list = await run('list');
  assert.strictEqual(list.count, 1);
  assert.strictEqual(list.documents[0].path, 'review');

  const shown = await run('show', 'review', '--content');
  assert.match(shown.content, /<h1>Review<\/h1>/);

  await fetch(`${base}/api/agent/queue?path=review`, { method: 'POST' });
  const queued = await run('queue');
  assert.strictEqual(queued.count, 1);
  assert.strictEqual(queued.jobs[0].status, 'queued');

  const polled = await run('poll', '--path', 'review', '--timeout', '2', '--lease', '30');
  assert.strictEqual(polled.review.path, 'review');
  assert.strictEqual(polled.review.comments.length, 1);
  assert.strictEqual(polled.prompt, undefined);

  const replied = JSON.parse(await runWithInput(
    ['reply', 'review', comment.id, '--stdin', '--resolve', '--server', base],
    'Updated the copy\nwith more detail'
  ));
  assert.strictEqual(replied.comment.resolved, true);
  assert.strictEqual(replied.reply.text, 'Updated the copy\nwith more detail');
  assert.strictEqual(replied.reply.author, 'agent');

  const acked = await run('ack', polled.review.id, polled.review.lease.id);
  assert.strictEqual(acked.acknowledged, true);
  assert.strictEqual((await run('queue')).count, 0);

  const empty = await run('list');
  assert.strictEqual(empty.count, 0);
  assert.match(empty.next_step, /No open documents/);
});

test('agent CLI fails loudly on unknown commands', async () => {
  await assert.rejects(
    exec(process.execPath, [CLI, 'lsit']),
    (error) => {
      assert.strictEqual(error.code, 2);
      const body = JSON.parse(error.stdout);
      assert.strictEqual(body.error.code, 'USAGE_ERROR');
      assert.match(body.error.message, /unknown command/);
      return true;
    }
  );
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
