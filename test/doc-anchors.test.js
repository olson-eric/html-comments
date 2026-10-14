const { test } = require('node:test');
const assert = require('node:assert/strict');
const DocAnchors = require('../public/doc-anchors.js');
const { resolveAnchor } = require('../public/anchor-resolver.js');

test('heading slugs match GitHub, including duplicates', () => {
  const slugger = DocAnchors.createSlugger();
  assert.deepEqual(
    ['Hello World!', 'API v2.0 — Notes', 'Café 🚀 menu', 'snake_case it', 'Foo', 'Foo', 'Foo-1'].map((t) => slugger.slug(t)),
    ['hello-world', 'api-v20--notes', 'café--menu', 'snake_case-it', 'foo', 'foo-1', 'foo-1-1']
  );
  // Ids already in an HTML document are never reused.
  assert.equal(DocAnchors.createSlugger(['intro']).slug('Intro'), 'intro-1');
});

test('quote fragments round-trip characters that are special in URLs', () => {
  const quote = 'a&b=c #50% "naïve"\nnext';
  const hash = DocAnchors.quoteFragment({ quote, contextBefore: 'x'.repeat(60) + 'before ', contextAfter: ' after&', startIdx: 42 });
  assert.doesNotMatch(hash, /[\s#"]/);
  const parsed = DocAnchors.parseFragment(`#${hash}`);
  assert.equal(parsed.type, 'quote');
  assert.equal(parsed.quote, quote);
  assert.equal(parsed.contextBefore, 'x'.repeat(17) + 'before ');
  assert.equal(parsed.contextAfter, ' after&');
  assert.equal(parsed.startIdx, 42);
});

test('a quote link finds the same occurrence after the document is edited', () => {
  const original = 'Intro. The budget is fixed. Later: the budget is flexible.';
  const startIdx = original.lastIndexOf('budget');
  const hash = DocAnchors.quoteFragment({
    quote: 'budget',
    contextBefore: original.slice(startIdx - 24, startIdx),
    contextAfter: original.slice(startIdx + 6, startIdx + 30),
    startIdx,
  });
  const edited = 'A new preamble paragraph that pushes everything down. ' + original;
  const match = resolveAnchor(edited, DocAnchors.quoteAnchor(DocAnchors.parseFragment(hash)));
  assert.equal(match.startIdx, edited.lastIndexOf('budget'));
});

test('comment and id fragments', () => {
  assert.deepEqual(DocAnchors.parseFragment(`#${DocAnchors.commentFragment('c_1 2')}`), { type: 'comment', id: 'c_1 2' });
  assert.deepEqual(DocAnchors.parseFragment('#caf%C3%A9'), { type: 'id', id: 'café' });
  assert.equal(DocAnchors.parseFragment('#'), null);
});

test('heading links fall back to the closest renamed section', () => {
  const headings = [
    { id: 'overview', text: 'Overview' },
    { id: 'retry-and-backoff-policy', text: 'Retry and backoff policy' },
    { id: 'set-up', text: 'Set up' },
  ];
  assert.deepEqual(DocAnchors.matchHeading('overview', headings), { index: 0, exact: true });
  assert.deepEqual(DocAnchors.matchHeading('Retry-and-Backoff-Policy', headings), { index: 1, exact: true });
  assert.deepEqual(DocAnchors.matchHeading('retry-policy', headings), { index: 1, exact: false });
  assert.deepEqual(DocAnchors.matchHeading('setup', headings), { index: 2, exact: false });
  assert.equal(DocAnchors.matchHeading('installation', headings), null);
});
