(function (global) {
  'use strict';

  function suffixMatchLen(a, b) {
    const limit = Math.min(a.length, b.length);
    let n = 0;
    while (n < limit && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }

  function prefixMatchLen(a, b) {
    const limit = Math.min(a.length, b.length);
    let n = 0;
    while (n < limit && a[n] === b[n]) n++;
    return n;
  }

  function contextScore(text, start, length, anchor) {
    const before = text.slice(Math.max(0, start - 40), start);
    const after = text.slice(start + length, start + length + 40);
    const contextBefore = typeof anchor.contextBefore === 'string' ? anchor.contextBefore : '';
    const contextAfter = typeof anchor.contextAfter === 'string' ? anchor.contextAfter : '';
    return suffixMatchLen(before, contextBefore) + prefixMatchLen(after, contextAfter);
  }

  function chooseOccurrence(text, occurrences, length, anchor) {
    let best = occurrences[0];
    let bestScore = -Infinity;
    for (const start of occurrences) {
      const score = contextScore(text, start, length, anchor) -
        Math.abs(start - anchor.startIdx) * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = start;
      }
    }
    return best;
  }

  function occurrencesOf(text, needle) {
    const found = [];
    if (!needle) return found;
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) found.push(i);
    return found;
  }

  // Normalize whitespace while retaining a map back to offsets in the original
  // text, so a normalized match still highlights the exact rendered range.
  function normalized(text) {
    let value = '';
    const map = [];
    let inWhitespace = false;
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) {
        if (!inWhitespace) {
          value += ' ';
          map.push(i);
          inWhitespace = true;
        }
      } else {
        value += text[i];
        map.push(i);
        inWhitespace = false;
      }
    }
    return { value, map };
  }

  function editSimilarity(a, b) {
    if (!a.length || !b.length) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) {
        next[j] = Math.min(
          next[j - 1] + 1,
          prev[j] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      prev = next;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }

  function addContextCandidates(text, context, offset, starts) {
    if (!context) return;
    const chunks = [context, context.slice(-20), context.slice(-12)].filter((s, i, a) =>
      s.length >= 6 && a.indexOf(s) === i
    );
    for (const chunk of chunks) {
      for (const at of occurrencesOf(text, chunk)) starts.add(at + chunk.length + offset);
      if (starts.size > 100) return;
    }
  }

  function fuzzyMatch(text, anchor) {
    const quote = typeof anchor.quote === 'string' ? anchor.quote : '';
    // Very long selections make edit-distance matching disproportionately
    // expensive; exact and whitespace matching above still handle them.
    if (quote.length < 8 || quote.length > 200 || !text.length) return null;
    const starts = new Set([Math.max(0, Math.min(text.length, anchor.startIdx))]);
    addContextCandidates(text, typeof anchor.contextBefore === 'string' ? anchor.contextBefore : '', 0, starts);

    const after = typeof anchor.contextAfter === 'string' ? anchor.contextAfter : '';
    for (const chunk of [after, after.slice(0, 20), after.slice(0, 12)]) {
      if (chunk.length < 6) continue;
      for (const at of occurrencesOf(text, chunk)) starts.add(Math.max(0, at - quote.length));
    }

    const lengthDelta = Math.max(3, Math.min(20, Math.ceil(quote.length * 0.3)));
    let best = null;
    for (const base of Array.from(starts).slice(0, 30)) {
      for (let start = Math.max(0, base - lengthDelta); start <= Math.min(text.length - 1, base + lengthDelta); start++) {
        const lengths = start === base
          ? Array.from({ length: lengthDelta * 2 + 1 }, (_, i) => quote.length - lengthDelta + i)
          : [quote.length];
        for (const length of lengths) {
          if (length < 1 || start + length > text.length) continue;
          const similarity = editSimilarity(quote, text.slice(start, start + length));
          if (similarity < 0.78) continue;
          const context = contextScore(text, start, length, anchor);
          const nearOriginal = Math.abs(start - anchor.startIdx) <= Math.max(40, quote.length);
          if (context < 6 && !nearOriginal) continue;
          const score = similarity * 100 + Math.min(context, 40) - Math.abs(start - anchor.startIdx) * 0.005;
          if (!best || score > best.score) best = { startIdx: start, length, score };
        }
      }
    }
    return best && { startIdx: best.startIdx, length: best.length, method: 'fuzzy' };
  }

  function resolveAnchor(fullText, anchor) {
    if (!anchor || typeof anchor.startIdx !== 'number' || typeof anchor.length !== 'number') return null;
    const { startIdx, length } = anchor;
    const quote = typeof anchor.quote === 'string' ? anchor.quote : '';
    if (quote && fullText.substr(startIdx, length) === quote) return { startIdx, length, method: 'exact' };
    if (!quote) {
      return startIdx >= 0 && startIdx + length <= fullText.length
        ? { startIdx, length, method: 'position' }
        : null;
    }

    const exact = occurrencesOf(fullText, quote);
    if (exact.length) {
      const found = chooseOccurrence(fullText, exact, quote.length, anchor);
      return { startIdx: found, length: quote.length, method: 'exact' };
    }

    const textNorm = normalized(fullText);
    const quoteNorm = normalized(quote).value;
    const normalizedOccurrences = occurrencesOf(textNorm.value, quoteNorm);
    if (quoteNorm && normalizedOccurrences.length) {
      const ranges = normalizedOccurrences.map((at) => ({
        startIdx: textNorm.map[at],
        length: textNorm.map[at + quoteNorm.length - 1] - textNorm.map[at] + 1,
      }));
      let best = ranges[0];
      let bestScore = -Infinity;
      for (const range of ranges) {
        const score = contextScore(fullText, range.startIdx, range.length, anchor) -
          Math.abs(range.startIdx - anchor.startIdx) * 0.01;
        if (score > bestScore) {
          bestScore = score;
          best = range;
        }
      }
      return { ...best, method: 'whitespace' };
    }

    return fuzzyMatch(fullText, anchor);
  }

  const api = { resolveAnchor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.AnchorResolver = api;
})(typeof window !== 'undefined' ? window : globalThis);
