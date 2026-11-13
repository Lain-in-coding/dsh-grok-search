// Constructed sheets are document-scoped; never adopt an iframe's sheet into
// another document. Each module generation retains at most one cached variant.
const sheets = new WeakMap();

export function attachSharedStyles(root, css) {
  const document = root.ownerDocument;
  const Constructor = document?.defaultView?.CSSStyleSheet;
  let sheet;
  if (typeof Constructor === 'function' && 'adoptedStyleSheets' in root) {
    try {
      const cached = sheets.get(document);
      if (cached?.css === css) sheet = cached.sheet;
      else {
        sheet = new Constructor();
        sheet.replaceSync(css);
        sheets.set(document, { css, sheet });
      }
      if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        root.adoptedStyleSheets = root.adoptedStyleSheets.filter(candidate => candidate !== sheet);
      };
    } catch {
      // Feature detection alone is insufficient (older/CSP-constrained hosts).
      // Retain the exact original style-element path without changing CSS.
    }
  }
  const style = document.createElement('style');
  style.textContent = css;
  root.prepend(style);
  return () => style.remove();
}
