/**
 * "Measure Logic's Channel EQ": downloads the test noise, takes the bounce back, shows how Logic's
 * Channel EQ compares with the app's model, and stores the correction used for every export.
 */
import { CALIBRATION_EQ, PstError, decodeChannelEq, encodeChannelEq } from '../core/eq/pst.js';
import { num } from '../core/format.js';
import { CancelledError } from '../audio/job-runner.js';
import { decodeFile } from '../audio/decode.js';
import { drawCalibration } from './charts.js';
import { downloadBytes } from './download.js';
import { $, h, mount } from './dom.js';
import { loadCalibrationPanelHidden, loadCalibrationResult, saveCalibrationPanelHidden, saveCalibrationResult } from './storage.js';

const VERDICT = { ready: ['Ready to use', 'good'], unusable: ['Can\'t be used', 'crit'] };
const TONE = { good: 'good', note: 'info', warning: 'warn', critical: 'crit' };
const FACTORS = ['bellQ', 'bellGain', 'shelfQ', 'shelfGain', 'cutQ'];
const isIdentity = (c) => FACTORS.every((k) => Math.abs((c[k] ?? 1) - 1) <= 0.05);

/**
 * @param {HTMLElement} root
 * @param {{ renderJobs: import('../audio/job-runner.js').JobRunner, calibration: () => object|null, onChange: (calibration: object|null) => void }} deps
 */
