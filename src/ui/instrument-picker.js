/** Instrument quick filter (ARIA combobox) and a grouped instrument <select>. */
import { GROUPS, INSTRUMENTS, filterInstruments } from '../core/eq/instruments.js';
import { h, mount } from './dom.js';

let uid = 0;

/**
 * Type to filter, arrow keys to move, Enter to add. Focus stays in the field so several tracks can be added quickly.
 * @param {{ onPick: (instrumentId: string) => void }} options
 */
export function instrumentPicker({ onPick }) {
  const id = `picker${++uid}`;
  let matches = [];
  let active = 0;

  const list = h('ul', { class: 'picker-list', id: `${id}-list`, role: 'listbox', 'aria-label': 'Instruments', hidden: true });
  const input = h('input', {
    type: 'text', id: `${id}-input`, class: 'picker-input', role: 'combobox', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Add a track: type an instrument (gtr, vox, kick…)',
    'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-list`,
  });

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const pick = (inst) => {
    if (!inst) return;
    onPick(inst.id);
    input.value = '';
    render();
  };
  const render = () => {
    matches = filterInstruments(input.value);
    active = Math.min(active, Math.max(0, matches.length - 1));
    mount(list, matches.length
      ? matches.map((inst, i) => h('li', {
          id: `${id}-opt-${inst.id}`, role: 'option', class: i === active ? 'active' : '', 'aria-selected': String(i === active),
          onmousedown: (e) => { e.preventDefault(); pick(inst); },
        }, h('span', { text: inst.name }), h('span', { class: 'picker-group', text: inst.group })))
      : h('li', { class: 'picker-empty', text: 'No instrument matches. Try "FX / other".' }));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (matches[active]) {
      input.setAttribute('aria-activedescendant', `${id}-opt-${matches[active].id}`);
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    }
  };

  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('focus', render);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return render();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % Math.max(1, matches.length);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(matches[active]);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  return h('div', { class: 'picker' }, h('label', { class: 'sr-only', for: `${id}-input`, text: 'Add a track by instrument' }), input, list);
}

/** Grouped instrument <select>; `null` value shows a "Choose instrument" prompt. */
export function instrumentSelect(value, { id, label, onChange }) {
  return h('select', { id, 'aria-label': label, onchange: (e) => onChange(e.target.value || null) },
    h('option', { value: '', text: 'Choose instrument…', selected: !value, disabled: Boolean(value) }),
    GROUPS.map((group) => h('optgroup', { label: group },
      INSTRUMENTS.filter((i) => i.group === group).map((i) => h('option', { value: i.id, text: i.name, selected: i.id === value })))));
}
