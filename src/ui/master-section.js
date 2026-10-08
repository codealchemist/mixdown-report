/**
 * "Master in the browser": tone (character + strength, toward the genre curve or reference),
 * glue compression and a true-peak limiter to the loudness target, with a synced A/B against the mix.
 */
import { CHARACTERS } from '../core/master/tone.js';
import { BANDS } from '../core/profiles.js';
import { num, signed } from '../core/format.js';
import { CancelledError } from '../audio/job-runner.js';
import { AbPlayer } from '../audio/ab-player.js';
import { loudestOffset } from '../audio/eq-preview.js';
import { $, h, mount } from './dom.js';

/**
 * @param {HTMLElement} root
 * @param {{
 *   context: () => { analysis: object, evaluation: object, hasReference: boolean, mixName: string, demo: boolean } | null,
 *   loadMix: () => Promise<{ channels: Float32Array[], sampleRate: number }>,
 *   renderJobs: import('../audio/job-runner.js').JobRunner,
 *   analyze: (channels: Float32Array[], sampleRate: number) => Promise<object>,
 *   evaluateMaster: (analysis: object) => object,
 *   onMaster: (master: object|null) => void,
 *   useForRelease: () => void,
 * }} deps
 */
export function createMasterSection(root, deps) {
  const el = {
    characters: $('#masterCharacters', root),
    strength: $('#masterStrength', root),
    strengthValue: $('#masterStrengthValue', root),
    target: $('#masterTarget', root),
    warning: $('#masterWarning', root),
    render: $('#masterRender', root),
    status: $('#masterStatus', root),
    result: $('#masterResult', root),
  };
  let character = 'balanced';
  let busy = false;
  let master = null; // { channels, sampleRate, report, analysis, evaluation, mixAnalysis }
  const player = new AbPlayer(() => renderPlayer());

  /* ---------- controls ---------- */
  mount(el.characters, Object.entries(CHARACTERS).map(([id, c]) =>
    h('label', { class: `character${id === character ? ' selected' : ''}` },
      h('input', { type: 'radio', name: 'masterCharacter', value: id, checked: id === character,
        onchange: () => { character = id; el.characters.querySelectorAll('.character').forEach((n) => n.classList.toggle('selected', n.querySelector('input').checked)); } }),
      h('span', { class: 'character-name', text: c.name }),
      h('span', { class: 'note', text: c.description }))));

  el.strength.addEventListener('input', () => { el.strengthValue.textContent = `${el.strength.value}%`; });

  function renderControls() {
    const ctx = deps.context();
    el.render.disabled = busy || !ctx;
    if (!ctx) return;
    const { evaluation: ev, analysis: a, hasReference } = ctx;
    el.target.textContent = `${hasReference ? 'Tone toward your reference track' : `Tone toward the ${ev.genre.name} curve`} · ${num(ev.target.lufs, 0)} LUFS, true peak ${num(ev.target.truePeak)} dBTP (${ev.target.name}; change it under "Release on")`;
    const already = ev.stage === 'master' || a.plr < 9;
    mount(el.warning, already && h('p', { class: 'callout warn', text: `This file looks already mastered or limited (peak-to-loudness ${num(a.plr)} dB). Mastering it again limits it twice and costs punch. Load the unmastered mix bounce for the best result.` }));
  }

  const status = (text, fraction = null, error = false) => mount(el.status, text && [
    h('span', { class: error ? 'err' : fraction != null ? 'busy' : '', text }),
    fraction != null && h('progress', { max: 1, value: fraction.toFixed(3), 'aria-label': 'Mastering progress' }),
  ]);

  /* ---------- render ---------- */
  async function render() {
    const ctx = deps.context();
    if (!ctx || busy) return;
    busy = true;
    renderControls();
    player.unload();
    try {
      status('Reading the mix', 0);
      const mix = await deps.loadMix();
      const mixCopy = mix.channels.map((c) => c.slice()); // kept for A/B; the original goes to the worker
      const { evaluation: ev } = ctx;
      const job = await deps.renderJobs.run('master', {
        type: 'master',
        channels: mix.channels,
        sampleRate: mix.sampleRate,
        options: { deviations: ev.deviations, character, strength: Number(el.strength.value) / 100, targetLufs: ev.target.lufs, ceilingDb: ev.target.truePeak },
      }, mix.channels.map((c) => c.buffer), (label, f) => status(label, f));

      status('Measuring the master', 1);
      const analysis = await deps.analyze(job.channels.map((c) => c.slice()), job.sampleRate);
      master = { ...job, analysis, evaluation: deps.evaluateMaster(analysis), mixAnalysis: ctx.analysis, mixEvaluation: ev };
      player.load({ channels: mixCopy, sampleRate: mix.sampleRate }, { channels: job.channels, sampleRate: job.sampleRate }, analysis.integrated - ctx.analysis.integrated);
      deps.onMaster(master);
      renderResult();
      status('');
    } catch (error) {
      if (error instanceof CancelledError) return;
      console.error(error);
      status(`Couldn't master the mix: ${error.message}`, null, true);
    } finally {
      busy = false;
      renderControls();
    }
  }

  /* ---------- result ---------- */
  function renderPlayer() {
    const box = el.result.querySelector('.ab-compare');
    if (!box) return;
    box.querySelector('.ab-play').textContent = player.playing ? 'Stop' : 'Play from the loudest part';
    for (const b of box.querySelectorAll('[data-pick]')) b.setAttribute('aria-pressed', String(player.selected === b.dataset.pick));
  }

  function renderResult() {
    if (!master) return mount(el.result);
    const { report: r, analysis: after, mixAnalysis: before, evaluation: evAfter, mixEvaluation: evBefore } = master;
    const rows = [
      ['Integrated loudness', `${num(before.integrated)} LUFS`, `${num(after.integrated)} LUFS`],
      ['True peak', `${num(before.truePeakDb)} dBTP`, `${num(after.truePeakDb)} dBTP`],
      ['Peak to loudness', `${num(before.plr)} dB`, `${num(after.plr)} dB`],
      ['Loudness range', `${num(before.loudnessRange)} LU`, `${num(after.loudnessRange)} LU`],
    ];
    mount(el.result,
      h('div', { class: 'master-card' },
        h('div', { class: 'master-card-head' },
          h('div', {}, h('span', { class: 'k', text: 'Master ready' }), h('div', { class: 'release-name', text: `${r.characterName} · ${Math.round(r.strength * 100)}% tone · ${num(r.targetLufs, 0)} LUFS` })),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn', text: 'Create release file from this master', onclick: () => deps.useForRelease() }))),
        h('div', { class: 'ab-compare', role: 'group', 'aria-label': 'Compare mix and master' },
          h('button', { type: 'button', class: 'btn ab-play', text: 'Play from the loudest part',
            onclick: () => (player.playing ? player.stop() : player.play(loudestOffset(after))) }),
          h('div', { class: 'segmented' },
            h('button', { type: 'button', 'data-pick': 'a', 'aria-pressed': 'false', text: 'Mix (A)', onclick: () => player.select('a') }),
            h('button', { type: 'button', 'data-pick': 'b', 'aria-pressed': 'true', text: 'Master (B)', onclick: () => player.select('b') })),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => player.setMatched(e.target.checked) }), 'Match loudness, so you compare tone and dynamics, not volume')),
        h('div', { class: 'master-grid-result' },
          h('table', { class: 'compare' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '' }), h('th', { scope: 'col', text: 'Mix' }), h('th', { scope: 'col', text: 'Master' }))),
            h('tbody', {}, rows.map(([k, a, b]) => h('tr', {}, h('th', { scope: 'row', text: k }), h('td', { text: a }), h('td', { text: b }))))),
          h('table', { class: 'compare' },
            h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: `Tone vs ${evBefore.basis.replace(/^the /, '')}` }), h('th', { scope: 'col', text: 'Mix' }), h('th', { scope: 'col', text: 'Master' }))),
            h('tbody', {}, BANDS.map((b, i) => h('tr', {}, h('th', { scope: 'row', text: b.name }), h('td', { text: `${signed(evBefore.deviations[i])} dB` }), h('td', { text: `${signed(evAfter.deviations[i])} dB` })))))),
        h('details', { class: 'processing' },
          h('summary', { text: 'What was done' }),
          h('ul', {},
            h('li', { text: `Tone EQ: ${r.tone.lines.join(' · ')}` }),
            h('li', { text: `Glue compression: ratio ${r.glue.ratio}:1, ${num(r.glue.averageReductionDb)} dB average, ${num(r.glue.maxReductionDb)} dB at most` }),
            h('li', { text: `Limiter: ${signed(r.limiter.inputGainDb)} dB into a ${num(r.ceilingDb - 0.1)} dB true-peak ceiling; ${num(r.limiter.averageReductionDb)} dB average reduction, ${num(r.limiter.maxReductionDb)} dB at most` }))),
        r.warnings.length > 0 && h('ul', { class: 'master-warnings' }, r.warnings.map((w) => h('li', { text: w }))),
        h('p', { class: 'note', text: "Compare with Logic's Mastering Assistant on the same mix: bounce it, load it here as the mix, and play both at matched loudness. Upload whichever sounds better." })));
    renderPlayer();
  }

  el.render.addEventListener('click', render);
  renderControls();

  return {
    /** Called when the mix or settings change. A new mix invalidates the master. */
    update({ mixChanged }) {
      if (mixChanged && master) {
        master = null;
        player.unload();
        deps.onMaster(null);
        renderResult();
      }
      renderControls();
    },
  };
}
