// Minimal markdown renderer shared by the browser (comment bodies, previews)
// and the server (rendering .md documents). No dependencies; HTML in the
// source is escaped, URLs are restricted to http(s)/mailto/relative.
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

  function renderMarkdown(src) {
    if (src == null) return '';
    let text = String(src);
    if (!text.trim()) return '';

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

    function renderInline(raw) {
      let s = escapeHtml(raw);
      s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
        return `<img src="${safeUrl(url)}" alt="${alt}" loading="lazy">`;
      });
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => {
        return `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
      });
      s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
      s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
      s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
      s = s.replace(/\x00IC(\d+)\x00/g, (_m, idx) => `<code>${escapeHtml(inlineCodes[+idx])}</code>`);
      return s;
    }

    function splitTableRow(ln) {
      let s = ln.trim();
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|')) s = s.slice(0, -1);
      return s.split('|').map((c) => c.trim());
    }

    const isTableSeparator = (ln) =>
      /^[\s|:-]+$/.test(ln) && ln.includes('-') && ln.includes('|');

    const lines = text.split('\n');
    const out = [];
    let i = 0;
    const isBlockStart = (ln) =>
      /^(#{1,6}\s|>\s?|[-*]\s+|\d+\.\s+)/.test(ln) ||
      /^(\*{3,}|-{3,}|_{3,})\s*$/.test(ln) ||
      /^\x00CB\d+\x00$/.test(ln);

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

      if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
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
        out.push(`<blockquote>${renderInline(block.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
        continue;
      }

      if (/^[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items.push(`<li>${renderInline(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
          i++;
        }
        out.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      if (/^\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${renderInline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
          i++;
        }
        out.push(`<ol>${items.join('')}</ol>`);
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
      out.push(`<p>${renderInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }

    return out.join('');
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderMarkdown };
  } else {
    global.renderMarkdown = renderMarkdown;
  }
})(typeof window !== 'undefined' ? window : globalThis);
