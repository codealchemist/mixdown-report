/** Renders release files (and masters) off the main thread. */
import { serveJobs } from '../audio/job-runner.js';
import { runRenderJob } from '../core/render-jobs.js';

serveJobs(runRenderJob);
