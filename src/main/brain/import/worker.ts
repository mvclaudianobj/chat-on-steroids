/**
 * Chat Marks Brain H2: runs `buildIndex` in a `worker_threads` worker so the main process stays
 * responsive while a multi-GB staged copy is indexed. One job at a time; cancel is a shared flag
 * checked between batches (the committed cursor makes the next run resume).
 */
import { Worker } from 'node:worker_threads';
import { buildIndex, type IndexJob, type IndexResult } from './indexer.js';

export const INDEX_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const flag = new Int32Array(workerData.cancel);
const buildIndex = (${buildIndex.toString()});
try {
  const result = buildIndex(workerData.job, {
    DatabaseSync, fs, path,
    progress: event => parentPort.postMessage({ type: 'progress', event }),
    cancelled: () => Atomics.load(flag, 0) === 1
  });
  parentPort.postMessage({ type: 'done', result });
} catch (error) {
  parentPort.postMessage({ type: 'error', message: String(error && error.message || error).slice(0, 300) });
}
`;

export interface IndexHandle { promise: Promise<IndexResult>; cancel(): void }

export function startIndexWorker(job: IndexJob, onProgress: (event: { source: string; done: number; total: number }) => void): IndexHandle {
  const cancel = new SharedArrayBuffer(4);
  const flag = new Int32Array(cancel);
  const worker = new Worker(INDEX_WORKER_SOURCE, { eval: true, workerData: { job, cancel } });
  let settled = false;
  const promise = new Promise<IndexResult>((resolve, reject) => {
    worker.on('message', (message: { type: string; event?: { source: string; done: number; total: number }; result?: IndexResult; message?: string }) => {
      if (message.type === 'progress' && message.event) onProgress(message.event);
      else if (message.type === 'done' && message.result) { settled = true; resolve(message.result); }
      else if (message.type === 'error') { settled = true; reject(new Error(message.message ?? 'Index failed')); }
    });
    worker.on('error', error => { if (!settled) { settled = true; reject(error); } });
    worker.on('exit', code => { if (!settled) { settled = true; reject(new Error(`Index worker stopped (${code})`)); } });
  });
  return { promise, cancel: () => { Atomics.store(flag, 0, 1); } };
}
