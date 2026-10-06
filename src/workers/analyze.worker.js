/** Runs the analysis off the main thread so the page stays responsive on long songs. */
import { analyze } from '../core/analyze.js';

self.addEventListener('message', (event) => {
  const { id, channels, sampleRate } = event.data;
  try {
    const result = analyze(channels, sampleRate, {
      onProgress: (label, fraction) => self.postMessage({ id, type: 'progress', label, fraction }),
    });
    self.postMessage({ id, type: 'result', result });
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error.message, name: error.name });
  }
});
