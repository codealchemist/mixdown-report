/**
 * Plays the mix through a Channel EQ model with an instant, level-matched A/B switch.
 * Filters are IIRFilterNodes built from the same coefficients as the on-screen curve.
 *
 *   source ─┬─ dry ───────────────────────────────┬─ destination
 *           └─ EQ sections ─ level match ─ wet ───┘
 */
import { eqSections } from '../core/eq/response.js';
import { replacementSections } from '../core/eq/correction.js';

const RAMP = 0.02; // seconds, avoids clicks when switching

export class EqPreview {
  /** @type {AudioContext|null} */ #ctx = null;
  /** @type {AudioBuffer|null} */ #buffer = null;
  /** @type {AudioBufferSourceNode|null} */ #source = null;
  #dry = null;
  #wet = null;
  #match = null;
  #filters = [];
  #eq = null;
  #replacing = null;
  #levelChange = 0;
  #bypassed = false;
  #onChange;

  /** @param {(state: { playing: boolean, bypassed: boolean, loaded: boolean }) => void} onChange */
  constructor(onChange = () => {}) {
    this.#onChange = onChange;
  }

  /** Replaces the state listener. */
  set onStateChange(listener) { this.#onChange = listener; }

  get playing() { return this.#source !== null; }
  get loaded() { return this.#buffer !== null; }
  get bypassed() { return this.#bypassed; }

  #emit() { this.#onChange({ playing: this.playing, bypassed: this.#bypassed, loaded: this.loaded }); }

  #context() {
    if (!this.#ctx) {
      this.#ctx = new AudioContext();
      this.#dry = this.#ctx.createGain();
      this.#wet = this.#ctx.createGain();
      this.#match = this.#ctx.createGain();
      this.#dry.connect(this.#ctx.destination);
      this.#match.connect(this.#wet).connect(this.#ctx.destination);
      this.#applyBypass(true);
    }
    return this.#ctx;
  }

  /** Loads decoded audio. Call `unload` when the mix changes. */
  load({ channels, sampleRate }) {
    const ctx = this.#context();
    const buffer = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
    channels.forEach((c, i) => buffer.copyToChannel(c, i));
    this.stop();
    this.#buffer = buffer;
    this.#emit();
  }

  unload() {
    this.stop();
    this.#buffer = null;
    this.#emit();
  }

  /**
   * @param {object} eq Channel EQ model
   * @param {number} levelChangeDb how much the EQ changes overall level; compensated so A/B compares tone, not volume
   * @param {object|null} replacing a correction EQ already in the audio, which `eq` replaces
   */
  setEq(eq, levelChangeDb = 0, replacing = null) {
    this.#eq = eq;
    this.#replacing = replacing;
    this.#levelChange = levelChangeDb;
    if (this.#ctx) this.#rebuild();
  }

  setBypass(bypassed) {
    this.#bypassed = bypassed;
    if (this.#ctx) this.#applyBypass(false);
    this.#emit();
  }

  /** Starts looping playback at `offset` seconds. Must be called from a user gesture the first time. */
  async play(offset = 0) {
    if (!this.#buffer) return;
    const ctx = this.#context();
    if (ctx.state === 'suspended') await ctx.resume();
    this.stop();
    const source = ctx.createBufferSource();
    source.buffer = this.#buffer;
    source.loop = true;
    this.#source = source;
    this.#rebuild();
    source.start(0, Math.max(0, Math.min(offset, this.#buffer.duration - 0.1)));
    this.#emit();
  }

  stop() {
    if (!this.#source) return;
    try { this.#source.stop(); } catch { /* already stopped */ }
    this.#source.disconnect();
    this.#source = null;
    this.#emit();
  }

  async dispose() {
    this.stop();
    await this.#ctx?.close();
    this.#ctx = null;
  }

  #applyBypass(immediate) {
    const t = this.#ctx.currentTime;
    const set = (param, v) => (immediate ? param.setValueAtTime(v, t) : param.setTargetAtTime(v, t, RAMP / 3));
    set(this.#dry.gain, this.#bypassed ? 1 : 0);
    set(this.#wet.gain, this.#bypassed ? 0 : 1);
  }

  #rebuild() {
    for (const f of this.#filters) f.disconnect();
    this.#filters = [];
    const ctx = this.#ctx;
    this.#match.gain.setTargetAtTime(10 ** (-this.#levelChange / 20), ctx.currentTime, RAMP / 3);
    if (!this.#source) return;
    this.#source.disconnect(); // drop the link to the previous filter chain
    this.#source.connect(this.#dry);
    const sections = !this.#eq ? [] : this.#replacing ? replacementSections(this.#eq, this.#replacing, ctx.sampleRate) : eqSections(this.#eq, ctx.sampleRate);
    let node = this.#source;
    for (const { b, a } of sections) {
      const filter = new IIRFilterNode(ctx, { feedforward: b, feedback: a });
      node.connect(filter);
      node = filter;
      this.#filters.push(filter);
    }
    node.connect(this.#match);
  }
}

/** Start time of the loudest 3-second window, so the preview opens on the chorus rather than the intro. */
export function loudestOffset(analysis) {
  let best = 0;
  analysis.shortTerm.forEach((v, i) => { if (v > analysis.shortTerm[best]) best = i; });
  return Math.max(0, best * analysis.shortTermStep);
}
