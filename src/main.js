/** App entry: owns state, wires inputs, and re-renders when state changes. */
import { GENRES, STAGES, TARGETS } from './core/profiles.js';
import { evaluate } from './core/evaluate.js';
import { loudnessSeries, spectrumSeries } from './core/series.js';
import { reportText } from './core/report.js';
import { num } from './core/format.js';
import { AnalysisClient, CancelledError } from './audio/analysis-client.js';
import { decodeFile } from './audio/decode.js';
import { renderDemo } from './audio/demo.js';
import { FileSource, canPickWithHandle, pickFile, sourceFromDrop } from './audio/file-source.js';
import { $ } from './ui/dom.js';
import { drawLoudness, drawSpectrum } from './ui/charts.js';
import { loadSettings, saveSettings } from './ui/storage.js';
import { fileSummary, fillSelect, renderBands, renderChain, renderFindings, renderMeters, renderStatus } from './ui/view.js';

/**
 * @typedef {object} Entry
 * @property {import('./core/analyze.js').Analysis} analysis
 * @property {import('./core/analyze.js').Analysis|null} previous analysis before the last reload, for "since last" changes
 * @property {{ format: string, bitDepth: number, lossy: boolean }} meta
 * @property {string} name
 * @property {boolean} demo
 * @property {Date} analyzedAt
 */
const state = {
  settings: loadSettings(),
  /** @type {Entry|null} */ mix: null,
  /** @type {Entry|null} */ ref: null,
  /** @type {FileSource|null} the mix file, kept for reloading */ mixSource: null,
  /** @type {ReturnType<typeof evaluate>|null} */ evaluation: null,
  busy: { mix: false, ref: false },
  userFileChosen: false, // stops the example from replacing a file the user picked
};

const SLOT_LABEL = { mix: 'Mix', ref: 'Reference' };
const REF_PLACEHOLDER = 'A released song you want to sound like';
const client = new AnalysisClient();
const el = {
  status: $('#status'),
  stage: $('#stage'),
  genre: $('#genre'),
  target: $('#target'),
  fileMix: $('#fileMix'),
  fileRef: $('#fileRef'),
  mixName: $('#mixName'),
  refName: $('#refName'),
  reloadMix: $('#reloadMix'),
  clearRef: $('#clearRef'),
  meters: $('#meters'),
  bands: $('#bands'),
  spec: $('#specCv'),
  loud: $('#loudCv'),
  cmpLegend: $('#cmpLegend'),
  tolLegend: $('#tolLegend'),
  specNote: $('#specNote'),
  findings: $('#recs'),
  findingsCount: $('#recCount'),
  chain: $('#chain'),
  chainTitle: $('#chainTitle'),
  chainAlt: $('#chainAlt'),
  copyBtn: $('#copyBtn'),
  copyMsg: $('#copyMsg'),
  copyOut: $('#copyOut'),
};

const clock = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/* ---------- rendering ---------- */

/** @param {{ kind: 'info'|'error', text: string }} [notice] a one-off message shown after the file details */
function render(notice) {
  updateReloadButton();
  const mix = state.mix;
  if (!mix) return;
  const ref = state.ref?.analysis ?? null;
  const ev = evaluate(mix.analysis, state.settings, { reference: ref, file: mix.meta });
  state.evaluation = ev;

  renderStatus(el.status, [
    ...(mix.demo ? [{ tag: 'Example' }] : []),
    { kind: 'info', text: mix.demo ? 'Generated demo loop. Drop your own bounce to replace it.' : mix.name },
    { kind: 'info', text: fileSummary(mix) },
    ...(mix.demo ? [] : [{ kind: 'info', text: `${mix.previous ? 'Reloaded' : 'Analyzed'} ${clock(mix.analyzedAt)}` }]),
    ...(state.ref ? [{ kind: 'info', text: `Reference: ${state.ref.name}` }] : []),
    ...(notice ? [notice] : []),
  ]);
  renderMeters(el.meters, mix.analysis, ev, ref, mix.previous);
  renderBands(el.bands, ev);
  renderFindings(el.findings, el.findingsCount, ev);
  renderChain(el.chain, el.chainTitle, el.chainAlt, ev);

  el.cmpLegend.textContent = ref ? 'Reference' : `${ev.genre.name} curve`;
  el.tolLegend.textContent = `±${ev.tolerance} dB`;
  el.specNote.textContent = ref
    ? 'Both tracks are level-matched, so only the shape of the balance is compared. Bars show how far each range sits from the reference.'
    : `Bars show how far each range sits from an approximate ${ev.genre.name} curve averaged from typical releases. A reference track in your style gives a sharper comparison.`;
  drawCharts();
}

