// URL fragments that point into a document in the viewer. Shared by the
// viewer, the markdown renderer (heading ids), and tests.
//
//   #c=<comment-id>                 a comment thread
//   #q=<quote>&b=<before>&a=<after>&i=<offset>
//                                   a text quote, resolved like a comment anchor
//                                   so it survives edits to the document
//   #<id>                           an element id; for headings, a GitHub-style
//                                   slug that falls back to the closest heading
//                                   when the section was renamed
(function (global) {
  'use strict';

  // Matches github-slugger: lowercase, drop everything except letters, marks,
  // numbers, connector punctuation (_), spaces and hyphens, then turn each
  // space into a hyphen (runs of spaces are not collapsed).
  function slugify(text) {
    return String(text).trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
  }

  // Repeated headings get -1, -2, … like GitHub. `taken` seeds ids that already
  // exist in the document so generated ones never collide with them.
  function createSlugger(taken) {
    const seen = new Set(taken || []);
    const counts = new Map();
    return {
      slug(text) {
        const base = slugify(text);
        if (!base) return '';
        let slug = base;
        while (seen.has(slug)) {
          const n = (counts.get(base) || 0) + 1;
          counts.set(base, n);
          slug = `${base}-${n}`;
        }
        seen.add(slug);
        return slug;
      },
    };
  }

  function decode(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }

  function parseFragment(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    if (!raw) return null;
    if (raw.startsWith('c=')) {
      const id = decode(raw.slice(2));
      return id ? { type: 'comment', id } : null;
    }
    if (raw.startsWith('q=')) {
      const params = new URLSearchParams(raw);
      const quote = params.get('q');
      if (!quote) return null;
      const startIdx = Number(params.get('i'));
      return {
        type: 'quote',
        quote,
        contextBefore: params.get('b') || '',
        contextAfter: params.get('a') || '',
        startIdx: Number.isInteger(startIdx) && startIdx >= 0 ? startIdx : 0,
      };
    }
    return { type: 'id', id: decode(raw) };
  }

  const LINK_CONTEXT = 24;
  const enc = (s) => encodeURIComponent(s);

  function quoteFragment(anchor) {
    const before = (anchor.contextBefore || '').slice(-LINK_CONTEXT);
    const after = (anchor.contextAfter || '').slice(0, LINK_CONTEXT);
    let hash = `q=${enc(anchor.quote)}`;
    if (before) hash += `&b=${enc(before)}`;
    if (after) hash += `&a=${enc(after)}`;
    return `${hash}&i=${anchor.startIdx}`;
  }

  function commentFragment(id) {
    return `c=${enc(id)}`;
  }

  function idFragment(id) {
    return enc(id);
  }

  // The anchor shape AnchorResolver.resolveAnchor expects.
  function quoteAnchor(fragment) {
    return {
      startIdx: fragment.startIdx,
      length: fragment.quote.length,
      quote: fragment.quote,
      contextBefore: fragment.contextBefore,
      contextAfter: fragment.contextAfter,
    };
  }

  function editSimilarity(a, b) {
    if (!a.length || !b.length) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) {
        next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = next;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }

  const words = (slug) => slug.split(/[-_]+/).filter(Boolean);

  // Find the heading a fragment id points at. `headings` is [{ id, text }] in
  // document order. Returns { index, exact } or null. Non-exact matches are
  // for links to a section that has since been renamed: the closest heading
  // by shared words or spelling, if any is reasonably close.
  function matchHeading(id, headings) {
    const exact = headings.findIndex((h) => h.id === id);
    if (exact !== -1) return { index: exact, exact: true };
    const target = slugify(id);
    if (!target) return null;
    const normalized = headings.findIndex((h) => h.id === target || slugify(h.text) === target);
    if (normalized !== -1) return { index: normalized, exact: true };

    const targetWords = words(target);
    const targetCompact = targetWords.join('');
    let best = null;
    headings.forEach((h, index) => {
      const candidateWords = words(slugify(h.text));
      if (!candidateWords.length) return;
      const shared = targetWords.filter((w) => candidateWords.includes(w)).length;
      const dice = (2 * shared) / (targetWords.length + candidateWords.length);
      const spelling = editSimilarity(targetCompact, candidateWords.join(''));
      const score = Math.max(dice, spelling);
      if (score >= 0.5 && (!best || score > best.score)) best = { index, score };
    });
    return best && { index: best.index, exact: false };
  }

  const api = { slugify, createSlugger, parseFragment, quoteFragment, commentFragment, idFragment, quoteAnchor, matchHeading };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DocAnchors = api;
})(typeof window !== 'undefined' ? window : globalThis);
