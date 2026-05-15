let lastTreeEtag = null;

async function loadRoot() {
  const res = await fetch('/api/root');
  const { root, name } = await res.json();
  document.getElementById('root-path').textContent = root;
  document.getElementById('root-name').textContent = name;
}

async function loadTree() {
  try {
    const res = await fetch('/api/tree');
    if (!res.ok) return;
    const tree = await res.json();
    const etag = JSON.stringify(tree);
    if (etag === lastTreeEtag) return;
    lastTreeEtag = etag;
    const container = document.getElementById('tree');
    container.innerHTML = '';
    if (!tree.children.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No .html files found in this directory.';
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
    ul.appendChild(renderNode(node, depth));
  }
  return ul;
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
    a.href = `/v?path=${encodeURIComponent(node.path)}`;
    const badge = node.openCount > 0
      ? `<span class="badge badge-open" title="${node.openCount} open / ${node.commentCount} total">${node.openCount}</span>`
      : node.commentCount > 0
        ? `<span class="badge badge-resolved" title="${node.commentCount} comment(s), all resolved">${node.commentCount}</span>`
        : '';
    a.innerHTML = `
      <span class="tree-twisty"></span>
      <span class="tree-icon">📄</span>
      <span class="tree-name">${escapeHtml(node.name)}</span>
      ${badge}
    `;
    li.appendChild(a);
  }
  return li;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

document.getElementById('refresh').addEventListener('click', loadTree);

loadRoot();
loadTree();
setInterval(loadTree, 10000);
