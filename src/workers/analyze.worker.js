/** Runs the analysis off the main thread so the page stays responsive on long songs. */
import { analyze } from '../core/analyze.js';
import { serveJobs } from '../audio/job-runner.js';

serveJobs(({ channels, sampleRate }, onProgress) => ({ result: analyze(channels, sampleRate, { onProgress }) }));
