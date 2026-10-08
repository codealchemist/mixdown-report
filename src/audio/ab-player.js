/**
 * Plays two versions of a song in sync and switches between them instantly (A = mix, B = master).
 * Both sources run together from the same position; switching only crossfades their gains,
 * so you hear the same moment in each. Optional level matching turns A up or down to B's loudness.
 */

const RAMP = 0.015;

export class AbPlayer {
  #ctx = null;
  #buffers = { a: null, b: null };
  #sources = [];
  #gains = { a: null, b: null };
  #matchDb = 0;
  #matched = true;
  #selected = 'b';
  #onChange;

  constructor(onChange = () => {}) { this.#onChange = onChange; }

  get playing() { return this.#sources.length > 0; }
  get selected() { return this.#selected; }
  get loaded() { return Boolean(this.#buffers.a && this.#buffers.b); }

  #emit() { this.#onChange({ playing: this.playing, selected: this.#selected, matched: this.#matched }); }

  #context() {
    if (!this.#ctx) {
      this.#ctx = new AudioContext();
      for (const k of ['a', 'b']) {
        this.#gains[k] = this.#ctx.createGain();
        this.#gains[k].connect(this.#ctx.destination);
      }
    }
    return this.#ctx;
  }

  #buffer({ channels, sampleRate }) {
    const ctx = this.#context();
    const buffer = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
    channels.forEach((c, i) => buffer.copyToChannel(c, i));
    return buffer;
  }

  /**
   * @param {{ channels: Float32Array[], sampleRate: number }} a
   * @param {{ channels: Float32Array[], sampleRate: number }} b
   * @param {number} matchDb gain for A that matches B's loudness
   */
  load(a, b, matchDb) {
    this.stop();
    this.#buffers = { a: this.#buffer(a), b: this.#buffer(b) };
    this.#matchDb = matchDb;
    this.#apply(true);
    this.#emit();
  }

  unload() {
    this.stop();
    this.#buffers = { a: null, b: null };
    this.#emit();
  }

  select(which) {
    this.#selected = which;
    if (this.#ctx) this.#apply(false);
    this.#emit();
  }

  setMatched(matched) {
    this.#matched = matched;
    if (this.#ctx) this.#apply(false);
    this.#emit();
  }

  async play(offset = 0) {
    if (!this.loaded) return;
    const ctx = this.#context();
    if (ctx.state === 'suspended') await ctx.resume();
    this.stop();
    const when = ctx.currentTime + 0.05;
    const start = Math.max(0, Math.min(offset, this.#buffers.b.duration - 0.1));
    for (const k of ['a', 'b']) {
      const source = ctx.createBufferSource();
      source.buffer = this.#buffers[k];
      source.loop = true;
      source.connect(this.#gains[k]);
      source.start(when, start);
      this.#sources.push(source);
    }
    this.#emit();
  }

  stop() {
    for (const s of this.#sources) {
      try { s.stop(); } catch { /* already stopped */ }
      s.disconnect();
    }
    this.#sources = [];
    this.#emit();
  }

  #apply(immediate) {
    const t = this.#ctx.currentTime;
    const aLevel = this.#matched ? 10 ** (this.#matchDb / 20) : 1;
    const set = (param, v) => (immediate ? param.setValueAtTime(v, t) : param.setTargetAtTime(v, t, RAMP / 3));
    set(this.#gains.a.gain, this.#selected === 'a' ? aLevel : 0);
    set(this.#gains.b.gain, this.#selected === 'b' ? 1 : 0);
  }
}
