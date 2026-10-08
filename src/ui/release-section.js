/**
 * "Release files": turns a mix or master into the file a distributor asks for, then checks the
 * finished file the way a store would: decode it, confirm it matches bit for bit, re-measure it.
 */
import { DELIVERY_SPECS, releaseFileName, releaseZipName } from '../core/delivery.js';
import { Md5 } from '../core/codecs/md5.js';
import { mp3Info } from '../core/codecs/mp3-info.js';
import { num, plural } from '../core/format.js';
import { CancelledError } from '../audio/job-runner.js';
import { downloadBytes } from './download.js';
import { createZip } from '../core/zip.js';
import { loadReleaseSpecs, saveReleaseSpecs } from './storage.js';
import { renderStatus } from './view.js';
import { $, h, mount } from './dom.js';

const STORE_CEILING = -1; // dBTP: headroom stores recommend for their lossy transcodes

/**
 * Integer sample from a decoded float. Browsers differ: Chrome divides positive values by 2^(bits−1) − 1
 * and negative ones by 2^(bits−1); others divide both by 2^(bits−1). Use whichever lands closer to a whole number.
 */
function toInt(f, scale) {
  if (f <= 0) return Math.round(f * scale);
  const a = f * (scale - 1);
  const b = f * scale;
  return Math.abs(a - Math.round(a)) < Math.abs(b - Math.round(b)) ? Math.round(a) : Math.round(b);
}