function drawCharts() {
  const mix = state.mix;
  const ev = state.evaluation;
  if (!mix || !ev) return;
  const a = mix.analysis;
  drawSpectrum(el.spec, spectrumSeries(a, ev, state.ref?.analysis ?? null), ev.tolerance);
  drawLoudness(el.loud, loudnessSeries(a), {
    duration: a.duration,
    integrated: a.integrated,
    target: ev.stage === 'master' ? ev.target.lufs : undefined,
  });
}

function updateReloadButton() {
  el.reloadMix.hidden = !state.mixSource;
  el.reloadMix.disabled = state.busy.mix;
  el.reloadMix.textContent = state.busy.mix ? 'Analyzing…' : 'Reload mix';
  if (!state.busy.mix) el.reloadMix.append(' ', Object.assign(document.createElement('kbd'), { textContent: 'R' }));
}

/* ---------- loading ---------- */

async function analyzeInto(slot, { channels, sampleRate }, entry) {
  const label = SLOT_LABEL[slot];
  const analysis = await client.run(slot, channels, sampleRate, (step, fraction) =>
    renderStatus(el.status, [{ kind: 'busy', text: `${label}: ${step}`, progress: fraction }]));
  state[slot] = { previous: null, ...entry, analysis, analyzedAt: new Date() };
  render();
}

/**
 * @param {'mix'|'ref'} slot
 * @param {FileSource|null} source
 * @param {{ reload?: boolean }} [options] reload keeps the previous analysis for comparison
 */
async function loadSource(slot, source, { reload = false } = {}) {
  if (!source) return;
  if (slot === 'mix') state.userFileChosen = true;
  state.busy[slot] = true;
  updateReloadButton();
  renderStatus(el.status, [{ kind: 'busy', text: `Reading ${source.name}` }]);
  try {
    const file = await source.read();
    const decoded = await decodeFile(file);
    const previous = reload ? state[slot]?.analysis ?? null : null;
    await analyzeInto(slot, decoded, { meta: decoded.meta, name: file.name, demo: false, previous });
    if (slot === 'mix') {
      state.mixSource = source.withFile(file);
      el.mixName.textContent = file.name;
    } else {
      el.refName.textContent = file.name;
      el.clearRef.hidden = false;
    }
  } catch (error) {
    if (error instanceof CancelledError) return;
    console.error(error);
    const text = error.name === 'NotReadableError'
      ? `This browser can't re-read ${source.name} after it changed. Choose the file again.`
      : error.message || `Couldn't analyze ${source.name}.`;
    renderStatus(el.status, [{ kind: 'error', text }]);
  } finally {
    state.busy[slot] = false;
    updateReloadButton();
  }
}

/** Re-reads the mix from disk and analyzes it again, keeping the previous result for comparison. */
async function reloadMix() {
  const source = state.mixSource;
  if (!source || state.busy.mix) return;
  let file;
  try {
    file = await source.read();
  } catch {
    render({ kind: 'error', text: `This browser can't re-read ${source.name} after it changed. Choose the file again.` });
    openPicker('mix');
    return;
  }
  if (source.isUnchanged(file)) {
    render({ kind: 'info', text: `No changes since ${clock(state.mix.analyzedAt)}. Bounce again in Logic, then reload.` });
    return;
  }
  await loadSource('mix', source.withFile(file), { reload: true });
}

