const { test } = require('node:test');
const assert = require('node:assert/strict');
const { htmlBlocks, applyHtmlEdits, applyMarkdownEdits } = require('../public/rich-edit.js');

const MD = [
  '# Retry policy',
  '',
  'Failed uploads retry',
  'three times.',
  '',
  '1. First',
  '2. Second',
  '',
  'Tail paragraph.',
].join('\n');

test('markdown: an edit rewrites only its own lines, wrapped lines included', () => {
  const out = applyMarkdownEdits(MD, [{ range: { start: 2, end: 3 }, blocks: [{ tag: 'p', content: 'Uploads retry **twice**.' }] }]);
  assert.equal(out, MD.replace('Failed uploads retry\nthree times.', 'Uploads retry **twice**.'));
});

test('markdown: keeps CRLF line endings', () => {
  const crlf = MD.replace(/\n/g, '\r\n');
  const out = applyMarkdownEdits(crlf, [{ range: { start: 0, end: 0 }, blocks: [{ tag: 'h2', content: 'Policy' }] }]);
  assert.equal(out, crlf.replace('# Retry policy', '## Policy'));
});

test('markdown: splitting a paragraph and an ordered item', () => {
  const out = applyMarkdownEdits(MD, [
    { range: { start: 2, end: 3 }, blocks: [{ tag: 'p', content: 'Failed uploads' }, { tag: 'p', content: 'retry.' }] },
    { range: { start: 6, end: 6 }, blocks: [{ tag: 'li', content: 'Sec' }, { tag: 'li', content: 'ond' }] },
  ]);
  assert.equal(out, [
    '# Retry policy', '', 'Failed uploads', '', 'retry.', '', '1. First', '2. Sec', '3. ond', '', 'Tail paragraph.',
  ].join('\n'));
});

test('markdown: joining a block away leaves a single blank line', () => {
  const out = applyMarkdownEdits(MD, [
    { range: { start: 0, end: 0 }, blocks: [{ tag: 'h1', content: 'Retry policyFailed uploads retry three times.' }] },
    { range: { start: 2, end: 3 }, blocks: [] },
  ]);
  assert.equal(out, ['# Retry policyFailed uploads retry three times.', '', '1. First', '2. Second', '', 'Tail paragraph.'].join('\n'));
});

test('markdown: a paragraph turned from a heading is kept apart from the next paragraph', () => {
  const src = '## Title\nbody text';
  const out = applyMarkdownEdits(src, [{ range: { start: 0, end: 0 }, blocks: [{ tag: 'p', content: 'Title' }] }]);
  assert.equal(out, 'Title\n\nbody text');
});

const HTML = `<!doctype html>
<html><head><title><p>not a block</p></title><script>const s = "<p>x</p>";</script></head>
<body>
  <div class="card">
    <h1 id="top" class="title">Retry <em>policy</em></h1>
    <p>One<p>Two</p>
    <ul>
      <li>Outer<ul><li>Inner</li></ul></li>
    </ul>
    <!-- <p>commented</p> -->
    <p class="note">Last <a href="api.html">link</a>.</p>
  </div>
</body></html>
`;

test('html: finds leaf text blocks with explicit end tags, with exact ranges', () => {
  const blocks = htmlBlocks(HTML);
  assert.deepEqual(blocks.map((b) => [b.tag, HTML.slice(b.innerStart, b.innerEnd)]), [
    ['h1', 'Retry <em>policy</em>'],
    ['p', 'Two'], // browsers close <p>One at the next <p>
    ['li', 'Inner'],
    ['p', 'Last <a href="api.html">link</a>.'],
  ]);
});

test('html: a content edit keeps the original start tag and every other byte', () => {
  const [h1] = htmlBlocks(HTML);
  const out = applyHtmlEdits(HTML, [{ range: h1, blocks: [{ tag: 'h1', content: 'Backoff' }] }]);
  assert.equal(out, HTML.replace('Retry <em>policy</em></h1>', 'Backoff</h1>'));
});

test('html: split keeps indentation, type change keeps attributes, join drops the line', () => {
  const blocks = htmlBlocks(HTML);
  const [h1] = blocks;
  const p = blocks[blocks.length - 1];
  const split = applyHtmlEdits(HTML, [{ range: p, blocks: [{ tag: 'p', content: 'Last' }, { tag: 'p', content: 'more' }] }]);
  assert.ok(split.includes('    <p class="note">Last</p>\n    <p>more</p>\n  </div>'));
  const retyped = applyHtmlEdits(HTML, [{ range: h1, blocks: [{ tag: 'h2', content: 'Retry' }] }]);
  assert.ok(retyped.includes('    <h2 id="top" class="title">Retry</h2>\n'));
  const joined = applyHtmlEdits(HTML, [{ range: p, blocks: [] }]);
  assert.ok(joined.includes('    <!-- <p>commented</p> -->\n  </div>'));
});