/** MD5 of decoded audio as interleaved little-endian integers, to compare with the file's own checksum. */
function pcmMd5(audioBuffer, bits) {
  const scale = 2 ** (bits - 1);
  const bytesPer = bits / 8;
  const chans = Array.from({ length: audioBuffer.numberOfChannels }, (_, c) => audioBuffer.getChannelData(c));
  const md5 = new Md5();
  const frames = 4096;
  const chunk = new Uint8Array(frames * chans.length * bytesPer);
  const view = new DataView(chunk.buffer);
  for (let start = 0; start < audioBuffer.length; start += frames) {
    const end = Math.min(audioBuffer.length, start + frames);
    let o = 0;
    for (let i = start; i < end; i++) {
      for (const c of chans) {
        const v = Math.max(-scale, Math.min(scale - 1, toInt(c[i], scale)));
        if (bits === 16) view.setInt16(o, v, true);
        else { view.setUint16(o, v & 0xffff, true); view.setInt8(o + 2, v >> 16); }
        o += bytesPer;
      }
    }
    md5.update(chunk.subarray(0, o));
  }
  return [...md5.digest()].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MIME = { flac: 'audio/flac', mp3: 'audio/mpeg' };
const MARK = { good: '✓', warn: '!', crit: '✕', info: 'i' };
const VERDICT_TEXT = { good: 'All checks passed', warn: 'Passed with warnings', crit: 'A check failed' };
const canPickFolder = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/**
 * @param {HTMLElement} root
 * @param {{
 *   sources: () => { id: string, label: string, available: boolean, peakDb?: number, version: unknown }[],
 *     version: changes whenever that audio is replaced, so files made from the old one are dropped
 *   loadAudio: (sourceId: string) => Promise<{ channels: Float32Array[], sampleRate: number, song: string, variant: string|null }>,
 *     returns fresh channels the caller may hand to a worker
 *   renderJobs: import('../audio/job-runner.js').JobRunner,
 *   analysisJobs: import('../audio/job-runner.js').JobRunner,
 *   targetLufs: () => number,
 *   onSourceChange?: (ids: string[]) => void,
 *   onFileReady?: (ready: boolean) => void,
 * }} deps
 */
export function createReleaseSection(root, deps) {
  const el = {
    sources: $('#releaseSources', root),
    specs: $('#releaseSpecs', root),
    ceiling: $('#releaseCeiling', root),
    ceilingNote: $('#releaseCeilingNote', root),
    create: $('#releaseCreate', root),
    stop: $('#releaseStop', root),
    count: $('#releaseCount', root),
    status: $('#releaseStatus', root),
    result: $('#releaseResult', root),
  };
  /**
   * What the section is doing. 'outdated': a run whose audio was replaced midway; it stops and discards its files.
   * @type {'idle'|'creating'|'stopping'|'outdated'|'saving'}
   */
  let phase = 'idle';
  const running = () => phase === 'creating' || phase === 'stopping' || phase === 'outdated';
  /** Source versions the current run reads from. @type {Map<string, unknown>} */
  let runVersions = new Map();
  /**
   * Finished files, in the order they were made.
   * @type {{ fileName: string, song: string, bytes: Uint8Array, type: string, checks: { tone: string, text: string }[], notes: string[], meta: string, verdict: string, sourceId: string, version: unknown, open?: boolean, saved?: string }[]}
   */
  let files = [];
  /** Jobs that failed in the last run. @type {{ label: string, error: string }[]} */
  let failures = [];

  const checked = (fieldset) => [...fieldset.querySelectorAll('input:checked')].map((i) => i.value);
  const option = (name, value, text, on, disabled = false) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name, value, checked: on, disabled }), h('span', { text }));
  const versionsNow = () => new Map(deps.sources().map((s) => [s.id, s.version]));

  const savedSpecs = loadReleaseSpecs();
  mount(el.specs, [
    h('legend', { class: 'k', text: 'File types' }),
    ...Object.entries(DELIVERY_SPECS).map(([id, spec]) => option('releaseSpec', id, spec.name, savedSpecs ? savedSpecs.includes(id) : id === 'routenote-flac')),
  ]);

  function renderSources(select = null) {
    const before = checked(el.sources);
    const sources = deps.sources();
    const wanted = select ?? (before.length ? before : [sources.find((s) => s.available)?.id]);
    mount(el.sources, [
      h('legend', { class: 'k', text: 'Audio' }),
      ...sources.map((s) => option('releaseSource', s.id, s.label + (s.available ? '' : ' (not available yet)'), s.available && wanted.includes(s.id), !s.available || phase !== 'idle')),
    ]);
    if (!checked(el.sources).length) {
      const first = el.sources.querySelector('input:not(:disabled)');
      if (first) first.checked = true;
    }
    renderPlan();
  }

  /** How many files the ticked boxes make, and the peak note for the ticked audio. */
  function renderPlan() {
    const sources = checked(el.sources);
    const n = sources.length * checked(el.specs).length;
    const all = deps.sources();
    el.count.textContent = phase !== 'idle' ? ''
      : n ? plural(n, 'file')
      : !all.some((s) => s.available) ? 'Load a mix first'
      : 'Tick at least one audio and one file type';
    el.create.textContent = n > 1 ? `Create ${n} release files` : 'Create release file';
    el.create.disabled = phase !== 'idle' || n === 0;
    const notes = sources.map((id) => all.find((s) => s.id === id)).filter((s) => Number.isFinite(s?.peakDb)).map((s) => {
      const name = sources.length > 1 ? (s.id === 'master' ? 'The master' : 'The mix') : 'This audio';
      return s.peakDb > STORE_CEILING
        ? `${name} peaks at ${num(s.peakDb)} dBTP. Stores make lossy versions for streaming, and those can clip above ${STORE_CEILING} dBTP.`
        : `${name} peaks at ${num(s.peakDb)} dBTP, already safe for store transcodes.`;
    });
    el.ceilingNote.textContent = notes.join(' ');
  }

  const status = (text, fraction = null, error = false) =>
    renderStatus(el.status, text ? [{ kind: error ? 'error' : fraction != null ? 'busy' : 'info', text, progress: fraction }] : [], 'Export progress');

  function setPhase(next) {
    phase = next;
    el.stop.hidden = !running();
    el.stop.disabled = phase !== 'creating';
    for (const input of [...el.specs.querySelectorAll('input'), el.ceiling]) input.disabled = phase !== 'idle';
    renderSources();
    renderFiles();
  }

  function clearFiles() {
    files = [];
    failures = [];
    renderFiles();
    deps.onFileReady?.(false);
  }

  /** Makes every ticked audio × file type combination, one after the other. */
  async function create() {
    if (phase !== 'idle') return;
    const specs = checked(el.specs);
    const plan = checked(el.sources).flatMap((source) => specs.map((spec) => ({ source, spec })));
    if (!plan.length) return;
    clearFiles();
    const versions = versionsNow();
    runVersions = new Map(plan.map(({ source }) => [source, versions.get(source)]));
    setPhase('creating');
    const ceilingDb = el.ceiling.checked ? STORE_CEILING : null;
    const audio = new Map(); // each source is read once, however many file types it makes
    try {
      for (const [i, { source: sourceId, spec }] of plan.entries()) {
        if (phase !== 'creating') break;
        const step = plan.length > 1 ? `File ${i + 1} of ${plan.length}: ` : '';
        try {
          status(`${step}reading the audio`, 0);
          if (!audio.has(sourceId)) audio.set(sourceId, await deps.loadAudio(sourceId));
          const source = audio.get(sourceId);
          // The worker takes ownership of what it's sent: copy while this audio has more file types to make, hand it over on its last one.
          const lastUse = !plan.slice(i + 1).some((job) => job.source === sourceId);
          const channels = lastUse ? source.channels : source.channels.map((c) => c.slice());
          if (lastUse) audio.delete(sourceId);
          const { bytes, report } = await deps.renderJobs.run('deliver', {
            type: 'deliver',
            channels,
            sampleRate: source.sampleRate,
            options: { spec, ceilingDb, title: source.song },
          }, channels.map((c) => c.buffer), (label, f) => status(`${step}${label}`, f));
          status(`${step}checking the finished file`, 1);
          files.push({ ...(await checkFile(bytes, report, source)), sourceId, version: runVersions.get(sourceId) });
          deps.onFileReady?.(true);
        } catch (error) {
          if (error instanceof CancelledError) break;
          console.error(error);
          failures.push({ label: `${DELIVERY_SPECS[spec].format.toUpperCase()} from the ${sourceId}`, error: error.message || String(error) });
        }
        renderFiles();
      }
      if (phase === 'outdated') {
        clearFiles();
        status('The audio changed while the files were being made, so they were discarded. Create them again.', null, true);
      } else if (phase === 'stopping') status(`Stopped. ${plural(files.length, 'file')} ready.`);
      else if (failures.length) status(`${plural(files.length, 'file')} ready; ${failures.length} couldn't be created.`, null, true);
      else status('');
    } finally {
      setPhase('idle');
    }
  }

  function stop() {
    if (phase !== 'creating') return;
    setPhase('stopping');
    deps.renderJobs.cancel('deliver');
  }

  /** Decodes the finished file and checks it the way a store would. */
  async function checkFile(bytes, report, { song, variant }) {
    const decoded = await new OfflineAudioContext(2, 1, report.sampleRate).decodeAudioData(bytes.slice().buffer);
    // Measure in the worker while the checksum runs here; the copies are handed over, not cloned again.
    const channels = [decoded.getChannelData(0).slice(), decoded.getChannelData(1).slice()];
    const measuring = deps.analysisJobs.run('release-check', { channels, sampleRate: decoded.sampleRate }, channels.map((c) => c.buffer), () => {});
    const exact = report.format === 'flac' ? pcmMd5(decoded, report.bits) === report.md5 : null;
    const measured = await measuring;
    const spec = DELIVERY_SPECS[report.spec];
    const isMp3 = report.format === 'mp3';
    const target = deps.targetLufs();
    const expectedSeconds = report.samples / report.sampleRate;
    const pass = (ok, otherwise = 'crit') => (ok ? 'good' : otherwise);
    const formatCheck = isMp3
      ? (() => {
          const info = mp3Info(bytes);
          const ok = info.constantBitrate && info.bitrates[0] === report.kbps && info.sampleRate === report.sampleRate && info.mode !== 'mono';
          return { tone: pass(ok), text: ok ? `MP3, ${report.kbps} kbps constant bitrate, ${info.sampleRate / 1000} kHz, ${info.mode} (matches the spec)` : `MP3 frames don't match the spec: ${info.bitrates.join('/')} kbps, ${info.sampleRate} Hz, ${info.mode}` };
        })()
      : { tone: 'good', text: `FLAC, ${report.bits}-bit, ${report.sampleRate / 1000} kHz, stereo` + (spec.sampleRate ? ' (matches the spec)' : '') };
    const checks = [
      formatCheck,
      { tone: pass(decoded.sampleRate === report.sampleRate && decoded.numberOfChannels === 2), text: `Decodes in this browser: ${num(decoded.duration, 1)} s, ${decoded.numberOfChannels} channels` },
      isMp3
        ? { tone: pass(Math.abs(decoded.duration - expectedSeconds) < 0.2, 'warn'), text: `Length ${num(decoded.duration, 2)} s for ${num(expectedSeconds, 2)} s of audio (MP3 adds a few milliseconds of silence at the start and end)` }
        : { tone: pass(exact), text: exact ? 'Bit-exact: the decoded audio matches the file’s checksum' : 'Checksum mismatch: the decoded audio differs from what was encoded' },
      { tone: pass(report.clipped === 0), text: report.clipped ? `${report.clipped} samples clipped when converting to ${report.bits}-bit. Turn on the true-peak option or lower the master.` : 'No clipped samples' },
      { tone: measured.truePeakDb <= STORE_CEILING + 0.05 ? 'good' : measured.truePeakDb <= 0 ? 'warn' : 'crit',
        text: `True peak ${num(measured.truePeakDb)} dBTP${isMp3 ? ' after decoding' : ''}${measured.truePeakDb > 0 ? ' — this clips when played; turn on the true-peak option' : measured.truePeakDb > STORE_CEILING + 0.05 ? ` (stores recommend ${STORE_CEILING} dBTP or lower)` : ''}` },
      { tone: pass(Math.abs(measured.integrated - target) <= 1, 'info'), text: `Loudness ${num(measured.integrated)} LUFS (your target is ${num(target, 0)} LUFS)` },
    ];
    const tones = new Set(checks.map((c) => c.tone));
    return {
      fileName: releaseFileName({ song, variant, report }),
      song,
      bytes,
      type: MIME[report.format],
      checks,
      notes: report.notes,
      verdict: tones.has('crit') ? 'crit' : tones.has('warn') ? 'warn' : 'good',
      meta: `${(bytes.length / 1048576).toFixed(1)} MB · ${num((bytes.length * 8) / decoded.duration / 1000, 0)} kbps average`,
    };
  }

  function renderFiles() {
    if (!files.length && !failures.length) return mount(el.result, h('p', { class: 'note release-empty', text: running() ? 'Files appear here as they are finished.' : 'Created files appear here, each with its checks and a Download button. Save them all to a folder or download them as one .zip.' }));
    const multiple = files.length > 1;
    const idle = phase === 'idle';
    mount(el.result, h('div', { class: 'release-files' },
      files.length > 0 && h('div', { class: 'release-files-h' },
        h('span', { class: 'k', text: running() ? `${files.length} ready so far` : `${plural(files.length, 'file')} ready to upload` }),
        h('div', { class: 'actions' },
          canPickFolder && h('button', { type: 'button', class: 'btn', text: multiple ? 'Save all to a folder…' : 'Save to a folder…', disabled: !idle, onclick: saveToFolder }),
          multiple && h('button', { type: 'button', class: canPickFolder ? 'ghost' : 'btn', text: 'Download all (.zip)', disabled: !idle, onclick: downloadZip }))),
      h('ul', { class: 'release-list' },
        files.map((f) => h('li', { class: 'release-file' },
          h('details', { open: f.open, ontoggle: (e) => { f.open = e.target.open; } },
            h('summary', {},
              h('span', { class: `verdict ${f.verdict}`, title: VERDICT_TEXT[f.verdict], text: MARK[f.verdict] }),
              h('span', { class: 'release-name', text: f.fileName }),
              h('span', { class: 'note', text: f.saved ? `${f.meta} · saved to ${f.saved}` : f.meta }),
              h('span', { class: 'release-toggle', 'aria-hidden': 'true' })),
            h('ul', { class: 'checks' }, f.checks.map((c) => h('li', { class: c.tone }, h('span', { class: 'mark', 'aria-hidden': 'true', text: MARK[c.tone] }), h('span', { text: c.text })))),
            f.notes.length > 0 && h('ul', { class: 'release-notes' }, f.notes.map((n) => h('li', { text: n })))),
          h('button', { type: 'button', class: 'ghost', text: 'Download', 'aria-label': `Download ${f.fileName}`, onclick: () => downloadBytes(f.bytes, f.fileName, f.type) }))),
        failures.map((f) => h('li', { class: 'release-file failed' },
          h('div', { class: 'release-fail' },
            h('span', { class: 'verdict crit', text: MARK.crit }),
            h('span', { text: `Couldn't create the ${f.label}: ${f.error}` })))))));
  }

  /** Writes every finished file into a folder the user picks (Chrome and Edge). */
  async function saveToFolder() {
    if (phase !== 'idle') return;
    const batch = files;
    let dir;
    try {
      dir = await window.showDirectoryPicker({ id: 'mixdown-release', mode: 'readwrite', startIn: 'music' });
    } catch (error) {
      if (error.name !== 'AbortError') status(`Couldn't open the folder: ${error.message}`, null, true);
      return;
    }
    const found = await Promise.allSettled(batch.map((f) => dir.getFileHandle(f.fileName)));
    const existing = batch.filter((_, i) => found[i].status === 'fulfilled').map((f) => f.fileName);
    if (existing.length && !window.confirm(`"${dir.name}" already has ${existing.length === 1 ? 'a file' : `${existing.length} files`} with ${existing.length === 1 ? 'this name' : 'these names'}:\n\n${existing.join('\n')}\n\nReplace ${existing.length === 1 ? 'it' : 'them'}?`)) return;
    setPhase('saving');
    try {
      for (const [i, f] of batch.entries()) {
        status(`Saving ${i + 1} of ${batch.length} to "${dir.name}"`, i / batch.length);
        const handle = await dir.getFileHandle(f.fileName, { create: true });
        const writable = await handle.createWritable();
        await writable.write(f.bytes);
        await writable.close();
        f.saved = `"${dir.name}"`;
      }
      status(`Saved ${plural(batch.length, 'file')} to "${dir.name}".`);
    } catch (error) {
      status(`Couldn't save to "${dir.name}": ${error.message}`, null, true);
    } finally {
      setPhase('idle');
    }
  }

  function downloadZip() {
    downloadBytes(createZip(files.map((f) => ({ name: f.fileName, data: f.bytes }))), releaseZipName(files[0].song), 'application/zip');
  }

  el.create.addEventListener('click', create);
  el.stop.addEventListener('click', stop);
  el.sources.addEventListener('change', () => {
    renderPlan();
    deps.onSourceChange?.(checked(el.sources));
  });
  el.specs.addEventListener('change', () => {
    saveReleaseSpecs(checked(el.specs));
    renderPlan();
  });
  renderSources();
  renderFiles();

  return {
    /** The ticked audio sources ('master', 'mix'). */
    get sources() {
      return checked(el.sources);
    },
    /** Ticks only this source, for example the master after mastering. */
    selectSource(id) {
      renderSources([id]);
      deps.onSourceChange?.(checked(el.sources));
    },
    /**
     * Call when the mix or master changes. Files made from audio that has since been replaced are dropped;
     * a run reading replaced audio stops and discards what it made.
     */
    update() {
      const now = versionsNow();
      const replaced = (id, version) => now.get(id) !== version;
      if (running()) {
        if (phase !== 'outdated' && [...runVersions].some(([id, v]) => replaced(id, v))) {
          phase = 'outdated';
          deps.renderJobs.cancel('deliver');
        }
      } else if (files.some((f) => replaced(f.sourceId, f.version))) {
        files = files.filter((f) => !replaced(f.sourceId, f.version));
        failures = [];
        renderFiles();
        deps.onFileReady?.(files.length > 0);
      }
      renderSources();
    },
  };
}
