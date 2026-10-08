/** App entry: owns state, wires inputs, and re-renders when state changes. */
import { GENRES, STAGES, TARGETS } from './core/profiles.js';
import { evaluate } from './core/evaluate.js';
import { loudnessSeries, spectrumSeries } from './core/series.js';
import { reportText } from './core/report.js';
import { num } from './core/format.js';
import { CancelledError, JobRunner } from './audio/job-runner.js';
import { decodeFile } from './audio/decode.js';
import { renderDemo } from './audio/demo.js';
import { FileSource, canPickWithHandle, pickFile, sourceFromDrop } from './audio/file-source.js';
import { SLOTS, forgetFiles, needsPermission, recallFile, rememberFile, reopen } from './audio/file-memory.js';
import { h, mount } from './ui/dom.js';
import { EqPreview } from './audio/eq-preview.js';
import { createEqSection } from './ui/eq-section.js';
import { createReleaseSection } from './ui/release-section.js';
import { createMasterSection } from './ui/master-section.js';
import { createTabs } from './ui/tabs.js';
import { $ } from './ui/dom.js';
import { drawLoudness, drawSpectrum } from './ui/charts.js';
import { loadCalibration, loadPrediction, loadSettings, saveCalibration, savePrediction, saveSettings } from './ui/storage.js';
import { createCalibrationSection } from './ui/calibration-section.js';
import { IDENTITY } from './core/eq/calibration.js';
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
  /** Master rendered in the browser, or null */ master: null,
  /** Measured Logic Channel EQ correction, or null */ calibration: loadCalibration(),
  busy: { mix: false, ref: false },
  userFileChosen: false, // stops the example from replacing a file the user picked
  /** Files remembered for next time, per slot: { name, ok } (ok = false when the browser refused to store it) */
  remembered: { mix: null, ref: null },
  /** Remembered files waiting for a click to allow reading them again */
  pendingRestore: { mix: null, ref: null },
};

