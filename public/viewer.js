// The viewer lives at <app-root>/v/<doc-path>, where <doc-path> is the file's
// extension-free path relative to the served root. The server injects a
// <base href> pointing at the app root (which honors the BASE_PATH env var),
// so every relative URL here — fetches, links, iframe src — resolves against
// it regardless of how deep the doc path nests.
const appRoot = new URL('.', document.baseURI).pathname;
const filePath = location.pathname.startsWith(`${appRoot}v/`)
  ? decodeURIComponent(location.pathname.slice(appRoot.length + 2))
  : '';
const apiQS = `?path=${encodeURIComponent(filePath)}`;
const frame = document.getElementById('page-frame');
const imageStage = document.getElementById('image-stage');
const pageImage = document.getElementById('page-image');
const imageOverlay = document.getElementById('image-overlay');
const commentsList = document.getElementById('comments-list');
const filterSelect = document.getElementById('filter');
const popover = document.getElementById('add-comment-popover');
const composerTemplate = document.getElementById('composer-template');
const authorInput = document.getElementById('author');
const sendToAgentBtn = document.getElementById('send-to-agent');
const copyAgentInstructionsBtn = document.getElementById('copy-agent-instructions');
const agentStatus = document.getElementById('agent-status');

authorInput.value = localStorage.getItem('hc:author') || '';
authorInput.addEventListener('input', () => localStorage.setItem('hc:author', authorInput.value));

// When the deployment trusts an auth proxy's identity header, the server
// stamps authorship itself; show the signed-in name and lock the field.
// Sharing controls only make sense with a verified identity, so the Share
// button appears alongside.
let signedInUser = null;
fetch('api/root')
  .then((r) => r.json())
  .then(({ identity }) => {
    if (identity && identity.user) {
      signedInUser = identity.user;
      authorInput.value = identity.user;
      authorInput.disabled = true;
      authorInput.title = 'Signed in through your organization';
      initShare();
    }
  })
  .catch(() => {});

const hideResolvedToggle = document.getElementById('hide-resolved');
hideResolvedToggle.checked = localStorage.getItem('hc:hideResolved') === '1';
hideResolvedToggle.addEventListener('change', () => {
  localStorage.setItem('hc:hideResolved', hideResolvedToggle.checked ? '1' : '0');
  renderHighlights();
});

const darkPageToggle = document.getElementById('dark-page');
darkPageToggle.checked = localStorage.getItem('hc:darkPage') === '1';
darkPageToggle.addEventListener('change', () => {
  localStorage.setItem('hc:darkPage', darkPageToggle.checked ? '1' : '0');
  applyDarkPage();
});

let state = { meta: null, comments: [], deletedComments: [], pendingAnchor: null, activeCommentId: null, reattachCommentId: null };

const POLL_COMMENTS_MS = 5000;
const POLL_DOC_MS = 15000;
let lastCommentsEtag = null;
let lastDocModifiedAt = null;

const copyLinkBtn = document.getElementById('copy-link');
const copyLinkArrow = document.getElementById('copy-link-arrow');
const copyLinkPopover = document.getElementById('copy-link-popover');
const copyLinkNameInput = document.getElementById('copy-link-name');
const copyLinkConfirmBtn = document.getElementById('copy-link-confirm');
let copyResetTimer = null;

// Split button: the main button copies the link as-is; the arrow opens a
// popover to address the link to a specific recipient.
copyLinkBtn.addEventListener('click', () => {
  closeCopyLinkPopover();
  copyLink('');
});

copyLinkArrow.addEventListener('click', () => {
  if (!copyLinkPopover.hidden) {
    closeCopyLinkPopover();
    return;
  }
  copyLinkNameInput.value = localStorage.getItem('hc:lastRecipient') || '';
  copyLinkPopover.hidden = false;
  copyLinkArrow.setAttribute('aria-expanded', 'true');
  copyLinkNameInput.focus();
  copyLinkNameInput.select();
});

copyLinkConfirmBtn.addEventListener('click', doCopyLink);
copyLinkNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doCopyLink();
  else if (e.key === 'Escape') closeCopyLinkPopover();
});

document.addEventListener('click', (e) => {
  if (copyLinkPopover.hidden) return;
  if (e.target === copyLinkArrow || copyLinkArrow.contains(e.target)) return;
  if (copyLinkPopover.contains(e.target)) return;
  closeCopyLinkPopover();
});

function closeCopyLinkPopover() {
  copyLinkPopover.hidden = true;
  copyLinkArrow.setAttribute('aria-expanded', 'false');
}

function doCopyLink() {
  copyLink(copyLinkNameInput.value.trim());
}

async function copyLink(name) {
  const url = new URL(`v/${encodePath(filePath)}`, document.baseURI);
  if (name) {
    url.searchParams.set('for', name);
    localStorage.setItem('hc:lastRecipient', name);
  }
  const link = url.toString();
  let copied = false;
  try {
    await navigator.clipboard.writeText(link);
    copied = true;
  } catch (e) {
    copied = legacyCopy(link);
  }
  if (!copied) return;
  closeCopyLinkPopover();
  copyLinkBtn.classList.add('copied');
  copyLinkBtn.setAttribute('aria-label', 'Link copied');
  clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(() => {
    copyLinkBtn.classList.remove('copied');
    copyLinkBtn.removeAttribute('aria-label');
  }, 1800);
}

// ----- Sharing -----
const shareWrap = document.getElementById('share-wrap');
const shareBtn = document.getElementById('share-btn');
const sharePopover = document.getElementById('share-popover');
const shareEmails = document.getElementById('share-emails');
const shareSave = document.getElementById('share-save');
const shareOwnerHint = document.getElementById('share-owner-hint');
let sharePerms = null;

