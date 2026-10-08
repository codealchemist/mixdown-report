/**
 * "Release files": turns a mix or master into the file a distributor asks for, then checks the
 * finished file the way a store would: decode it, confirm it matches bit for bit, re-measure it.
 */
import { DELIVERY_SPECS } from '../core/delivery.js';
import { Md5 } from '../core/codecs/md5.js';
import { mp3Info } from '../core/codecs/mp3-info.js';
import { num } from '../core/format.js';
import { CancelledError } from '../audio/job-runner.js';
import { downloadBytes } from './download.js';
import { createZip } from '../core/zip.js';
import { loadReleaseSpecs, saveReleaseSpecs } from './storage.js';
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

const fileBase = (name) => name.replace(/\.[^.]+$/, '');
const MIME = { flac: 'audio/flac', mp3: 'audio/mpeg' };
const canPickFolder = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/**
 * @param {HTMLElement} root
 * @param {{
 *   sources: () => { id: string, label: string, available: boolean, peakDb?: number }[],
 *   loadAudio: (sourceId: string) => Promise<{ channels: Float32Array[], sampleRate: number, name: string, analysis: object|null }>,
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
  let busy = false;
  let stopping = false;
  /** Finished files, in the order they were made. @type {{ fileName: string, bytes: Uint8Array, type: string, checks: object[], notes: string[], meta: string, verdict: string, saved?: string }[]} */
  let files = [];
  /** Jobs that failed in the last run. @type {{ label: string, error: string }[]} */
  let failures = [];
  /** Files whose checks are expanded; all start collapsed. */
  const openFiles = new Set();

  const checked = (fieldset) => [...fieldset.querySelectorAll('input:checked')].map((i) => i.value);
  const option = (name, value, text, on, disabled = false) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name, value, checked: on, disabled }), h('span', { text }));

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
      ...sources.map((s) => option('releaseSource', s.id, s.label + (s.available ? '' : ' (not available yet)'), s.available && wanted.includes(s.id), !s.available || busy)),
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
    const specs = checked(el.specs);
    const n = sources.length * specs.length;
    el.count.textContent = busy ? '' : n ? `${n} file${n === 1 ? '' : 's'}` : 'Tick at least one audio and one file type';
    el.create.textContent = n > 1 ? `Create ${n} release files` : 'Create release file';
    el.create.disabled = busy || n === 0;
    const all = deps.sources();
    const notes = sources.map((id) => all.find((s) => s.id === id)).filter((s) => Number.isFinite(s?.peakDb)).map((s) => {
      const name = sources.length > 1 ? (s.id === 'master' ? 'The master' : 'The mix') : 'This audio';
      return s.peakDb > STORE_CEILING
        ? `${name} peaks at ${num(s.peakDb)} dBTP. Stores make lossy versions for streaming, and those can clip above ${STORE_CEILING} dBTP.`
        : `${name} peaks at ${num(s.peakDb)} dBTP, already safe for store transcodes.`;
    });
    el.ceilingNote.textContent = notes.join(' ');
  }

  const status = (text, fraction = null, error = false) => {
    mount(el.status, text && [
      h('span', { class: error ? 'err' : fraction != null ? 'busy' : '', text }),
      fraction != null && h('progress', { max: 1, value: fraction.toFixed(3), 'aria-label': 'Export progress' }),
    ]);
  };

  function setBusy(on) {
    busy = on;
    el.stop.hidden = !on;
    el.stop.disabled = false;
    for (const input of root.querySelectorAll('.release-pick input, #releaseCeiling')) input.disabled = on || (input.name === 'releaseSource' && !deps.sources().find((s) => s.id === input.value)?.available);
    renderPlan();
  }

  /** Makes every ticked audio × file type combination, one after the other. */
  async function create() {
    if (busy) return;
    const sourceIds = checked(el.sources);
    const specs = checked(el.specs);
    const plan = sourceIds.flatMap((source) => specs.map((spec) => ({ source, spec })));
    if (!plan.length) return;
    files = [];
    failures = [];
    openFiles.clear();
    stopping = false;
    setBusy(true);
    renderFiles();
    deps.onFileReady?.(false);
    const ceilingDb = el.ceiling.checked ? STORE_CEILING : null;
    const audio = new Map(); // each source is read once, however many file types it makes
    try {
      for (const [i, { source: sourceId, spec }] of plan.entries()) {
        if (stopping) break;
        const step = plan.length > 1 ? `File ${i + 1} of ${plan.length}: ` : '';
        const what = `${DELIVERY_SPECS[spec].format.toUpperCase()} from the ${sourceId === 'master' ? 'master' : 'mix'}`;
        try {
          status(`${step}reading the audio`, 0);
          if (!audio.has(sourceId)) audio.set(sourceId, await deps.loadAudio(sourceId));
          const source = audio.get(sourceId);
          const channels = source.channels.map((c) => c.slice()); // the worker takes ownership of what it's sent
          const { bytes, report } = await deps.renderJobs.run('deliver', {
            type: 'deliver',
            channels,
            sampleRate: source.sampleRate,
            options: { spec, ceilingDb, title: fileBase(source.name) },
          }, channels.map((c) => c.buffer), (label, f) => status(`${step}${label}`, f));
          status(`${step}checking the finished file`, 1);
          files.push(await checkFile(bytes, report, source.name));
          deps.onFileReady?.(true);
        } catch (error) {
          if (error instanceof CancelledError) break;
          console.error(error);
          failures.push({ label: what, error: error.message || String(error) });
        }
        renderFiles();
      }
      const made = `${files.length} file${files.length === 1 ? '' : 's'} ready`;
      if (stopping) status(`Stopped. ${made}.`);
      else if (failures.length) status(`${made}; ${failures.length} couldn't be created.`, null, true);
      else status('');
    } finally {
      setBusy(false);
      renderFiles();
    }
  }

  function stop() {
    if (!busy) return;
    stopping = true;
    el.stop.disabled = true;
    deps.renderJobs.cancel('deliver');
  }

  /** Decodes the finished file and checks it the way a store would. */
  async function checkFile(bytes, report, sourceName) {
    const decoded = await new OfflineAudioContext(2, 1, report.sampleRate).decodeAudioData(bytes.slice().buffer);
    const exact = report.format === 'flac' ? pcmMd5(decoded, report.bits) === report.md5 : null;
    const measured = await deps.analysisJobs.run('release-check', {
      channels: [decoded.getChannelData(0).slice(), decoded.getChannelData(1).slice()],
      sampleRate: decoded.sampleRate,
    }, [], () => {});
    const spec = DELIVERY_SPECS[report.spec];
    const isMp3 = report.format === 'mp3';
    const fileName = isMp3
      ? `${fileBase(sourceName)} (${report.kbps} kbps).mp3`
      : `${fileBase(sourceName)} (${report.sampleRate / 1000}k ${report.bits}-bit).flac`;
    const target = deps.targetLufs();
    const expectedSeconds = report.samples / report.sampleRate;
    const formatCheck = isMp3
      ? (() => {
          const info = mp3Info(bytes);
          const ok = info.constantBitrate && info.bitrates[0] === report.kbps && info.sampleRate === report.sampleRate && info.mode !== 'mono';
          return { ok, text: ok ? `MP3, ${report.kbps} kbps constant bitrate, ${info.sampleRate / 1000} kHz, ${info.mode} (matches the spec)` : `MP3 frames don't match the spec: ${info.bitrates.join('/')} kbps, ${info.sampleRate} Hz, ${info.mode}` };
        })()
      : { ok: true, text: `FLAC, ${report.bits}-bit, ${report.sampleRate / 1000} kHz, stereo` + (spec.sampleRate ? ' (matches the spec)' : '') };
    const checks = [
      formatCheck,
      { ok: decoded.sampleRate === report.sampleRate && decoded.numberOfChannels === 2, text: `Decodes in this browser: ${num(decoded.duration, 1)} s, ${decoded.numberOfChannels} channels` },
      isMp3
        ? { ok: Math.abs(decoded.duration - expectedSeconds) < 0.2 ? true : 'warn', text: `Length ${num(decoded.duration, 2)} s for ${num(expectedSeconds, 2)} s of audio (MP3 adds a few milliseconds of silence at the start and end)` }
        : { ok: exact, text: exact ? 'Bit-exact: the decoded audio matches the file’s checksum' : 'Checksum mismatch: the decoded audio differs from what was encoded' },
      { ok: report.clipped === 0, text: report.clipped ? `${report.clipped} samples clipped when converting to ${report.bits}-bit. Turn on the true-peak option or lower the master.` : 'No clipped samples' },
      { ok: measured.truePeakDb <= STORE_CEILING + 0.05 ? true : measured.truePeakDb <= 0 ? 'warn' : false,
        text: `True peak ${num(measured.truePeakDb)} dBTP${isMp3 ? ' after decoding' : ''}${measured.truePeakDb > 0 ? ' — this clips when played; turn on the true-peak option' : measured.truePeakDb > STORE_CEILING + 0.05 ? ` (stores recommend ${STORE_CEILING} dBTP or lower)` : ''}` },
      { ok: Math.abs(measured.integrated - target) <= 1 ? true : 'info', text: `Loudness ${num(measured.integrated)} LUFS (your target is ${num(target, 0)} LUFS)` },
    ];
    const verdict = checks.some((c) => c.ok === false) ? 'false' : checks.some((c) => c.ok === 'warn') ? 'warn' : 'true';
    return {
      fileName,
      bytes,
      type: MIME[report.format],
      checks,
      notes: report.notes,
      verdict,
      meta: `${(bytes.length / 1048576).toFixed(1)} MB · ${num((bytes.length * 8) / decoded.duration / 1000, 0)} kbps average`,
    };
  }

  const mark = { true: '✓', false: '✕', warn: '!', info: 'i' };
  const cls = { true: 'good', false: 'crit', warn: 'warn', info: 'info' };
  const verdictText = { true: 'All checks passed', warn: 'Passed with warnings', false: 'A check failed' };

  function renderFiles() {
    if (!files.length && !failures.length) return mount(el.result, h('p', { class: 'note release-empty', text: busy ? 'Files appear here as they are finished.' : 'Created files appear here, each with its checks and a Download button. Save them all to a folder or download them as one .zip.' }));
    const multiple = files.length > 1;
    mount(el.result, h('div', { class: 'release-files' },
      files.length > 0 && h('div', { class: 'release-files-h' },
        h('span', { class: 'k', text: busy ? `${files.length} ready so far` : `${files.length} file${multiple ? 's' : ''} ready to upload` }),
        h('div', { class: 'actions' },
          canPickFolder && h('button', { type: 'button', class: 'btn', text: multiple ? 'Save all to a folder…' : 'Save to a folder…', disabled: busy, onclick: saveToFolder }),
          multiple && h('button', { type: 'button', class: canPickFolder ? 'ghost' : 'btn', text: 'Download all (.zip)', disabled: busy, onclick: downloadZip }))),
      h('ul', { class: 'release-list' },
        files.map((f) => h('li', { class: 'release-file' },
          h('details', { open: openFiles.has(f.fileName), ontoggle: (e) => { if (e.target.open) openFiles.add(f.fileName); else openFiles.delete(f.fileName); } },
            h('summary', {},
              h('span', { class: `verdict ${cls[f.verdict]}`, title: verdictText[f.verdict], text: mark[f.verdict] }),
              h('span', { class: 'release-name', text: f.fileName }),
              h('span', { class: 'note', text: f.saved ? `${f.meta} · saved to ${f.saved}` : f.meta }),
              h('span', { class: 'release-toggle', 'aria-hidden': 'true' })),
            h('ul', { class: 'checks' }, f.checks.map((c) => h('li', { class: cls[String(c.ok)] }, h('span', { class: 'mark', 'aria-hidden': 'true', text: mark[String(c.ok)] }), h('span', { text: c.text })))),
            f.notes.length > 0 && h('ul', { class: 'release-notes' }, f.notes.map((n) => h('li', { text: n })))),
          h('button', { type: 'button', class: 'ghost', text: 'Download', 'aria-label': `Download ${f.fileName}`, onclick: () => downloadBytes(f.bytes, f.fileName, f.type) }))),
        failures.map((f) => h('li', { class: 'release-file failed' },
          h('div', { class: 'release-fail' },
            h('span', { class: 'verdict crit', text: '✕' }),
            h('span', { text: `Couldn't create the ${f.label}: ${f.error}` })))))));
  }

  /** Writes every finished file into a folder the user picks (Chrome and Edge). */
  async function saveToFolder() {
    let dir;
    try {
      dir = await window.showDirectoryPicker({ id: 'mixdown-release', mode: 'readwrite', startIn: 'music' });
    } catch (error) {
      if (error.name !== 'AbortError') status(`Couldn't open the folder: ${error.message}`, null, true);
      return;
    }
    const existing = [];
    for (const f of files) {
      try { await dir.getFileHandle(f.fileName); existing.push(f.fileName); } catch { /* not there yet */ }
    }
    if (existing.length && !window.confirm(`"${dir.name}" already has ${existing.length === 1 ? 'a file' : `${existing.length} files`} with ${existing.length === 1 ? 'this name' : 'these names'}:\n\n${existing.join('\n')}\n\nReplace ${existing.length === 1 ? 'it' : 'them'}?`)) return;
    try {
      for (const [i, f] of files.entries()) {
        status(`Saving ${i + 1} of ${files.length} to "${dir.name}"`, i / files.length);
        const handle = await dir.getFileHandle(f.fileName, { create: true });
        const writable = await handle.createWritable();
        await writable.write(f.bytes);
        await writable.close();
        f.saved = `"${dir.name}"`;
      }
      status(`Saved ${files.length} file${files.length === 1 ? '' : 's'} to "${dir.name}".`);
    } catch (error) {
      status(`Couldn't save to "${dir.name}": ${error.message}`, null, true);
    }
    renderFiles();
  }

  function downloadZip() {
    const base = fileBase(files.find((f) => !f.fileName.includes('(master)'))?.fileName ?? files[0].fileName).replace(/( \([^)]*\))+$/, '');
    downloadBytes(createZip(files.map((f) => ({ name: f.fileName, data: f.bytes }))), `${base} (release files).zip`, 'application/zip');
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
    /** Ticks a source, for example after mastering, keeping the others as they are. */
    selectSource(id) {
      renderSources([...new Set([...checked(el.sources), id])]);
    },
    /** Refreshes the source list and the peak note when the mix or a master changes. */
    update({ sourceChanged = false } = {}) {
      if (sourceChanged && !busy) {
        files = []; // files made from the previous mix no longer match
        failures = [];
        renderFiles();
        deps.onFileReady?.(false);
      }
      renderSources();
    },
  };
}
