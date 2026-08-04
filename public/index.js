// All URLs are relative; the server injects a <base href> pointing at the app
// root, so everything resolves correctly wherever the app is mounted
// (BASE_PATH env var).
let lastTreeEtag = null;

let serverInfo = { uploadsEnabled: false, identity: null };

async function loadRoot() {
  const res = await fetch('api/root');
  const info = await res.json();
  serverInfo = info;
  document.getElementById('root-path').textContent = info.root;
  document.getElementById('root-name').textContent = info.name;
  if (info.uploadsEnabled) {
    document.getElementById('upload').hidden = false;
    // Lazy home folder: nothing is created at login — the signed-in user's
    // folder is only suggested here and comes into existence on first upload.
    if (info.identity && info.identity.home) {
      document.getElementById('upload-dest').value = info.identity.home;
    }
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

async function loadTree() {
  try {
    const res = await fetch('api/tree');
    if (!res.ok) return;
    const tree = await res.json();
    const etag = JSON.stringify(tree) + (showArchivedToggle.checked ? ':a' : '');
    if (etag === lastTreeEtag) return;
    lastTreeEtag = etag;
    showArchivedWrap.hidden = !tree.children.some(hasArchived);
    const container = document.getElementById('tree');
    container.innerHTML = '';
    if (!tree.children.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No .html, .md, or image files found in this directory.';
      container.appendChild(empty);
      return;
    }
    container.appendChild(renderChildren(tree.children, 0));
  } catch {}
}

function renderChildren(children, depth) {
  const ul = document.createElement('ul');
  ul.className = 'tree-list';
  for (const node of children) {
    if (!isVisible(node)) continue;
    ul.appendChild(renderNode(node, depth));
  }
  return ul;
}

async function apiMove(from, to) {
  const res = await fetch('api/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(`Rename failed: ${err.error || res.status}`);
  }
  lastTreeEtag = null;
  loadTree();
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
  const current = node.type === 'file' ? node.file : node.path;
  btn('Rename or move', '✎', () => {
    const to = prompt(node.type === 'file' ? 'New file path (with extension):' : 'New folder path:', current);
    if (to && to !== current) apiMove(current, to.trim());
  });
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
    const open = depth < 1;
    const header = document.createElement('div');
    header.className = 'tree-row tree-dir-row';
    header.innerHTML = `
      <span class="tree-twisty">${open ? '▾' : '▸'}</span>
      <span class="tree-icon">📁</span>
      <span class="tree-name">${escapeHtml(node.name)}</span>
    `;
    if (serverInfo.uploadsEnabled) header.appendChild(nodeActions(node));
    li.appendChild(header);
    const kids = renderChildren(node.children, depth + 1);
    if (!open) kids.hidden = true;
    li.appendChild(kids);
    header.addEventListener('click', () => {
      kids.hidden = !kids.hidden;
      header.querySelector('.tree-twisty').textContent = kids.hidden ? '▸' : '▾';
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
    const icon = { html: '📄', markdown: '📝', image: '🖼️' }[node.kind] || '📄';
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

document.getElementById('upload').addEventListener('click', () => {
  pendingFiles = [];
  renderPendingFiles();
  setUploadStatus('');
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
    if (!pendingFiles.some((p) => p.name === f.name)) pendingFiles.push(f);
  }
  renderPendingFiles();
}

function renderPendingFiles() {
  uploadList.innerHTML = '';
  for (const f of pendingFiles) {
    const li = document.createElement('li');
    li.textContent = `${f.name} (${formatBytes(f.size)})`;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'linklike';
    rm.textContent = 'remove';
    rm.addEventListener('click', () => {
      pendingFiles = pendingFiles.filter((p) => p !== f);
      renderPendingFiles();
    });
    li.appendChild(rm);
    uploadList.appendChild(li);
  }
  uploadGo.disabled = pendingFiles.length === 0;
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
  for (const f of pendingFiles) {
    const res = await fetch(`api/file?path=${encodeURIComponent(destPathFor(f.name))}`);
    if (res.ok) existing.push(f.name);
  }
  if (existing.length && !confirm(`This will replace: ${existing.join(', ')}. Continue?`)) {
    uploadGo.disabled = false;
    setUploadStatus('');
    return;
  }

  const failures = [];
  let done = 0;
  for (const f of pendingFiles) {
    setUploadStatus(`Uploading ${f.name} (${++done}/${pendingFiles.length})…`);
    try {
      const res = await fetch(`api/upload/${encodePath(destPathFor(f.name))}`, {
        method: 'PUT',
        body: f,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        failures.push(`${f.name}: ${err.error || res.status}`);
      }
    } catch (e) {
      failures.push(`${f.name}: ${e.message}`);
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