function initShare() {
  shareWrap.hidden = false;
  shareBtn.addEventListener('click', () => {
    if (!sharePopover.hidden) return closeSharePopover();
    openSharePopover();
  });
  for (const radio of sharePopover.querySelectorAll('input[name="share-vis"]')) {
    radio.addEventListener('change', () => {
      shareEmails.hidden = shareVisibility() !== 'shared';
    });
  }
  shareSave.addEventListener('click', saveShare);
  document.addEventListener('click', (e) => {
    if (sharePopover.hidden) return;
    if (shareWrap.contains(e.target)) return;
    closeSharePopover();
  });
  refreshShareState();
}

async function refreshShareState() {
  try {
    const res = await fetch(`api/file/permissions${apiQS}`);
    if (!res.ok) return;
    sharePerms = await res.json();
  } catch {
    return;
  }
  const v = sharePerms.visibility;
  shareBtn.textContent = v === 'private' ? '🔒 Private' : v === 'shared' ? '👥 Shared' : 'Share';
  shareBtn.classList.toggle('restricted', v !== 'everyone');
}

function shareVisibility() {
  const checked = sharePopover.querySelector('input[name="share-vis"]:checked');
  return checked ? checked.value : 'everyone';
}

function openSharePopover() {
  const v = (sharePerms && sharePerms.visibility) || 'everyone';
  const radio = sharePopover.querySelector(`input[name="share-vis"][value="${v}"]`);
  if (radio) radio.checked = true;
  shareEmails.value = ((sharePerms && sharePerms.sharedWith) || []).join('\n');
  shareEmails.hidden = v !== 'shared';
  // Docs claimed by someone else are read-only here; the server enforces
  // owner-only writes regardless.
  const owner = sharePerms && sharePerms.owner;
  const notOwner = !!owner && owner.toLowerCase() !== String(signedInUser || '').toLowerCase();
  for (const el of sharePopover.querySelectorAll('input, textarea, #share-save')) el.disabled = notOwner;
  shareOwnerHint.hidden = !notOwner;
  if (notOwner) shareOwnerHint.textContent = `Only the owner (${owner}) can change sharing.`;
  sharePopover.hidden = false;
  shareBtn.setAttribute('aria-expanded', 'true');
}

function closeSharePopover() {
  sharePopover.hidden = true;
  shareBtn.setAttribute('aria-expanded', 'false');
}

