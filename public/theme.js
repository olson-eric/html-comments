// Shared light/dark theme controller for the html-comments chrome.
// The initial theme is applied by a tiny inline script in each page's <head>
// (to avoid a flash of the wrong theme); this file wires up the toggle button
// and keeps the stored preference in sync.
(function () {
  const KEY = 'hc:theme';

  function systemTheme() {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  function current() {
    return document.documentElement.dataset.theme || stored() || systemTheme();
  }

  function apply(theme) {
    document.documentElement.dataset.theme = theme;
  }

  function setTheme(theme) {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {}
    updateButtons();
  }

  function toggle() {
    setTheme(current() === 'dark' ? 'light' : 'dark');
  }

  function updateButtons() {
    const dark = current() === 'dark';
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.textContent = dark ? '☀️' : '🌙';
      const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
      btn.title = label;
      btn.setAttribute('aria-label', label);
    });
  }

  // Follow the OS theme as long as the user hasn't made an explicit choice.
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!stored()) {
        apply(e.matches ? 'dark' : 'light');
        updateButtons();
      }
    });
  } catch {}

  function init() {
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      btn.addEventListener('click', toggle);
    });
    updateButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.HCTheme = { setTheme, toggle, current };
})();
