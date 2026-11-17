const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAnchor, nearestPosition } = require('../public/anchor-resolver.js');

test('exact matches use context to choose among repeated quotes', () => {
  const text = 'first target gap surrounding second target tail';
  const result = resolveAnchor(text, {
    startIdx: 0,
    length: 6,
    quote: 'target',
    contextBefore: 'surrounding second ',
    contextAfter: ' tail',
  });
  assert.equal(result.startIdx, text.lastIndexOf('target'));
  assert.equal(result.method, 'exact');
});

test('whitespace-only edits map back to rendered offsets', () => {
  const text = 'before quick\n  brown\tfox after';
  const result = resolveAnchor(text, {
    startIdx: 7,
    length: 15,
    quote: 'quick brown fox',
    contextBefore: 'before ',
    contextAfter: ' after',
  });
  assert.deepEqual(result, { startIdx: 7, length: 17, method: 'whitespace' });
});

test('fuzzy matching accepts a small edit but rejects unrelated text', () => {
  const anchor = {
    startIdx: 7,
    length: 15,
    quote: 'quick brown fox',
    contextBefore: 'before ',
    contextAfter: ' after',
  };
  const result = resolveAnchor('before quick brown cat after', anchor);
  assert.equal(result.startIdx, 7);
  assert.equal(result.length, 15);
  assert.equal(result.method, 'fuzzy');
  assert.equal(resolveAnchor('before entirely deleted after', anchor), null);
});

test('nearestPosition places a removed quote between its surviving context', () => {
  const anchor = {
    // The offset is stale: a paragraph was also inserted earlier in the doc.
    startIdx: 20,
    length: 22,
    quote: 'the retry limit is 3. ',
    contextBefore: 'Section two. Notes. ',
    contextAfter: 'Backoff doubles each time.',
  };
  const text = 'A new intro paragraph. Intro. Section one. Section two. Notes. Backoff doubles each time.';
  assert.equal(resolveAnchor(text, anchor), null);
  assert.deepEqual(nearestPosition(text, anchor), { startIdx: text.indexOf('Backoff'), method: 'context' });

  // Only the following context survives, and it appears twice: use the copy nearest the old offset.
  const after = 'Backoff doubles each time.';
  const twice = `${after} Rewritten section. ${after}`;
  const near = nearestPosition(twice, { ...anchor, startIdx: 40, contextBefore: 'gone gone gone' });
  assert.deepEqual(near, { startIdx: twice.lastIndexOf(after), method: 'context' });

  // No context survives: fall back to the old offset, clamped to the text.
  assert.deepEqual(nearestPosition('short', { ...anchor, contextBefore: '', contextAfter: '' }), { startIdx: 5, method: 'position' });
});
