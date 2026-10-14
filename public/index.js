// All URLs are relative; the server injects a <base href> pointing at the app
// root, so everything resolves correctly wherever the app is mounted
// (BASE_PATH env var).
let lastTreeEtag = null;

let serverInfo = { uploadsEnabled: false, identity: null };
document.getElementById('agent-server-url').textContent = new URL('.', document.baseURI).toString().replace(/\/$/, '');

async function loadRoot() {
  const res = await fetch('api/root');
  const info = await res.json();
  serverInfo = info;
  document.getElementById('root-path').textContent = info.root;
  document.getElementById('root-name').textContent = info.name;
  if (info.uploadsEnabled) {
    document.getElementById('upload').hidden = false;
    document.getElementById('new-markdown').hidden = false;
    // Lazy home folder: nothing is created at login — the signed-in user's
    // folder is only suggested (outside a folder view) and comes into
    // existence on first upload.
    updateFolderLinks();
    // Signed-in uploads default to private (unless the deployment overrides
    // DEFAULT_VISIBILITY); say so up front rather than surprising people.
    if (info.identity && info.defaultVisibility === 'private') {
      document.getElementById('upload-privacy-hint').hidden = false;
    }
  }
}

const showArchivedWrap = document.getElementById('show-archived-wrap');
const showArchivedToggle = document.getElementById('show-archived');
showArchivedToggle.checked = localStorage.getItem('hc:showArchived') === '1';
showArchivedToggle.addEventListener('change', () => {
  localStorage.setItem('hc:showArchived', showArchivedToggle.checked ? '1' : '0');
  lastTreeEtag = null;
  loadTree();
});

function hasArchived(node) {
  if (node.type === 'file') return !!node.archived;
  return node.children.some(hasArchived);
}

function isVisible(node) {
  if (node.type === 'file') return showArchivedToggle.checked || !node.archived;
  return node.children.some(isVisible);
}

// ----- Folder view + sorting -----
// The current folder lives in ?folder= so a folder view is linkable and the
// back button works; '' is the root.
function currentFolder() {
  return (new URLSearchParams(location.search).get('folder') || '').replace(/^\/+|\/+$/g, '');
}

function folderHref(dir) {
  return dir ? `?folder=${encodeURIComponent(dir)}` : './';
}

function navigateToFolder(dir) {
  history.pushState(null, '', folderHref(dir));
  onFolderChange();
}

window.addEventListener('popstate', onFolderChange);

function onFolderChange() {
  lastTreeEtag = null;
  updateFolderLinks();
  loadTree();
}

// New markdown / upload default to the folder being viewed.
function updateFolderLinks() {
  const folder = currentFolder();
  document.getElementById('new-markdown').href = folder ? `new?folder=${encodeURIComponent(folder)}` : 'new';
  const home = serverInfo.identity && serverInfo.identity.home;
  document.getElementById('upload-dest').value = folder || home || '';
}

const sortSelect = document.getElementById('sort');
sortSelect.value = localStorage.getItem('hc:sort') || 'name';
if (!sortSelect.value) sortSelect.value = 'name';
sortSelect.addEventListener('change', () => {
  localStorage.setItem('hc:sort', sortSelect.value);
  lastTreeEtag = null;
  loadTree();
});

function openCountOf(node) {
  if (node.type === 'file') return node.openCount || 0;
  return node.children.reduce((n, c) => n + openCountOf(c), 0);
}

// Newest first for timestamps; folders stay above files so the layout is
// stable, but within each group the chosen order applies.
const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name),
  activity: (a, b) => (b.activityAt || '').localeCompare(a.activityAt || '') || a.name.localeCompare(b.name),
  modified: (a, b) => (latestModified(b) || '').localeCompare(latestModified(a) || '') || a.name.localeCompare(b.name),
  comments: (a, b) => openCountOf(b) - openCountOf(a) || SORTS.activity(a, b),
};

function latestModified(node) {
  if (node.type === 'file') return node.modifiedAt;
  return node.children.map(latestModified).filter(Boolean).sort().pop() || null;
}

function sortedChildren(children) {
  const cmp = SORTS[sortSelect.value] || SORTS.name;
  return [...children].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return cmp(a, b);
  });
}

