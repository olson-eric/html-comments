const filePath = new URLSearchParams(location.search).get('path') || '';
const apiQS = `?path=${encodeURIComponent(filePath)}`;
const frame = document.getElementById('page-frame');
const commentsList = document.getElementById('comments-list');
const filterSelect = document.getElementById('filter');
const popover = document.getElementById('add-comment-popover');
const composerTemplate = document.getElementById('composer-template');
const authorInput = document.getElementById('author');

authorInput.value = localStorage.getItem('hc:author') || '';
authorInput.addEventListener('input', () => localStorage.setItem('hc:author', authorInput.value));

let state = { meta: null, comments: [], pendingAnchor: null, activeCommentId: null };

document.getElementById('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    flash('Link copied');
  } catch (e) {
    prompt('Copy this link', location.href);
  }
});

filterSelect.addEventListener('change', renderSidebar);

bootstrap();

async function bootstrap() {
  if (!filePath) {
    document.body.innerHTML = '<p style="padding:2rem">Missing ?path= parameter.</p>';
    return;
  }
  const res = await fetch(`/api/file${apiQS}`);
  if (!res.ok) {
    document.body.innerHTML = '<p style="padding:2rem">File not found.</p>';
    return;
  }
  state.meta = await res.json();
  state.comments = state.meta.comments || [];
  document.getElementById('page-title').textContent = state.meta.title;
  const pathEl = document.getElementById('page-path');
  if (pathEl) pathEl.textContent = state.meta.path;
  document.title = `${state.meta.title} — html-comments`;

  frame.addEventListener('load', () => {
    injectFrameHooks();
    renderHighlights();
    renderSidebar();
  });
  frame.src = `/raw/${state.meta.path.split('/').map(encodeURIComponent).join('/')}`;
}

function injectFrameHooks() {
  const doc = frame.contentDocument;
  if (!doc) return;
  const style = doc.createElement('style');
  style.textContent = `
    .hc-highlight { background: rgba(255, 213, 79, 0.55); border-bottom: 2px solid rgba(255, 152, 0, 0.7); cursor: pointer; transition: background 0.15s; }
    .hc-highlight.hc-resolved { background: rgba(200, 200, 200, 0.25); border-bottom: 2px solid rgba(120, 120, 120, 0.4); }
    .hc-highlight.hc-active { background: rgba(255, 152, 0, 0.6); }
    body { padding-bottom: 4rem; }
  `;
  doc.head && doc.head.appendChild(style);

  doc.addEventListener('mouseup', onFrameSelection);
  doc.addEventListener('keyup', onFrameSelection);
  doc.addEventListener('click', (e) => {
    const span = e.target.closest && e.target.closest('.hc-highlight');
    if (span) {
      const cid = span.dataset.commentId;
      setActiveComment(cid, { scrollSidebar: true });
    } else {
      setActiveComment(null);
    }
  });
}

function onFrameSelection() {
  const doc = frame.contentDocument;
  const sel = doc.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    popover.hidden = true;
    return;
  }
  const range = sel.getRangeAt(0);
  if (range.startContainer.nodeType !== Node.TEXT_NODE || range.endContainer.nodeType !== Node.TEXT_NODE) {
    popover.hidden = true;
    return;
  }
  const anchor = serializeRange(range, doc.body);
  if (!anchor) {
    popover.hidden = true;
    return;
  }
  state.pendingAnchor = anchor;
  const rect = range.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  popover.style.top = `${frameRect.top + rect.bottom + window.scrollY + 6}px`;
  popover.style.left = `${frameRect.left + rect.left + window.scrollX}px`;
  popover.hidden = false;
}

document.getElementById('start-comment').addEventListener('click', () => {
  if (!state.pendingAnchor) return;
  popover.hidden = true;
  openComposerForNewComment(state.pendingAnchor);
});

function openComposerForNewComment(anchor) {
  const existing = commentsList.querySelector('.composer-host');
  if (existing) existing.remove();
  const host = document.createElement('div');
  host.className = 'thread composer-host';
  const composer = composerTemplate.content.firstElementChild.cloneNode(true);
  composer.querySelector('.composer-quote').textContent = `“${truncate(anchor.quote, 140)}”`;
  composer.querySelector('textarea').focus();
  composer.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    host.remove();
    state.pendingAnchor = null;
  });
  composer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const ta = composer.querySelector('textarea');
    const text = ta.value.trim();
    if (!text) return;
    await createComment(anchor, text);
    host.remove();
    state.pendingAnchor = null;
  });
  host.appendChild(composer);
  commentsList.prepend(host);
}

