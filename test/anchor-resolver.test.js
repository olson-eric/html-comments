const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAnchor } = require('../public/anchor-resolver.js');

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
