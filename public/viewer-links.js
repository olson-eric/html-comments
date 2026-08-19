// Resolve links from a rendered document back to a document in the viewer's
// file tree. Shared as a small module so the URL handling can be unit tested.
(function (global) {
  'use strict';

  function findDocument(tree, candidate) {
    for (const child of (tree && tree.children) || []) {
      if (child.type === 'dir') {
        const match = findDocument(child, candidate);
        if (match) return match;
      } else if (child.path === candidate || child.file === candidate) {
        return child;
      }
    }
    return null;
  }

  function documentPathForLink(href, origin, appRoot, tree) {
    let url;
    try {
      url = new URL(href, origin);
    } catch {
      return null;
    }
    if (url.origin !== origin) return null;

    const routedPrefixes = ['raw/', 'render/', 'v/'].map((route) => `${appRoot}${route}`);
    const routedPrefix = routedPrefixes.find((prefix) => url.pathname.startsWith(prefix));
    let encodedPath;
    if (routedPrefix) encodedPath = url.pathname.slice(routedPrefix.length);
    else if (url.pathname.startsWith(appRoot)) encodedPath = url.pathname.slice(appRoot.length);
    else encodedPath = url.pathname.replace(/^\/+/, '');

    let candidate;
    try {
      candidate = decodeURIComponent(encodedPath);
    } catch {
      return null;
    }
    const document = findDocument(tree, candidate);
    return document ? document.path : null;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { documentPathForLink };
  } else {
    global.documentPathForLink = documentPathForLink;
  }
})(typeof window !== 'undefined' ? window : globalThis);
