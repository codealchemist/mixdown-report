/**
 * "EQ presets for Logic Pro": the master EQ (suggested, editable, previewable) and per-track EQs
 * (instrument starting points plus fixes for what the mix analysis found), exported as Channel EQ presets.
 */
import { cloneEq, flatEq, formatGain } from '../core/eq/channel-eq.js';
import { eqLoudnessChange } from '../core/eq/response.js';
import { CORRECTION_NAME, replacementLoudnessChange } from '../core/eq/correction.js';
import { checkPrediction, makePrediction, testEq } from '../core/eq/eq-test.js';
import { num, signed } from '../core/format.js';
import { BANDS } from '../core/profiles.js';
import { suggestMasterEq } from '../core/eq/mastering.js';
import { suggestTrackEq } from '../core/eq/track-eq.js';
import { INSTRUMENT_BY_ID } from '../core/eq/instruments.js';
import { CALIBRATION_EQ, encodeChannelEq, presetFileName } from '../core/eq/pst.js';
import { suggestTracksFromMetadata } from '../core/logic-project.js';
import { createZip } from '../core/zip.js';
import { loudestOffset } from '../audio/eq-preview.js';
import { drawEqCurve } from './charts.js';
import { eqEditor, eqSummary } from './eq-editor.js';
import { instrumentPicker, instrumentSelect } from './instrument-picker.js';
import { readDroppedProject, readProjectFile } from './project-file.js';
import { downloadBytes, PRESET_FOLDER } from './download.js';
import { $, h, mount } from './dom.js';

const TRACKS_KEY = 'mixdown-report:tracks:v1';
const ZIP_FOLDER = 'Mixdown Report';
const SOURCE_LABEL = { recording: 'Recorded audio', sampler: 'Sampler instrument', unused: 'Recording not on the timeline' };


