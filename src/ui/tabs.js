/**
 * Tabbed navigation: one section of the app at a time, no scrolling between sections.
 * Follows the ARIA tabs pattern (arrow keys, Home and End move between tabs), keeps the open tab
 * in the address (#analysis, #release…) so reloads and links reopen it, and shows status badges.
 */

const DEFAULT_TAB = 'analysis';

/**
 * @param {HTMLElement} tablist element with role="tablist" containing role="tab" buttons
 * @param {{ onChange?: (tab: string) => void }} [options]
 */
export function createTabs(tablist, { onChange = () => {} } = {}) {
  const buttons = [...tablist.querySelectorAll('[role="tab"]')];
  const ids = buttons.map((b) => b.dataset.tab);
  const panelOf = (id) => document.getElementById(`tab-${id}`);
  let current = null;

  function select(id, { focus = false, updateAddress = true } = {}) {
    if (!ids.includes(id)) id = DEFAULT_TAB;
    for (const b of buttons) {
      const on = b.dataset.tab === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      panelOf(b.dataset.tab).hidden = !on;
    }
    const button = buttons[ids.indexOf(id)];
    if (focus) button.focus();
    // keep the selected tab visible when the bar scrolls sideways on narrow screens
    tablist.scrollTo({ left: Math.max(0, button.offsetLeft - tablist.clientWidth / 2 + button.offsetWidth / 2), behavior: 'auto' });
    if (updateAddress && location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
    window.scrollTo({ top: 0 });
    const changed = id !== current;
    current = id;
    if (changed) onChange(id);
  }

  tablist.addEventListener('click', (e) => {
    const button = e.target.closest('[role="tab"]');
    if (button) select(button.dataset.tab);
  });
  tablist.addEventListener('keydown', (e) => {
    const i = ids.indexOf(current);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(ids[(next + ids.length) % ids.length], { focus: true });
  });
  // Links and buttons elsewhere can open a tab: <button data-goto="help">
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-goto]');
    if (link) select(link.dataset.goto, { focus: true });
  });
  window.addEventListener('hashchange', () => select(location.hash.slice(1), { updateAddress: false }));

  select(location.hash.slice(1) || DEFAULT_TAB, { updateAddress: false });

  return {
    select,
    get current() {
      return current;
    },
    /**
     * Sets or hides a tab's badge.
     * @param {string} name matches data-badge in the markup
     * @param {{ text: string, tone?: 'good'|'warn'|'crit'|'info', label?: string } | null} badge
     */
    setBadge(name, badge) {
      const el = tablist.querySelector(`[data-badge="${name}"]`);
      if (!el) return;
      el.hidden = !badge;
      if (!badge) return;
      el.textContent = badge.text;
      el.className = `nav-badge ${badge.tone ?? 'info'}`;
      if (badge.label) el.setAttribute('aria-label', badge.label);
      else el.removeAttribute('aria-label');
    },
  };
}
