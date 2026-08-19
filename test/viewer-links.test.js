const { test } = require('node:test');
const assert = require('node:assert');
const { documentPathForLink } = require('../public/viewer-links.js');

const tree = {
  type: 'dir',
  children: [
    {
      type: 'dir',
      children: [
        { type: 'file', path: 'packet/index', file: 'packet/index.html' },
        { type: 'file', path: 'packet/case', file: 'packet/case.html' },
      ],
    },
    { type: 'file', path: 'summary', file: 'summary.md' },
  ],
};

test('document links resolve from raw viewer URLs by filename or doc path', () => {
  assert.strictEqual(
    documentPathForLink('http://localhost/raw/packet/case.html', 'http://localhost', '/', tree),
    'packet/case'
  );
  assert.strictEqual(
    documentPathForLink('http://localhost/raw/packet/case', 'http://localhost', '/', tree),
    'packet/case'
  );
});

test('document links resolve with a base path and root-relative hrefs', () => {
  assert.strictEqual(
    documentPathForLink('http://localhost/reviews/render/summary.md', 'http://localhost', '/reviews/', tree),
    'summary'
  );
  assert.strictEqual(
    documentPathForLink('http://localhost/packet/case.html', 'http://localhost', '/reviews/', tree),
    'packet/case'
  );
});

test('external and non-document links do not resolve to viewer documents', () => {
  assert.strictEqual(
    documentPathForLink('https://example.com/packet/case.html', 'http://localhost', '/', tree),
    null
  );
  assert.strictEqual(
    documentPathForLink('http://localhost/raw/packet/styles.css', 'http://localhost', '/', tree),
    null
  );
});
