const { test, after } = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-agent-queue-test-'));
process.env.HTML_DIR = ROOT;
delete process.env.BASE_PATH;
delete process.env.TRUST_IDENTITY_HEADER;

fs.writeFileSync(path.join(ROOT, 'review.md'), '# Review\n\nSome copy.\n');

const { app } = require('../server.js');

test('review batches wake agents and remain durable until polled', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const queue = () => fetch(`${base}/api/agent/queue?path=review`, { method: 'POST' });
  const create = (text) =>
    fetch(`${base}/api/file/comments?path=review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anchor: { startIdx: 0, length: 6, quote: 'Review' },
        text,
        author: 'reviewer',
      }),
    });

  await t.test('an empty review cannot be queued', async () => {
    const res = await queue();
    assert.strictEqual(res.status, 400);
  });

  await create('First change');
  await create('Second change');

  await t.test('a queued batch persists until an agent polls', async () => {
    const queued = await queue();
    assert.strictEqual(queued.status, 200);
    assert.strictEqual((await queued.json()).commentCount, 2);

    const status = await (await fetch(`${base}/api/agent/status?path=review`)).json();
    assert.strictEqual(status.queued, 1);

    const polled = await fetch(`${base}/api/agent/poll?timeout=1`);
    assert.strictEqual(polled.status, 200);
    const payload = await polled.json();
    assert.strictEqual(payload.job.path, 'review');
    assert.deepStrictEqual(payload.job.comments.map((comment) => comment.text), ['First change', 'Second change']);
    assert.match(payload.prompt, /Address each comment/);

    const afterPoll = await (await fetch(`${base}/api/agent/status?path=review`)).json();
    assert.strictEqual(afterPoll.queued, 0);
  });

  await t.test('sending feedback wakes a waiting poll', async () => {
    const poll = fetch(`${base}/api/agent/poll?timeout=3`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const status = await (await fetch(`${base}/api/agent/status?path=review`)).json();
    assert.strictEqual(status.agentWaiting, true);

    await queue();
    const response = await poll;
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).job.comments.length, 2);
  });

  await t.test('poll timeout returns no content', async () => {
    const res = await fetch(`${base}/api/agent/poll?timeout=1`);
    assert.strictEqual(res.status, 204);
  });
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