function loadTracks() {
  try {
    const saved = JSON.parse(localStorage.getItem(TRACKS_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((t) => t && typeof t.name === 'string' && (t.instrumentId === null || INSTRUMENT_BY_ID[t.instrumentId])) : [];
  } catch {
    return [];
  }
}

const uniqueName = (name, taken) => {
  let n = name;
  for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${name} ${i}`;
  return n;
};

/**
 * @param {HTMLElement} root
 * @param {{
 *   preview: import('../audio/eq-preview.js').EqPreview,
 *   loadPreviewAudio: () => Promise<{channels: Float32Array[], sampleRate: number}>,
 *   onMasterEqChange: () => void,
 *   mixLabel: () => string,
 *   mixInfo: () => { name: string, analyzedAt: number, demo: boolean } | null,
 *   runEqTest: (eq: object, onProgress: Function) => Promise<{ analysis: object, evaluation: object }>,
 *   evaluate: (analysis: object) => object,
 *   savePrediction: (prediction: object) => void,
 *   loadPrediction: (name: string) => object|null,
 * }} deps
 */
export function createEqSection(root, deps) {
  const state = {
    analysis: null,
    evaluation: null,
    master: { suggestion: null, eq: flatEq(), edited: false, notes: [], keepLoudness: true, test: null, testing: false, confirmWorse: false, check: null, current: null, includesCurrent: false },
    tracks: loadTracks().map((t, i) => ({ id: `t${i}-${Date.now()}`, name: t.name, instrumentId: t.instrumentId, override: t.override ?? null })),
    expanded: new Set(),
    importResult: null,
    message: null,
  };
  let nextId = state.tracks.length + 1;

  const el = {
    masterCurve: $('#masterCurve', root),
    masterEditor: $('#masterEditor', root),
    masterNotes: $('#masterNotes', root),
    masterReset: $('#masterReset', root),
    masterDownload: $('#masterDownload', root),
    masterTestButton: $('#masterTestButton', root),
    masterTest: $('#masterTest', root),
    masterCheck: $('#masterCheck', root),
    keepLoudness: $('#masterKeepLoudness', root),
    correctionState: $('#correctionState', root),
    placement: $('#correctionPlacement', root),
    play: $('#previewPlay', root),
    ab: $('#previewAb', root),
    previewInfo: $('#previewInfo', root),
    trackTools: $('#trackTools', root),
    trackList: $('#trackList', root),
    trackDrop: $('#trackDrop', root),
    importPanel: $('#importPanel', root),
    projectInput: $('#projectInput', root),
    projectButton: $('#projectButton', root),
    downloadAll: $('#downloadAll', root),
    trackMessage: $('#trackMessage', root),
    copyPath: $('#copyPath', root),
    presetPath: $('#presetPath', root),
    calibration: $('#calibrationDownload', root),
  };

  /* ---------- persistence ---------- */
  const saveTracks = () => {
    try {
      localStorage.setItem(TRACKS_KEY, JSON.stringify(state.tracks.map(({ name, instrumentId, override }) => ({ name, instrumentId, override }))));
    } catch { /* storage unavailable */ }
  };

  /* ---------- master EQ ---------- */
  const eqKey = (eq) => JSON.stringify(eq);
  /** The correction already in this bounce, which the suggestion replaces, or null. */
  const replacing = () => (state.master.includesCurrent && state.master.current ? state.master.current.eq : null);
  const loudnessOf = (eq) => {
    if (!state.analysis) return 0;
    const { thirds, sampleRate } = state.analysis;
    return replacing() ? replacementLoudnessChange(eq, replacing(), thirds, sampleRate) : eqLoudnessChange(eq, thirds, sampleRate);
  };
  const loudnessChange = () => loudnessOf(state.master.eq);
  const when = (t) => new Date(t).toLocaleDateString([], { dateStyle: 'medium' });
  const testIsFresh = () => state.master.test && state.master.test.key === eqKey(state.master.eq);

  function renderMaster({ rebuildEditor = true } = {}) {
    const { master } = state;
    if (rebuildEditor) {
      mount(el.masterEditor, eqEditor(master.eq, {
        label: 'Correction EQ',
        onChange: (eq) => {
          if (eq.outputGain !== master.eq.outputGain && master.keepLoudness) {
            master.keepLoudness = false; // a gain typed by hand wins over automatic loudness matching
            el.keepLoudness.checked = false;
          }
          master.eq = eq;
          master.edited = true;
          master.confirmWorse = false;
          renderMaster({ rebuildEditor: false });
        },
      }));
    }
    drawEqCurve(el.masterCurve, master.eq);
    el.masterReset.hidden = !master.edited;
    el.keepLoudness.checked = master.keepLoudness;
    const change = loudnessChange();
    deps.preview.setEq(master.eq, change, replacing());
    el.previewInfo.textContent = Math.abs(change) < 0.2
      ? 'The EQ keeps the mix at the same loudness, so the A/B compares tone, not volume.'
      : `Level-matched: the EQ changes loudness by ${formatGain(change)} LU, so the preview compensates and you compare tone, not volume.`;
    const s = master.suggestion;
    const changes = s && s.mode === 'update' && !master.edited
      ? s.change.map((c, i) => ({ c, name: BANDS[i].name })).filter((x) => Math.abs(x.c) >= 0.3).map((x) => `${x.name} ${x.c > 0 ? '+' : '−'}${Math.abs(x.c).toFixed(1)} dB`)
      : [];
    mount(el.masterNotes, [
      ...(master.edited ? [h('li', { text: 'Edited by you. Reset to go back to the suggestion.' })] : []),
      ...(s?.unchanged && !master.edited ? [h('li', { text: 'Your current correction already does the job: nothing to change.' })] : []),
      ...(changes.length ? [h('li', { text: `Changes compared with your current correction: ${changes.join(', ')}.` })] : []),
      ...master.notes.map((n) => h('li', { text: n })),
      ...(!replacing() && (!s?.moves.length || s.moves.length === 1) ? [h('li', { text: 'No tonal correction needed beyond the 20 Hz rumble filter.' })] : []),
    ]);
    renderCorrectionState();
    renderTest();
    deps.onMasterEqChange();
  }

  el.masterReset.addEventListener('click', () => {
    state.master.eq = cloneEq(state.master.suggestion.eq);
    state.master.edited = false;
    state.master.keepLoudness = true;
    state.master.confirmWorse = false;
    renderMaster();
  });

  el.keepLoudness.addEventListener('change', () => {
    const { master } = state;
    master.keepLoudness = el.keepLoudness.checked;
    const baseGain = replacing()?.outputGain ?? 0;
    const change = loudnessOf({ ...master.eq, outputGain: baseGain });
    master.eq = { ...master.eq, outputGain: master.keepLoudness ? Math.round((baseGain - change) * 10) / 10 : baseGain };
    renderMaster();
  });

  /** Explains where this correction stands: first one, update of the one in the bounce, or unclear. */
  function renderCorrectionState() {
    const { master } = state;
    const c = master.current;
    const updating = Boolean(replacing());
    el.placement.textContent = updating
      ? `Load it into your existing "${CORRECTION_NAME}" Channel EQ, replacing its settings. Don't add another EQ.`
      : `Load it into a new Channel EQ named "${CORRECTION_NAME}" on the Stereo Out, after your own master EQ and before any compressor, limiter or Mastering Assistant. Never into your own EQ.`;
    if (!c) return mount(el.correctionState, h('p', { class: 'note', text: 'No correction exported for this song yet. The suggestion below is your first correction.' }));
    const measured = master.check?.result;
    mount(el.correctionState,
      h('p', { class: updating ? 'good' : 'note', text: updating
        ? `This bounce includes the correction you exported on ${when(c.exportedAt)}${measured?.applied != null ? ` (measured: ${Math.round(Math.max(0, measured.applied) * 100)}% of it shows up)` : ''}. The suggestion below is the updated whole correction.`
        : `You exported a correction for this song on ${when(c.exportedAt)}, but this file doesn't seem to include it, so the suggestion below is a fresh correction for this file.` }),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: master.includesCurrent, onchange: (e) => { master.includesCurrent = e.target.checked; refreshSuggestion(); } }),
        `This bounce already has the "${CORRECTION_NAME}" EQ from ${when(c.exportedAt)} on the Stereo Out`));
  }

  /** Recomputes the suggestion (after the mix or the "already includes" choice changes). */
  function refreshSuggestion() {
    const { master } = state;
    const suggestion = suggestMasterEq(state.evaluation, { analysis: state.analysis, keepLoudness: master.keepLoudness, current: replacing() });
    master.suggestion = suggestion;
    master.notes = suggestion.notes;
    master.test = null;
    master.edited = false;
    master.eq = cloneEq(suggestion.eq);
    renderMaster();
  }

  /* ---------- test on the mix ---------- */

  /** Shifts measured levels by a gain change, which is exact for a pure gain. */
  const withGain = ({ analysis }, db) => {
    const shifted = { ...analysis, integrated: analysis.integrated + db, truePeakDb: analysis.truePeakDb + db, samplePeakDb: analysis.samplePeakDb + db, plr: analysis.plr };
    return { analysis: shifted, evaluation: deps.evaluate(shifted) };
  };

  async function runTest() {
    const { master } = state;
    if (master.testing || !state.analysis) return;
    master.testing = true;
    el.masterTestButton.disabled = true;
    el.masterDownload.disabled = true;
    const status = (text, f) => mount(el.masterTest, h('div', { class: 'status' }, h('span', { class: 'busy', text }), f != null && h('progress', { max: 1, value: f.toFixed(3) })));
    status('Applying the EQ to the mix', 0);
    try {
      const before = { analysis: state.analysis, evaluation: state.evaluation };
      let after = await deps.runEqTest(cloneEq(master.eq), (label, f) => status(`Testing: ${label}`, f), replacing());
      let result = testEq(before, after);
      // Keep loudness: correct the output gain by what the full measurement found
      if (master.keepLoudness && Math.abs(result.loudnessChange) >= 0.1) {
        const delta = Math.round(-result.loudnessChange * 10) / 10;
        master.eq = { ...master.eq, outputGain: Math.round((master.eq.outputGain + delta) * 10) / 10 };
        after = withGain(after, delta);
        result = testEq(before, after);
        renderMaster();
      }
      master.test = { key: eqKey(master.eq), result, before, after };
      master.confirmWorse = false;
    } catch (error) {
      console.error(error);
      master.test = null;
      mount(el.masterTest, h('p', { class: 'note err', text: `Couldn't test the EQ: ${error.message}` }));
      return;
    } finally {
      master.testing = false;
      el.masterTestButton.disabled = false;
      el.masterDownload.disabled = false;
    }
    renderTest();
  }

  const VERDICT = {
    better: { label: 'Closer to target', tone: 'good' },
    mixed: { label: 'Mixed result', tone: 'warn' },
    worse: { label: 'Worse', tone: 'crit' },
    'no-change': { label: 'Little change', tone: 'info' },
  };
  const STATUS = { ok: ['✓', 'good', 'within tolerance'], fixed: ['✓', 'good', 'now within tolerance'], better: ['↑', 'good', 'closer'], same: ['·', 'info', 'about the same'], worse: ['↓', 'crit', 'further away'] };
  const SEVERITY_TONE = { good: 'good', note: 'info', warning: 'warn', critical: 'crit' };

  function renderTest() {
    const { master } = state;
    const what = replacing() ? 'updated correction' : 'correction preset';
    el.masterDownload.textContent = master.confirmWorse ? 'Download anyway' : testIsFresh() ? `Download ${what}` : `Test and download ${what}`;
    if (master.testing) return;
    if (!master.test) return mount(el.masterTest, h('p', { class: 'note', text: 'Test the EQ on your mix before downloading: the app applies it, measures the result like a bounce, and shows whether each range moves toward the target.' }));
    const { result, after } = master.test;
    const stale = !testIsFresh();
    const v = VERDICT[result.verdict];
    mount(el.masterTest,
      h('div', { class: `test-card${stale ? ' stale' : ''}` },
        h('div', { class: 'test-head' },
          h('span', { class: `pill ${v.tone}`, text: v.label }),
          h('span', { class: 'k', text: stale ? 'Changed since this test: test again' : 'Measured on your mix' })),
        h('ul', { class: 'test-messages' }, result.messages.map((m) => h('li', { class: SEVERITY_TONE[m.severity] }, m.text))),
        h('div', { class: 'test-grid' },
          h('table', { class: 'compare' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: `Tone vs ${state.evaluation.basis.replace(/^the /, '')}` }), h('th', { scope: 'col', text: 'Mix' }), h('th', { scope: 'col', text: 'With EQ' }), h('th', { scope: 'col', text: '' }))),
            h('tbody', {}, result.bands.map((b) => {
              const [mark, tone, label] = STATUS[b.status];
              return h('tr', {}, h('th', { scope: 'row', text: b.name }), h('td', { text: `${signed(b.before)} dB` }), h('td', { text: `${signed(b.after)} dB` }), h('td', { class: `mark ${tone}`, title: label, 'aria-label': label, text: mark }));
            }))),
          h('table', { class: 'compare' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Level' }), h('th', { scope: 'col', text: 'Mix' }), h('th', { scope: 'col', text: 'With EQ' }))),
            h('tbody', {},
              h('tr', {}, h('th', { scope: 'row', text: 'Loudness' }), h('td', { text: `${num(master.test.before.analysis.integrated)} LUFS` }), h('td', { text: `${num(after.analysis.integrated)} LUFS` })),
              h('tr', {}, h('th', { scope: 'row', text: 'True peak' }), h('td', { text: `${num(master.test.before.analysis.truePeakDb)} dBTP` }), h('td', { text: `${num(after.analysis.truePeakDb)} dBTP` })),
              h('tr', {}, h('th', { scope: 'row', text: 'Distance to target' }), h('td', { text: `${num(result.rmsBefore)} dB` }), h('td', { text: `${num(result.rmsAfter)} dB` })))))));
  }

  el.masterTestButton.addEventListener('click', runTest);

  el.masterDownload.addEventListener('click', async () => {
    const { master } = state;
    if (!testIsFresh()) {
      await runTest();
      if (!testIsFresh()) return;
    }
    if (master.test.result.verdict === 'worse' && !master.confirmWorse) {
      master.confirmWorse = true;
      renderTest();
      flash('The test shows this EQ makes the mix worse. Change it, or click "Download anyway".', true);
      return;
    }
    const updating = Boolean(replacing());
    downloadBytes(encodeChannelEq(master.eq, { calibration: deps.calibration() }), presetFileName(`${CORRECTION_NAME} - ${deps.mixLabel()}`));
    const info = deps.mixInfo();
    if (info && !info.demo) deps.savePrediction({ ...makePrediction({ name: info.name, before: master.test.before, after: master.test.after, eq: master.eq }), mixStamp: info.stamp });
    master.confirmWorse = false;
    renderTest();
    flash(updating
      ? `Downloaded the updated correction. Load it into your existing "${CORRECTION_NAME}" EQ (replacing its settings), bounce again to the same file name, and reload here to check it.`
      : `Downloaded. Add a Channel EQ named "${CORRECTION_NAME}" on the Stereo Out after your own master EQ, load this preset into it, bounce again to the same file name, and reload here to check it.`);
  });

  /* ---------- check a new bounce against the prediction ---------- */
  function renderCheck() {
    const c = state.master.check;
    if (!c) return mount(el.masterCheck);
    const { result, prediction } = c;
    const when = new Date(prediction.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const toggle = (hidden) => { c.hidden = hidden; renderCheck(); };
    const lead = result.diagnosis[0];
    if (c.hidden) {
      // Collapsed to one line, so the check is never lost until the next bounce replaces it
      return mount(el.masterCheck,
        h('div', { class: 'check-card collapsed' },
          h('div', { class: 'test-head' },
            h('span', {},
              h('b', { text: 'Bounce check: ' }),
              h('span', { class: lead ? `tone-${SEVERITY_TONE[lead.severity]}` : '', text: lead ? lead.title : 'compared with the tested correction EQ' })),
            h('button', { type: 'button', class: 'ghost', text: 'Show', 'aria-expanded': 'false', onclick: () => toggle(false) }))));
    }
    mount(el.masterCheck,
      h('div', { class: 'check-card' },
        h('div', { class: 'test-head' },
          h('h4', { text: 'This bounce vs. the tested correction EQ' }),
          h('button', { type: 'button', class: 'ghost', text: 'Hide', 'aria-expanded': 'true', onclick: () => toggle(true) })),
        h('p', { class: 'note', text: `Compared with the test of the preset you downloaded on ${when}${result.applied !== null ? `. About ${Math.round(Math.max(0, result.applied) * 100)}% of the predicted tone change shows up in this bounce` : ''}.` }),
        h('ul', { class: 'test-messages' }, result.diagnosis.map((d) => h('li', { class: SEVERITY_TONE[d.severity] }, h('b', { text: `${d.title}. ` }), d.text))),
        result.diagnosis.some((d) => d.calibrate) && h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn', text: "Measure Logic's Channel EQ", onclick: () => deps.openCalibration() }),
          h('span', { class: 'note', text: 'A one-time, five-minute check that makes exported presets sound in Logic the way they do here.' })),
        h('table', { class: 'compare' },
          h('thead', {}, h('tr', {}, ['Tone', 'Before', 'Predicted', 'This bounce', 'Gap'].map((t) => h('th', { scope: 'col', text: t })))),
          h('tbody', {}, result.bands.map((b) => h('tr', { class: Math.abs(b.gap) > 2 ? 'off' : '' },
            h('th', { scope: 'row', text: b.name }), h('td', { text: signed(b.before) }), h('td', { text: signed(b.predicted) }), h('td', { text: signed(b.measured) }), h('td', { text: signed(b.gap) })))))));
  }

  /* ---------- preview ---------- */
  deps.preview.setEq(state.master.eq, 0);
  const renderPreview = ({ playing, bypassed }) => {
    el.play.textContent = playing ? 'Stop' : 'Play from the loudest part';
    el.play.setAttribute('aria-pressed', String(playing));
    el.ab.textContent = bypassed ? 'EQ off (B)' : 'EQ on (B)';
    el.ab.setAttribute('aria-pressed', String(!bypassed));
    el.ab.classList.toggle('is-off', bypassed);
  };
  deps.preview.onStateChange = renderPreview;
  renderPreview({ playing: false, bypassed: false });

  el.play.addEventListener('click', async () => {
    const preview = deps.preview;
    if (preview.playing) return preview.stop();
    if (!state.analysis) return;
    try {
      if (!preview.loaded) {
        el.play.textContent = 'Loading audio…';
        el.play.disabled = true;
        preview.load(await deps.loadPreviewAudio());
      }
      await preview.play(loudestOffset(state.analysis));
    } catch (error) {
      console.error(error);
      flash(`Couldn't play the mix: ${error.message}`, true);
    } finally {
      el.play.disabled = false;
      renderPreview({ playing: preview.playing, bypassed: preview.bypassed });
    }
  });
  el.ab.addEventListener('click', () => deps.preview.setBypass(!deps.preview.bypassed));
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'b' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.target instanceof HTMLElement && e.target.closest('input, select, textarea, [contenteditable]')) return;
    e.preventDefault();
    deps.preview.setBypass(!deps.preview.bypassed);
  });

  /* ---------- tracks ---------- */
  const trackEq = (track) => {
    if (track.override) return { eq: track.override, moves: [], notes: [], edited: true };
    if (!track.instrumentId) return null;
    return { ...suggestTrackEq(track.instrumentId, state.evaluation), edited: false };
  };

  function addTrack(instrumentId, name = INSTRUMENT_BY_ID[instrumentId]?.name ?? 'Track') {
    const taken = new Set(state.tracks.map((t) => t.name.toLowerCase()));
    const track = { id: `t${nextId++}`, name: uniqueName(name, taken), instrumentId, override: null };
    state.tracks.push(track);
    saveTracks();
    renderTracks();
    return track;
  }

  function trackRow(track) {
    const suggestion = trackEq(track);
    const open = state.expanded.has(track.id);
    const curve = h('canvas', { class: 'track-curve', role: 'img', 'aria-label': `EQ curve for ${track.name}` });
    const summary = h('span', { class: 'track-summary', text: suggestion ? eqSummary(suggestion.eq) : 'Choose an instrument to get an EQ' });
    const rerender = () => { saveTracks(); renderTracks(); };

    const details = open && suggestion && h('div', { class: 'track-details' },
      eqEditor(suggestion.eq, {
        label: track.name,
        onChange: (eq) => {
          track.override = eq;
          saveTracks();
          summary.textContent = eqSummary(eq);
          drawEqCurve(curve, eq, { compact: true });
          row.querySelector('.edited-badge').hidden = false;
          row.querySelector('.reset-track').hidden = false;
        },
      }),
      h('div', { class: 'track-why' },
        suggestion.moves.length
          ? [h('span', { class: 'k', text: 'Why these bands' }), h('ul', {}, suggestion.moves.map((m) => h('li', {},
              h('span', { class: `origin ${m.origin}`, text: m.origin === 'mix' ? 'From your mix' : 'Starting point' }), ` ${m.reason ?? ''}`)))]
          : h('p', { class: 'note', text: 'Edited by you. Reset to see the suggestion and its reasons.' }),
        suggestion.notes.length > 0 && h('ul', { class: 'track-notes' }, suggestion.notes.map((n) => h('li', { text: n })))));

    const row = h('li', { class: `track${open ? ' open' : ''}` },
      h('div', { class: 'track-main' },
        h('input', {
          type: 'text', class: 'track-name', id: `${track.id}-name`, value: track.name, 'aria-label': 'Track name', maxlength: 80,
          onchange: (e) => { track.name = e.target.value.trim() || track.name; e.target.value = track.name; saveTracks(); },
        }),
        instrumentSelect(track.instrumentId, {
          id: `${track.id}-inst`, label: `Instrument for ${track.name}`,
          onChange: (value) => { track.instrumentId = value; track.override = null; rerender(); },
        }),
        curve,
        summary,
        h('span', { class: 'pill info edited-badge', text: 'Edited', hidden: !track.override }),
        h('div', { class: 'track-actions' },
          h('button', { type: 'button', class: 'ghost', 'aria-expanded': String(open), disabled: !suggestion, text: open ? 'Close' : 'Edit',
            onclick: () => { open ? state.expanded.delete(track.id) : state.expanded.add(track.id); renderTracks(); } }),
          h('button', { type: 'button', class: 'ghost reset-track', hidden: !track.override, text: 'Reset',
            onclick: () => { track.override = null; rerender(); } }),
          h('button', { type: 'button', class: 'ghost', disabled: !suggestion, text: 'Download .pst',
            onclick: () => { downloadBytes(encodeChannelEq(trackEq(track).eq, { calibration: deps.calibration() }), presetFileName(track.name)); flash(`Downloaded ${presetFileName(track.name)}.`); } }),
          h('button', { type: 'button', class: 'ghost danger', 'aria-label': `Remove ${track.name}`, text: '✕',
            onclick: () => { state.tracks = state.tracks.filter((t) => t !== track); state.expanded.delete(track.id); rerender(); } }))),
      details);
    queueMicrotask(() => suggestion && drawEqCurve(curve, suggestion.eq, { compact: true }));
    return row;
  }

  function renderTracks() {
    deps.onTracksChange?.(state.tracks.filter((t) => t.instrumentId || t.override).length);
    el.downloadAll.disabled = !state.tracks.some((t) => t.instrumentId || t.override);
    mount(el.trackList, state.tracks.length
      ? state.tracks.map(trackRow)
      : h('li', { class: 'track-empty' },
          h('p', { text: 'Add the tracks in your song to get a Channel EQ preset for each one. Type an instrument above, or drop your Logic project here to suggest tracks from its recordings.' })));
    renderImport();
  }

  /* ---------- export all ---------- */
  el.downloadAll.addEventListener('click', () => {
    const taken = new Set();
    const entries = [];
    const add = (name, eq) => {
      const file = presetFileName(uniqueName(name, taken));
      taken.add(file.slice(0, -4).toLowerCase());
      entries.push({ name: `${ZIP_FOLDER}/${file}`, data: encodeChannelEq(eq, { calibration: deps.calibration() }) });
    };
    if (state.analysis) add(CORRECTION_NAME, state.master.eq);
    for (const t of state.tracks) { const s = trackEq(t); if (s) add(t.name, s.eq); }
    entries.push({ name: 'How to install.txt', data: installText(entries.length) });
    downloadBytes(createZip(entries), 'Mixdown Report EQ presets.zip', 'application/zip');
    flash(`Downloaded ${entries.length - 1} presets in one .zip file.`);
  });

  /* ---------- Logic project import ---------- */
  function showImport(result, name) {
    const suggestions = result.tracks.map((t) => ({ ...t, selected: t.source !== 'unused' && Boolean(t.instrumentId) }));
    state.importResult = { name, ...result, tracks: suggestions };
    renderImport();
    el.importPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderImport() {
    const r = state.importResult;
    el.importPanel.hidden = !r;
    if (!r) return mount(el.importPanel);
    const existing = new Set(state.tracks.map((t) => t.name.toLowerCase()));
    const count = r.tracks.filter((t) => t.selected && t.instrumentId).length;
    mount(el.importPanel,
      h('div', { class: 'import-h' },
        h('h4', { text: `Tracks suggested from ${r.name}` }),
        h('p', { class: 'note', text: `${r.tracks.length} suggestion${r.tracks.length === 1 ? '' : 's'}${r.trackCount ? ` for a project with ${r.trackCount} tracks` : ''}. Logic stores audio tracks' names in their recordings; software-instrument tracks only appear when they use a recognised sampler instrument, so add any others by hand.` })),
      r.tracks.length
        ? h('ul', { class: 'import-list' }, r.tracks.map((t, i) => h('li', { class: existing.has(t.name.toLowerCase()) ? 'exists' : '' },
            h('input', { type: 'checkbox', id: `imp-${i}`, checked: t.selected, disabled: existing.has(t.name.toLowerCase()),
              onchange: (e) => { t.selected = e.target.checked; renderImport(); } }),
            h('label', { for: `imp-${i}` }, h('span', { class: 'import-name', text: t.name }), h('span', { class: 'note', text: existing.has(t.name.toLowerCase()) ? 'Already in your list' : `${SOURCE_LABEL[t.source]} · ${t.files} file${t.files === 1 ? '' : 's'}` })),
            instrumentSelect(t.instrumentId, { id: `imp-${i}-inst`, label: `Instrument for ${t.name}`, onChange: (v) => { t.instrumentId = v; t.selected = Boolean(v); renderImport(); } }))))
        : h('p', { class: 'note', text: 'No recordings or recognised instruments found in this project.' }),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', disabled: !count, text: count ? `Add ${count} track${count === 1 ? '' : 's'}` : 'Choose instruments to add tracks',
          onclick: () => {
            for (const t of r.tracks) if (t.selected && t.instrumentId && !existing.has(t.name.toLowerCase())) addTrack(t.instrumentId, t.name);
            state.importResult = null;
            renderTracks();
            flash(`Added ${count} track${count === 1 ? '' : 's'} from ${r.name}.`);
          } }),
        h('button', { type: 'button', class: 'ghost', text: 'Cancel', onclick: () => { state.importResult = null; renderImport(); } })));
  }

  const importFrom = async (promise) => {
    try {
      const { name, meta } = await promise;
      showImport(suggestTracksFromMetadata(meta), name);
    } catch (error) {
      console.error(error);
      flash(error.message, true);
    }
  };
  el.projectButton.addEventListener('click', () => el.projectInput.click());
  el.projectInput.addEventListener('change', () => {
    const file = el.projectInput.files?.[0];
    if (file) importFrom(readProjectFile(file));
    el.projectInput.value = '';
  });
  el.trackDrop.addEventListener('dragover', (e) => { e.preventDefault(); el.trackDrop.classList.add('over'); });
  el.trackDrop.addEventListener('dragleave', (e) => { if (!el.trackDrop.contains(e.relatedTarget)) el.trackDrop.classList.remove('over'); });
  el.trackDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    el.trackDrop.classList.remove('over');
    importFrom(readDroppedProject(e.dataTransfer));
  });

  /* ---------- install help ---------- */
  el.presetPath.textContent = PRESET_FOLDER;
  el.copyPath.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(PRESET_FOLDER);
      flash('Copied the folder path. In Finder, press ⇧⌘G and paste it.');
    } catch {
      flash('Select the path and copy it, then press ⇧⌘G in Finder and paste it.', true);
    }
  });
  el.calibration.addEventListener('click', () => downloadBytes(encodeChannelEq(CALIBRATION_EQ), presetFileName('Mixdown Calibration'))); // always uncorrected: it's the measuring stick

  /* ---------- messages ---------- */
  let flashTimer = 0;
  function flash(text, error = false) {
    el.trackMessage.textContent = text;
    el.trackMessage.classList.toggle('err', error);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.trackMessage.textContent = ''; }, 8000);
  }

  el.trackTools.prepend(instrumentPicker({ onPick: (id) => { addTrack(id); flash(`Added ${INSTRUMENT_BY_ID[id].name}.`); } }));
  renderTracks();

  return {
    /** Called whenever the mix analysis or settings change. */
    update(analysis, evaluation) {
      const newMix = analysis !== state.analysis;
      state.analysis = analysis;
      state.evaluation = evaluation;
      const { master } = state;
      if (newMix) {
        master.test = null;
        master.edited = false;
        master.keepLoudness = true;
        master.check = null;
        const info = deps.mixInfo();
        const prediction = info && !info.demo ? deps.loadPrediction(info.name) : null;
        // Only a changed file is a new bounce: reopening the exported mix itself must not trigger the check
        const sameFile = prediction?.mixStamp && info.stamp && prediction.mixStamp.lastModified === info.stamp.lastModified && prediction.mixStamp.size === info.stamp.size;
        if (prediction && info.analyzedAt > prediction.createdAt && !sameFile) {
          master.check = { prediction, result: checkPrediction(prediction, { analysis, evaluation }) };
        }
        // The correction exported for this song, and whether this bounce contains it (from the check)
        master.current = prediction?.eq ? { eq: prediction.eq, exportedAt: prediction.createdAt } : null;
        const r = master.check?.result;
        master.includesCurrent = Boolean(master.current && r && (r.applied != null ? r.applied >= 0.5 : r.toneGap <= 1));
      }
      const suggestion = suggestMasterEq(evaluation, { analysis, keepLoudness: master.keepLoudness, current: replacing() });
      master.suggestion = suggestion;
      master.notes = suggestion.notes;
      if (!master.edited) master.eq = cloneEq(suggestion.eq);
      renderMaster();
      renderCheck();
      renderTracks();
    },
    /** The suggested correction EQ (or the user's edit of it), for drawing on the spectrum. */
    get masterEq() {
      return state.master.eq;
    },
    /** The correction already in the bounce that the suggestion replaces, or null. */
    get replacingEq() {
      return replacing();
    },
    /** Redraws canvases; track rows are rebuilt only when asked (e.g. theme change), to keep input focus. */
    redraw({ tracks = false } = {}) {
      drawEqCurve(el.masterCurve, state.master.eq);
      if (tracks) renderTracks();
    },
  };
}

function installText(count) {
  return [
    `Mixdown Report: ${count} Channel EQ preset${count === 1 ? '' : 's'} for Logic Pro`,
    '',
    'Install',
    `1. In Finder, press Shift-Command-G and go to: ${PRESET_FOLDER}`,
    `2. Copy the "${ZIP_FOLDER}" folder from this download into that folder.`,
    '3. In Logic Pro, open Channel EQ on a track, click the Setting menu at the top of the plug-in window,',
    `   and choose ${ZIP_FOLDER} > the preset. If Logic was open, the folder appears the next time you open the menu.`,
    '',
    'Use',
    '- Track presets go on the matching channel strip.',
    `- "${CORRECTION_NAME}.pst" goes into its own Channel EQ on the Stereo Out, after your master EQ and before any`,
    '  compressor, limiter or Mastering Assistant. Never load it into your own EQ: a preset replaces all of its settings.',
    `  When the app suggests an updated correction, load it into the same "${CORRECTION_NAME}" EQ instead of adding one.`,
    '- These are starting points from an analysis of the whole mix. Adjust by ear, and bypass to compare.',
    '',
    'The Channel EQ preset format is not documented by Apple. If a preset loads incorrectly, please report it.',
    '',
  ].join('\n');
}