const SLOT_LABEL = { mix: 'Mix', ref: 'Reference' };
const REF_PLACEHOLDER = 'A released song you want to sound like';
const analysisJobs = new JobRunner(new URL('./workers/analyze.worker.js', import.meta.url), async ({ channels, sampleRate }, onProgress) => {
  const { analyze } = await import('./core/analyze.js');
  return analyze(channels, sampleRate, { onProgress });
});
const el = {
  status: $('#status'),
  filePills: $('#filePills'),
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

// Charts and sections are created below; tab changes only redraw once they all exist.
let tabsReady = false;
const tabs = createTabs($('#tabs'), { onChange: () => { if (tabsReady) { renderFilePills(); redrawVisible(); } } });
const preview = new EqPreview();

/** Decodes the current mix again for the EQ preview (analysis transfers its copy to the worker). */
async function loadPreviewAudio() {
  if (!state.mix) throw new Error('No mix loaded.');
  if (state.mix.demo) return renderDemo();
  if (!state.mixSource) throw new Error('The mix file is no longer available. Choose it again.');
  return decodeFile(await state.mixSource.read());
}

const eqSection = createEqSection(document, {
  preview,
  loadPreviewAudio,
  onMasterEqChange: () => drawCharts(),
  onTracksChange: (count) => tabs.setBadge('tracks', count ? { text: String(count), tone: 'info', label: `${count} track preset${count === 1 ? '' : 's'}` } : null),
  mixLabel: () => (state.mix?.demo ? 'example' : (state.mix?.name ?? 'mix').replace(/\.[^.]+$/, '')),
  mixInfo: () => (state.mix ? { name: state.mix.name, analyzedAt: state.mix.analyzedAt.getTime(), demo: state.mix.demo, stamp: state.mix.stamp ?? null } : null),
  runEqTest: async (eq, onProgress, current = null) => {
    const { channels, sampleRate } = await loadPreviewAudio();
    const { analysis } = await renderJobs.run('eq-test', { type: 'testEq', channels, sampleRate, eq, current }, channels.map((c) => c.buffer), onProgress);
    return { analysis, evaluation: evaluateLike(analysis) };
  },
  evaluate: (analysis) => evaluateLike(analysis),
  savePrediction,
  loadPrediction,
  calibration: () => state.calibration ?? IDENTITY,
  openCalibration: () => {
    tabs.select('calibrate');
    calibrationSection.show();
    const heading = $('#eqCalibration').querySelector('h3');
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  },
});

/** Evaluates other audio (an EQ test, a master) with the mix's current settings and reference. */
function evaluateLike(analysis) {
  return evaluate(analysis, state.settings, { reference: state.ref?.analysis ?? null, file: state.mix?.meta ?? {} });
}

const renderJobs = new JobRunner(new URL('./workers/render.worker.js', import.meta.url), async (payload, onProgress) => {
  const { runRenderJob } = await import('./core/render-jobs.js');
  return (await runRenderJob(payload, onProgress)).result;
});

const mixTitle = () => (state.mix?.demo ? 'Example demo loop' : state.mix?.name ?? 'Mix');

const releaseSection = createReleaseSection($('#releaseSection'), {
  sources: () => [
    { id: 'master', label: state.master ? `Master made here: ${state.master.report.characterName}, ${state.master.report.targetLufs} LUFS` : 'Master made here', available: Boolean(state.master), peakDb: state.master?.analysis.truePeakDb },
    { id: 'mix', label: state.mix ? `Loaded file as is: ${mixTitle()}` : 'Loaded file', available: Boolean(state.mix), peakDb: state.mix?.analysis.truePeakDb },
  ],
  loadAudio: async (sourceId) => {
    if (sourceId === 'master' && state.master) {
      return { channels: state.master.channels.map((c) => c.slice()), sampleRate: state.master.sampleRate, name: `${mixTitle().replace(/\.[^.]+$/, '')} (master)`, analysis: state.master.analysis };
    }
    return { ...(await loadPreviewAudio()), name: mixTitle(), analysis: state.mix.analysis };
  },
  renderJobs,
  analysisJobs,
  targetLufs: () => state.evaluation?.target.lufs ?? -14,
  onSourceChange: () => renderFilePills(),
  onFileReady: (ready) => tabs.setBadge('release', ready ? { text: 'Ready', tone: 'good', label: 'Release files ready' } : null),
});

const calibrationSection = createCalibrationSection($('#eqCalibration'), {
  renderJobs,
  calibration: () => state.calibration,
  onChange: (calibration) => {
    state.calibration = calibration;
    saveCalibration(calibration);
    renderCalibrationNote();
  },
});

/** One line in the master EQ block saying whether exports are corrected for the user's Logic. */
function renderCalibrationNote() {
  const c = state.calibration;
  tabs.setBadge('calibrate', c ? { text: 'On', tone: 'good', label: 'Calibration in use' } : null);
  $('#masterCalNote').textContent = c
    ? `Exports are matched to your Logic's Channel EQ (measured ${new Date(c.measuredAt).toLocaleDateString([], { dateStyle: 'medium' })}).`
    : "Exports assume Logic's Channel EQ behaves like the app's model. If presets don't sound as tested, measure it in the Calibrate tab.";
}
renderCalibrationNote();

const masterSection = createMasterSection($('#masterSection'), {
  context: () => (state.mix && state.evaluation ? { analysis: state.mix.analysis, evaluation: state.evaluation, hasReference: Boolean(state.ref), mixName: mixTitle(), demo: state.mix.demo } : null),
  loadMix: loadPreviewAudio,
  renderJobs,
  analyze: (channels, sampleRate) => analysisJobs.run('master-check', { channels, sampleRate }, channels.map((c) => c.buffer)),
  evaluateMaster: (analysis) => evaluate(analysis, { ...state.settings, stage: 'master' }, { reference: state.ref?.analysis ?? null }),
  onMaster: (master) => {
    state.master = master;
    tabs.setBadge('master', master ? { text: 'Ready', tone: 'good', label: 'Master ready' } : null);
    releaseSection.update();
    renderFilePills();
  },
  useForRelease: () => {
    releaseSection.selectSource('master');
    tabs.select('release');
    renderFilePills();
  },
});

/**
 * Coloured pills under the tab bar naming the files the open tab works on. The colour is the
 * file (mix, reference, master), the label is its role in this tab.
 */
function renderFilePills() {
  const mix = state.mix && { file: 'mix', name: mixTitle() };
  const ref = state.ref && { file: 'ref', label: 'Reference', name: state.ref.name };
  const master = state.master && { file: 'master', name: `Master: ${state.master.report.characterName}, ${state.master.report.targetLufs} LUFS` };
  const curve = state.evaluation && { file: 'curve', label: 'Reference', name: `${state.evaluation.genre.name} curve (no reference file)` };
  const pills = {
    calibrate: [{ file: 'test', label: 'Source', name: "Test noise bounced through Logic's Channel EQ, not your mix" }],
    help: [],
    master: [mix && { ...mix, label: 'Source' }, ref, master && { ...master, label: 'Result' }],
    release: releaseSection.sources.map((id) => (id === 'master' ? master : mix)).map((file) => file && { ...file, label: 'Source' }),
  }[tabs.current] ?? [mix && { ...mix, label: 'Source' }, ref ?? curve];
  mount(el.filePills, pills.filter(Boolean).map((p) => h('span', { class: `file-pill ${p.file}`, title: `${p.label}: ${p.name}` }, [
    h('span', { class: 'file-pill-k', text: p.label }),
    h('span', { class: 'file-pill-name', text: p.name }),
  ])));
}

const clock = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/* ---------- rendering ---------- */

/** @param {{ kind: 'info'|'error', text: string }} [notice] a one-off message shown after the file details */
function render(notice) {
  updateReloadButton();
  renderFilePills();
  const mix = state.mix;
  if (!mix) return;
  const ref = state.ref?.analysis ?? null;
  const ev = evaluate(mix.analysis, state.settings, { reference: ref, file: mix.meta });
  state.evaluation = ev;

  renderStatus(el.status, [
    ...(mix.demo ? [{ tag: 'Example' }] : []),
    ...(mix.demo ? [{ kind: 'info', text: 'Generated demo loop. Drop your own bounce to replace it.' }] : []),
    { kind: 'info', text: fileSummary(mix) },
    ...(mix.demo ? [] : [{ kind: 'info', text: `${mix.previous ? 'Reloaded' : 'Analyzed'} ${clock(mix.analyzedAt)}` }]),
    ...(notice ? [notice] : []),
  ]);
  renderMeters(el.meters, mix.analysis, ev, ref, mix.previous);
  renderBands(el.bands, ev);
  renderFindings(el.findings, el.findingsCount, ev);
  const critical = ev.findings.filter((f) => f.severity === 'critical').length;
  tabs.setBadge('fixes', ev.findings.length
    ? { text: String(ev.findings.length), tone: critical ? 'crit' : ev.findings.some((f) => f.severity === 'warning') ? 'warn' : 'info', label: `${ev.findings.length} item${ev.findings.length === 1 ? '' : 's'}${critical ? `, ${critical} to fix first` : ''}` }
    : { text: '✓', tone: 'good', label: 'Nothing to fix' });
  renderChain(el.chain, el.chainTitle, el.chainAlt, ev);
  eqSection.update(mix.analysis, ev);
  const mixChanged = state.lastMixAnalysis !== mix.analysis;
  masterSection.update({ mixChanged });
  state.lastMixAnalysis = mix.analysis;
  releaseSection.update({ sourceChanged: mixChanged });

  el.cmpLegend.textContent = ref ? 'Reference' : `${ev.genre.name} curve`;
  el.cmpLegend.classList.toggle('ref', Boolean(ref));
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
  drawSpectrum(el.spec, spectrumSeries(a, ev, state.ref?.analysis ?? null, eqSection.masterEq, eqSection.replacingEq), ev.tolerance, { reference: Boolean(state.ref) });
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
  const analysis = await analysisJobs.run(slot, { channels, sampleRate }, channels.map((c) => c.buffer), (step, fraction) =>
    renderStatus(el.status, [{ kind: 'busy', text: `${label}: ${step}`, progress: fraction }]));
  state[slot] = { previous: null, ...entry, analysis, analyzedAt: new Date() };
  if (slot === 'mix') preview.unload(); // the preview re-decodes the new mix on next play
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
    await analyzeInto(slot, decoded, { meta: decoded.meta, name: file.name, demo: false, previous, stamp: { lastModified: file.lastModified, size: file.size } });
    rememberFile(slot, source, file).then((ok) => {
      state.remembered[slot] = { name: file.name, ok };
      renderFilesBar();
    });
    if (slot === 'mix') {
      state.mixSource = source.withFile(file);
      el.mixName.textContent = file.name;
      if (!reload && tabs.current === 'files') tabs.select('analysis');
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

/* ---------- remembered files ---------- */

const SLOT_NAME = { mix: 'mix', ref: 'reference' };
const MIX_PLACEHOLDER = 'Drop a WAV or AIFF bounce here';

function renderFilesBar() {
  const bar = $('#filesBar');
  const pending = SLOTS.filter((s) => state.pendingRestore[s]);
  const kept = SLOTS.filter((s) => state.remembered[s]?.ok);
  const refused = SLOTS.filter((s) => state.remembered[s] && !state.remembered[s].ok);
  const list = (slots, pick) => slots.map((s) => `${pick(s)}${s === 'ref' ? ' (reference)' : ''}`).join(' and ');
  const forget = h('button', { type: 'button', class: 'ghost', text: 'Forget files', onclick: forgetAll });
  bar.hidden = !pending.length && !kept.length && !refused.length;
  if (pending.length) {
    mount(bar,
      h('span', { text: `Last time you used ${list(pending, (s) => state.pendingRestore[s].name)}.` }),
      h('button', { type: 'button', class: 'btn', text: pending.length > 1 ? 'Restore files' : 'Restore file', onclick: restorePending }),
      forget);
  } else {
    mount(bar,
      kept.length > 0 && h('span', { text: `${list(kept, (s) => state.remembered[s].name)} ${kept.length > 1 ? 'are' : 'is'} remembered in this browser for next time.` }),
      refused.length > 0 && h('span', { class: 'note', text: `${list(refused, (s) => state.remembered[s].name)} couldn't be remembered in this browser (too large, or storage is blocked or full).` }),
      kept.length > 0 && forget);
  }
}

/** Reopens a remembered file and analyzes it. `ask` requests read permission (inside a click). */
async function restoreSlot(slot, record, { ask = false } = {}) {
  try {
    const source = await reopen(record, { ask });
    state.pendingRestore[slot] = null;
    renderFilesBar();
    await loadSource(slot, source);
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      renderStatus(el.status, [{ kind: 'info', text: `${record.name} wasn't reopened. Click "Restore" to allow it, or drop a file.` }]);
      return;
    }
    console.error(error);
    state.pendingRestore[slot] = null;
    state.remembered[slot] = null;
    forgetFiles([slot]);
    renderFilesBar();
    renderStatus(el.status, [{ kind: 'error', text: error.message }]);
    if (slot === 'mix' && !state.mix) {
      state.userFileChosen = false;
      loadDemo();
    }
  }
}

async function restorePending() {
  for (const slot of SLOTS) {
    const record = state.pendingRestore[slot];
    if (record) await restoreSlot(slot, record, { ask: true });
  }
}

/** Opens the files remembered from last time, or the example when there are none. */
async function startup() {
  const records = {};
  for (const slot of SLOTS) records[slot] = await recallFile(slot);
  for (const slot of SLOTS) {
    const record = records[slot];
    if (!record) continue;
    if (slot === 'mix') state.userFileChosen = true; // don't let the example replace it
    if (await needsPermission(record)) state.pendingRestore[slot] = record;
    else restoreSlot(slot, record);
  }
  renderFilesBar();
  if (!records.mix) loadDemo();
  else if (state.pendingRestore.mix) {
    el.mixName.textContent = records.mix.name;
    renderStatus(el.status, [{ kind: 'info', text: `Click "Restore" to reopen ${records.mix.name}, or drop a new mix.` }]);
  }
}

/** Forgets the remembered files and goes back to the example. */
async function forgetAll() {
  await forgetFiles();
  for (const slot of SLOTS) {
    analysisJobs.cancel(slot);
    state.remembered[slot] = null;
    state.pendingRestore[slot] = null;
  }
  if (state.ref) el.clearRef.click();
  state.mix = null;
  state.mixSource = null;
  state.userFileChosen = false;
  el.mixName.textContent = MIX_PLACEHOLDER;
  preview.unload();
  updateReloadButton();
  renderFilesBar();
  loadDemo();
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
  const schedule = (themeChanged) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      drawCharts();
      eqSection.redraw({ tracks: themeChanged === true });
      calibrationSection.redraw();
    });
  };
  new ResizeObserver(() => schedule(false)).observe(el.spec.parentElement);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => schedule(true));
  new MutationObserver(() => schedule(true)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

wireDropZone($('#dropMix'), el.fileMix, 'mix');
wireDropZone($('#dropRef'), el.fileRef, 'ref');
el.clearRef.addEventListener('click', () => {
  forgetFiles(['ref']);
  state.remembered.ref = null;
  state.pendingRestore.ref = null;
  renderFilesBar();
  analysisJobs.cancel('ref');
  state.ref = null;
  el.clearRef.hidden = true;
  el.refName.textContent = REF_PLACEHOLDER;
  render();
});
wireReload();
wireSettings();
wireCopy();
wireRedraw();
/** Canvases in hidden tabs have no size, so the open tab's charts are drawn when it appears. */
function redrawVisible() {
  drawCharts();
  eqSection.redraw({ tracks: true });
  calibrationSection.redraw();
}
tabsReady = true;
renderFilePills();
redrawVisible();

startup();