export function createCalibrationSection(root, deps) {
  const el = {
    state: $('#calState', root),
    reset: $('#calReset', root),
    noise: $('#calNoise', root),
    presetUsed: $('#calPresetUsed', root),
    pstInput: $('#calPstInput', root),
    pstName: $('#calPstName', root),
    drop: $('#calDrop', root),
    bounceInput: $('#calBounceInput', root),
    progress: $('#calProgress', root),
    result: $('#calResult', root),
    toggle: $('#calToggle', root),
    body: $('#calBody', root),
  };
  let presetRaw = decodeChannelEq(encodeChannelEq(CALIBRATION_EQ)).eq; // what the calibration preset file stores
  let presetLabel = 'Mixdown Calibration';
  let last = loadCalibrationResult(); // the last measurement, kept across reloads

  const progress = (text, f = null, error = false) => mount(el.progress, text && [
    h('span', { class: error ? 'err' : f != null ? 'busy' : '', text }),
    f != null && h('progress', { max: 1, value: f.toFixed(3) }),
  ]);

  function renderState() {
    const c = deps.calibration();
    el.reset.hidden = !c;
    el.state.classList.toggle('on', Boolean(c));
    if (!c) {
      el.state.textContent = "Not measured yet. Exported presets assume Logic's Channel EQ behaves like the app's model.";
      return;
    }
    const when = new Date(c.measuredAt).toLocaleDateString([], { dateStyle: 'medium' });
    el.state.textContent = isIdentity(c)
      ? `Measured ${when}: Logic's Channel EQ matches the app's model (within ${num(c.rmsAfter, 2)} dB), so exports need no correction.`
      : `In use since ${when}: every exported preset is converted so your Logic's Channel EQ reproduces the curve tested here (bell Q ×${num(c.bellQ, 2)}, bell gain ×${num(c.bellGain, 2)}, shelf Q ×${num(c.shelfQ, 2)}, shelf gain ×${num(c.shelfGain, 2)}, cut Q ×${num(c.cutQ ?? 1, 2)}).`;
  }

  el.reset.addEventListener('click', () => {
    deps.onChange(null);
    renderState();
  });

  el.noise.addEventListener('click', async () => {
    try {
      progress('Writing the test noise', 0);
      const { bytes } = await deps.renderJobs.run('cal-noise', { type: 'testSignal' }, [], () => {});
      downloadBytes(bytes, 'Mixdown test noise (48k 24-bit).wav', 'audio/wav');
      progress('');
    } catch (error) {
      progress(`Couldn't write the test noise: ${error.message}`, null, true);
    }
  });

  el.presetUsed.addEventListener('change', () => {
    if (el.presetUsed.value === 'file') el.pstInput.click();
    else {
      presetRaw = decodeChannelEq(encodeChannelEq(CALIBRATION_EQ)).eq;
      presetLabel = 'Mixdown Calibration';
      el.pstName.textContent = '';
    }
  });
  el.pstInput.addEventListener('change', async () => {
    const file = el.pstInput.files?.[0];
    el.pstInput.value = '';
    if (!file) return;
    try {
      presetRaw = decodeChannelEq(new Uint8Array(await file.arrayBuffer())).eq;
      presetLabel = file.name.replace(/\.pst$/i, '');
      el.pstName.textContent = `Using ${file.name}`;
    } catch (error) {
      el.presetUsed.value = 'calibration';
      el.pstName.textContent = error instanceof PstError ? error.message : `Couldn't read ${file.name}.`;
    }
  });

  async function measure(file) {
    if (!file) return;
    mount(el.result);
    try {
      progress(`Reading ${file.name}`, 0);
      const { channels, sampleRate } = await decodeFile(file);
      const result = await deps.renderJobs.run('calibrate', { type: 'calibrate', channels, sampleRate, raw: presetRaw }, channels.map((c) => c.buffer), (label, f) => progress(label, f));
      last = { result, sampleRate, preset: presetLabel, measuredAt: Date.now() };
      saveCalibrationResult(last);
      renderResult();
      progress('');
    } catch (error) {
      if (error instanceof CancelledError) return;
      console.error(error);
      progress(error.message || `Couldn't measure ${file.name}.`, null, true);
    }
  }

  el.bounceInput.addEventListener('change', () => {
    measure(el.bounceInput.files?.[0]);
    el.bounceInput.value = '';
  });
  el.drop.addEventListener('dragover', (e) => { e.preventDefault(); el.drop.classList.add('over'); });
  el.drop.addEventListener('dragleave', () => el.drop.classList.remove('over'));
  el.drop.addEventListener('drop', (e) => {
    e.preventDefault();
    el.drop.classList.remove('over');
    measure(e.dataTransfer?.files?.[0]);
  });

  function renderResult() {
    if (!last) return mount(el.result);
    const { result: r, sampleRate, preset } = last;
    const [label, tone] = VERDICT[r.status];
    const canvas = h('canvas', { id: 'calCurve', role: 'img', 'aria-label': "Logic's measured Channel EQ response compared with the app's model" });
    const apply = () => {
      deps.onChange({ ...r.calibration, measuredAt: last.measuredAt ?? Date.now(), sampleRate, rmsAfter: r.rmsAfter });
      renderState();
      renderResult();
    };
    const current = deps.calibration();
    const applied = current && FACTORS.every((k) => (current[k] ?? 1) === (r.calibration[k] ?? 1));
    mount(el.result,
      h('div', { class: 'test-card' },
        h('div', { class: 'test-head' },
          h('span', { class: `pill ${tone}`, text: label }),
          h('span', { class: 'k', text: `${preset} · ${sampleRate / 1000} kHz bounce${last.measuredAt ? ` · measured ${new Date(last.measuredAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''} · app model vs Logic: ${num(r.rmsBefore, 2)} dB → ${num(r.rmsAfter, 2)} dB after correction` })),
        h('ul', { class: 'test-messages' }, r.messages.map((m) => h('li', { class: TONE[m.severity], text: m.text }))),
        h('div', { class: 'legend cal-legend' }, h('span', { text: 'Logic (measured)' }), h('span', { class: 'before', text: 'App model before' }), h('span', { class: 'after', text: 'App model corrected' })),
        canvas,
        r.bandChecks.length > 0 && h('table', { class: 'compare' },
          h('thead', {}, h('tr', {}, ['Band', 'In the preset', 'App model', 'Measured in Logic', ''].map((t) => h('th', { scope: 'col', text: t })))),
          h('tbody', {}, r.bandChecks.map((b) => h('tr', { class: b.missing ? 'off' : '' },
            h('th', { scope: 'row', text: b.label }),
            h('td', { text: `${b.freq} Hz, ${b.gain > 0 ? '+' : ''}${num(b.gain)} dB` }),
            h('td', { text: `${num(b.intended)} dB` }),
            h('td', { text: `${num(b.measured)} dB` }),
            h('td', { class: `mark ${b.missing ? 'crit' : 'good'}`, text: b.missing ? '✕' : '✓', 'aria-label': b.missing ? 'missing' : 'present' }))))),
        h('div', { class: 'actions' },
          r.usable
            ? applied
              ? h('span', { class: 'pill good', text: 'In use for all exports' })
              : h('button', { type: 'button', class: 'btn', text: 'Use this calibration for all exports', onclick: apply })
            : h('span', { class: 'note', text: "This measurement can't be used for corrections. Fix the problems above and bounce again." }),
          r.usable && !applied && h('span', { class: 'note', text: "Using it doesn't change how EQs are suggested or tested here; it converts each exported preset so Logic plays exactly the curve you tested." }))));
    requestAnimationFrame(() => drawCalibration(canvas, r.curves));
  }

  /** Hides or shows everything but the title and the status line. */
  function setHidden(hidden, { remember = true } = {}) {
    el.body.hidden = hidden;
    el.toggle.textContent = hidden ? 'Show' : 'Hide';
    el.toggle.setAttribute('aria-expanded', String(!hidden));
    if (remember) saveCalibrationPanelHidden(hidden);
    if (!hidden) requestAnimationFrame(() => { // canvases have no size while hidden
      const canvas = el.result.querySelector('#calCurve');
      if (canvas && last) drawCalibration(canvas, last.result.curves);
    });
  }
  el.toggle.addEventListener('click', () => setHidden(!el.body.hidden));

  renderState();
  renderResult();
  // Until the user chooses, keep the panel out of the way once a calibration is in use
  setHidden(loadCalibrationPanelHidden() ?? Boolean(deps.calibration()), { remember: false });
  return {
    /** Shows the panel, for example when a bounce check suggests measuring Logic's Channel EQ. */
    show() {
      setHidden(false);
    },
    redraw() {
      const canvas = el.result.querySelector('#calCurve');
      if (canvas && last) drawCalibration(canvas, last.result.curves);
    },
  };
}