async function saveShare() {
  const visibility = shareVisibility();
  const body = { visibility };
  if (visibility === 'shared') {
    body.sharedWith = shareEmails.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  const res = await fetch(`api/file/permissions${apiQS}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    flash(err.error || 'Failed to update sharing');
    return;
  }
  sharePerms = await res.json();
  closeSharePopover();
  refreshShareState();
  flash('Sharing updated');
}

applyRecipientName();

function applyRecipientName() {
  const recipient = new URLSearchParams(location.search).get('for');
  if (!recipient) return;
  if (!authorInput.disabled && !localStorage.getItem('hc:author')) {
    authorInput.value = recipient;
    localStorage.setItem('hc:author', recipient);
  }
  const url = new URL(location.href);
  url.searchParams.delete('for');
  history.replaceState(null, '', url.toString());
}

function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

filterSelect.addEventListener('change', async () => {
  if (filterSelect.value === 'deleted') await loadDeletedComments();
  renderSidebar();
});
sendToAgentBtn.addEventListener('click', sendToAgent);
copyAgentInstructionsBtn.addEventListener('click', copyAgentInstructions);

bootstrap();

async function bootstrap() {
  if (!filePath) {
    document.body.innerHTML = '<p style="padding:2rem">Missing document path.</p>';
    return;
  }
  const res = await fetch(`api/file${apiQS}`);
  if (!res.ok) {
    document.body.innerHTML = '<p style="padding:2rem">File not found.</p>';
    return;
  }
  state.meta = await res.json();
  state.comments = state.meta.comments || [];
  lastCommentsEtag = JSON.stringify(state.comments);
  lastDocModifiedAt = state.meta.modifiedAt;
  document.getElementById('page-title').textContent = state.meta.title;
  await renderBreadcrumb();
  document.title = `${state.meta.title} — html-comments`;

  if (isImageDoc()) {
    setupImageMode();
  } else {
    frame.addEventListener('load', () => {
      injectFrameHooks();
      applyDarkPage();
      renderHighlights();
      renderSidebar();
    });
    frame.src = docUrl();
  }

  setInterval(pollComments, POLL_COMMENTS_MS);
  setInterval(pollDocument, POLL_DOC_MS);
  setInterval(pollAgentStatus, POLL_COMMENTS_MS);
  pollAgentStatus();
}

// Breadcrumb: each folder segment of the current file's path is clickable and
// opens a dropdown of that folder's contents, so you can jump to a sibling file
// (or drill into a subfolder) without returning to the home screen.
let treeCache = null;

async function getTree(force) {
  if (treeCache && !force) return treeCache;
  try {
    const res = await fetch('api/tree');
    if (!res.ok) return treeCache;
    treeCache = await res.json();
  } catch {}
  return treeCache;
}

function findDirNode(tree, relDir) {
  if (!tree) return null;
  if (!relDir) return tree;
  let node = tree;
  for (const seg of relDir.split('/')) {
    if (!node || !node.children) return null;
    node = node.children.find((c) => c.type === 'dir' && c.name === seg);
  }
  return node || null;
}

async function renderBreadcrumb() {
  const el = document.getElementById('page-path');
  if (!el) return;
  const tree = await getTree();
  el.innerHTML = '';
  const parts = state.meta.path.split('/');
  parts.pop();
  const fileName = state.meta.name;
  const rootName = (tree && tree.name) || 'root';

  el.appendChild(makeCrumb(rootName, ''));
  let dir = '';
  for (const seg of parts) {
    el.appendChild(makeSeparator());
    dir = dir ? `${dir}/${seg}` : seg;
    el.appendChild(makeCrumb(seg, dir));
  }
  el.appendChild(makeSeparator());
  const cur = document.createElement('span');
  cur.className = 'crumb crumb-current';
  cur.textContent = fileName;
  el.appendChild(cur);
}

function makeSeparator() {
  const sep = document.createElement('span');
  sep.className = 'crumb-sep';
  sep.textContent = '/';
  sep.setAttribute('aria-hidden', 'true');
  return sep;
}

function makeCrumb(label, dir) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'crumb crumb-dir';
  btn.textContent = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFolderMenu(btn, dir);
  });
  return btn;
}

let openMenu = null;

function closeFolderMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
  document.removeEventListener('click', onDocClickForMenu, true);
  document.removeEventListener('keydown', onKeydownForMenu, true);
}

function onDocClickForMenu(e) {
  if (openMenu && !openMenu.contains(e.target)) closeFolderMenu();
}

function onKeydownForMenu(e) {
  if (e.key === 'Escape') closeFolderMenu();
}

async function toggleFolderMenu(btn, dir) {
  // Clicking the same crumb again closes the menu.
  if (openMenu && openMenu._anchor === btn) {
    closeFolderMenu();
    return;
  }
  closeFolderMenu();
  const tree = await getTree(true);
  const node = findDirNode(tree, dir);
  if (!node) return;
  const menu = document.createElement('div');
  menu.className = 'folder-menu';
  menu._anchor = btn;
  document.body.appendChild(menu);
  openMenu = menu;
  buildFolderMenu(menu, node, []);
  setTimeout(() => {
    document.addEventListener('click', onDocClickForMenu, true);
    document.addEventListener('keydown', onKeydownForMenu, true);
  }, 0);
}

function buildFolderMenu(menu, node, stack) {
  menu.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'folder-menu-head';
  if (stack.length) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'folder-menu-back';
    back.textContent = '‹';
    back.title = 'Back';
    back.addEventListener('click', (e) => {
      e.stopPropagation();
      buildFolderMenu(menu, stack[stack.length - 1], stack.slice(0, -1));
    });
    head.appendChild(back);
  }
  const title = document.createElement('span');
  title.className = 'folder-menu-title';
  title.textContent = node.name || 'root';
  head.appendChild(title);
  menu.appendChild(head);

  const list = document.createElement('div');
  list.className = 'folder-menu-list';
  const children = node.children || [];
  if (!children.length) {
    const empty = document.createElement('div');
    empty.className = 'folder-menu-empty muted';
    empty.textContent = 'No files in this folder.';
    list.appendChild(empty);
  }
  for (const child of children) {
    if (child.type === 'dir') {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'folder-menu-item';
      row.innerHTML = `<span class="mi-icon">📁</span><span class="mi-name">${escapeHtml(child.name)}</span><span class="mi-chev">›</span>`;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        buildFolderMenu(menu, child, [...stack, node]);
      });
      list.appendChild(row);
    } else {
      list.appendChild(makeMenuFile(child));
    }
  }
  menu.appendChild(list);
  if (openMenu === menu) positionMenu(menu, menu._anchor);
}

function makeMenuFile(node) {
  const a = document.createElement('a');
  a.className = 'folder-menu-item' + (node.path === state.meta.path ? ' current' : '');
  a.href = `v/${encodePath(node.path)}`;
  const icon = { html: '📄', markdown: '📝', json: '🔢', image: '🖼️' }[node.kind] || '📄';
  const badge = node.openCount > 0
    ? `<span class="badge badge-open" title="${node.openCount} open / ${node.commentCount} total">${node.openCount}</span>`
    : node.commentCount > 0
      ? `<span class="badge badge-resolved" title="${node.commentCount} comment(s), all resolved">${node.commentCount}</span>`
      : '';
  a.innerHTML = `<span class="mi-icon">${icon}</span><span class="mi-name">${escapeHtml(node.name)}</span>${badge}`;
  return a;
}

function positionMenu(menu, anchorBtn) {
  const r = anchorBtn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  const maxLeft = window.innerWidth - menu.offsetWidth - 8;
  menu.style.left = `${Math.max(8, Math.min(r.left, maxLeft))}px`;
}

function isImageDoc() {
  return state.meta && state.meta.kind === 'image';
}

// /raw/ and /render/ address the real file (meta.file, extension and all),
// not the extension-free doc path.
function docUrl() {
  const encoded = encodePath(state.meta.file);
  return ['markdown', 'json'].includes(state.meta.kind) ? `render/${encoded}` : `raw/${encoded}`;
}

async function pollComments() {
  if (commentsList.querySelector('.composer-host, .reply-composer')) return;
  try {
    const res = await fetch(`api/file/comments${apiQS}`);
    if (!res.ok) return;
    const data = await res.json();
    const etag = JSON.stringify(data.comments);
    if (etag === lastCommentsEtag) return;
    lastCommentsEtag = etag;
    if (mergeComments(data.comments)) {
      renderHighlights();
      renderSidebar();
    }
  } catch {}
}

async function sendToAgent() {
  sendToAgentBtn.disabled = true;
  agentStatus.textContent = 'Sending…';
  try {
    const res = await fetch(`api/agent/queue${apiQS}`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      agentStatus.textContent = data.error || 'Failed to send';
      updateAgentDispatch();
      return;
    }
    agentStatus.textContent = `Sent ${data.commentCount} comment${data.commentCount === 1 ? '' : 's'}`;
    flash('Feedback sent to agent');
  } catch {
    agentStatus.textContent = 'Failed to send';
  } finally {
    sendToAgentBtn.disabled = state.comments.every((comment) => comment.resolved);
  }
}

async function copyAgentInstructions() {
  if (!state.meta) return;
  const server = new URL('.', document.baseURI).toString().replace(/\/$/, '');
  const quotedServer = shellQuote(server);
  const quotedPath = shellQuote(state.meta.path);
  const quotedFile = shellQuote(state.meta.file);
  const instructions = `Handle feedback for ${state.meta.path} with the html-comments CLI:

export HTML_COMMENTS_URL=${quotedServer}
# Set HTML_COMMENTS_TOKEN too if the server requires it.

# Claim the review lease and read its comments. Save review.id and review.lease.id.
html-comments poll --path ${quotedPath} --lease 300

# Apply each comment, then reply and resolve it.
html-comments reply ${quotedPath} <comment-id> "What changed" --resolve

# If needed, publish the updated artifact.
html-comments publish <local-file> --to ${quotedFile}

# After every comment is complete, acknowledge the lease.
html-comments ack <review.id> <review.lease.id>

Do not ack incomplete work. If the lease expires, poll again before acking.`;

  let copied = false;
  try {
    await navigator.clipboard.writeText(instructions);
    copied = true;
  } catch {
    copied = legacyCopy(instructions);
  }
  if (!copied) {
    flash('Could not copy agent instructions');
    return;
  }
  copyAgentInstructionsBtn.classList.add('copied');
  copyAgentInstructionsBtn.setAttribute('aria-label', 'Agent instructions copied');
  flash('Agent instructions copied');
  setTimeout(() => {
    copyAgentInstructionsBtn.classList.remove('copied');
    copyAgentInstructionsBtn.setAttribute('aria-label', 'Copy agent instructions');
  }, 1800);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function updateAgentDispatch() {
  const count = state.comments.filter((comment) => !comment.resolved).length;
  sendToAgentBtn.disabled = count === 0;
  const sent = agentStatus.textContent.startsWith('Sent') || agentStatus.textContent.startsWith('Queued');
  sendToAgentBtn.textContent = count ? (sent ? 'Send again' : `Send ${count} to agent`) : 'Send to agent';
  if (!count) agentStatus.textContent = 'No open comments';
  else if (agentStatus.textContent === 'No open comments') agentStatus.textContent = 'Bundles all open comments';
}

async function pollAgentStatus() {
  try {
    const res = await fetch(`api/agent/status${apiQS}`);
    if (!res.ok) return;
    const status = await res.json();
    if (status.queued) agentStatus.textContent = `Queued: ${status.queued} batch${status.queued === 1 ? '' : 'es'}`;
    else if (status.agentWaiting) agentStatus.textContent = 'Agent waiting';
    else if (!agentStatus.textContent.startsWith('Sent')) agentStatus.textContent = 'No agent waiting';
    updateAgentDispatch();
  } catch {}
}

function mergeComments(serverComments) {
  const localById = new Map(state.comments.map((c) => [c.id, c]));
  const serverById = new Map(serverComments.map((c) => [c.id, c]));
  let changed = false;
  for (const sc of serverComments) {
    if (!localById.has(sc.id)) {
      state.comments.push(sc);
      changed = true;
    } else {
      const lc = localById.get(sc.id);
      if (JSON.stringify(lc) !== JSON.stringify(sc)) {
        Object.assign(lc, sc);
        changed = true;
      }
    }
  }
  const prevLen = state.comments.length;
  state.comments = state.comments.filter((c) => serverById.has(c.id));
  if (state.comments.length !== prevLen) changed = true;
  return changed;
}

async function pollDocument() {
  if (commentsList.querySelector('.composer-host, .reply-composer')) return;
  try {
    const res = await fetch(`api/file${apiQS}`);
    if (!res.ok) return;
    const meta = await res.json();
    if (meta.modifiedAt === lastDocModifiedAt) return;
    lastDocModifiedAt = meta.modifiedAt;
    state.meta = meta;
    flash('Document updated — reloading…');
    if (isImageDoc()) {
      pageImage.src = `${docUrl()}?_t=${Date.now()}`;
    } else {
      frame.src = `${docUrl()}?_t=${Date.now()}`;
    }
  } catch {}
}

function injectFrameHooks() {
  const doc = frame.contentDocument;
  if (!doc) return;
  const style = doc.createElement('style');
  style.textContent = `
    .hc-highlight { background: rgba(255, 213, 79, 0.55); border-bottom: 2px solid rgba(255, 152, 0, 0.7); cursor: pointer; transition: background 0.15s; }
    .hc-highlight.hc-resolved { background: rgba(200, 200, 200, 0.25); border-bottom: 2px solid rgba(120, 120, 120, 0.4); }
    .hc-highlight.hc-active { background: rgba(255, 152, 0, 0.6); }
    svg .hc-highlight { fill: #6b4a00; stroke: rgba(255, 213, 79, 0.9); stroke-width: 3px; paint-order: stroke; stroke-linejoin: round; }
    svg .hc-highlight.hc-resolved { fill: inherit; stroke: rgba(150, 150, 150, 0.45); }
    svg .hc-highlight.hc-active { stroke: rgba(255, 152, 0, 0.9); }
    img { cursor: crosshair; }
    .hc-image-region { position: fixed; z-index: 2147483646; box-sizing: border-box; border: 2px solid rgba(255, 152, 0, 0.9); background: rgba(255, 213, 79, 0.25); border-radius: 2px; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
    .hc-image-region:hover { background: rgba(255, 213, 79, 0.4); }
    .hc-image-region.hc-resolved { border-color: rgba(130, 130, 130, 0.55); background: rgba(200, 200, 200, 0.15); }
    .hc-image-region.hc-active { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2); background: rgba(255, 213, 79, 0.35); }
    .hc-image-region-draft { position: fixed; z-index: 2147483647; box-sizing: border-box; border: 2px dashed #2563eb; background: rgba(37, 99, 235, 0.12); pointer-events: none; }
    body { padding-bottom: 4rem; }
  `;
  doc.head && doc.head.appendChild(style);

  setupInlineImageComments(doc);
  doc.addEventListener('mouseup', onFrameSelection);
  doc.addEventListener('keyup', onFrameSelection);
  doc.addEventListener('click', (e) => {
    if (suppressInlineImageClick) {
      suppressInlineImageClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const link = e.target.closest && e.target.closest('a[href]');
    if (link) {
      const href = link.getAttribute('href');
      // Let in-page anchor jumps (#fragment) behave normally inside the frame.
      if (href && !href.startsWith('#')) {
        e.preventDefault();
        const url = link.href; // resolved absolute URL
        const docPath = url && documentPathForLink(url, location.origin, appRoot, treeCache);
        if (docPath) {
          const viewerUrl = new URL(`v/${encodePath(docPath)}`, document.baseURI).toString();
          if (e.metaKey || e.ctrlKey) window.open(viewerUrl, '_blank', 'noopener,noreferrer');
          else location.assign(viewerUrl);
        } else if (url) {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
        return;
      }
    }
    const span = e.target.closest && e.target.closest('.hc-highlight');
    if (span) {
      const cid = span.dataset.commentId;
      setActiveComment(cid, { scrollSidebar: true });
    } else {
      setActiveComment(null);
    }
  });
}

let suppressInlineImageClick = false;

function setupInlineImageComments(doc) {
  let drag = null;

  doc.addEventListener('dragstart', (e) => {
    if (e.target.closest && e.target.closest('img')) e.preventDefault();
  });
  doc.addEventListener('mousedown', (e) => {
    const image = e.target.closest && e.target.closest('img');
    if (e.button !== 0 || !image) return;
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    popover.hidden = true;
    clearDraftRegion();
    drag = { image, x0: e.clientX - rect.left, y0: e.clientY - rect.top, rect };
  });
  doc.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const box = dragBox(drag, e);
    if (!draftRegionEl) {
      e.preventDefault();
      draftRegionEl = doc.createElement('div');
      draftRegionEl.className = 'hc-image-region-draft';
      doc.body.appendChild(draftRegionEl);
    }
    positionInlineRegion(draftRegionEl, drag.image, box);
  });
  doc.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const box = dragBox(drag, e);
    const { image, rect } = drag;
    drag = null;
    if (box.w * rect.width < 8 || box.h * rect.height < 8) {
      clearDraftRegion();
      return;
    }
    e.preventDefault();
    suppressInlineImageClick = true;
    setTimeout(() => { suppressInlineImageClick = false; }, 0);
    positionInlineRegion(draftRegionEl, image, box);
    const images = Array.from(doc.images);
    const imageSrc = image.getAttribute('src') || '';
    state.pendingAnchor = {
      type: 'region',
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      imageSrc,
      imageIndex: images.indexOf(image),
      imageOccurrence: images.filter((candidate) => candidate.getAttribute('src') === imageSrc).indexOf(image),
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
    };
    document.getElementById('start-comment').textContent = state.reattachCommentId ? '🔗 Re-attach comment' : '💬 Add comment';
    const paneRect = document.querySelector('.page-pane').getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    popover.style.left = `${frameRect.left - paneRect.left + imageRect.left + box.x * imageRect.width}px`;
    popover.style.top = `${frameRect.top - paneRect.top + imageRect.top + (box.y + box.h) * imageRect.height + 6}px`;
    popover.hidden = false;
    e.stopImmediatePropagation();
  });
  doc.addEventListener('scroll', positionInlineImageHighlights, true);
  frame.contentWindow.addEventListener('resize', positionInlineImageHighlights);
  doc.addEventListener('load', (e) => {
    if (e.target.tagName === 'IMG') renderHighlights();
  }, true);
}

// Image mode: the document is a single image shown directly in the pane (no
// iframe). Comments are anchored to rectangular regions drawn by dragging on
// the image, stored as fractions of the image size so they survive rescaling.
let draftRegionEl = null;

function setupImageMode() {
  frame.hidden = true;
  imageStage.hidden = false;
  const darkToggleLabel = darkPageToggle.closest('.toggle');
  if (darkToggleLabel) darkToggleLabel.hidden = true;
  pageImage.src = docUrl();
  pageImage.addEventListener('load', renderHighlights);
  renderSidebar();

  let drag = null;
  imageOverlay.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.hc-region')) return;
    e.preventDefault();
    popover.hidden = true;
    clearDraftRegion();
    const rect = imageOverlay.getBoundingClientRect();
    drag = { x0: e.clientX - rect.left, y0: e.clientY - rect.top, rect };
    draftRegionEl = document.createElement('div');
    draftRegionEl.className = 'hc-region-draft';
    imageOverlay.appendChild(draftRegionEl);
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    positionRegion(draftRegionEl, dragBox(drag, e));
  });
  window.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const box = dragBox(drag, e);
    const { rect } = drag;
    drag = null;
    // Treat tiny drags as a click: deselect instead of creating a sliver region.
    if (box.w * rect.width < 8 || box.h * rect.height < 8) {
      clearDraftRegion();
      setActiveComment(null);
      return;
    }
    positionRegion(draftRegionEl, box);
    state.pendingAnchor = {
      type: 'region',
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      imageWidth: pageImage.naturalWidth,
      imageHeight: pageImage.naturalHeight,
    };
    const paneRect = document.querySelector('.page-pane').getBoundingClientRect();
    const overlayRect = imageOverlay.getBoundingClientRect();
    popover.style.left = `${overlayRect.left - paneRect.left + box.x * overlayRect.width}px`;
    popover.style.top = `${overlayRect.top - paneRect.top + (box.y + box.h) * overlayRect.height + 6}px`;
    popover.hidden = false;
  });
}

function dragBox(drag, e) {
  const { rect } = drag;
  const x1 = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
  const y1 = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
  return {
    x: Math.min(drag.x0, x1) / rect.width,
    y: Math.min(drag.y0, y1) / rect.height,
    w: Math.abs(x1 - drag.x0) / rect.width,
    h: Math.abs(y1 - drag.y0) / rect.height,
  };
}

// Regions are positioned with percentages so they track the displayed image
// size with no resize listeners.
function positionRegion(el, box) {
  el.style.left = `${box.x * 100}%`;
  el.style.top = `${box.y * 100}%`;
  el.style.width = `${box.w * 100}%`;
  el.style.height = `${box.h * 100}%`;
}

function positionInlineRegion(el, image, box) {
  const rect = image.getBoundingClientRect();
  el.style.left = `${rect.left + box.x * rect.width}px`;
  el.style.top = `${rect.top + box.y * rect.height}px`;
  el.style.width = `${box.w * rect.width}px`;
  el.style.height = `${box.h * rect.height}px`;
}

function inlineImageForAnchor(doc, anchor) {
  const images = Array.from(doc.images);
  const indexed = images[anchor.imageIndex];
  if (indexed && indexed.getAttribute('src') === anchor.imageSrc) return indexed;
  const matching = images.filter((image) => image.getAttribute('src') === anchor.imageSrc);
  return matching[anchor.imageOccurrence || 0] || null;
}

function positionInlineImageHighlights() {
  const doc = frame.contentDocument;
  if (!doc) return;
  for (const el of doc.querySelectorAll('.hc-image-region')) {
    const comment = state.comments.find((candidate) => candidate.id === el.dataset.commentId);
    const image = comment && inlineImageForAnchor(doc, comment.anchor);
    if (image) positionInlineRegion(el, image, comment.anchor);
  }
}

function clearDraftRegion() {
  if (draftRegionEl) {
    draftRegionEl.remove();
    draftRegionEl = null;
  }
}

function renderImageHighlights() {
  imageOverlay.querySelectorAll('.hc-region').forEach((el) => el.remove());
  const hideResolved = hideResolvedToggle.checked;
  for (const c of state.comments) {
    if (!isRegionAnchor(c.anchor)) continue;
    if (hideResolved && c.resolved) continue;
    const el = document.createElement('div');
    el.className =
      'hc-region' +
      (c.resolved ? ' hc-resolved' : '') +
      (c.id === state.activeCommentId ? ' hc-active' : '');
    el.dataset.commentId = c.id;
    positionRegion(el, c.anchor);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      setActiveComment(c.id, { scrollSidebar: true });
    });
    imageOverlay.appendChild(el);
  }
}

function isRegionAnchor(anchor) {
  return !!anchor && typeof anchor.x === 'number' && typeof anchor.y === 'number';
}

function anchorLabel(anchor) {
  if (!isRegionAnchor(anchor)) return truncate(anchor && anchor.quote, 140);
  const pct = (v) => `${Math.round(v * 100)}%`;
  return `Region at ${pct(anchor.x)}, ${pct(anchor.y)} · ${pct(anchor.w)} × ${pct(anchor.h)}`;
}

// Best-effort dark rendering of the document inside the iframe. Many HTML
// artifacts assume a light background, so when "Dark page" is on we invert the
// whole document and re-invert media (images/video/canvas/etc.) so they keep
// their original colors. It's a heuristic, not a real theme — pages that ship
// their own dark styling generally look better with this left off.
function applyDarkPage() {
  // The iframe element's own background lives in the chrome (outside the
  // inverted document), so flip it too — otherwise a transparent or
  // partial-height page shows light behind/around its content.
  frame.style.background = darkPageToggle.checked ? '#161922' : '';
  const doc = frame.contentDocument;
  if (!doc) return;
  const STYLE_ID = 'hc-dark-page';
  let style = doc.getElementById(STYLE_ID);
  if (!darkPageToggle.checked) {
    if (style) style.remove();
    return;
  }
  if (!style) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    (doc.head || doc.documentElement).appendChild(style);
  }
  // Force an opaque LIGHT base so the page-wide invert below turns it dark
  // (a dark base would get inverted back to light). invert() then flips the
  // whole document; media is re-inverted so images/video keep real colors.
  style.textContent = `
    html { background-color: #ffffff !important; filter: invert(0.92) hue-rotate(180deg); }
    img, picture, video, canvas, svg, iframe, embed, object,
    [style*="background-image"], [style*="background: url"], [style*="background:url"] {
      filter: invert(1) hue-rotate(180deg) !important;
    }
  `;
}

function onFrameSelection() {
  const doc = frame.contentDocument;
  const sel = doc.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    popover.hidden = true;
    return;
  }
  const range = sel.getRangeAt(0);
  const anchor = serializeRange(range, doc.body);
  if (!anchor) {
    popover.hidden = true;
    return;
  }
  state.pendingAnchor = anchor;
  document.getElementById('start-comment').textContent = state.reattachCommentId ? '🔗 Re-attach comment' : '💬 Add comment';
  const rect = range.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  popover.style.top = `${frameRect.top + rect.bottom + window.scrollY + 6}px`;
  popover.style.left = `${frameRect.left + rect.left + window.scrollX}px`;
  popover.hidden = false;
}

document.getElementById('start-comment').addEventListener('click', async () => {
  if (!state.pendingAnchor) return;
  popover.hidden = true;
  if (state.reattachCommentId) {
    if (await reattachComment(state.reattachCommentId, state.pendingAnchor)) {
      state.reattachCommentId = null;
      state.pendingAnchor = null;
    }
    return;
  }
  openComposerForNewComment(state.pendingAnchor);
});

async function reattachComment(commentId, anchor) {
  const res = await fetch(`api/file/comments/${commentId}${apiQS}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anchor }),
  });
  if (!res.ok) {
    flash('Failed to re-attach comment');
    return false;
  }
  const updated = await res.json();
  const comment = state.comments.find((c) => c.id === commentId);
  Object.assign(comment, updated);
  delete comment._anchorOrphaned;
  renderHighlights();
  renderSidebar();
  setActiveComment(commentId, { scrollFrame: true, scrollSidebar: true });
  flash('Comment re-attached');
  return true;
}

function openComposerForNewComment(anchor) {
  const existing = commentsList.querySelector('.composer-host');
  if (existing) existing.remove();
  const host = document.createElement('div');
  host.className = 'thread composer-host';
  const composer = composerTemplate.content.firstElementChild.cloneNode(true);
  composer.querySelector('.composer-quote').textContent = isRegionAnchor(anchor)
    ? `📐 ${anchorLabel(anchor)}`
    : `“${truncate(anchor.quote, 140)}”`;
  const ta = composer.querySelector('textarea');
  ta.focus();
  wireMarkdownPreview(ta, composer.querySelector('.markdown-preview'));
  composer.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    host.remove();
    state.pendingAnchor = null;
    clearDraftRegion();
  });
  composer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) return;
    await createComment(anchor, text);
    host.remove();
    state.pendingAnchor = null;
    clearDraftRegion();
  });
  host.appendChild(composer);
  commentsList.prepend(host);
}