async function createComment(anchor, text) {
  const res = await fetch(`/api/file/comments${apiQS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anchor, text, author: authorInput.value || 'Anonymous' }),
  });
  if (!res.ok) {
    flash('Failed to create comment');
    return;
  }
  const comment = await res.json();
  state.comments.push(comment);
  renderHighlights();
  renderSidebar();
  setActiveComment(comment.id, { scrollSidebar: true });
}

async function addReply(commentId, text) {
  const res = await fetch(`/api/file/comments/${commentId}/replies${apiQS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, author: authorInput.value || 'Anonymous' }),
  });
  if (!res.ok) {
    flash('Failed to reply');
    return;
  }
  const reply = await res.json();
  const c = state.comments.find((c) => c.id === commentId);
  c.replies.push(reply);
  renderSidebar();
}

async function setResolved(commentId, resolved) {
  const res = await fetch(`/api/file/comments/${commentId}${apiQS}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolved }),
  });
  if (!res.ok) return;
  const updated = await res.json();
  const c = state.comments.find((c) => c.id === commentId);
  Object.assign(c, updated);
  renderHighlights();
  renderSidebar();
}

async function deleteComment(commentId) {
  if (!confirm('Delete this comment thread?')) return;
  const res = await fetch(`/api/file/comments/${commentId}${apiQS}`, { method: 'DELETE' });
  if (!res.ok) return;
  state.comments = state.comments.filter((c) => c.id !== commentId);
  renderHighlights();
  renderSidebar();
}

function serializeRange(range, root) {
  const startIdx = textOffsetOf(range.startContainer, range.startOffset, root);
  const endIdx = textOffsetOf(range.endContainer, range.endOffset, root);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return null;
  const fullText = collectText(root);
  const quote = fullText.slice(startIdx, endIdx);
  return {
    startIdx,
    length: endIdx - startIdx,
    quote,
    contextBefore: fullText.slice(Math.max(0, startIdx - 40), startIdx),
    contextAfter: fullText.slice(endIdx, endIdx + 40),
  };
}

function textOffsetOf(node, offset, root) {
  if (node.nodeType !== Node.TEXT_NODE) {
    if (offset > 0 && node.childNodes[offset - 1]) {
      const inner = collectText(node.childNodes[offset - 1]).length;
      const beforeNode = textOffsetOf(node, offset - 1, root);
      return beforeNode + inner;
    }
    return textOffsetOf(node, 0, root);
  }
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    if (n === node) return total + offset;
    total += n.nodeValue.length;
  }
  return -1;
}

function collectText(root) {
  let out = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) out += n.nodeValue;
  return out;
}

function clearHighlights() {
  const doc = frame.contentDocument;
  if (!doc || !doc.body) return;
  const spans = Array.from(doc.querySelectorAll('.hc-highlight'));
  for (const span of spans) {
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  }
  doc.body.normalize();
}

function renderHighlights() {
  const doc = frame.contentDocument;
  if (!doc || !doc.body) return;
  clearHighlights();
  const sorted = [...state.comments].sort((a, b) => a.anchor.startIdx - b.anchor.startIdx);
  for (const c of sorted) {
    applyHighlight(doc.body, c);
  }
}

function applyHighlight(root, comment) {
  const { startIdx, length } = comment.anchor;
  const endIdx = startIdx + length;
  const wraps = [];
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    const nodeStart = total;
    const nodeEnd = total + node.nodeValue.length;
    total = nodeEnd;
    if (nodeEnd <= startIdx || nodeStart >= endIdx) continue;
    const s = Math.max(0, startIdx - nodeStart);
    const e = Math.min(node.nodeValue.length, endIdx - nodeStart);
    if (s >= e) continue;
    wraps.push({ node, start: s, end: e });
  }
  for (const w of wraps) {
    wrapTextNodeRange(w.node, w.start, w.end, comment);
  }
}

function wrapTextNodeRange(node, start, end, comment) {
  const doc = node.ownerDocument;
  const text = node.nodeValue;
  const before = text.slice(0, start);
  const middle = text.slice(start, end);
  const after = text.slice(end);
  const span = doc.createElement('span');
  span.className = 'hc-highlight' + (comment.resolved ? ' hc-resolved' : '');
  span.dataset.commentId = comment.id;
  span.textContent = middle;
  const parent = node.parentNode;
  if (before) parent.insertBefore(doc.createTextNode(before), node);
  parent.insertBefore(span, node);
  if (after) parent.insertBefore(doc.createTextNode(after), node);
  parent.removeChild(node);
}

function renderSidebar() {
  commentsList.innerHTML = '';
  const filter = filterSelect.value;
  let comments = [...state.comments];
  if (filter === 'open') comments = comments.filter((c) => !c.resolved);
  if (filter === 'resolved') comments = comments.filter((c) => c.resolved);
  comments.sort((a, b) => a.anchor.startIdx - b.anchor.startIdx);
  if (!comments.length) {
    const empty = document.createElement('div');
    empty.className = 'muted empty';
    empty.textContent = 'No comments yet. Select text in the page to add one.';
    commentsList.appendChild(empty);
    return;
  }
  for (const c of comments) {
    commentsList.appendChild(renderThread(c));
  }
  if (state.activeCommentId) {
    const el = commentsList.querySelector(`[data-thread-id="${state.activeCommentId}"]`);
    if (el) el.classList.add('active');
  }
}

function renderThread(comment) {
  const wrap = document.createElement('div');
  wrap.className = 'thread' + (comment.resolved ? ' resolved' : '');
  wrap.dataset.threadId = comment.id;
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('button, textarea, input')) return;
    setActiveComment(comment.id, { scrollFrame: true });
  });
  const header = document.createElement('div');
  header.className = 'thread-header';
  header.innerHTML = `
    <div class="thread-quote">“${escapeHtml(truncate(comment.anchor.quote, 140))}”</div>
    <div class="thread-meta">
      <strong>${escapeHtml(comment.author)}</strong>
      <span>${formatDate(comment.createdAt)}</span>
    </div>
  `;
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'thread-body';
  body.textContent = comment.text;
  wrap.appendChild(body);

  for (const r of comment.replies || []) {
    const reply = document.createElement('div');
    reply.className = 'reply';
    reply.innerHTML = `
      <div class="reply-meta"><strong>${escapeHtml(r.author)}</strong> · ${formatDate(r.createdAt)}</div>
      <div class="reply-body"></div>
    `;
    reply.querySelector('.reply-body').textContent = r.text;
    wrap.appendChild(reply);
  }

  const actions = document.createElement('div');
  actions.className = 'thread-actions';
  const replyBtn = document.createElement('button');
  replyBtn.className = 'secondary';
  replyBtn.textContent = 'Reply';
  replyBtn.addEventListener('click', () => openReplyBox(wrap, comment.id));
  const resolveBtn = document.createElement('button');
  resolveBtn.className = 'secondary';
  resolveBtn.textContent = comment.resolved ? 'Reopen' : 'Resolve';
  resolveBtn.addEventListener('click', () => setResolved(comment.id, !comment.resolved));
  const delBtn = document.createElement('button');
  delBtn.className = 'link-button danger';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', () => deleteComment(comment.id));
  actions.appendChild(replyBtn);
  actions.appendChild(resolveBtn);
  actions.appendChild(delBtn);
  wrap.appendChild(actions);
  return wrap;
}

function openReplyBox(threadEl, commentId) {
  if (threadEl.querySelector('.reply-composer')) return;
  const box = document.createElement('div');
  box.className = 'reply-composer';
  box.innerHTML = `
    <textarea rows="2" placeholder="Reply…"></textarea>
    <div class="composer-actions">
      <button data-action="cancel" class="secondary">Cancel</button>
      <button data-action="save">Reply</button>
    </div>
  `;
  threadEl.appendChild(box);
  const ta = box.querySelector('textarea');
  ta.focus();
  box.querySelector('[data-action="cancel"]').addEventListener('click', () => box.remove());
  box.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) return;
    await addReply(commentId, text);
  });
}

function setActiveComment(commentId, opts = {}) {
  state.activeCommentId = commentId;
  const doc = frame.contentDocument;
  if (doc) {
    doc.querySelectorAll('.hc-highlight.hc-active').forEach((el) => el.classList.remove('hc-active'));
    if (commentId) {
      const target = doc.querySelector(`.hc-highlight[data-comment-id="${commentId}"]`);
      if (target) {
        target.classList.add('hc-active');
        if (opts.scrollFrame) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }
  commentsList.querySelectorAll('.thread.active').forEach((el) => el.classList.remove('active'));
  if (commentId) {
    const el = commentsList.querySelector(`[data-thread-id="${commentId}"]`);
    if (el) {
      el.classList.add('active');
      if (opts.scrollSidebar) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

let flashTimer;
function flash(msg) {
  let el = document.getElementById('flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash';
    el.className = 'flash';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('visible'), 1600);
}
