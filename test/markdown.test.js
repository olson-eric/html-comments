const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { renderMarkdown } = require('../public/markdown.js');

const doc = (src) => renderMarkdown(src, { breaks: false });

test('paragraphs: breaks option controls soft-wrap joining', () => {
  assert.equal(renderMarkdown('one\ntwo'), '<p>one<br>two</p>');
  assert.equal(doc('one\ntwo'), '<p>one two</p>');
});

test('headings, hr, blockquote, code blocks', () => {
  assert.equal(doc('## Title'), '<h2>Title</h2>');
  assert.equal(doc('---'), '<hr>');
  assert.equal(doc('> a\n> b'), '<blockquote>a b</blockquote>');
  assert.equal(doc('```js\nconst x = 1;\n```'), '<pre><code class="language-js">const x = 1;</code></pre>');
});

test('inline: emphasis, code, strikethrough, escaping', () => {
  assert.equal(doc('**b** *i* `c` ~~s~~'), '<p><strong>b</strong> <em>i</em> <code>c</code> <del>s</del></p>');
  assert.equal(doc('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('inline: bold spanning a soft-wrapped line', () => {
  assert.equal(doc('**bold across\nlines** tail'), '<p><strong>bold across lines</strong> tail</p>');
});

test('links and images: relative and http(s) allowed, unsafe schemes blocked', () => {
  assert.equal(
    doc('[a](https://x.io) [b](sub/doc.md)'),
    '<p><a href="https://x.io" target="_blank" rel="noopener noreferrer">a</a> ' +
      '<a href="sub/doc.md" target="_blank" rel="noopener noreferrer">b</a></p>'
  );
  assert.equal(doc('![shot](img/a.png)'), '<p><img src="img/a.png" alt="shot" loading="lazy"></p>');
  assert.ok(doc('[x](javascript:alert(1))').includes('href="#"'));
  assert.ok(doc('![x](data:text/html,hi)').includes('src="#"'));
});

test('bullet list: wrapped items stay one <li>', () => {
  const html = doc('- first line\n  continues here.\n- second item');
  assert.equal(html, '<ul><li>first line continues here.</li><li>second item</li></ul>');
});

test('bullet list: chat-style breaks keep <br> inside items', () => {
  assert.equal(
    renderMarkdown('- first line\n  continues here.'),
    '<ul><li>first line<br>continues here.</li></ul>'
  );
});

test('ordered list: blank-line-separated items with continuations stay one <ol>', () => {
  const html = doc(
    '1. **First.**\n   More about first.\n\n2. **Second.**\n   More about second.'
  );
  assert.equal(
    html,
    '<ol><li><strong>First.</strong> More about first.</li>' +
      '<li><strong>Second.</strong> More about second.</li></ol>'
  );
});

test('ordered list: preserves a non-1 starting number', () => {
  assert.equal(doc('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
});

test('nested lists', () => {
  const html = doc('- parent\n  - child one\n  - child two\n- sibling');
  assert.equal(
    html,
    '<ul><li>parent<ul><li>child one</li><li>child two</li></ul></li><li>sibling</li></ul>'
  );
});

test('list item with its own paragraphs and code block', () => {
  const html = doc('1. lead\n\n   second para\n\n   ```\n   code\n   ```\n\n2. next');
  assert.ok(html.startsWith('<ol><li><p>lead</p><p>second para</p><pre><code>'));
  assert.ok(html.endsWith('<li>next</li></ol>'));
  assert.equal((html.match(/<ol>/g) || []).length, 1);
});

test('paragraph after a list is not swallowed by it', () => {
  assert.equal(doc('- item\n\nAfter.'), '<ul><li>item</li></ul><p>After.</p>');
});

test('tables', () => {
  const html = doc('| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.equal(
    html,
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
  );
});

test('document fixture: realistic doc keeps list structure intact', () => {
  const md = fs.readFileSync(path.join(__dirname, 'fixtures', 'document.md'), 'utf8');
  const html = doc(md);

  // One bullet list of 3 under "Component tests", one of 3 under "Which one?".
  assert.equal((html.match(/<ul>/g) || []).length, 2);
  // The two gotchas form a single ordered list numbered 1..2.
  assert.equal((html.match(/<ol>/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 8);

  // Wrapped continuation lines belong to their items, not stray paragraphs.
  assert.ok(html.includes('<li>Run: <code>pnpm test</code> once tests exist.</li>'));
  assert.ok(!/<p>[^<]*(build plugins|tests exist|real render-loop|effects re-fire|hangs CI|integrated behavior)/.test(html));

  // Bold lead-ins inside numbered items survive, including the wrapped one.
  assert.ok(html.includes('<strong>Mocks must return referentially-stable values when the real hook memoizes.</strong>'));
  assert.ok(html.includes('<strong>Guard against infinite render loops with a render counter, not a timeout.</strong>'));
});
