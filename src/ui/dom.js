/**
 * Tiny element builder. Children are appended as nodes or text, never parsed as HTML,
 * so file names and other text can't inject markup, and the page works under a strict CSP.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style') for (const [p, v] of Object.entries(value)) el.style.setProperty(p, v);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

export const $ = (selector, root = document) => root.querySelector(selector);

/** Replaces all children of `el`. */
export function mount(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}