function findDir(tree, dir) {
  if (!dir) return tree;
  let node = tree;
  for (const seg of dir.split('/')) {
    node = node.children.find((c) => c.type === 'dir' && c.name === seg);
    if (!node) return null;
  }
  return node;
}

function renderBreadcrumbs(dir) {
  const nav = document.getElementById('breadcrumbs');
  nav.innerHTML = '';
  const h2 = document.createElement('h2');
  const segs = dir ? dir.split('/') : [];
  const crumb = (label, target, current) => {
    if (current) {
      const span = document.createElement('span');
      span.className = 'crumb-current';
      span.textContent = label;
      return span;
    }
    const a = document.createElement('a');
    a.href = folderHref(target);
    a.textContent = label;
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      navigateToFolder(target);
    });
    return a;
  };
  h2.appendChild(crumb(serverInfo.name || 'Files', '', !segs.length));
  segs.forEach((seg, i) => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    h2.append(sep, crumb(seg, segs.slice(0, i + 1).join('/'), i === segs.length - 1));
  });
  nav.appendChild(h2);
  document.title = dir ? `${segs[segs.length - 1]} — html-comments` : 'html-comments';
}

async function loadTree() {
  try {
    const res = await fetch('api/tree');
    if (!res.ok) return;
    const tree = await res.json();
    const folder = currentFolder();
    const etag = JSON.stringify(tree) + (showArchivedToggle.checked ? ':a' : '') + `:${sortSelect.value}:${folder}`;
    if (etag === lastTreeEtag) return;
    lastTreeEtag = etag;
    renderBreadcrumbs(folder);
    const node = findDir(tree, folder);
    const container = document.getElementById('tree');
    container.innerHTML = '';
    showArchivedWrap.hidden = !(node && node.children.some(hasArchived));
    if (!node || !node.children.some(isVisible)) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = !node
        ? 'This folder is empty or no longer exists.'
        : folder
          ? 'No documents in this folder.'
          : 'No .html, .md, .json, .jsonl, .pdf, or image files found in this directory.';
      container.appendChild(empty);
      return;
    }
    container.appendChild(renderChildren(node.children, 0));
  } catch {}
}

function renderChildren(children, depth) {
  const ul = document.createElement('ul');
  ul.className = 'tree-list';
  for (const node of sortedChildren(children)) {
    if (!isVisible(node)) continue;
    ul.appendChild(renderNode(node, depth));
  }
  return ul;
}

