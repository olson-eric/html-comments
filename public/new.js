// Blank-canvas markdown editor: write, preview, then publish to a new path
// through the regular upload API and open the result in the viewer.
const pathInput = document.getElementById('doc-path');
const source = document.getElementById('document-source');
const preview = document.getElementById('editor-preview');
const status = document.getElementById('editor-status');
const saveBtn = document.getElementById('editor-save');

const folder = (new URLSearchParams(location.search).get('folder') || '').replace(/^\/+|\/+$/g, '');
if (folder) document.getElementById('back').href = `./?folder=${encodeURIComponent(folder)}`;
let saving = false;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function encodePath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle('editor-error', error);
}

// Normalize to a relative .md path: trims slashes, appends .md if no
// markdown extension was given.
function targetPath() {
  let p = pathInput.value.trim().replace(/^\/+/, '');
  if (!p || p.endsWith('/')) return null;
  if (!/\.(md|markdown)$/i.test(p)) p += '.md';
  return p;
}

function previewBase() {
  const p = targetPath() || '';
  const dir = p.includes('/') ? `${encodePath(p.slice(0, p.lastIndexOf('/')))}/` : '';
  return new URL(`raw/${dir}`, document.baseURI).toString();
}

function renderPreview() {
  preview.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base href="${escapeHtml(previewBase())}"><style>
    body { max-width: 840px; margin: 0 auto; padding: 2.5rem 2rem 4rem; color: #1f2328; background: #fff; font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; }
    h1 { font-size: 1.9em; } h2 { font-size: 1.45em; } h3 { font-size: 1.2em; }
    h1, h2 { border-bottom: 1px solid #d8dee4; padding-bottom: 0.3em; }
    p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
    a { color: #0969da; } img { max-width: 100%; }
    code { background: rgba(175,184,193,.2); padding: .1em .35em; border-radius: 4px; font: .88em ui-monospace, monospace; }
    pre { overflow-x: auto; padding: .8em 1em; border-radius: 8px; background: #f6f8fa; }
    pre code { padding: 0; background: none; } blockquote { border-left: 4px solid #d8dee4; padding-left: 1em; color: #59636e; }
    table { border-collapse: collapse; } th, td { border: 1px solid #d8dee4; padding: .35em .8em; text-align: left; }
    .empty { color: #8c959f; font-style: italic; }
  </style></head><body>${source.value.trim() ? renderMarkdown(source.value, { breaks: false }) : '<p class="empty">Nothing to preview yet.</p>'}</body></html>`;
}

let previewTimer = null;
source.addEventListener('input', () => {
  setStatus('');
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
});
pathInput.addEventListener('input', () => setStatus(''));

source.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    source.setRangeText('  ', source.selectionStart, source.selectionEnd, 'end');
    source.dispatchEvent(new Event('input'));
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    create();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (!saving && source.value.trim()) e.preventDefault();
});
saveBtn.addEventListener('click', create);

async function create() {
  if (saveBtn.disabled) return;
  const rel = targetPath();
  if (!rel) {
    setStatus('Enter a file name', true);
    pathInput.focus();
    return;
  }
  if (!source.value.trim()) {
    setStatus('Document cannot be empty', true);
    source.focus();
    return;
  }
  saveBtn.disabled = true;
  setStatus('Creating…');
  try {
    // Never silently replace an existing document from the blank canvas.
    const existing = await fetch(`api/file?path=${encodeURIComponent(rel)}`);
    if (existing.ok) {
      setStatus(`${rel} already exists — pick another name`, true);
      pathInput.focus();
      return;
    }
    const res = await fetch(`api/upload/${encodePath(rel)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: source.value,
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(result.error || `Create failed (${res.status})`, true);
      return;
    }
    saving = true;
    location.href = `v/${encodePath(result.path)}`;
  } catch {
    setStatus('Create failed', true);
  } finally {
    saveBtn.disabled = false;
  }
}

async function init() {
  let home = '';
  try {
    const info = await (await fetch('api/root')).json();
    if (!info.uploadsEnabled) {
      setStatus('Creating documents is disabled on this server (UPLOADS_ENABLED)', true);
      saveBtn.disabled = true;
    }
    home = (info.identity && info.identity.home) || '';
  } catch {}
  const dir = folder || home;
  pathInput.value = `${dir ? `${dir}/` : ''}untitled.md`;
  renderPreview();
  source.focus();
}
init();
