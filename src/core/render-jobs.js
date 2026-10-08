/** Render jobs shared by the render worker and the inline fallback. */
import { prepareDelivery } from './delivery.js';
import { masterMix } from './master/chain.js';
import { analyze } from './analyze.js';
import { eqSections } from './eq/response.js';
import { applySections } from './dsp/biquad.js';
import { replacementSections } from './eq/correction.js';
import { fitCalibration, measureResponse, testSignal, TEST_SIGNAL } from './eq/calibration.js';
import { encodeWav } from './codecs/wav.js';

/**
 * @param {{ type: 'deliver'|'master'|'testEq'|'testSignal'|'calibrate', channels?: Float32Array[], sampleRate?: number, options?: object, eq?: object, raw?: object }} payload
 * @param {(label: string, fraction: number) => void} onProgress
 * @returns {Promise<{ result: any, transfer: Transferable[] }>}
 */
export async function runRenderJob(payload, onProgress) {
  switch (payload.type) {
    case 'deliver': {
      const { bytes, report } = await prepareDelivery(payload.channels, payload.sampleRate, { ...payload.options, onProgress });
      return { result: { bytes, report }, transfer: [bytes.buffer] };
    }
    case 'master': {
      const { channels, report } = masterMix(payload.channels, payload.sampleRate, { ...payload.options, onProgress });
      return { result: { channels, sampleRate: payload.sampleRate, report }, transfer: channels.map((c) => c.buffer) };
    }
    case 'testEq': {
      // Apply the EQ exactly as the preview and preset describe it, then measure the result like a bounce
      onProgress('Applying the EQ', 0);
      // With `current`, the bounce already contains that correction: test replacing it, not adding to it
      const sections = payload.current ? replacementSections(payload.eq, payload.current, payload.sampleRate) : eqSections(payload.eq, payload.sampleRate);
      for (const c of payload.channels) applySections(c, sections);
      const analysis = analyze(payload.channels, payload.sampleRate, { onProgress: (label, f) => onProgress(label, 0.1 + 0.9 * f) });
      return { result: { analysis }, transfer: [] };
    }
    case 'testSignal': {
      const x = testSignal();
      const bytes = encodeWav([x, x], TEST_SIGNAL.sampleRate, 24);
      return { result: { bytes }, transfer: [bytes.buffer] };
    }
    case 'calibrate': {
      onProgress('Measuring Logic\'s response', 0.2);
      const measured = measureResponse(payload.channels, payload.sampleRate);
      onProgress('Fitting the correction', 0.7);
      return { result: fitCalibration(measured, payload.raw, payload.sampleRate), transfer: [] };
    }
    default:
      throw new Error(`Unknown render job: ${payload.type}`);
  }
}
