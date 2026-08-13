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
fs.writeFileSync(path.join(ROOT, 'other.md'), '# Other\n\nMore copy.\n');

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

  await t.test('poll leases a durable batch until it is acknowledged', async () => {
    const queued = await queue();
    assert.strictEqual(queued.status, 200);
    assert.strictEqual((await queued.json()).commentCount, 2);

    const duplicate = await queue();
    assert.strictEqual(duplicate.status, 200);
    assert.strictEqual((await duplicate.json()).deduplicated, true);

    const status = await (await fetch(`${base}/api/agent/status?path=review`)).json();
    assert.strictEqual(status.queued, 1);

    const listed = await (await fetch(`${base}/api/agent/queue`)).json();
    assert.strictEqual(listed.count, 1);
    assert.strictEqual(listed.jobs[0].status, 'queued');

    const polled = await fetch(`${base}/api/agent/poll?timeout=1&lease=10`);
    assert.strictEqual(polled.status, 200);
    const payload = await polled.json();
    assert.strictEqual(payload.job.path, 'review');
    assert.deepStrictEqual(payload.job.comments.map((comment) => comment.text), ['First change', 'Second change']);
    assert.match(payload.prompt, /Address each comment/);

    const afterPoll = await (await fetch(`${base}/api/agent/status?path=review`)).json();
    assert.strictEqual(afterPoll.queued, 1);
    const leased = await (await fetch(`${base}/api/agent/queue`)).json();
    assert.strictEqual(leased.jobs[0].status, 'leased');

    const secondPoll = await fetch(`${base}/api/agent/poll?timeout=1`);
    assert.strictEqual(secondPoll.status, 204);

    const wrongAck = await fetch(`${base}/api/agent/jobs/${payload.job.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseId: 'wrong' }),
    });
    assert.strictEqual(wrongAck.status, 409);

    const ack = await fetch(`${base}/api/agent/jobs/${payload.job.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseId: payload.job.lease.id }),
    });
    assert.strictEqual(ack.status, 200);
    assert.strictEqual((await ack.json()).acknowledged, true);
    assert.strictEqual((await (await fetch(`${base}/api/agent/queue`)).json()).count, 0);
  });

  await t.test('an expired lease makes a job available again', async () => {
    await queue();
    const first = await (await fetch(`${base}/api/agent/poll?timeout=1&lease=1`)).json();
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const second = await (await fetch(`${base}/api/agent/poll?timeout=1&lease=10`)).json();
    assert.strictEqual(second.job.id, first.job.id);
    assert.notStrictEqual(second.job.lease.id, first.job.lease.id);
    await fetch(`${base}/api/agent/jobs/${second.job.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseId: second.job.lease.id }),
    });
  });

  await t.test('sending feedback wakes a waiting poll', async () => {
    const poll = fetch(`${base}/api/agent/poll?timeout=3`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const status = await (await fetch(`${base}/api/agent/status?path=review`)).json();
    assert.strictEqual(status.agentWaiting, true);

    await queue();
    const response = await poll;
    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.job.comments.length, 2);
    await fetch(`${base}/api/agent/jobs/${payload.job.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseId: payload.job.lease.id }),
    });
  });

  await t.test('a path-specific poll leases only the selected document', async () => {
    await fetch(`${base}/api/file/comments?path=other`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anchor: { startIdx: 0, length: 5, quote: 'Other' },
        text: 'Change the other document',
        author: 'reviewer',
      }),
    });
    await fetch(`${base}/api/agent/queue?path=other`, { method: 'POST' });
    await queue();

    const selected = await (await fetch(`${base}/api/agent/poll?path=review&timeout=1`)).json();
    assert.strictEqual(selected.job.path, 'review');
    await fetch(`${base}/api/agent/jobs/${selected.job.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseId: selected.job.lease.id }),
    });

    const remaining = await (await fetch(`${base}/api/agent/poll?timeout=1`)).json();
    assert.strictEqual(remaining.job.path, 'other');
    await fetch(`${base}/api/agent/jobs/${remaining.job.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseId: remaining.job.lease.id }),
    });
  });

  await t.test('poll timeout returns no content', async () => {
    const res = await fetch(`${base}/api/agent/poll?timeout=1`);
    assert.strictEqual(res.status, 204);
  });
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
