/**
 * Editable Channel EQ band table, laid out like Logic's band strip.
 * The editor keeps its own copy of the model and reports every committed edit through onChange,
 * without re-rendering itself, so focus and typing are never interrupted.
 */
import { BAND_INFO, BAND_KEYS, LIMITS, SLOPES, cloneEq, formatFreq, normalizeEq } from '../core/eq/channel-eq.js';
import { h } from './dom.js';

let uid = 0;

/**
 * @param {object} eq Channel EQ model
 * @param {{ onChange: (eq: object) => void, label: string }} options
 * @returns {HTMLElement}
 */
export function eqEditor(eq, { onChange, label }) {
  const id = `eq${++uid}`;
  let model = cloneEq(eq);
  const commit = () => {
    model = normalizeEq(model);
    onChange(cloneEq(model));
  };

  const number = (key, field, [min, max], step, value, aria) => h('input', {
    type: 'number', id: `${id}-${key}-${field}`, min, max, step, value: String(value), inputmode: 'decimal', 'aria-label': aria,
    onchange: (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) { e.target.value = String(model.bands[key][field]); return; }
      model.bands[key][field] = v;
      commit();
      e.target.value = String(model.bands[key][field]);
    },
  });

  const rows = BAND_KEYS.map((key) => {
    const band = model.bands[key];
    const { label: bandLabel, kind } = BAND_INFO[key];
    const name = `${label} ${bandLabel}`;
    return h('tr', { class: band.on ? '' : 'off' },
      h('td', {}, h('input', {
        type: 'checkbox', id: `${id}-${key}-on`, checked: band.on, 'aria-label': `${name} on`,
        onchange: (e) => { model.bands[key].on = e.target.checked; e.target.closest('tr').classList.toggle('off', !e.target.checked); commit(); },
      })),
      h('th', { scope: 'row', text: bandLabel }),
      h('td', {}, number(key, 'freq', LIMITS.freq, 1, band.freq, `${name} frequency in hertz`)),
      h('td', {}, kind === 'cut'
        ? h('select', {
            id: `${id}-${key}-slope`, 'aria-label': `${name} slope`,
            onchange: (e) => { model.bands[key].slope = Number(e.target.value); commit(); },
          }, SLOPES.map((s) => h('option', { value: s, selected: s === band.slope, text: `${s} dB/Oct` })))
        : number(key, 'gain', LIMITS.gain, 0.5, band.gain, `${name} gain in dB`)),
      h('td', {}, number(key, 'q', LIMITS.q, 0.01, band.q, `${name} Q`)));
  });

  return h('div', { class: 'eq-editor' },
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'On' }), h('th', { scope: 'col', text: 'Band' }), h('th', { scope: 'col', text: 'Freq (Hz)' }), h('th', { scope: 'col', text: 'Gain / slope' }), h('th', { scope: 'col', text: 'Q' }))),
      h('tbody', {}, rows),
      h('tfoot', {}, h('tr', {},
        h('td', {}),
        h('th', { scope: 'row', text: 'Gain' }),
        h('td', { colspan: 2 }, h('input', {
          type: 'number', id: `${id}-gain`, min: LIMITS.outputGain[0], max: LIMITS.outputGain[1], step: 0.5, value: String(model.outputGain), 'aria-label': `${label} output gain in dB`,
          onchange: (e) => { model.outputGain = Number(e.target.value) || 0; commit(); e.target.value = String(model.outputGain); },
        })),
        h('td', {})))));
}

/** Compact read-only summary of the active bands, e.g. "LC 90 · 276 −5.5 · HC 11k". */
export function eqSummary(eq) {
  const parts = [];
  for (const key of BAND_KEYS) {
    const b = eq.bands[key];
    if (!b.on) continue;
    const kind = BAND_INFO[key].kind;
    if (kind === 'cut') parts.push(`${key === 'lowCut' ? 'Low cut' : 'High cut'} ${formatFreq(b.freq)}`);
    else if (b.gain) parts.push(`${formatFreq(b.freq)} ${b.gain > 0 ? '+' : '−'}${Math.abs(b.gain)}`);
  }
  return parts.join(' · ') || 'Flat';
}
