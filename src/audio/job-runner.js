/**
 * Runs jobs in module Web Workers, one worker per slot so different jobs can run at once.
 * Starting a new job in a slot cancels the previous one. Falls back to running inline when
 * module workers aren't available.
 *
 * Protocol: the page posts { id, payload }; the worker replies { id, type: 'progress', label, fraction },
 * { id, type: 'result', result } or { id, type: 'error', name, message }.
 */

export class CancelledError extends Error {
  constructor() {
    super('The job was replaced by a newer one.');
    this.name = 'CancelledError';
  }
}

export class JobRunner {
  #url;
  #inline;
  #workers = new Map();
  #pending = new Map();
  #nextId = 1;

  /**
   * @param {URL} workerUrl
   * @param {(payload: any, onProgress: Function) => Promise<any>} inline fallback that runs the job on this thread
   */
  constructor(workerUrl, inline) {
    this.#url = workerUrl;
    this.#inline = inline;
  }

  /**
   * @param {string} slot
   * @param {any} payload
   * @param {Transferable[]} [transfer] buffers moved to the worker; don't use them afterwards
   * @param {(label: string, fraction: number) => void} [onProgress]
   */
  run(slot, payload, transfer = [], onProgress = () => {}) {
    this.cancel(slot);
    let worker;
    try {
      worker = new Worker(this.#url, { type: 'module' });
    } catch {
      return this.#inline(payload, onProgress);
    }
    const id = this.#nextId++;
    this.#workers.set(slot, worker);
    return new Promise((resolve, reject) => {
      this.#pending.set(slot, { reject });
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
          reject(Object.assign(new Error(data.message), { name: data.name }));
        }
      };
      worker.onerror = (event) => {
        settle();
        reject(new Error(event.message || 'The background worker failed.'));
      };
      worker.postMessage({ id, payload }, transfer);
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
}

/** Helper for worker scripts: runs `handle(payload, onProgress)` for each message and posts the outcome. */
export function serveJobs(handle) {
  self.addEventListener('message', async ({ data }) => {
    const { id, payload } = data;
    try {
      const { result, transfer = [] } = await handle(payload, (label, fraction) => self.postMessage({ id, type: 'progress', label, fraction }));
      self.postMessage({ id, type: 'result', result }, transfer);
    } catch (error) {
      self.postMessage({ id, type: 'error', name: error.name, message: error.message });
    }
  });
}
