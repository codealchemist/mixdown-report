/** Renders each part of the page from app state. Each function owns one container. */
import { BANDS, THRESHOLDS } from '../core/profiles.js';
import { SEVERITY, meterStates } from '../core/evaluate.js';
import { formatTime, num, signed } from '../core/format.js';
import { h, mount } from './dom.js';

const SEVERITY_CLASS = { critical: 'crit', warning: 'warn', note: 'info' };
const STATE_CLASS = { good: 'good', warning: 'warn', critical: 'crit', '': '' };

/** @param {{ kind: 'busy'|'error'|'info', text: string, progress?: number, tag?: string }[]} items */
export function renderStatus(el, items) {
  mount(el, items.map((it) => {
    if (it.tag) return h('span', { class: 'tag', text: it.tag });
    const span = h('span', { class: it.kind === 'busy' ? 'busy' : it.kind === 'error' ? 'err' : '', text: it.text });
    if (it.kind !== 'busy' || it.progress == null) return span;
    return [span, h('progress', { max: 1, value: it.progress.toFixed(3), 'aria-label': 'Analysis progress' })];
  }));
}

export function fileSummary(entry) {
  const a = entry.analysis;
  return [
    formatTime(a.duration),
    `${(a.sampleRate / 1000).toFixed(a.sampleRate % 1000 ? 1 : 0)} kHz`,
    entry.meta.bitDepth ? `${entry.meta.bitDepth}-bit` : '',
    a.channelCount === 2 ? 'stereo' : 'mono',
    entry.meta.format,
  ].filter(Boolean).join(' · ');
}

/**
 * @param {import('../core/analyze.js').Analysis|null} [previous] analysis before the last reload; adds "since last" changes
 */
export function renderMeters(el, a, ev, ref, previous = null) {
  const states = meterStates(a, ev);
  const master = ev.stage === 'master';
  const vsRef = (v, unit = '') => (ref ? ` · ref ${v}${unit}` : '');
  const stereo = a.channelCount === 2;
  const tiles = [
    ['loudness', 'Integrated loudness', num(a.integrated), 'LUFS', (master ? `Target ${num(ev.target.lufs, 0)} LUFS` : 'Set during mastering') + vsRef(num(ref?.integrated))],
    ['truePeak', 'True peak', num(a.truePeakDb), 'dBTP', (master ? `Ceiling ${num(ev.target.truePeak)} dBTP` : 'Aim for −6 to −3 before mastering') + (a.clippedRuns ? ` · ${a.clippedRuns} clipped runs` : '')],
    ['plr', 'Peak to loudness', num(a.plr), 'dB', (master ? '8–12 typical for streaming' : 'Above 12 means dynamics intact') + vsRef(num(ref?.plr), ' dB')],
    ['range', 'Loudness range', num(a.loudnessRange), 'LU', 'Quiet vs loud sections' + vsRef(num(ref?.loudnessRange), ' LU')],
    ['correlation', 'Stereo correlation', stereo ? signed(a.correlation, 2) : '–', '', stereo ? `Below 120 Hz: ${signed(a.lowCorrelation, 2)}` : 'Mono file'],
    ['width', 'Side vs center', stereo ? num(a.widthDb) : '–', stereo ? 'dB' : '', stereo ? 'Higher is wider' + vsRef(num(ref?.widthDb), ' dB') : 'Mono file'],
  ];
  const fields = { loudness: 'integrated', truePeak: 'truePeakDb', plr: 'plr', range: 'loudnessRange', correlation: 'correlation', width: 'widthDb' };
  const change = (key) => {
    const field = fields[key];
    const before = previous?.[field];
    const now = a[field];
    if (!Number.isFinite(before) || !Number.isFinite(now)) return null;
    const digits = key === 'correlation' ? 2 : 1;
    const delta = now - before;
    return Math.abs(delta) < 0.5 * 10 ** -digits ? 'No change since last' : `${signed(delta, digits)} since last`;
  };
  mount(el, tiles.map(([key, label, value, unit, sub]) =>
    h('div', { class: `meter ${STATE_CLASS[states[key]]}` },
      h('span', { class: 'k', text: label }),
      h('span', { class: 'val' }, value, unit && h('small', { text: unit })),
      h('span', { class: 'sub', text: sub }),
      previous && change(key) && h('span', { class: 'delta', text: change(key) }))));
}

export function renderBands(el, ev) {
  const span = 12; // dB at full bar height
  mount(el, BANDS.map((band, i) => {
    const d = ev.deviations[i];
    const severity = Math.abs(d) > ev.tolerance + THRESHOLDS.severeMargin ? 'crit' : Math.abs(d) > ev.tolerance ? 'warn' : '';
    const height = `${(Math.min(Math.abs(d), span) / span) * 50}%`;
    const style = d >= 0 ? { bottom: '50%', height } : { top: '50%', height };
    return h('div', { class: `band ${severity}` },
      h('div', { class: 'bar', role: 'img', 'aria-label': `${band.name} ${signed(d)} dB` }, h('div', { class: 'fill', style })),
      h('span', { class: 'bd', text: signed(d) }),
      h('span', { class: 'bn', text: band.name }),
      h('span', { class: 'bf', text: band.range }));
  }));
}

export function renderFindings(el, countEl, ev) {
  countEl.textContent = ev.findings.length ? `${ev.findings.length} item${ev.findings.length > 1 ? 's' : ''}` : '';
  mount(el,
    ev.findings.map((f) =>
      h('article', { class: 'rec' },
        h('div', { class: 'rec-h' },
          h('span', { class: `pill ${SEVERITY_CLASS[f.severity]}`, text: SEVERITY[f.severity].label }),
          h('span', { class: 'k', text: f.area })),
        h('h3', { text: f.title }),
        h('p', { text: f.detail }),
        f.steps.length && [h('span', { class: 'k logic-k', text: 'In Logic Pro' }), h('ul', { class: 'logic' }, f.steps.map((s) => h('li', { text: s })))])),
    !ev.findings.length && h('p', { class: 'note', text: 'Nothing stands out. Trust your ears and compare against a reference.' }),
    ev.ok.length && h('div', { class: 'oklist-wrap' },
      h('span', { class: 'k', text: 'Looks good' }),
      h('div', { class: 'oklist' }, ev.ok.map((o) => h('span', { class: 'pill good', text: o })))));
}

export function renderChain(listEl, titleEl, altEl, ev) {
  titleEl.textContent = ev.stage === 'mix' ? 'When you master this mix' : 'Adjust your mastering chain';
  mount(listEl, ev.chain.map((step, i) =>
    h('li', {},
      h('span', { class: 'slot', text: `Insert ${i + 1}` }),
      h('span', { class: 'plug', text: step.plugin }),
      h('ul', {}, step.settings.map((s) => h('li', { text: s }))))));
  altEl.textContent = ev.assistant;
}

/** Fills a <select> from a profile map. */
export function fillSelect(select, entries, describe = (v) => v.name) {
  mount(select, Object.entries(entries).map(([value, entry]) => h('option', { value, text: describe(entry) })));
}