function timeAgo(iso) {
  if (!iso) return '';
  const mins = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function rowTime(node) {
  const iso = sortSelect.value === 'modified' ? latestModified(node) : node.activityAt;
  if (!iso) return '';
  const what = sortSelect.value === 'modified'
    ? 'Last updated'
    : node.type === 'file' && node.lastCommentAt && node.lastCommentAt === node.activityAt ? 'Last comment' : 'Last activity';
  return `<span class="tree-time" title="${what}: ${escapeHtml(new Date(iso).toLocaleString())}">${timeAgo(iso)}</span>`;
}

async function apiMove(from, to) {
  const res = await fetch('api/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  lastTreeEtag = null;
  await loadTree();
}

async function apiArchive(docPath, archived) {
  const res = await fetch(`api/archive?path=${encodeURIComponent(docPath)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(`${archived ? 'Archive' : 'Unarchive'} failed: ${err.error || res.status}`);
  }
  lastTreeEtag = null;
  loadTree();
}

// Per-row actions (rename / archive), shown on hover when uploads are enabled.
const renameDialog = document.getElementById('rename-dialog');
const renameForm = document.getElementById('rename-form');
const renameTitle = document.getElementById('rename-title');
const renamePath = document.getElementById('rename-path');
const renameStatus = document.getElementById('rename-status');
const renameSave = document.getElementById('rename-save');
let renameFrom = '';

function openRenameDialog(node) {
  renameFrom = node.type === 'file' ? node.file : node.path;
  renameTitle.textContent = node.type === 'file' ? 'Rename or move file' : 'Rename or move folder';
  renamePath.value = renameFrom;
  renamePath.setAttribute('aria-label', node.type === 'file' ? 'New file path with extension' : 'New folder path');
  renameStatus.hidden = true;
  renameStatus.textContent = '';
  renameSave.disabled = false;
  renameDialog.showModal();
  renamePath.focus();
  renamePath.select();
}

document.getElementById('rename-cancel').addEventListener('click', () => renameDialog.close());
renameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const to = renamePath.value.trim();
  renameStatus.hidden = true;
  if (!to) {
    renameStatus.textContent = 'Enter a new path.';
    renameStatus.hidden = false;
    renamePath.focus();
    return;
  }
  if (to === renameFrom) {
    renameDialog.close();
    return;
  }
  renameSave.disabled = true;
  try {
    await apiMove(renameFrom, to);
    renameDialog.close();
  } catch (err) {
    renameStatus.textContent = `Rename failed: ${err.message}`;
    renameStatus.hidden = false;
    renameSave.disabled = false;
    renamePath.focus();
  }
});

function nodeActions(node) {
  const span = document.createElement('span');
  span.className = 'tree-actions';
  const btn = (title, glyph, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tree-action';
    b.title = title;
    b.textContent = glyph;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    span.appendChild(b);
  };
  btn('Rename or move', '✎', () => openRenameDialog(node));
  if (node.type === 'file') {
    if (node.archived) btn('Unarchive', '↩', () => apiArchive(node.path, false));
    else btn('Archive (hides from the tree; link and comments stay)', '🗄', () => apiArchive(node.path, true));
  }
  return span;
}

function renderNode(node, depth) {
  const li = document.createElement('li');
  li.className = `tree-node tree-${node.type}`;
  if (node.type === 'dir') {
    // Clicking a folder opens a view of just that folder; the twisty still
    // expands it inline for a quick peek.
    const header = document.createElement('a');
    header.className = 'tree-row tree-dir-row';
    header.href = folderHref(node.path);
    header.innerHTML = `
      <button type="button" class="tree-twisty" aria-label="Expand ${escapeHtml(node.name)}">▸</button>
      <span class="tree-icon">📁</span>
      <span class="tree-name">${escapeHtml(node.name)}</span>
      ${rowTime(node)}
    `;
    if (serverInfo.uploadsEnabled) header.appendChild(nodeActions(node));
    li.appendChild(header);
    let kids = null;
    const twisty = header.querySelector('.tree-twisty');
    twisty.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!kids) {
        kids = renderChildren(node.children, depth + 1);
        kids.hidden = true;
        li.appendChild(kids);
      }
      kids.hidden = !kids.hidden;
      twisty.textContent = kids.hidden ? '▸' : '▾';
    });
    header.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigateToFolder(node.path);
    });
  } else {
    const a = document.createElement('a');
    a.className = 'tree-row tree-file-row';
    a.href = `v/${encodePath(node.path)}`;
    const badge = node.openCount > 0
      ? `<span class="badge badge-open" title="${node.openCount} open / ${node.commentCount} total">${node.openCount}</span>`
      : node.commentCount > 0
        ? `<span class="badge badge-resolved" title="${node.commentCount} comment(s), all resolved">${node.commentCount}</span>`
        : '';
    const icon = { html: '📄', markdown: '📝', json: '🔢', pdf: '📕', image: '🖼️' }[node.kind] || '📄';
    if (node.archived) a.classList.add('archived');
    // The server only returns docs this viewer can read; the lock just marks
    // ones that are restricted (private to you, or shared with a list).
    const lock = node.visibility
      ? `<span class="badge badge-restricted" title="${node.visibility === 'private' ? 'Private' : 'Shared with specific people'}">🔒</span>`
      : '';
    a.innerHTML = `
      <span class="tree-twisty"></span>
      <span class="tree-icon">${icon}</span>
      <span class="tree-name">${escapeHtml(node.name)}</span>
      ${lock}
      ${node.archived ? '<span class="badge badge-archived">archived</span>' : ''}
      ${rowTime(node)}
      ${badge}
    `;
    if (serverInfo.uploadsEnabled) a.appendChild(nodeActions(node));
    li.appendChild(a);
  }
  return li;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function encodePath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}

document.getElementById('refresh').addEventListener('click', loadTree);

// ----- Upload dialog -----
const uploadDialog = document.getElementById('upload-dialog');
const uploadDest = document.getElementById('upload-dest');
const uploadDrop = document.getElementById('upload-drop');
const uploadFilesInput = document.getElementById('upload-files');
const uploadList = document.getElementById('upload-list');
const uploadStatus = document.getElementById('upload-status');
const uploadGo = document.getElementById('upload-go');
let pendingFiles = [];

document.getElementById('upload-form').addEventListener('submit', (e) => e.preventDefault());

document.getElementById('upload').addEventListener('click', () => {
  pendingFiles = [];
  renderPendingFiles();
  setUploadStatus('');
  updateFolderLinks();
  uploadDialog.showModal();
});
document.getElementById('upload-cancel').addEventListener('click', () => uploadDialog.close());
document.getElementById('upload-browse').addEventListener('click', () => uploadFilesInput.click());
uploadDrop.addEventListener('click', (e) => {
  if (e.target.id !== 'upload-browse') uploadFilesInput.click();
});
uploadFilesInput.addEventListener('change', () => {
  addFiles(uploadFilesInput.files);
  uploadFilesInput.value = '';
});
uploadDrop.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadDrop.classList.add('dragging');
});
uploadDrop.addEventListener('dragleave', () => uploadDrop.classList.remove('dragging'));
uploadDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadDrop.classList.remove('dragging');
  addFiles(e.dataTransfer.files);
});

function addFiles(fileList) {
  for (const f of fileList) {
    if (!pendingFiles.some((p) => p.name === f.name)) pendingFiles.push({ file: f, name: f.name });
  }
  renderPendingFiles();
}

function renderPendingFiles() {
  uploadList.innerHTML = '';
  for (const pending of pendingFiles) {
    const li = document.createElement('li');
    const details = document.createElement('div');
    details.className = 'upload-file-details';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = pending.name;
    input.setAttribute('aria-label', `Upload filename for ${pending.file.name}`);
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('input', () => {
      pending.name = input.value;
      updateUploadButton();
    });
    const size = document.createElement('span');
    size.className = 'upload-file-size';
    size.textContent = formatBytes(pending.file.size);
    details.append(input, size);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'linklike';
    rm.textContent = 'remove';
    rm.addEventListener('click', () => {
      pendingFiles = pendingFiles.filter((p) => p !== pending);
      renderPendingFiles();
    });
    li.append(details, rm);
    uploadList.appendChild(li);
  }
  updateUploadButton();
}

function updateUploadButton() {
  const names = pendingFiles.map((p) => p.name.trim());
  uploadGo.disabled = !names.length || names.some((name) => !name || name.includes('/') || name.includes('\\')) || new Set(names).size !== names.length;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function setUploadStatus(text) {
  uploadStatus.textContent = text;
  uploadStatus.hidden = !text;
}

function destPathFor(fileName) {
  const dest = uploadDest.value.trim().replace(/^\/+|\/+$/g, '');
  return dest ? `${dest}/${fileName}` : fileName;
}

uploadGo.addEventListener('click', async () => {
  if (!pendingFiles.length) return;
  uploadGo.disabled = true;
  setUploadStatus('Checking…');

  // Overwrites are the update flow, but never silent: list what already
  // exists and confirm once.
  const existing = [];
  for (const pending of pendingFiles) {
    const name = pending.name.trim();
    const res = await fetch(`api/file?path=${encodeURIComponent(destPathFor(name))}`);
    if (res.ok) existing.push(name);
  }
  if (existing.length && !confirm(`This will replace: ${existing.join(', ')}. Continue?`)) {
    uploadGo.disabled = false;
    setUploadStatus('');
    return;
  }

  const failures = [];
  let done = 0;
  for (const pending of pendingFiles) {
    const name = pending.name.trim();
    setUploadStatus(`Uploading ${name} (${++done}/${pendingFiles.length})…`);
    try {
      const res = await fetch(`api/upload/${encodePath(destPathFor(name))}`, {
        method: 'PUT',
        body: pending.file,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        failures.push(`${name}: ${err.error || res.status}`);
      }
    } catch (e) {
      failures.push(`${name}: ${e.message}`);
    }
  }
  uploadGo.disabled = false;
  if (failures.length) {
    setUploadStatus(`Failed — ${failures.join('; ')}`);
  } else {
    uploadDialog.close();
    loadTree();
  }
});

// Tree rendering depends on serverInfo (action buttons), so resolve the root
// before the first render.
loadRoot()
  .catch(() => {})
  .finally(loadTree);
setInterval(loadTree, 10000);