async function createComment(anchor, text) {
  const res = await fetch(`api/file/comments${apiQS}`, {
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
  const res = await fetch(`api/file/comments/${commentId}/replies${apiQS}`, {
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
  const res = await fetch(`api/file/comments/${commentId}${apiQS}`, {
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
  const res = await fetch(`api/file/comments/${commentId}${apiQS}`, { method: 'DELETE' });
  if (!res.ok) {
    flash('Failed to delete comment');
    return;
  }
  const data = await res.json();
  state.comments = state.comments.filter((c) => c.id !== commentId);
  state.deletedComments = state.deletedComments.filter((c) => c.id !== commentId);
  state.deletedComments.push(data.comment);
  renderHighlights();
  renderSidebar();
  flash('Comment deleted', {
    label: 'Restore',
    action: () => restoreComment(commentId),
  });
}

async function restoreComment(commentId) {
  const res = await fetch(`api/file/comments/${commentId}${apiQS}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleted: false }),
  });
  if (!res.ok) {
    flash('Failed to restore comment');
    return;
  }
  const comment = await res.json();
  state.deletedComments = state.deletedComments.filter((c) => c.id !== commentId);
  state.comments.push(comment);
  renderHighlights();
  renderSidebar();
  setActiveComment(comment.id, { scrollSidebar: true, scrollFrame: true });
  flash('Comment restored');
}

async function loadDeletedComments() {
  try {
    const res = await fetch(`api/file/comments${apiQS}&status=deleted`);
    if (!res.ok) throw new Error();
    state.deletedComments = (await res.json()).comments;
  } catch {
    flash('Failed to load deleted comments');
  }
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
  if (node !== root && !root.contains(node)) return -1;
  const range = root.ownerDocument.createRange();
  try {
    range.setStart(root, 0);
    range.setEnd(node, offset);
  } catch {
    return -1;
  }
  return collectText(range.cloneContents()).length;
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
  if (isImageDoc()) return renderImageHighlights();
  const doc = frame.contentDocument;
  if (!doc || !doc.body) return;
  clearHighlights();
  doc.querySelectorAll('.hc-image-region').forEach((el) => el.remove());
  const hideResolved = hideResolvedToggle.checked;
  const fullText = collectText(doc.body);
  const resolved = [];
  for (const c of state.comments) {
    if (hideResolved && c.resolved) continue;
    if (isRegionAnchor(c.anchor)) {
      const image = inlineImageForAnchor(doc, c.anchor);
      c._anchorOrphaned = !image;
      if (!image) continue;
      const el = doc.createElement('div');
      el.className =
        'hc-image-region' +
        (c.resolved ? ' hc-resolved' : '') +
        (c.id === state.activeCommentId ? ' hc-active' : '');
      el.dataset.commentId = c.id;
      positionInlineRegion(el, image, c.anchor);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        setActiveComment(c.id, { scrollSidebar: true });
      });
      doc.body.appendChild(el);
      continue;
    }
    const r = c.anchor.stale ? null : AnchorResolver.resolveAnchor(fullText, c.anchor);
    c._anchorOrphaned = !r;
    if (!r) continue;
    resolved.push({ comment: c, startIdx: r.startIdx, length: r.length });
  }
  resolved.sort((a, b) => a.startIdx - b.startIdx);
  for (const r of resolved) {
    applyHighlight(doc.body, r.comment, r.startIdx, r.length);
  }
}

function applyHighlight(root, comment, startIdx, length) {
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

const SVG_NS = 'http://www.w3.org/2000/svg';

function wrapTextNodeRange(node, start, end, comment) {
  const doc = node.ownerDocument;
  const text = node.nodeValue;
  const before = text.slice(0, start);
  const middle = text.slice(start, end);
  const after = text.slice(end);
  // Inside inline SVG an HTML <span> is foreign content the SVG renderer
  // won't draw, which makes the wrapped text vanish — use a <tspan> there.
  const inSvgText = node.parentNode.namespaceURI === SVG_NS;
  const span = inSvgText ? doc.createElementNS(SVG_NS, 'tspan') : doc.createElement('span');
  // setAttribute, not .className — on SVG elements className is a read-only
  // SVGAnimatedString and plain assignment is silently ignored.
  span.setAttribute('class', 'hc-highlight' + (comment.resolved ? ' hc-resolved' : ''));
  span.dataset.commentId = comment.id;
  span.textContent = middle;
  const parent = node.parentNode;
  if (before) parent.insertBefore(doc.createTextNode(before), node);
  parent.insertBefore(span, node);
  if (after) parent.insertBefore(doc.createTextNode(after), node);
  parent.removeChild(node);
}

function renderSidebar() {
  updateAgentDispatch();
  commentsList.innerHTML = '';
  const filter = filterSelect.value;
  let comments = filter === 'deleted' ? [...state.deletedComments] : [...state.comments];
  if (filter === 'open') comments = comments.filter((c) => !c.resolved);
  if (filter === 'resolved') comments = comments.filter((c) => c.resolved);
  comments.sort((a, b) => anchorSortKey(a.anchor) - anchorSortKey(b.anchor));
  if (!comments.length) {
    const empty = document.createElement('div');
    empty.className = 'muted empty';
    empty.textContent = filter === 'deleted'
      ? 'No deleted comments.'
      : isImageDoc()
      ? 'No comments yet. Drag a box on the image to add one.'
      : 'No comments yet. Select text, or drag a box on an image, to add one.';
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
  const deleted = !!comment.deletedAt;
  const orphaned = comment.anchor.stale || comment._anchorOrphaned;
  wrap.className = 'thread' + (comment.resolved ? ' resolved' : '') + (orphaned ? ' orphaned' : '') + (deleted ? ' deleted' : '');
  wrap.dataset.threadId = comment.id;
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('button, textarea, input')) return;
    setActiveComment(comment.id, { scrollFrame: true });
  });
  const quoteHtml = isRegionAnchor(comment.anchor)
    ? `📐 ${escapeHtml(anchorLabel(comment.anchor))}`
    : `“${escapeHtml(truncate(comment.anchor.quote, 140))}”`;
  const header = document.createElement('div');
  header.className = 'thread-header';
  header.innerHTML = `
    <div class="thread-quote">${quoteHtml}${orphaned ? '<span class="orphan-badge">text changed</span>' : ''}${deleted ? '<span class="deleted-badge">deleted</span>' : ''}</div>
    <div class="thread-meta">
      <strong>${escapeHtml(comment.author)}</strong>
      <span>${formatDate(comment.createdAt)}</span>
    </div>
  `;
  wrap.appendChild(header);

  if (orphaned) {
    const notice = document.createElement('div');
    notice.className = 'orphan-notice';
    notice.textContent = isRegionAnchor(comment.anchor)
      ? 'The selected image is no longer in this version of the document, so there is no region to show.'
      : 'The selected text is no longer in this version of the document, so there is no highlight to show.';
    wrap.appendChild(notice);
  }

  const body = document.createElement('div');
  body.className = 'thread-body markdown-body';
  body.innerHTML = renderMarkdown(comment.text);
  wrap.appendChild(body);

  for (const r of comment.replies || []) {
    const reply = document.createElement('div');
    reply.className = 'reply';
    reply.innerHTML = `
      <div class="reply-meta"><strong>${escapeHtml(r.author)}</strong> · ${formatDate(r.createdAt)}</div>
      <div class="reply-body markdown-body"></div>
    `;
    reply.querySelector('.reply-body').innerHTML = renderMarkdown(r.text);
    wrap.appendChild(reply);
  }

  const actions = document.createElement('div');
  actions.className = 'thread-actions';
  if (deleted) {
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'secondary';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', () => restoreComment(comment.id));
    actions.appendChild(restoreBtn);
    wrap.appendChild(actions);
    return wrap;
  }
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
  if (orphaned) {
    const reattachBtn = document.createElement('button');
    reattachBtn.className = 'secondary';
    reattachBtn.textContent = 'Re-attach';
    reattachBtn.title = 'Select replacement text or an image region in the document';
    reattachBtn.addEventListener('click', () => {
      state.reattachCommentId = comment.id;
      state.pendingAnchor = null;
      flash('Select replacement text or drag an image region, then click Re-attach comment.');
      frame.focus();
    });
    actions.appendChild(reattachBtn);
  }
  actions.appendChild(delBtn);
  wrap.appendChild(actions);
  return wrap;
}

function openReplyBox(threadEl, commentId) {
  if (threadEl.querySelector('.reply-composer')) return;
  const box = document.createElement('div');
  box.className = 'reply-composer';
  box.innerHTML = `
    <textarea rows="2" placeholder="Reply… (markdown supported)"></textarea>
    <div class="markdown-preview" hidden></div>
    <div class="composer-actions">
      <span class="composer-hint">Markdown supported</span>
      <button data-action="cancel" class="secondary">Cancel</button>
      <button data-action="save">Reply</button>
    </div>
  `;
  threadEl.appendChild(box);
  const ta = box.querySelector('textarea');
  ta.focus();
  wireMarkdownPreview(ta, box.querySelector('.markdown-preview'));
  box.querySelector('[data-action="cancel"]').addEventListener('click', () => box.remove());
  box.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) return;
    await addReply(commentId, text);
  });
}

function anchorSortKey(anchor) {
  if (isRegionAnchor(anchor)) return (anchor.imageIndex || 0) * 1e9 + anchor.y * 1e6 + anchor.x * 1e3;
  return anchor && typeof anchor.startIdx === 'number' ? anchor.startIdx : 0;
}

function setActiveComment(commentId, opts = {}) {
  state.activeCommentId = commentId;
  if (isImageDoc()) {
    imageOverlay.querySelectorAll('.hc-region.hc-active').forEach((el) => el.classList.remove('hc-active'));
    if (commentId) {
      const target = imageOverlay.querySelector(`.hc-region[data-comment-id="${commentId}"]`);
      if (target) {
        target.classList.add('hc-active');
        if (opts.scrollFrame) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }
  const doc = frame.contentDocument;
  if (doc && !isImageDoc()) {
    doc.querySelectorAll('.hc-highlight.hc-active, .hc-image-region.hc-active').forEach((el) => el.classList.remove('hc-active'));
    if (commentId) {
      const target = doc.querySelector(`.hc-highlight[data-comment-id="${commentId}"], .hc-image-region[data-comment-id="${commentId}"]`);
      if (target) {
        target.classList.add('hc-active');
        if (opts.scrollFrame) {
          const comment = state.comments.find((candidate) => candidate.id === commentId);
          const image = comment && isRegionAnchor(comment.anchor) && inlineImageForAnchor(doc, comment.anchor);
          (image || target).scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
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

function encodePath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}

// renderMarkdown comes from /markdown.js (shared with the server).

function wireMarkdownPreview(textarea, previewEl) {
  if (!textarea || !previewEl) return;

  const showPreview = () => {
    const val = textarea.value;
    if (!val.trim()) return;
    previewEl.innerHTML = renderMarkdown(val);
    previewEl.hidden = false;
    textarea.hidden = true;
  };

  const showEditor = () => {
    textarea.hidden = false;
    previewEl.hidden = true;
    textarea.focus();
  };

  textarea.addEventListener('blur', () => {
    setTimeout(() => {
      if (!document.body.contains(textarea)) return;
      if (document.activeElement === textarea) return;
      showPreview();
    }, 0);
  });

  previewEl.addEventListener('click', showEditor);
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
function flash(msg, option) {
  let el = document.getElementById('flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash';
    el.className = 'flash';
    document.body.appendChild(el);
  }
  el.replaceChildren(document.createTextNode(msg));
  el.classList.toggle('has-action', !!option);
  if (option) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = option.label;
    button.addEventListener('click', () => {
      el.classList.remove('visible');
      option.action();
    }, { once: true });
    el.appendChild(button);
  }
  el.classList.add('visible');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('visible'), option ? 6000 : 1600);
}
