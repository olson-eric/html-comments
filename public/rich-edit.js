// Maps in-place edits of a rendered document back onto its source, so the
// visual editor rewrites only the blocks someone changed and leaves every
// other byte of the file alone. No dependencies; shared by the viewer and
// the tests.
//
// Markdown blocks come from renderMarkdown's sourceMap option (source line
// ranges). HTML blocks come from htmlBlocks(), a small scanner that finds leaf
// text blocks (headings, paragraphs, list items, cells, …) holding only inline
// markup, with explicit end tags, so each one maps to an exact source range.
//
// An edit is { range, blocks: [{ tag, content }] }: the block's original range
// and what now stands in its place. One block is the usual edit; several mean
// it was split with Enter; none means it was joined into the block before it.
(function (global) {
  'use strict';

  const EDITABLE = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'dt', 'dd', 'blockquote', 'figcaption', 'caption']);
  const INLINE = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins',
    'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
  ]);
  const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
  const TAG = /<!--[\s\S]*?(?:-->|$)|<![^>]*>?|<\?[^>]*>?|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(?:>|$)/g;

  // Editable blocks of an HTML source, in document order:
  // { tag, outerStart, innerStart, innerEnd, outerEnd } as string offsets.
  // A block containing anything but inline markup, or without its end tag,
  // is skipped, so the editor never has to guess where a block ends.
  function htmlBlocks(source) {
    const blocks = [];
    const open = [];
    const lower = source.toLowerCase();
    TAG.lastIndex = 0;
    let m;
    while ((m = TAG.exec(source))) {
      if (!m[2]) continue; // comment, doctype, processing instruction
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();
      if (INLINE.has(tag)) continue;
      if (closing && EDITABLE.has(tag)) {
        const k = open.map((b) => b.tag).lastIndexOf(tag);
        if (k === -1) continue;
        const block = open[k];
        const nested = open.length - 1 > k;
        open.length = k;
        if (block.ok && !nested) {
          blocks.push({ tag, outerStart: block.outerStart, innerStart: block.innerStart, innerEnd: m.index, outerEnd: TAG.lastIndex });
        }
        continue;
      }
      // Any other element inside an open block makes it a container.
      for (const b of open) b.ok = false;
      if (closing) continue;
      if (RAW_TEXT.has(tag)) {
        const end = lower.indexOf(`</${tag}`, TAG.lastIndex);
        TAG.lastIndex = end === -1 ? source.length : end;
        continue;
      }
      if (EDITABLE.has(tag) && !/\/\s*$/.test(m[3])) {
        open.push({ tag, outerStart: m.index, innerStart: TAG.lastIndex, ok: true });
      }
    }
    return blocks.sort((a, b) => a.outerStart - b.outerStart);
  }

  // The source with data-hc-id="<index>" on each block's start tag, so the
  // rendered element can be matched back to its range.
  function annotateHtml(source, blocks) {
    let out = source;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const at = blocks[i].outerStart + 1 + blocks[i].tag.length;
      out = `${out.slice(0, at)} data-hc-id="${i}"${out.slice(at)}`;
    }
    return out;
  }

  function lineBounds(source, start, end) {
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = source.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = source.length;
    return { lineStart, lineEnd };
  }

  function applyHtmlEdits(source, edits) {
    const sorted = edits.slice().sort((a, b) => b.range.outerStart - a.range.outerStart);
    for (const { range: r, blocks } of sorted) {
      const { lineStart, lineEnd } = lineBounds(source, r.outerStart, r.outerEnd);
      const before = source.slice(lineStart, r.outerStart);
      let start = r.outerStart;
      let end = r.outerEnd;
      let text;
      if (!blocks.length) {
        // Joined into the block above: drop it, with its line if it had one.
        text = '';
        if (!before.trim() && !source.slice(r.outerEnd, lineEnd).trim()) {
          start = lineStart;
          end = lineEnd < source.length ? lineEnd + 1 : lineEnd;
        }
      } else if (blocks.length === 1 && blocks[0].tag === r.tag) {
        // Only the content changed: keep the original tags byte for byte.
        start = r.innerStart;
        end = r.innerEnd;
        text = blocks[0].content;
      } else {
        const indent = before.trim() ? '' : before;
        const startTag = source.slice(r.outerStart, r.innerStart);
        text = blocks.map((b, i) => {
          const open = i === 0 ? startTag.replace(/^<[\w:-]+/, `<${b.tag}`) : `<${b.tag}>`;
          return `${open}${b.content}</${b.tag}>`;
        }).join(`\n${indent}`);
      }
      source = source.slice(0, start) + text + source.slice(end);
    }
    return source;
  }

  const MD_BLOCK_START = /^(#{1,6}\s|>|[-*]\s|\d+\.\s|```|\|)/;

  function applyMarkdownEdits(source, edits) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const lines = source.split(/\r?\n/);
    const sorted = edits.slice().sort((a, b) => b.range.start - a.range.start);
    for (const { range: { start, end }, blocks } of sorted) {
      if (!blocks.length) {
        lines.splice(start, end - start + 1);
        // Don't leave two blank lines where the block was.
        const above = start === 0 || lines[start - 1].trim() === '';
        if (above && start < lines.length && lines[start].trim() === '') lines.splice(start, 1);
        continue;
      }
      const marker = (lines[start].match(/^([-*]|\d+\.)\s/) || [])[1] || '-';
      const number = parseInt(marker, 10);
      const out = [];
      let item = 0;
      blocks.forEach((b, i) => {
        if (i > 0 && !(b.tag === 'li' && blocks[i - 1].tag === 'li')) out.push('');
        if (b.tag === 'li') out.push(`${Number.isNaN(number) ? marker : `${number + item++}.`} ${b.content}`);
        else if (/^h[1-6]$/.test(b.tag)) out.push(`${'#'.repeat(+b.tag[1])} ${b.content}`);
        else if (b.tag === 'blockquote') out.push(`> ${b.content}`);
        else out.push(b.content);
      });
      // A paragraph now directly above plain text would merge with it.
      const next = lines[end + 1];
      const last = blocks[blocks.length - 1].tag;
      if ((last === 'p' || last === 'blockquote') && next !== undefined && next.trim() && !MD_BLOCK_START.test(next)) out.push('');
      lines.splice(start, end - start + 1, ...out);
    }
    return lines.join(eol);
  }

  // Inline markdown for an edited element: the marks markdown.js renders,
  // with everything else (spans the browser adds, unknown tags) reduced to
  // its text.
  function inlineMarkdown(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        out += n.nodeValue;
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (tag === 'br') {
        out += ' ';
        continue;
      }
      if (tag === 'img') {
        out += `![${n.getAttribute('alt') || ''}](${n.getAttribute('src') || ''})`;
        continue;
      }
      if (tag === 'code') {
        if (n.textContent) out += `\`${n.textContent}\``;
        continue;
      }
      const inner = inlineMarkdown(n);
      // Markers must hug the text ("**bold** ", not "**bold **").
      const wrap = (before, after) => {
        const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
        return m[2] ? `${m[1]}${before}${m[2]}${after}${m[3]}` : inner;
      };
      if (tag === 'strong' || tag === 'b') out += wrap('**', '**');
      else if (tag === 'em' || tag === 'i') out += wrap('*', '*');
      else if (tag === 'del' || tag === 's' || tag === 'strike') out += wrap('~~', '~~');
      else if (tag === 'a' && n.getAttribute('href')) out += wrap('[', `](${n.getAttribute('href')})`);
      else out += inner;
    }
    return out;
  }

  function blockMarkdown(el) {
    return inlineMarkdown(el).replace(/\u00a0/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
  }

  function blockHtml(el) {
    const html = el.innerHTML;
    return html === '<br>' ? '' : html;
  }

  const api = { htmlBlocks, annotateHtml, applyHtmlEdits, applyMarkdownEdits, blockMarkdown, blockHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.RichEdit = api;
})(typeof window !== 'undefined' ? window : globalThis);
