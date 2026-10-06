/**
 * Renders a short example loop so the app opens with a real analysis to look at.
 * It has two deliberate problems the report should catch: a low-mid bump on the pads
 * and bass that leaks into the sides.
 */
import { channelsOf } from './decode.js';

const SAMPLE_RATE = 44100;
const DURATION = 24;
const BEAT = 0.5; // 120 BPM
const ROOTS = [55, 43.65, 65.41, 49]; // A1 F1 C2 G1
const CHORDS = [[220, 261.6, 329.6], [174.6, 220, 261.6], [261.6, 329.6, 392], [196, 246.9, 293.7]];
const PEAK_DBFS = -0.4;

function envelope(gainNode, t, peak, decay) {
  gainNode.gain.setValueAtTime(0.0001, t);
  gainNode.gain.exponentialRampToValueAtTime(peak, t + 0.004);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t + decay);
}

function noiseBuffer(ctx) {
  const buffer = ctx.createBuffer(1, SAMPLE_RATE, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  let seed = 1;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 16807) % 2147483647; // deterministic so the example is identical every time
    data[i] = (seed / 2147483647) * 2 - 1;
  }
  return buffer;
}

function addDrums(ctx, out, noise) {
  for (let t = 0; t < DURATION - 0.5; t += BEAT) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.12);
    envelope(g, t, 0.9, 0.42);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.5);
  }
  for (let t = BEAT; t < DURATION - 0.5; t += 2 * BEAT) {
    const src = ctx.createBufferSource();
    const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1800, Q: 0.7 });
    const g = ctx.createGain();
    src.buffer = noise;
    envelope(g, t, 0.55, 0.18);
    src.connect(bp).connect(g).connect(out);
    src.start(t);
    src.stop(t + 0.25);
  }
  for (let t = 0; t < DURATION - 0.3; t += BEAT / 2) {
    const src = ctx.createBufferSource();
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 7500 });
    const g = ctx.createGain();
    const pan = new StereoPannerNode(ctx, { pan: 0.35 });
    src.buffer = noise;
    envelope(g, t, 0.16, 0.05);
    src.connect(hp).connect(g).connect(pan).connect(out);
    src.start(t);
    src.stop(t + 0.08);
  }
}

function addBass(ctx, out) {
  const osc = new OscillatorNode(ctx, { type: 'sawtooth' });
  const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 320 });
  const g = new GainNode(ctx, { gain: 0.32 });
  const merger = ctx.createChannelMerger(2);
  const delay = new DelayNode(ctx, { delayTime: 0.011 }); // right channel late: bass leaks into the sides
  osc.connect(lp).connect(g);
  g.connect(merger, 0, 0);
  g.connect(delay).connect(merger, 0, 1);
  merger.connect(out);
  for (let bar = 0; bar * 2 < DURATION; bar++) osc.frequency.setValueAtTime(ROOTS[bar % 4], bar * 2);
  osc.start(0);
  osc.stop(DURATION);
}

function addPads(ctx, out) {
  const bump = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 300, Q: 0.9, gain: 9 }); // muddy low mids
  const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2600 });
  bump.connect(lp).connect(out);
  for (let bar = 0; bar * 2 < DURATION; bar++) {
    const t0 = bar * 2;
    CHORDS[bar % 4].forEach((frequency, k) => {
      const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency, detune: (k - 1) * 7 });
      const g = ctx.createGain();
      const pan = new StereoPannerNode(ctx, { pan: [-0.6, 0, 0.6][k] });
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.05, t0 + 0.3);
      g.gain.setValueAtTime(0.05, t0 + 1.8);
      g.gain.linearRampToValueAtTime(0.0001, t0 + 2);
      osc.connect(g).connect(pan).connect(bump);
      osc.start(t0);
      osc.stop(t0 + 2);
    });
  }
}

/** @returns {Promise<{ channels: Float32Array[], sampleRate: number }>} */
export async function renderDemo() {
  const ctx = new OfflineAudioContext(2, SAMPLE_RATE * DURATION, SAMPLE_RATE);
  const out = new GainNode(ctx, { gain: 0.8 });
  out.connect(ctx.destination);
  addDrums(ctx, out, noiseBuffer(ctx));
  addBass(ctx, out);
  addPads(ctx, out);

  const channels = channelsOf(await ctx.startRendering());
  let peak = 0;
  for (const c of channels) for (const v of c) peak = Math.max(peak, Math.abs(v));
  const gain = 10 ** (PEAK_DBFS / 20) / (peak || 1);
  for (const c of channels) for (let i = 0; i < c.length; i++) c[i] *= gain;
  return { channels, sampleRate: SAMPLE_RATE };
}
