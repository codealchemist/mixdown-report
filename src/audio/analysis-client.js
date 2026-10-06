/**
 * Runs analyses in Web Workers, one per slot (mix, reference), so both can run at once.
 * Starting a new job in a slot cancels the previous one. Falls back to the main thread
 * if module workers aren't available.
 */

export class CancelledError extends Error {
  constructor() {
    super('Analysis was replaced by a newer one.');
    this.name = 'CancelledError';
  }
}

export class AnalysisClient {
  #workers = new Map();
  #pending = new Map();
  #nextId = 1;

  /**
   * @param {string} slot
   * @param {Float32Array[]} channels transferred to the worker; don't reuse them afterwards
   * @param {number} sampleRate
   * @param {(label: string, fraction: number) => void} onProgress
   */
  run(slot, channels, sampleRate, onProgress) {
    this.cancel(slot);
    const worker = this.#createWorker();
    if (!worker) return this.#runInline(channels, sampleRate, onProgress);

    const id = this.#nextId++;
    this.#workers.set(slot, worker);
    return new Promise((resolve, reject) => {
      this.#pending.set(slot, { id, reject });
      const settle = () => {
        this.#pending.delete(slot);
        this.#workers.delete(slot);
        worker.terminate();
      };
      worker.onmessage = ({ data }) => {
        if (data.id !== id) return;
        if (data.type === 'progress') onProgress(data.label, data.fraction);
        else if (data.type === 'result') { settle(); resolve(data.result); }
        else if (data.type === 'error') {
          settle();
          const error = new Error(data.message);
          error.name = data.name;
          reject(error);
        }
      };
      worker.onerror = (event) => {
        settle();
        reject(new Error(event.message || 'The analysis worker failed.'));
      };
      worker.postMessage({ id, channels, sampleRate }, channels.map((c) => c.buffer));
    });
  }

  /** Stops a running job; its promise rejects with CancelledError. */
  cancel(slot) {
    this.#workers.get(slot)?.terminate();
    this.#workers.delete(slot);
    const pending = this.#pending.get(slot);
    if (pending) {
      this.#pending.delete(slot);
      pending.reject(new CancelledError());
    }
  }

  #createWorker() {
    try {
      return new Worker(new URL('../workers/analyze.worker.js', import.meta.url), { type: 'module' });
    } catch {
      return null;
    }
  }

  async #runInline(channels, sampleRate, onProgress) {
    const { analyze } = await import('../core/analyze.js');
    return analyze(channels, sampleRate, { onProgress });
  }
}