async function loadDemo() {
  renderStatus(el.status, [{ kind: 'busy', text: 'Building an example analysis' }]);
  try {
    const demo = await renderDemo();
    if (state.userFileChosen) return;
    await analyzeInto('mix', demo, { meta: { format: '', bitDepth: 0, lossy: false }, name: 'Example demo loop', demo: true });
  } catch (error) {
    if (error instanceof CancelledError) return;
    console.error(error);
    renderStatus(el.status, [{ kind: 'info', text: 'Drop a bounce from Logic Pro to start.' }]);
  }
}

/* ---------- inputs ---------- */

const nativePickerAllowed = new WeakSet();

/** Opens a picker for a slot: the handle-based one where supported, otherwise the file input. */
function openPicker(slot) {
  const input = slot === 'mix' ? el.fileMix : el.fileRef;
  if (!canPickWithHandle()) return input.click();
  pickFile().then(
    (source) => loadSource(slot, source),
    (error) => {
      if (error.name === 'AbortError') return; // user cancelled
      nativePickerAllowed.add(input); // e.g. blocked in an iframe: fall back to the plain input
      input.click();
    },
  );
}

function wireDropZone(zone, input, slot) {
  // Clicking the zone (or pressing Enter/Space on the input) opens the picker that can keep a file handle.
  input.addEventListener('click', (e) => {
    if (nativePickerAllowed.delete(input) || !canPickWithHandle()) return;
    e.preventDefault();
    openPicker(slot);
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) loadSource(slot, new FileSource(file));
    input.value = '';
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    sourceFromDrop(e.dataTransfer).then((source) => loadSource(slot, source));
  });
}

function wireReload() {
  el.reloadMix.addEventListener('click', reloadMix);
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'r' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.target instanceof HTMLElement && e.target.closest('input, select, textarea, [contenteditable]')) return;
    if (!state.mixSource) return;
    e.preventDefault();
    reloadMix();
  });
}

function wireSettings() {
  fillSelect(el.stage, STAGES);
  fillSelect(el.genre, GENRES);
  fillSelect(el.target, TARGETS, (t) => `${t.name} (${num(t.lufs, 0)} LUFS)`);
  for (const key of ['stage', 'genre', 'target']) {
    el[key].value = state.settings[key];
    el[key].addEventListener('change', () => {
      state.settings = { ...state.settings, [key]: el[key].value };
      saveSettings(state.settings);
      render();
    });
  }
}

function wireCopy() {
  el.copyBtn.addEventListener('click', async () => {
    if (!state.mix || !state.evaluation) return;
    const text = reportText(state.mix.analysis, state.evaluation, {
      name: state.mix.demo ? 'example demo loop' : state.mix.name,
      referenceName: state.ref?.name,
    });
    try {
      await navigator.clipboard.writeText(text);
      el.copyOut.hidden = true;
      el.copyMsg.textContent = 'Copied';
    } catch {
      el.copyOut.value = text;
      el.copyOut.hidden = false;
      el.copyOut.select();
      el.copyMsg.textContent = 'Select all and copy the text below';
    }
  });
}

function wireRedraw() {
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(drawCharts);
  };
  new ResizeObserver(schedule).observe(el.spec.parentElement);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule);
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

wireDropZone($('#dropMix'), el.fileMix, 'mix');
wireDropZone($('#dropRef'), el.fileRef, 'ref');
el.clearRef.addEventListener('click', () => {
  client.cancel('ref');
  state.ref = null;
  el.clearRef.hidden = true;
  el.refName.textContent = REF_PLACEHOLDER;
  render();
});
wireReload();
wireSettings();
wireCopy();
wireRedraw();
loadDemo();
