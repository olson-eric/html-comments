// Minimal markdown renderer shared by the browser (comment bodies, previews)
// and the server (rendering .md documents). No dependencies; HTML in the
// source is escaped, URLs are restricted to http(s)/mailto/relative.
//
// renderMarkdown(src, opts):
//   opts.breaks — when true (default), single newlines inside a paragraph or
//   list item become <br> (chat style, used for comments). When false, wrapped
//   lines are joined with a space (document style, used for .md files).
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // Allow relative URLs and a small scheme allowlist; anything else (javascript:,
  // data:, vbscript:, …) is neutralized.
  function safeUrl(url) {
    if (/^(https?:|mailto:)/i.test(url)) return url;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return '#';
    return url;
  }

  const UL_ITEM = /^[-*]\s+(.*)$/;
  const OL_ITEM = /^(\d+)\.\s+(.*)$/;
  const HR = /^(\*{3,}|-{3,}|_{3,})\s*$/;

  function renderMarkdown(src, opts) {
    if (src == null) return '';
    let text = String(src);
    if (!text.trim()) return '';
    const breaks = !(opts && opts.breaks === false);

    const codeBlocks = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.push({ lang, code: code.replace(/\n$/, '') }) - 1;
      return `\x00CB${idx}\x00`;
    });

    const inlineCodes = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodes.push(code) - 1;
      return `\x00IC${idx}\x00`;
    });

    // Inline emphasis can span a soft-wrapped line ("do **not** reuse … its\n
    // plugins"), so run inline rules over the joined text of the whole block,
    // then apply the newline policy.
    function renderInline(raw) {
      let s = escapeHtml(raw);
      s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
        return `<img src="${safeUrl(url)}" alt="${alt}" loading="lazy">`;
      });
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => {
        return `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
      });
      s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/__([^_]+?)__/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
      s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
      s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
      s = s.replace(/\x00IC(\d+)\x00/g, (_m, idx) => `<code>${escapeHtml(inlineCodes[+idx])}</code>`);
      return s;
    }

    function inlineBlock(blockLines) {
      return renderInline(blockLines.join('\n')).replace(/\n/g, breaks ? '<br>' : ' ');
    }

    function splitTableRow(ln) {
      let s = ln.trim();
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|')) s = s.slice(0, -1);
      return s.split('|').map((c) => c.trim());
    }

    const isTableSeparator = (ln) =>
      /^[\s|:-]+$/.test(ln) && ln.includes('-') && ln.includes('|');

    const isBlockStart = (ln) =>
      /^(#{1,6}\s|>\s?)/.test(ln) ||
      UL_ITEM.test(ln) ||
      OL_ITEM.test(ln) ||
      HR.test(ln) ||
      /^\x00CB\d+\x00$/.test(ln);

    // A list runs until a non-blank, non-indented line that isn't another item.
    // Indented lines are continuation content of the current item (wrapped
    // text, nested lists, code blocks); blank lines only end the list when the
    // next content line doesn't belong to it.
    function parseList(lines, i) {
      const ordered = OL_ITEM.test(lines[i]);
      const itemRe = ordered ? OL_ITEM : UL_ITEM;
      const items = [];
      let start = 1;
      while (i < lines.length) {
        const ln = lines[i];
        const m = ln.match(itemRe);
        if (m) {
          if (ordered && !items.length) start = parseInt(m[1], 10) || 1;
          // Continuation lines are dedented by the marker width ("- " = 2,
          // "12. " = 4) so nested structures parse at the right level.
          items.push({ indent: ln.length - m[ordered ? 2 : 1].length, lines: [m[ordered ? 2 : 1]] });
          i++;
          continue;
        }
        if (!items.length) break;
        if (ln.trim() === '') {
          let j = i + 1;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length && (itemRe.test(lines[j]) || /^\s+\S/.test(lines[j]))) {
            items[items.length - 1].lines.push('');
            i++;
            continue;
          }
          break;
        }
        if (/^\s+\S/.test(ln)) {
          const item = items[items.length - 1];
          item.lines.push(ln.replace(new RegExp(`^\\s{1,${item.indent}}`), ''));
          i++;
          continue;
        }
        break;
      }
      const lis = items.map((item) => {
        const content = item.lines;
        while (content.length && content[content.length - 1].trim() === '') content.pop();
        let firstBreak = -1;
        for (let k = 1; k < content.length; k++) {
          if (content[k].trim() === '' || isBlockStart(content[k])) {
            firstBreak = k;
            break;
          }
        }
        if (firstBreak === -1) return `<li>${inlineBlock(content)}</li>`;
        // Tight item (nested block follows the text directly): bare lead text.
        // Loose item (blank line inside): let renderBlocks wrap paragraphs.
        if (content[firstBreak].trim() !== '') {
          return `<li>${inlineBlock(content.slice(0, firstBreak))}${renderBlocks(content.slice(firstBreak))}</li>`;
        }
        return `<li>${renderBlocks(content)}</li>`;
      });
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
      return { html: `<${tag}${startAttr}>${lis.join('')}</${tag}>`, next: i };
    }

    function renderBlocks(lines) {
      const out = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        let m;

        if ((m = line.match(/^\x00CB(\d+)\x00$/))) {
          const cb = codeBlocks[+m[1]];
          const langClass = cb.lang ? ` class="language-${escapeHtml(cb.lang)}"` : '';
          out.push(`<pre><code${langClass}>${escapeHtml(cb.code)}</code></pre>`);
          i++;
          continue;
        }

        if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
          out.push(`<h${m[1].length}>${renderInline(m[2])}</h${m[1].length}>`);
          i++;
          continue;
        }

        if (HR.test(line)) {
          out.push('<hr>');
          i++;
          continue;
        }

        if (/^>\s?/.test(line)) {
          const block = [];
          while (i < lines.length && /^>\s?/.test(lines[i])) {
            block.push(lines[i].replace(/^>\s?/, ''));
            i++;
          }
          out.push(`<blockquote>${inlineBlock(block)}</blockquote>`);
          continue;
        }

        if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
          const list = parseList(lines, i);
          out.push(list.html);
          i = list.next;
          continue;
        }

        if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
          const head = splitTableRow(line);
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
            rows.push(splitTableRow(lines[i]));
            i++;
          }
          const thead = `<thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead>`;
          const tbody = rows.length
            ? `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`
            : '';
          out.push(`<table>${thead}${tbody}</table>`);
          continue;
        }

        if (line.trim() === '') {
          i++;
          continue;
        }

        const para = [];
        while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
          para.push(lines[i]);
          i++;
        }
        out.push(`<p>${inlineBlock(para)}</p>`);
      }

      return out.join('');
    }

    return renderBlocks(text.split('\n'));
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderMarkdown };
  } else {
    global.renderMarkdown = renderMarkdown;
  }
})(typeof window !== 'undefined' ? window : globalThis);
