async function loadPages() {
  const res = await fetch('/api/pages');
  const { pages } = await res.json();
  const list = document.getElementById('pages-list');
  list.innerHTML = '';
  if (!pages.length) {
    list.innerHTML = '<li class="muted">No pages yet.</li>';
    return;
  }
  for (const p of pages) {
    const li = document.createElement('li');
    const open = p.openCount;
    const total = p.commentCount;
    li.innerHTML = `
      <a href="/p/${p.id}"><strong>${escapeHtml(p.title)}</strong></a>
      <span class="meta">${new Date(p.createdAt).toLocaleString()} · ${open} open / ${total} total</span>
      <button class="link-button" data-id="${p.id}" data-action="delete">Delete</button>
    `;
    list.appendChild(li);
  }
  list.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this page and its comments?')) return;
      await fetch(`/api/pages/${btn.dataset.id}`, { method: 'DELETE' });
      loadPages();
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

document.getElementById('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const fd = new FormData(form);
  const file = form.file.files[0];
  const html = (form.html.value || '').trim();
  if (!file && !html) {
    document.getElementById('upload-result').textContent = 'Provide a file or paste HTML.';
    return;
  }
  const res = await fetch('/api/pages', { method: 'POST', body: fd });
  const out = document.getElementById('upload-result');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    out.textContent = 'Error: ' + (err.error || res.statusText);
    return;
  }
  const { id, viewerUrl } = await res.json();
  out.innerHTML = `Created: <a href="${viewerUrl}">${location.origin}${viewerUrl}</a>`;
  form.reset();
  loadPages();
});

loadPages();
